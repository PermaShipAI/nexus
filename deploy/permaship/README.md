# PermaShip Production Deployment

This directory contains everything needed to deploy the Agents system to PermaShip's production environment on AWS.

## Architecture

```
                    ┌──────────────────────────────────┐
                    │         ALB (HTTPS :443)          │
                    │    conductor-production           │
                    └──────┬───────────────┬────────────┘
                           │               │
              ┌────────────▼──┐   ┌────────▼──────────┐
              │  Priority 92-96│   │   Priority 100     │
              │  /v1/webhooks/ │   │   /v1/* (comms)    │
              │  /api/internal/│   │                    │
              └────────┬──────┘   └────────────────────┘
                       │
              ┌────────▼──────────┐
              │   ECS Fargate     │
              │   conductor-agents│
              │   (port 9000)     │
              └────────┬──────────┘
                       │
              ┌────────▼──────────┐
              │   RDS PostgreSQL   │
              │   agents database  │
              └───────────────────┘
```

- **Cluster:** `conductor-production` (ECS Fargate)
- **Service:** `conductor-agents` (1 task, 512 CPU / 1024 MB)
- **Image:** `permaship/agents:latest` in ECR
- **Secrets:** `conductor-production-agents-config` in AWS Secrets Manager
- **Logs:** `/ecs/conductor-production/agents` in CloudWatch (30-day retention)
- **ALB routing:** Specific path rules forward to agents; everything else goes to comms

## Files

| File | Purpose |
|------|---------|
| `deploy-aws.sh` | Full deployment script — builds image, pushes to ECR, registers task definition, updates ECS service, configures ALB rules |
| `pre-deploy-check.sh` | Pre-deploy validation — checks config compat, adapter loading, typecheck, tests, Docker build, migration safety, and AWS secrets |
| `rollback.sh` | Instant rollback — points the ECS service at a previous task definition revision |
| `rollback-migration-0013.sql` | Database rollback for the `permaship_tickets` → `tickets` rename (migration 0013) |
| `Dockerfile.agents` | Production Dockerfile with git and CA certificates (used by `deploy-aws.sh`) |
| `infra/` | Terraform modules for compute, database, DNS, networking, and secrets |
| `seed-knowledge.ts` | One-time script to populate the knowledge base with PermaShip project descriptions |

## Deploying

### Prerequisites

- AWS CLI configured with access to account `748560966555` (permaship-admin)
- Docker installed and running
- Credentials in `../../claude-conductor/.env` or local `.env` (the script auto-detects)

### Standard Deployment

```bash
cd deploy/permaship

# 1. Run pre-deploy checks
./pre-deploy-check.sh

# 2. Deploy
./deploy-aws.sh

# 3. Watch logs
aws logs tail /ecs/conductor-production/agents --follow
```

The deploy script handles everything: ECR login, Docker build, image push, task definition registration, and ECS service update with a forced new deployment. ECS performs a rolling update — the old task stays running until the new one passes health checks.

### Pre-Deploy Checks

Always run this before deploying, especially after code changes:

```bash
./pre-deploy-check.sh
```

What it validates:

| Check | What It Catches |
|-------|----------------|
| Config backward compat | New config.ts still loads with the existing `PERMASHIP_*` env vars in production |
| Adapter loader | `ADAPTER_PROFILE=permaship` correctly initializes all 8 adapters |
| TypeScript | Compilation errors |
| Tests | Regressions (295 tests across 33 files) |
| Docker build | Missing files, broken Dockerfile, startup crash |
| Container health | The `/health` endpoint responds 200 within 15 seconds |
| Migration safety | Checks that pending migrations don't contain destructive operations |
| AWS Secrets | All required keys exist in Secrets Manager; warns if `ADAPTER_PROFILE` is missing |

