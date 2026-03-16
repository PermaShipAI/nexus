#!/usr/bin/env bash
# ============================================================================
# pre-deploy-check.sh — Validate the OSS changes won't break production
#
# Run this BEFORE deploying. It checks every known risk surface:
#   1. Config loads with existing env vars (backward compat)
#   2. PermaShip adapter profile initializes
#   3. TypeScript compiles
#   4. Tests pass
#   5. Docker image builds
#   6. Container starts and /health responds
#   7. Database migration is safe (dry-run parse)
#   8. Secrets Manager has all required keys
#
# Usage:
#   ./pre-deploy-check.sh              # Run all checks
#   ./pre-deploy-check.sh --skip-aws   # Skip AWS/secrets checks
#   ./pre-deploy-check.sh --skip-docker # Skip Docker build/run
# ============================================================================
set -euo pipefail

SKIP_AWS=false
SKIP_DOCKER=false
for arg in "$@"; do
  case $arg in
    --skip-aws) SKIP_AWS=true ;;
    --skip-docker) SKIP_DOCKER=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${YELLOW}SKIP${NC} $*"; }
info() { echo -e "${BLUE}──${NC} $*"; }

cd "$(dirname "$0")/../.."  # Navigate to project root

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE} Pre-Deploy Validation for Agents (OSS branch)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# 1. Config backward compatibility
# ═══════════════════════════════════════════════════════════════════════════
info "Config backward compatibility"

# The production environment has these env vars. Verify config.ts loads
# without error when they're present (the fallback preprocessors must work).
TMPFILE=".pre-deploy-config-check.ts"
cat > "$TMPFILE" <<'TSEOF'
import { config } from './src/config.js';
const checks: string[] = [];
if (!config.DATABASE_URL) checks.push('DATABASE_URL missing');
if (!config.WEBHOOK_SIGNING_SECRET) checks.push('WEBHOOK_SIGNING_SECRET missing (should fallback from COMMS_SIGNING_SECRET)');
if (!config.INTERNAL_SECRET) checks.push('INTERNAL_SECRET missing (should fallback from PERMASHIP_INTERNAL_SECRET)');
if (!config.ACTIVATION_URL) checks.push('ACTIVATION_URL missing (should fallback from PERMASHIP_API_URL)');
if (checks.length > 0) { console.error(checks.join('; ')); process.exit(1); }
console.log('OK');
TSEOF

ENV_TEST=$(DATABASE_URL="postgresql://x:x@localhost/x" \
  GEMINI_API_KEY="test-key" \
  PERMASHIP_API_KEY="test-key" \
  PERMASHIP_API_URL="https://control.permaship.ai" \
  PERMASHIP_ORG_ID="00000000-0000-0000-0000-000000000000" \
  PERMASHIP_INTERNAL_SECRET="abc123" \
  COMMS_API_URL="https://comms.permaship.ai" \
  COMMS_SIGNING_SECRET="secret" \
  NODE_ENV="production" \
  npx tsx "$TMPFILE" 2>&1) || true
rm -f "$TMPFILE"

if [[ "$ENV_TEST" == *"OK"* ]]; then
  pass "Config loads with existing production env vars"
else
  fail "Config fails with production env vars: ${ENV_TEST}"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2. Adapter profile loads
# ═══════════════════════════════════════════════════════════════════════════
info "Adapter loader"

TMPFILE2=".pre-deploy-adapter-check.ts"
cat > "$TMPFILE2" <<'TSEOF'
import { loadAdapters } from './src/adapters/loader.js';
import { getLLMProvider, getCommunicationAdapter, getProjectRegistry } from './src/adapters/registry.js';
(async () => {
  await loadAdapters();
  const llm = getLLMProvider();
  const comms = getCommunicationAdapter();
  const registry = getProjectRegistry();
  if (!llm || !comms || !registry) { console.error('Adapters not initialized'); process.exit(1); }
  console.log('OK');
})();
TSEOF

