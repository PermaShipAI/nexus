#!/usr/bin/env bash
# ============================================================================
# deploy-aws.sh — Deploy PermaShip AI Agents to AWS ECS
# ============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
AWS_REGION="us-east-1"
PREFIX="conductor-production"
SERVICE_NAME="conductor-agents"
TASK_FAMILY="${PREFIX}-agents"
ECR_REPO="permaship/agents"
AGENT_SECRET_NAME="${PREFIX}-agents-config"
LOG_GROUP="/ecs/${PREFIX}/agents"
TASK_ROLE_NAME="${PREFIX}-agents-task"
EXEC_ROLE_NAME="${PREFIX}-task-execution"
CPU=512
MEMORY=1024

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $*"; }
ok()    { echo -e "${GREEN}[$(date '+%H:%M:%S')] ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠${NC} $*"; }
err()   { echo -e "${RED}[$(date '+%H:%M:%S')] ✗${NC} $*" >&2; }
die()   { err "$@"; exit 1; }

# ---------------------------------------------------------------------------
# Load Credentials
# ---------------------------------------------------------------------------
if [[ -f ../claude-conductor/.env ]]; then
  log "Loading AWS credentials from ../claude-conductor/.env..."
  export AWS_ACCESS_KEY_ID=$(grep AWS_ACCESS_KEY ../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  export AWS_SECRET_ACCESS_KEY=$(grep AWS_SECRET_KEY ../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  export AWS_DEFAULT_REGION=$AWS_REGION
  # Some envs use AWS_ACCOUNT_ID
  AWS_ACCOUNT_ID=$(grep AWS_ACCOUNT_ID ../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
elif [[ -f .env ]]; then
  log "Loading credentials from local .env..."
  set -a && source .env && set +a
  export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY:-$AWS_ACCESS_KEY_ID}
  export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_KEY:-$AWS_SECRET_ACCESS_KEY}
fi

if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  die "AWS_ACCESS_KEY_ID not found. Please provide credentials."
fi

# Get account ID if not loaded
if [[ -z "${AWS_ACCOUNT_ID:-}" ]]; then
  AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
fi

ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
log "Using AWS Account: ${AWS_ACCOUNT_ID} in ${AWS_REGION}"

# ============================================================================
# Step 1: Infrastructure Discovery
# ============================================================================
log "Discovering cluster and networking..."

# ECS cluster
if ! aws ecs describe-clusters --clusters "${PREFIX}" --query 'clusters[0].clusterArn' --output text | grep -q "arn:aws:ecs"; then
  die "ECS cluster '${PREFIX}' not found. Ensure core infra is deployed."
fi

# VPC & Subnets
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=conductor-vpc" --query 'Vpcs[0].VpcId' --output text)
PRIVATE_SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" "Name=tag:Tier,Values=private" --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

# Security Group
AGENT_SG_NAME="conductor-agents-sg"
AGENT_SG_ID=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=${AGENT_SG_NAME}" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "")

if [[ "$AGENT_SG_ID" == "None" || -z "$AGENT_SG_ID" ]]; then
  log "Creating security group ${AGENT_SG_NAME}..."
  AGENT_SG_ID=$(aws ec2 create-security-group --group-name "${AGENT_SG_NAME}" --description "Security group for PermaShip Agents" --vpc-id "${VPC_ID}" --query 'GroupId' --output text)
  aws ec2 create-tags --resources "${AGENT_SG_ID}" --tags "Key=Name,Value=${AGENT_SG_NAME}"
fi

# Execution Role
EXEC_ROLE_ARN=$(aws iam get-role --role-name "${EXEC_ROLE_NAME}" --query 'Role.Arn' --output text)

# ============================================================================
# Step 2: Build & Push
# ============================================================================
log "Handling ECR and Docker image..."

if ! aws ecr describe-repositories --repository-names "${ECR_REPO}" >/dev/null 2>&1; then
  aws ecr create-repository --repository-name "${ECR_REPO}" --image-scanning-configuration scanOnPush=true
fi

aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

IMAGE_URI="${ECR_REGISTRY}/${ECR_REPO}:latest"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker build -t "${IMAGE_URI}" -f "${SCRIPT_DIR}/Dockerfile.agents" .
docker push "${IMAGE_URI}"
ok "Image pushed: ${IMAGE_URI}"

# ============================================================================
# Step 3: Secrets Manager
# ============================================================================
log "Configuring secrets..."

if ! aws secretsmanager describe-secret --secret-id "${AGENT_SECRET_NAME}" >/dev/null 2>&1; then
  log "Creating new secret ${AGENT_SECRET_NAME}..."
  aws secretsmanager create-secret --name "${AGENT_SECRET_NAME}" --description "PermaShip Agents config" --secret-string "{}"
fi

AGENT_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "${AGENT_SECRET_NAME}" --query 'ARN' --output text)

