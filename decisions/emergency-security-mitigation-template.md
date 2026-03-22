# Emergency Security Mitigation — Decision Brief Template

**Applies to:** Any finding with CVSS score ≥ 8.0 (High / Critical severity)

**Required reviewers (MANDATORY before merge):**
- **CISO** — validates CVSS 8.0+ template logic and safety constraints
- **AgentOps** — validates prompt routing integration and pipeline safety

---

## Template

Use this template verbatim for all CVSS 8.0+ findings. Do **not** use the standard Decision Brief template for these cases. Fields marked **[REQUIRED]** must be completed; leaving them blank is a quality violation and will block ticket creation.

---

### 1. Finding Summary [REQUIRED]

- **CVE / Finding ID:**
- **CVSS Score and Vector:**
- **Affected component(s) / service(s):**
- **Exposure window:** (when was the vulnerability introduced or first observable?)
- **Reachability:** (is this exploitable from the internet / authenticated users only / internal only?)

---

### 2. Smallest Shippable Mitigation [REQUIRED]

**Mandate:** Propose the *smallest* change that closes or meaningfully reduces the attack surface. This is not the time for architectural rewrites. Prefer:
- WAF rules or rate-limit controls
- Feature flag / toggle to disable the vulnerable code path
- Input validation or output encoding patches
- Dependency version pin or upgrade (single package)
- Header hardening or TLS policy enforcement

**Prohibited in this brief:**
- Architectural rewrites spanning more than 2 subsystems
- Database schema migrations that require downtime
- Any change that cannot be rolled back within 15 minutes

**Proposed mitigation (describe exactly what will change):**

> _e.g., "Add WAF rule to block requests matching XSS payload pattern X on endpoint /api/v1/upload. No application code changes required."_

**Estimated lines / files changed:**

**Why this is the smallest viable slice:**

---

### 3. Two-Way Door Rollback Plan [REQUIRED]

All mitigations — including critical patches — MUST be reversible. There are no exceptions.

- **Rollback mechanism:** (feature flag off / WAF rule removal / git revert / config change)
- **Rollback time target:** Must be ≤ 15 minutes from decision to restored state
- **Who can execute rollback:** (any oncall engineer / CISO + oncall / human approval required)
- **Rollback trigger conditions:** (what observable signals indicate the fix is causing harm?)
- **Rollback test:** (how will we verify the rollback works before deploying the fix?)

> _If a rollback cannot be designed, escalate immediately to human engineering leadership. Do NOT proceed with the mitigation until a rollback path exists._

---

### 4. Proof of Closure — Testable Criteria [REQUIRED]

The vulnerability must be demonstrably closed. Define explicit, reproducible test steps:

**Reproduction steps (before fix):**
1.
2.
3.

**Expected result before fix:** _(exploit succeeds / malicious input accepted / unauthorized access granted)_

**Verification steps (after fix):**
1.
2.
3.

**Expected result after fix:** _(exploit blocked / input rejected / access denied with correct status code)_

**Automated test / CI gate:** (name of test file and test case, or explain why automation is not feasible)

> _"The vulnerability is closed" is not a testable criterion. A specific reproduction script, request payload, or scanner result is required._

---

### 5. Post-Deployment Exploit Telemetry [REQUIRED]

Monitoring must be in place before or simultaneously with the fix deployment. The system must be able to detect ongoing or renewed exploitation attempts.

**Telemetry signal(s) to add or confirm:**
- [ ] Log line / structured event emitted when the attack path is attempted post-fix
- [ ] Alert threshold defined (e.g., > 5 blocked attempts per minute → page oncall)
- [ ] Baseline established (what is normal traffic volume on this endpoint / path?)
- [ ] Dashboard or query to review exploit attempt frequency post-deployment

**Monitoring owner:** (SRE / CISO / AgentOps — who is watching the signal?)

**Review window:** (how long will active monitoring continue post-deployment? minimum 72 hours for CVSS ≥ 8.0)

---

### 6. Blast Radius Assessment [REQUIRED]

- **What breaks if this mitigation is wrong:** (list affected user flows, integrations, SLOs)
- **Tenant / data isolation risk:** (does this touch any cross-tenant boundary?)
- **Performance impact:** (latency, throughput, memory — estimated or measured)
- **Dependent services that need notification:** (list downstream consumers)

---

### 7. Dependencies and Prerequisites

- [ ] Secrets rotation required? (yes / no — if yes, must be coordinated with CISO)
- [ ] Downstream service changes required? (yes / no)
- [ ] Human approval required before deployment? (yes — mandatory for CVSS ≥ 9.0 / no)
- [ ] Change freeze or maintenance window required? (yes / no)

---

### 8. Required Sign-Offs [REQUIRED — DO NOT SKIP]

This section is a hard gate. Tickets created under this template cannot be marked approved or moved to `in_progress` until both sign-offs are recorded.

| Reviewer | Role | Sign-Off Scope | Status |
|---|---|---|---|
| **CISO** | Security validation | Confirms CVSS score is accurate, mitigation closes the attack path, testable criteria are complete, and telemetry plan is adequate | ☐ Pending |
| **AgentOps** | Prompt routing validation | Confirms this brief was generated via the emergency routing path, pipeline is configured for emergency ticket kind, and no safety gates were bypassed | ☐ Pending |

**Sign-off format (agents record inline):**
```
CISO Sign-Off: [approved / needs_changes] — [brief rationale, ≤ 2 sentences]
AgentOps Sign-Off: [approved / needs_changes] — [brief rationale, ≤ 2 sentences]
```

---

### 9. Fallback Plan [REQUIRED]

**Fallback:** If automated mitigation deployment fails or agents cannot validate the fix reliably, escalate immediately to a Human-in-the-Loop approval gate. Any CVSS 8.0+ finding that cannot be resolved via this template within 4 hours must be manually reviewed by an on-call human engineer. The vulnerable feature or endpoint must be disabled via feature flag until human review is complete.

---

## Usage Notes for Agents

- **Nexus:** When evaluating proposals for CVSS ≥ 8.0 findings, do NOT apply the standard Decision Brief template. Switch to this Emergency Mitigation template and enforce all [REQUIRED] fields before creating a ticket.
- **CISO:** When surfacing CVSS ≥ 8.0 findings, structure your proposal using this template. Your sign-off on the final brief is mandatory.
- **AgentOps:** Validate that the ticket was created via emergency routing (ticket kind = `security-emergency`) and that the pipeline includes a mandatory human approval step for CVSS ≥ 9.0 findings.
- **All agents:** Do not request exceptions to the Two-Way Door rollback requirement, even under time pressure. If a rollback cannot be designed, escalate to humans instead of bypassing this constraint.