ADAPTER_TEST=$(DATABASE_URL="postgresql://x:x@localhost/x" \
  GEMINI_API_KEY="test-key" \
  PERMASHIP_API_KEY="test-key" \
  PERMASHIP_API_URL="https://control.permaship.ai" \
  PERMASHIP_ORG_ID="00000000-0000-0000-0000-000000000000" \
  COMMS_API_URL="https://comms.permaship.ai" \
  COMMS_SIGNING_SECRET="secret" \
  ADAPTER_PROFILE="permaship" \
  NODE_ENV="production" \
  npx tsx "$TMPFILE2" 2>&1) || true
rm -f "$TMPFILE2"

if [[ "$ADAPTER_TEST" == *"OK"* ]]; then
  pass "PermaShip adapter profile loads successfully"
else
  fail "PermaShip adapter profile failed: ${ADAPTER_TEST}"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 3. TypeScript compiles
# ═══════════════════════════════════════════════════════════════════════════
info "TypeScript compilation"

if npx tsc --noEmit 2>&1; then
  pass "TypeScript typecheck passes"
else
  fail "TypeScript typecheck fails"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. Tests pass
# ═══════════════════════════════════════════════════════════════════════════
info "Test suite"

TEST_OUTPUT=$(npx vitest run 2>&1 | tail -5)
if echo "$TEST_OUTPUT" | grep -q "passed"; then
  TESTS_PASSED=$(echo "$TEST_OUTPUT" | grep -oP '\d+ passed' | head -1)
  pass "Tests: ${TESTS_PASSED}"
else
  fail "Test suite has failures"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 5. Docker build
# ═══════════════════════════════════════════════════════════════════════════
info "Docker image"

if [[ "$SKIP_DOCKER" == true ]]; then
  skip "Docker build (--skip-docker)"
else
  if docker build -t agents-pre-deploy-check -f deploy/permaship/Dockerfile.agents . 2>&1 | tail -3; then
    pass "Docker image builds successfully"

    # 6. Container health check
    info "Container health check"
    CONTAINER_ID=$(docker run -d --rm \
      -e DATABASE_URL="postgresql://x:x@localhost/x" \
      -e GEMINI_API_KEY="test" \
      -e PERMASHIP_API_KEY="test" \
      -e PERMASHIP_API_URL="https://control.permaship.ai" \
      -e PERMASHIP_ORG_ID="00000000-0000-0000-0000-000000000000" \
      -e COMMS_API_URL="https://comms.permaship.ai" \
      -e COMMS_SIGNING_SECRET="secret" \
      -e ADAPTER_PROFILE="permaship" \
      -e NODE_ENV="production" \
      -p 19000:9000 \
      agents-pre-deploy-check 2>/dev/null) || true

    if [[ -n "$CONTAINER_ID" ]]; then
      # Wait for startup (max 15 seconds)
      HEALTH_OK=false
      for i in {1..15}; do
        if curl -sf http://localhost:19000/health >/dev/null 2>&1; then
          HEALTH_OK=true
          break
        fi
        sleep 1
      done

      docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true

      if $HEALTH_OK; then
        pass "Container /health responds 200"
      else
        fail "Container /health did not respond within 15s"
        # Show container logs for debugging
        echo "  Container logs (last 20 lines):"
        docker logs "$CONTAINER_ID" 2>&1 | tail -20 | sed 's/^/    /'
      fi
    else
      fail "Container failed to start"
    fi
  else
    fail "Docker build failed"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 7. Migration safety
# ═══════════════════════════════════════════════════════════════════════════
info "Migration safety"

MIGRATION_DIR="src/db/migrations"
JOURNAL_FILE="${MIGRATION_DIR}/meta/_journal.json"