# Ensure execution role can read this secret
EXISTING_POLICY=$(aws iam get-role-policy --role-name "${EXEC_ROLE_NAME}" --policy-name "secrets-access" --query 'PolicyDocument' --output json 2>/dev/null || echo "")
if [[ -n "$EXISTING_POLICY" ]]; then
  if ! echo "$EXISTING_POLICY" | grep -q "${AGENT_SECRET_ARN}"; then
    log "Updating execution role policy to include agents secret..."
    UPDATED_POLICY=$(echo "$EXISTING_POLICY" | jq --arg arn "$AGENT_SECRET_ARN" '.Statement[0].Resource += [$arn]')
    aws iam put-role-policy --role-name "${EXEC_ROLE_NAME}" --policy-name "secrets-access" --policy-document "$UPDATED_POLICY"
  fi
fi

# ============================================================================
# Step 4: IAM Task Role
# ============================================================================
log "Handling IAM roles..."

if ! aws iam get-role --role-name "${TASK_ROLE_NAME}" >/dev/null 2>&1; then
  TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam create-role --role-name "${TASK_ROLE_NAME}" --assume-role-policy-document "$TRUST_POLICY"
fi

TASK_ROLE_ARN=$(aws iam get-role --role-name "${TASK_ROLE_NAME}" --query 'Role.Arn' --output text)

# ============================================================================
# Step 5: CloudWatch Logs
# ============================================================================
if ! aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --query "logGroups[?logGroupName=='${LOG_GROUP}'].logGroupName" --output text | grep -q "${LOG_GROUP}"; then
  aws logs create-log-group --log-group-name "${LOG_GROUP}"
  aws logs put-retention-policy --log-group-name "${LOG_GROUP}" --retention-in-days 30
fi

# ============================================================================
# Step 6: ECS Task Definition & Service
# ============================================================================
log "Registering task definition..."

CONTAINER_DEFS=$(jq -n \
  --arg image "$IMAGE_URI" \
  --arg log_group "$LOG_GROUP" \
  --arg region "$AWS_REGION" \
  --arg secret_arn "$AGENT_SECRET_ARN" \
  '[{
    name: "agents",
    image: $image,
    essential: true,
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-group": $log_group,
        "awslogs-region": $region,
        "awslogs-stream-prefix": "agents"
      }
    },
    portMappings: [
      {
        containerPort: 9000,
        hostPort: 9000,
        protocol: "tcp"
      }
    ],
    environment: [
      { name: "NODE_ENV", value: "production" },
      { name: "ADAPTER_PROFILE", value: "permaship" }
    ],
    secrets: [
      { name: "GEMINI_API_KEY", valueFrom: ($secret_arn + ":GEMINI_API_KEY::") },
      { name: "PERMASHIP_API_KEY", valueFrom: ($secret_arn + ":PERMASHIP_API_KEY::") },
      { name: "PERMASHIP_API_URL", valueFrom: ($secret_arn + ":PERMASHIP_API_URL::") },
      { name: "PERMASHIP_ORG_ID", valueFrom: ($secret_arn + ":PERMASHIP_ORG_ID::") },
      { name: "PERMASHIP_INTERNAL_SECRET", valueFrom: ($secret_arn + ":PERMASHIP_INTERNAL_SECRET::") },
      { name: "COMMS_API_URL", valueFrom: ($secret_arn + ":COMMS_API_URL::") },
      { name: "COMMS_SIGNING_SECRET", valueFrom: ($secret_arn + ":COMMS_SIGNING_SECRET::") },
      { name: "CONDUCTOR_BOT_SECRET", valueFrom: ($secret_arn + ":CONDUCTOR_BOT_SECRET::") },
      { name: "DATABASE_URL", valueFrom: ($secret_arn + ":DATABASE_URL::") },
      { name: "COMMS_AGENT_API_KEY", valueFrom: ($secret_arn + ":COMMS_AGENT_API_KEY::") }
    ]
  }]')

TASK_DEF=$(jq -n \
  --arg family "$TASK_FAMILY" \
  --arg exec_role "$EXEC_ROLE_ARN" \
  --arg task_role "$TASK_ROLE_ARN" \
  --arg cpu "$CPU" \
  --arg mem "$MEMORY" \
  --argjson container_defs "$CONTAINER_DEFS" \
  '{
    family: $family,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: $cpu,
    memory: $mem,
    executionRoleArn: $exec_role,
    taskRoleArn: $task_role,
    containerDefinitions: $container_defs
  }')

