# Security Policy

## CI Security Model for External Contributions

This repository is open to public contributions. To protect against malicious
pull requests (supply-chain attacks, secret exfiltration, compute abuse), the
CI pipeline enforces the following controls:

### 1. Read-Only `GITHUB_TOKEN`

All CI workflows run with `permissions: contents: read`. The token cannot push
to protected branches, create releases, or modify repository settings.

### 2. No Production Secrets in PR Builds

Pull-request CI jobs do **not** receive production API keys
(`LLM_API_KEY`, `DISCORD_BOT_TOKEN`, etc.). Tests run in `NODE_ENV=test` and
must mock all external dependencies. Eval jobs that require live API keys only
run on the default branch via scheduled pipelines.

### 3. Fork PR Approval Gate

Pull requests from external forks are **paused after DCO verification** and
require explicit approval from a repository maintainer via the
`pr-fork-approval` GitHub Environment before any compute runs.

Maintainers: approve or reject pending fork PR runs in
**Settings → Environments → pr-fork-approval**.

### 4. DCO Sign-Off Required

All commits must include a `Signed-off-by` trailer (Developer Certificate of
Origin). This check runs before any code-level CI and will block the pipeline
if absent.

```
git commit -s -m "feat: my change"
```

## Activating the Hardened CI Workflows

The reviewed workflow definitions live in `docs/ci-workflows/`. A repository
admin must copy them to `.github/workflows/` to activate them. See
[`docs/ci-workflows/README.md`](../docs/ci-workflows/README.md) for step-by-step
deployment instructions and required GitHub Settings configuration.

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities. Email the
maintainers directly or use GitHub's private vulnerability reporting feature
(Security → Report a vulnerability).