# 7a. Check for orphaned SQL files not registered in the journal.
#     This catches the exact bug that broke rev 61: a migration file
#     exists but Drizzle doesn't know about it, so it never runs.
if [[ -f "$JOURNAL_FILE" ]]; then
  JOURNAL_TAGS=$(python3 -c "import json; j=json.load(open('${JOURNAL_FILE}')); [print(e['tag']) for e in j['entries']]" 2>/dev/null)
  ORPHANS=""
  for sql_file in "${MIGRATION_DIR}"/*.sql; do
    [[ -f "$sql_file" ]] || continue
    TAG=$(basename "$sql_file" .sql)
    if ! echo "$JOURNAL_TAGS" | grep -qx "$TAG"; then
      ORPHANS="${ORPHANS}  ${TAG}.sql\n"
    fi
  done

  if [[ -n "$ORPHANS" ]]; then
    fail "Migration files exist but are NOT in _journal.json (they will never run!):"
    echo -e "$ORPHANS" | sed 's/^/    /'
  else
    pass "All migration SQL files are registered in _journal.json"
  fi
else
  fail "Migration journal not found at ${JOURNAL_FILE}"
fi

# 7b. Check for destructive operations in any migration file.
DESTRUCTIVE=$(grep -rli "DROP TABLE\|DROP COLUMN\|TRUNCATE" "${MIGRATION_DIR}"/*.sql 2>/dev/null || true)
if [[ -n "$DESTRUCTIVE" ]]; then
  fail "Migration files contain destructive operations (DROP/TRUNCATE):"
  echo "$DESTRUCTIVE" | sed 's/^/    /'
else
  pass "No destructive operations in migration files"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 8. AWS Secrets
# ═══════════════════════════════════════════════════════════════════════════
info "AWS Secrets Manager"

if [[ "$SKIP_AWS" == true ]]; then
  skip "AWS Secrets check (--skip-aws)"
else
  # Load credentials
  if [[ -f ../../claude-conductor/.env ]]; then
    export AWS_ACCESS_KEY_ID=$(grep AWS_ACCESS_KEY ../../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    export AWS_SECRET_ACCESS_KEY=$(grep AWS_SECRET_KEY ../../claude-conductor/.env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    export AWS_DEFAULT_REGION="us-east-1"
  fi

  if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
    skip "AWS Secrets check (no credentials)"
  else
    SECRET_NAME="conductor-production-agents-config"
    SECRETS_JSON=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query 'SecretString' --output text 2>/dev/null || echo "{}")

    REQUIRED_KEYS=("DATABASE_URL" "GEMINI_API_KEY" "PERMASHIP_API_KEY" "PERMASHIP_API_URL" "PERMASHIP_ORG_ID" "COMMS_API_URL" "COMMS_SIGNING_SECRET")
    ALL_PRESENT=true
    for key in "${REQUIRED_KEYS[@]}"; do
      if echo "$SECRETS_JSON" | jq -e --arg k "$key" '.[$k] // empty' >/dev/null 2>&1; then
        : # present
      else
        fail "Secret key missing: ${key}"
        ALL_PRESENT=false
      fi
    done

    if $ALL_PRESENT; then
      pass "All required secret keys present in Secrets Manager"
    fi

    # Check if ADAPTER_PROFILE needs to be added
    if echo "$SECRETS_JSON" | jq -e '.ADAPTER_PROFILE // empty' >/dev/null 2>&1; then
      pass "ADAPTER_PROFILE is set in secrets"
    else
      echo -e "  ${YELLOW}WARN${NC} ADAPTER_PROFILE not set in secrets — will default to 'default' profile"
      echo -e "       You must add ADAPTER_PROFILE=permaship to the secrets or task definition env vars"
      WARN=$((WARN + 1))
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
TOTAL=$((PASS + FAIL))
echo -e " Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${WARN} warnings${NC} (${TOTAL} checks)"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Pre-deploy checks failed. DO NOT DEPLOY until all failures are resolved.${NC}" >&2
  exit 1
fi

if [[ $WARN -gt 0 ]]; then
  echo -e "  ${YELLOW}Pre-deploy checks passed with warnings. Review warnings before deploying.${NC}"
  exit 0
fi

echo -e "  ${GREEN}All pre-deploy checks passed. Safe to deploy.${NC}"