Flags:
- `--skip-docker` — Skip Docker build and health check (faster, good for CI or quick iteration)
- `--skip-aws` — Skip AWS Secrets Manager check (when you don't have credentials available)

### Rollback

If the new deployment breaks, roll back instantly:

```bash
# Roll back to the previous task definition revision
./rollback.sh

# Or roll back to a specific revision number
./rollback.sh 42
```

This does NOT rebuild anything. It tells ECS to use a previous task definition revision — the old Docker image is already in ECR. The switch takes about 30-60 seconds.

Useful commands:

```bash
# List recent revisions (shows which one is currently running)
./rollback.sh --list

# Show live deployment status (running count, pending, rollout state)
./rollback.sh --status
```

### Database Rollback (Migration 0013)

Migration 0013 renames the `permaship_tickets` table to `tickets`. This is a non-destructive rename (no data loss), but if it causes issues:

```bash
# 1. Roll back the app first
./rollback.sh

# 2. Reverse the migration
psql "$DATABASE_URL" -f rollback-migration-0013.sql

# 3. Remove the migration journal entry so Drizzle doesn't think it's applied
psql "$DATABASE_URL" -c "DELETE FROM \"__drizzle_migrations\" WHERE hash = (SELECT hash FROM \"__drizzle_migrations\" ORDER BY created_at DESC LIMIT 1);"
```

## Environment Variables

The ECS task definition injects secrets from AWS Secrets Manager and sets environment variables directly.

### Hardcoded in Task Definition

| Variable | Value | Notes |
|----------|-------|-------|
| `NODE_ENV` | `production` | Enables production behavior (SSL, fast-path execution) |
| `ADAPTER_PROFILE` | `permaship` | Loads the PermaShip adapter set instead of defaults |

### From Secrets Manager (`conductor-production-agents-config`)

| Secret Key | Purpose |
|------------|---------|
| `DATABASE_URL` | PostgreSQL connection string (RDS `agents` database) |
| `GEMINI_API_KEY` | Google Gemini API key for LLM inference |
| `PERMASHIP_API_KEY` | API key for PermaShip Control API |
| `PERMASHIP_API_URL` | PermaShip Control base URL (`https://control.permaship.ai`) |
| `PERMASHIP_ORG_ID` | UUID of the PermaShip organization |
| `PERMASHIP_INTERNAL_SECRET` | Shared secret for internal API authentication |
| `COMMS_API_URL` | Comms gateway URL (`https://control.permaship.ai`) |
| `COMMS_SIGNING_SECRET` | HMAC secret for webhook signature verification |
| `CONDUCTOR_BOT_SECRET` | Legacy name for comms signing secret (backward compat) |
| `COMMS_AGENT_API_KEY` | API key for agent-to-comms communication |

The core config uses fallback preprocessors so these existing secret names continue to work without changes. For example, `INTERNAL_SECRET` falls back to `PERMASHIP_INTERNAL_SECRET`, and `WEBHOOK_SIGNING_SECRET` falls back to `COMMS_SIGNING_SECRET`.

## ALB Routing Rules

The ALB listener on port 443 uses path-based rules to route traffic. Agent-specific routes have higher priority than the general comms routes:

| Priority | Path | Target |
|----------|------|--------|
| 92 | `/api/internal/chat/*` | Agents (admin dashboard chat API) |
| 93 | `/api/internal/trigger-nexus` | Agents |
| 94 | `/api/internal/trigger-idle` | Agents |
| 95 | `/v1/webhooks/comms` | Agents (inbound message webhook) |
| 96 | `/api/internal/link-workspace` | Agents |
| 100 | `/v1/*` | Comms (default) |

## Infrastructure (Terraform)

The `infra/` directory contains Terraform modules for provisioning the underlying AWS resources:

| Module | Resources |
|--------|-----------|
| `compute/` | ECS cluster, task definitions, services |
| `database/` | RDS PostgreSQL instance |
| `dns/` | Route 53 records |
| `networking/` | VPC, subnets, security groups |
| `secrets/` | Secrets Manager secrets |

Production config is in `infra/environments/production/`.

## Monitoring

```bash
# Tail live logs
aws logs tail /ecs/conductor-production/agents --follow

# Check service health
aws ecs describe-services --cluster conductor-production --services conductor-agents \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'

# Check recent deployments
aws ecs describe-services --cluster conductor-production --services conductor-agents \
  --query 'services[0].deployments[*].{Status:status,Running:runningCount,Rollout:rolloutState}'

# Health check
curl https://control.permaship.ai/api/internal/health
```

## Troubleshooting

### Container fails to start
Check CloudWatch logs for the startup error:
```bash
aws logs tail /ecs/conductor-production/agents --follow --since 5m
```

Common causes:
- Missing secret in Secrets Manager (config validation fails on startup)
- Database unreachable (check security group rules allow traffic from Fargate subnet to RDS)
- Migration failure (check for lock contention or schema conflicts)

### Health check fails but container is running
The `/health` endpoint returns 200 when Fastify is listening. If the health check fails:
- The server might not have started yet (increase ALB health check start period)
- Port 9000 might not be exposed (check task definition `portMappings`)

### Webhook messages not arriving
- Verify ALB rule for `/v1/webhooks/comms` routes to the agents target group (not comms)
- Check HMAC verification — the signing secret must match between comms and agents
- Look for `401 Invalid signature` in logs

### Agents receive messages (eyes reaction) but never respond
This means the webhook is reaching agents and the bot processed the message far enough to add a reaction, but the agent execution failed. Check logs for errors after `"Received inbound webhook from Comms"`. Common causes:
- Database schema mismatch — a Drizzle schema change references a table/column that doesn't exist yet (migration didn't run)
- LLM API error — Gemini API key expired or rate limited
- Adapter initialization failure — check for `ADAPTER_PROFILE` being set correctly

### Rollback didn't help
If rolling back to a previous task definition doesn't fix the issue, the problem is likely in the database (a migration changed the schema). Use the migration rollback SQL and delete the Drizzle journal entry as described above.

## Adding Database Migrations

Drizzle uses a journal file (`src/db/migrations/meta/_journal.json`) to track which migrations exist. **A SQL file alone is not enough** — if it's not registered in the journal, it will never run.

When adding a new migration:

1. Create the SQL file in `src/db/migrations/` (e.g., `0014_my_change.sql`)
2. Add an entry to `src/db/migrations/meta/_journal.json`:
   ```json
   {
     "idx": 14,
     "version": "6",
     "when": 1773790800000,
     "tag": "0014_my_change",
     "breakpoints": true
   }
   ```
3. Run `./pre-deploy-check.sh` — it will catch orphaned SQL files that aren't in the journal

Alternatively, use `npm run db:generate` to let Drizzle generate both the SQL and journal entry automatically from schema changes. Manual SQL files are only needed for operations Drizzle can't generate (renames, data backfills, etc.).
