#!/usr/bin/env bash
# ============================================================================
# rollback.sh — Instantly roll back the Agents ECS service to a previous
# task definition revision. No rebuild, no waiting — just point the service
# at a known-good revision and force a new deployment.
#
# Usage:
#   ./rollback.sh              # Roll back to the previous revision (current - 1)
#   ./rollback.sh 42           # Roll back to a specific revision number
#   ./rollback.sh --list       # List recent task definition revisions
#   ./rollback.sh --status     # Show current deployment status
# ============================================================================
set -euo pipefail

AWS_REGION="us-east-1"
PREFIX="conductor-production"
SERVICE_NAME="conductor-agents"
TASK_FAMILY="${PREFIX}-agents"

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

# Load credentials
if [[ -f ../../claude-conductor/.env ]]; then
  export AWS_ACCESS_KEY_ID=$(grep AWS_ACCESS_KEY ../../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  export AWS_SECRET_ACCESS_KEY=$(grep AWS_SECRET_KEY ../../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  export AWS_DEFAULT_REGION=$AWS_REGION
elif [[ -f .env ]]; then
  set -a && source .env && set +a
fi

[[ -z "${AWS_ACCESS_KEY_ID:-}" ]] && die "AWS credentials not found."

# ---------------------------------------------------------------------------
# --list: Show recent revisions
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--list" ]]; then
  log "Recent task definition revisions for ${TASK_FAMILY}:"
  echo ""

  REVISIONS=$(aws ecs list-task-definitions \
    --family-prefix "${TASK_FAMILY}" \
    --sort DESC \
    --max-items 10 \
    --query 'taskDefinitionArns' --output json)

  # Get the currently running revision
  CURRENT_TASK_DEF=$(aws ecs describe-services \
    --cluster "${PREFIX}" --services "${SERVICE_NAME}" \
    --query 'services[0].taskDefinition' --output text 2>/dev/null || echo "unknown")
  CURRENT_REV=$(echo "$CURRENT_TASK_DEF" | grep -oP ':\K\d+$' || echo "?")

  echo "$REVISIONS" | jq -r '.[]' | while read -r arn; do
    REV=$(echo "$arn" | grep -oP ':\K\d+$')
    STATUS=$(aws ecs describe-task-definition --task-definition "$arn" \
      --query 'taskDefinition.status' --output text 2>/dev/null || echo "unknown")
    REGISTERED=$(aws ecs describe-task-definition --task-definition "$arn" \
      --query 'taskDefinition.registeredAt' --output text 2>/dev/null || echo "unknown")

    MARKER=""
    if [[ "$REV" == "$CURRENT_REV" ]]; then
      MARKER=" ${GREEN}<-- CURRENT${NC}"
    fi
    echo -e "  Revision ${REV}  (${STATUS})  registered ${REGISTERED}${MARKER}"
  done

  exit 0
fi

# ---------------------------------------------------------------------------
# --status: Show current deployment status
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--status" ]]; then
  log "Current deployment status for ${SERVICE_NAME}:"
  echo ""

  aws ecs describe-services \
    --cluster "${PREFIX}" --services "${SERVICE_NAME}" \
    --query 'services[0].{
      Status: status,
      TaskDefinition: taskDefinition,
      RunningCount: runningCount,
      DesiredCount: desiredCount,
      PendingCount: pendingCount,
      Deployments: deployments[*].{
        Id: id,
        Status: status,
        TaskDef: taskDefinition,
        Running: runningCount,
        Desired: desiredCount,
        Rollout: rolloutState
      }
    }' --output yaml

  exit 0
fi

# ---------------------------------------------------------------------------
# Determine target revision
# ---------------------------------------------------------------------------
if [[ -n "${1:-}" ]]; then
  TARGET_REV="$1"
  TARGET_TASK_DEF="${TASK_FAMILY}:${TARGET_REV}"
  log "Rolling back to specified revision: ${TARGET_REV}"
else
  # Find the current revision and go back one
  CURRENT_TASK_DEF=$(aws ecs describe-services \
    --cluster "${PREFIX}" --services "${SERVICE_NAME}" \
    --query 'services[0].taskDefinition' --output text)
  CURRENT_REV=$(echo "$CURRENT_TASK_DEF" | grep -oP ':\K\d+$')

  if [[ -z "$CURRENT_REV" ]]; then
    die "Could not determine current task definition revision"
  fi

  TARGET_REV=$((CURRENT_REV - 1))
  TARGET_TASK_DEF="${TASK_FAMILY}:${TARGET_REV}"
  log "Current revision: ${CURRENT_REV}"
  log "Rolling back to previous revision: ${TARGET_REV}"
fi

# Verify target exists
if ! aws ecs describe-task-definition --task-definition "${TARGET_TASK_DEF}" >/dev/null 2>&1; then
  die "Task definition ${TARGET_TASK_DEF} not found"
fi

# Confirm
echo ""
warn "This will update the ECS service to use task definition revision ${TARGET_REV}."
warn "The current running tasks will be replaced."
echo ""
read -p "Proceed? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  log "Rollback cancelled."
  exit 0
fi

# ---------------------------------------------------------------------------
# Execute rollback
# ---------------------------------------------------------------------------
log "Updating service to revision ${TARGET_REV}..."

aws ecs update-service \
  --cluster "${PREFIX}" \
  --service "${SERVICE_NAME}" \
  --task-definition "${TARGET_TASK_DEF}" \
  --force-new-deployment \
  --query 'service.deployments[0].{Id:id,Status:status,TaskDef:taskDefinition}' \
  --output yaml

ok "Rollback initiated! Service is deploying revision ${TARGET_REV}."
echo ""
log "Monitor deployment:"
log "  aws ecs describe-services --cluster ${PREFIX} --services ${SERVICE_NAME} --query 'services[0].deployments'"
log "  aws logs tail /ecs/${PREFIX}/agents --follow"