aws ecs register-task-definition --cli-input-json "$TASK_DEF" >/dev/null
ok "Task definition registered."

# ============================================================================
# Step 7: ALB Target Group & Listener Rules
# ============================================================================
log "Configuring ALB target group and listener rules for agents..."

AGENTS_TG_NAME="conductor-prod-agents"
CONTAINER_PORT=9000

# Discover ALB
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names "${PREFIX}" \
  --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null) \
  || die "ALB '${PREFIX}' not found — deploy core infrastructure first"

HTTPS_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "${ALB_ARN}" \
  --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text)

ALB_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=conductor-alb-*" \
  --query 'SecurityGroups[0].GroupId' --output text)

# Allow ALB to reach agents SG on port 9000
aws ec2 authorize-security-group-ingress \
  --group-id "${AGENT_SG_ID}" \
  --protocol tcp --port ${CONTAINER_PORT} \
  --source-group "${ALB_SG_ID}" 2>/dev/null \
  && ok "Added inbound rule: TCP ${CONTAINER_PORT} from ALB SG" \
  || ok "Inbound rule TCP ${CONTAINER_PORT} from ALB SG already exists"

# Create or find target group
AGENTS_TG_ARN=$(aws elbv2 describe-target-groups \
  --names "${AGENTS_TG_NAME}" \
  --region "${AWS_REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null) || AGENTS_TG_ARN=""

if [[ -n "$AGENTS_TG_ARN" && "$AGENTS_TG_ARN" != "None" ]]; then
  ok "Target group '${AGENTS_TG_NAME}' already exists: ${AGENTS_TG_ARN}"
else
  AGENTS_TG_ARN=$(aws elbv2 create-target-group \
    --name "${AGENTS_TG_NAME}" \
    --protocol HTTP \
    --port ${CONTAINER_PORT} \
    --vpc-id "${VPC_ID}" \
    --target-type ip \
    --health-check-protocol HTTP \
    --health-check-path "/health" \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --matcher "HttpCode=200" \
    --region "${AWS_REGION}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  ok "Created target group: ${AGENTS_TG_ARN}"
fi

aws elbv2 modify-target-group-attributes \
  --target-group-arn "${AGENTS_TG_ARN}" \
  --attributes "Key=deregistration_delay.timeout_seconds,Value=30" \
  --region "${AWS_REGION}" >/dev/null

# Create listener rules for agents-specific paths (higher priority than /v1/* comms rule)
EXISTING_RULES=$(aws elbv2 describe-rules \
  --listener-arn "${HTTPS_LISTENER_ARN}" \
  --region "${AWS_REGION}" \
  --query 'Rules[*].{Priority:Priority,Conditions:Conditions,Actions:Actions}')

# Route /v1/webhooks/comms to agents (priority 95, more specific than /v1/* at priority 100)
AGENTS_WEBHOOK_RULE=$(echo "$EXISTING_RULES" | jq -r '[.[] | select(.Conditions[]?.Values[]? == "/v1/webhooks/comms")] | length')
if [[ "$AGENTS_WEBHOOK_RULE" -gt 0 ]]; then
  ok "Listener rule for /v1/webhooks/comms already exists"
else
  aws elbv2 create-rule \
    --listener-arn "${HTTPS_LISTENER_ARN}" \
    --priority 95 \
    --conditions "Field=path-pattern,Values=/v1/webhooks/comms" \
    --actions "Type=forward,TargetGroupArn=${AGENTS_TG_ARN}" \
    --region "${AWS_REGION}" >/dev/null
  ok "Created listener rule: /v1/webhooks/comms -> agents (priority 95)"
fi

# Route specific agent internal endpoints (NOT wildcard — /api/internal/* would steal conductor routes)
# Remove stale wildcard rule if it exists
OLD_WILDCARD_ARN=$(echo "$EXISTING_RULES" | jq -r '[.[] | select(.Conditions[]?.Values[]? == "/api/internal/*")] | .[0].RuleArn // empty')
if [[ -n "$OLD_WILDCARD_ARN" ]]; then
  aws elbv2 delete-rule --rule-arn "$OLD_WILDCARD_ARN" --region "${AWS_REGION}" 2>/dev/null || true
  ok "Removed stale /api/internal/* wildcard rule"
fi

AGENTS_LINK_RULE=$(echo "$EXISTING_RULES" | jq -r '[.[] | select(.Conditions[]?.Values[]? == "/api/internal/link-workspace")] | length')
if [[ "$AGENTS_LINK_RULE" -gt 0 ]]; then
  ok "Listener rule for /api/internal/link-workspace already exists"
else
  aws elbv2 create-rule \
    --listener-arn "${HTTPS_LISTENER_ARN}" \
    --priority 96 \
    --conditions "Field=path-pattern,Values=/api/internal/link-workspace" \
    --actions "Type=forward,TargetGroupArn=${AGENTS_TG_ARN}" \
    --region "${AWS_REGION}" >/dev/null
  ok "Created listener rule: /api/internal/link-workspace -> agents (priority 96)"
fi

AGENTS_IDLE_RULE=$(echo "$EXISTING_RULES" | jq -r '[.[] | select(.Conditions[]?.Values[]? == "/api/internal/trigger-idle")] | length')
if [[ "$AGENTS_IDLE_RULE" -gt 0 ]]; then
  ok "Listener rule for /api/internal/trigger-idle already exists"
else
  aws elbv2 create-rule \
    --listener-arn "${HTTPS_LISTENER_ARN}" \
    --priority 94 \
    --conditions "Field=path-pattern,Values=/api/internal/trigger-idle" \
    --actions "Type=forward,TargetGroupArn=${AGENTS_TG_ARN}" \
    --region "${AWS_REGION}" >/dev/null
  ok "Created listener rule: /api/internal/trigger-idle -> agents (priority 94)"
fi

AGENTS_NEXUS_RULE=$(echo "$EXISTING_RULES" | jq -r '[.[] | select(.Conditions[]?.Values[]? == "/api/internal/trigger-nexus")] | length')
if [[ "$AGENTS_NEXUS_RULE" -gt 0 ]]; then
  ok "Listener rule for /api/internal/trigger-nexus already exists"
else
  aws elbv2 create-rule \
    --listener-arn "${HTTPS_LISTENER_ARN}" \
    --priority 93 \
    --conditions "Field=path-pattern,Values=/api/internal/trigger-nexus" \
    --actions "Type=forward,TargetGroupArn=${AGENTS_TG_ARN}" \
    --region "${AWS_REGION}" >/dev/null
  ok "Created listener rule: /api/internal/trigger-nexus -> agents (priority 93)"
fi

# Route /api/internal/chat/* to agents (admin dashboard chat viewer)
AGENTS_CHAT_RULE=$(echo "$EXISTING_RULES" | jq -r '[.[] | select(.Conditions[]?.Values[]? == "/api/internal/chat/*")] | length')
if [[ "$AGENTS_CHAT_RULE" -gt 0 ]]; then
  ok "Listener rule for /api/internal/chat/* already exists"
else
  aws elbv2 create-rule \
    --listener-arn "${HTTPS_LISTENER_ARN}" \
    --priority 92 \
    --conditions "Field=path-pattern,Values=/api/internal/chat/*" \
    --actions "Type=forward,TargetGroupArn=${AGENTS_TG_ARN}" \
    --region "${AWS_REGION}" >/dev/null
  ok "Created listener rule: /api/internal/chat/* -> agents (priority 92)"
fi

ok "ALB routing configured for agents"

# ============================================================================
# Step 8: Create/Update ECS Service
# ============================================================================
log "Updating ECS service..."
if aws ecs describe-services --cluster "${PREFIX}" --services "${SERVICE_NAME}" --query 'services[0].status' --output text 2>/dev/null | grep -q "ACTIVE"; then
  aws ecs update-service --cluster "${PREFIX}" --service "${SERVICE_NAME}" --task-definition "${TASK_FAMILY}" --force-new-deployment >/dev/null
  ok "Service updated."
else
  aws ecs create-service \
    --cluster "${PREFIX}" \
    --service-name "${SERVICE_NAME}" \
    --task-definition "${TASK_FAMILY}" \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${PRIVATE_SUBNET_IDS}],securityGroups=[${AGENT_SG_ID}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${AGENTS_TG_ARN},containerName=agents,containerPort=${CONTAINER_PORT}" \
    --query 'service.serviceName' --output text >/dev/null
  ok "Service created."
fi

echo ""
ok "Deployment triggered! Use 'aws logs tail ${LOG_GROUP} --follow' to watch startup."
log "IMPORTANT: Ensure all required secrets are set in AWS Secrets Manager: ${AGENT_SECRET_NAME}"
log "Agents are accessible via ALB at: /v1/webhooks/comms and /api/internal/link-workspace"
