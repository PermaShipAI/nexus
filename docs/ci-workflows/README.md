# CI Workflow Templates

These files are the **reviewed and approved** GitHub Actions workflow definitions
for securing the `agents` CI pipeline against malicious public PRs.

## Deployment Instructions

A repository admin with `workflow` scope must copy these files to activate them:

```bash
mkdir -p .github/workflows
cp docs/ci-workflows/ci.yml      .github/workflows/ci.yml
cp docs/ci-workflows/scorecard.yml .github/workflows/scorecard.yml
git add .github/workflows/
git commit -s -m "ci: activate hardened GitHub Actions workflows"
git push
```

## Required Repository Configuration

After deploying the workflow files, complete the following setup in
**GitHub → Settings**:

### 1. Fork PR Approval Environment

Navigate to **Settings → Environments → New environment** and create:

- **Name:** `pr-fork-approval`
- **Required reviewers:** Add your security/triage team (at least 1 reviewer)
- **Deployment branches:** Leave unrestricted (the workflow handles branch logic)

This causes GitHub to pause any fork PR's compute jobs and send a Slack/email
notification to reviewers before untrusted code runs in CI.

### 2. Actions Permissions for Fork PRs

Navigate to **Settings → Actions → General → Fork pull request workflows**:

- Select: **"Require approval for first-time contributors"** (minimum)
- Recommended: **"Require approval for all outside collaborators"**

This adds a second layer of protection independent of the workflow environment gate.

### 3. Branch Protection (main)

Navigate to **Settings → Branches → Add rule** for `main`:

- [x] Require status checks to pass: `DCO Sign-off`, `Lint & Type Check`, `Test`
- [x] Require branches to be up to date before merging
- [x] Restrict who can push to matching branches

## Security Controls Summary

| Control | Implementation |
|---|---|
| Read-only `GITHUB_TOKEN` | `permissions: contents: read` at workflow level |
| No production secrets in PR builds | `NODE_ENV=test` only; no `LLM_API_KEY` / `DISCORD_BOT_TOKEN` |
| Fork PR approval gate | `environment: pr-fork-approval` blocks compute until team approves |
| DCO sign-off required | `dco-org/enforce-dco@v1` runs before all downstream jobs |
| Supply-chain monitoring | OpenSSF Scorecard runs weekly, results in Security tab |
