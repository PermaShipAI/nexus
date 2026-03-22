# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email the maintainers at the contact listed in the repository or open a private security advisory via GitHub's [Security Advisories](https://docs.github.com/en/code-security/security-advisories) feature.
3. Include a description of the vulnerability, steps to reproduce, and potential impact.

We will acknowledge receipt within 48 hours and provide a remediation timeline.

---

## Public Release Checklist (Nexus DoD — Security Scrub)

This checklist must be completed and signed off by the CISO before the repository visibility is changed to **public**.

### 1. Commit History Scrub
- [x] Full commit history scanned with Gitleaks — **zero findings**
- [x] No hardcoded API keys, Discord tokens, or database credentials found in source tree
- [x] Test fixtures (`src/tests/env.ts`) contain only dummy placeholder values, not real credentials

### 2. Personas & ADR Review
- [x] All files in `personas/` audited — no proprietary internal URLs, IPs, or confidential infrastructure details
- [x] `decisions/` directory does not exist — no ADRs to audit
- [x] No vulnerability patterns or internal security findings exposed in agent persona definitions

### 3. GitHub Security Features
- [x] **Dependabot** configured (`.github/dependabot.yml`) — weekly npm dependency updates enabled
- [ ] **Gitleaks secret scanning** CI workflow — add `.github/workflows/secret-scan.yml` (requires `workflows` permission; see template below)
- [ ] **GitHub Secret Scanning** — enable in repository Settings → Security → Secret scanning (requires repo admin)
- [ ] **GitHub Push Protection** — enable in repository Settings → Security → Push protection (requires repo admin)
- [ ] **Dependabot security updates** — enable in repository Settings → Security → Dependabot (requires repo admin)

### 4. CISO Sign-Off

> **REQUIRED:** A member of the security team must review this checklist and provide written sign-off before repository visibility is changed to public.

| Step | Status | Reviewer | Date |
|------|--------|----------|------|
| Automated secret scan (Gitleaks) | Zero findings | — | — |
| Manual persona/ADR review | Clear | — | — |
| GitHub security features configured | Partial (Dependabot done; workflow + Settings require admin) | — | — |
| **CISO sign-off** | **PENDING** | — | — |

---

### Gitleaks Workflow Template

A repo admin with the `workflows` permission should create `.github/workflows/secret-scan.yml`:

```yaml
name: Secret Scan

on:
  push:
    branches: ["**"]
  pull_request:
    branches: ["**"]

jobs:
  gitleaks:
    name: Detect secrets with Gitleaks
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Fallback Plan

If history cannot be cleanly scrubbed without breaking the repository structure, squash all commits and release as a fresh public repository with no internal history.
