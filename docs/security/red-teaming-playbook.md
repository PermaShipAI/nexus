# Security Red Teaming Playbook
## PermaShip Discord Agent System

**Document Version:** 1.0.0
**Date:** 2026-03-08
**Classification:** Internal — Security Sensitive

---

## 1. Overview

This playbook defines the red teaming methodology for the PermaShip Discord Agent System. It provides structured attack scenarios, test coverage expectations, and a register of known security findings discovered through prior exercises. The playbook is intended to be executed by the security team and reviewed alongside the [Intent Recognition Threat Model](./intent-recognition-threat-model.md).

### 1.1 Scope

- Context window exhaustion and adversarial input resilience (`agents/router/index.ts`, `src/gemini/client.ts`)
- Identity state and role fuzzing for RBAC enforcement (`src/middleware/rbac/admin.ts`)
- Cross-tenant intent isolation and RBAC URL construction (`src/middleware/rbac/admin.ts`)
- Confirmation gate identity binding (`src/services/intent/confirmation-handler.ts`, `src/services/intent/confirmation.ts`)

### 1.2 Objectives

1. Verify that adversarial or malformed inputs to the routing pipeline resolve without crashing.
2. Confirm that RBAC enforcement fails closed for all non-admin and invalid roles.
3. Ensure that RBAC API calls are scoped to the correct org ID via environment variable — never hardcoded.
4. Document and track known insecure behaviors with remediation owners.

---

## 2. Attack Section 1 — Context Exhaustion and Adversarial Input

### 2.1 Description

An attacker floods the routing pipeline with an extremely long message or a prompt-injection payload designed to overflow context limits, produce unexpected LLM output, or crash the router. The goal is to either cause a thrown exception that surfaces to the caller, or to produce a response that bypasses Zod schema validation.

### 2.2 Attack Scenarios

| ID | Scenario | Expected Behavior |
|---|---|---|
| CE-001 | Message of ≥5000 characters (long repeated pattern) | Router resolves without throwing; returns fallback or valid RouteResult |
| CE-002 | Prompt injection payload (e.g., "Ignore all previous instructions…") | Router resolves without throwing; Zod validation catches malformed output |
| CE-003 | LLM returns out-of-enum intent value | `IntentResponseSchema.safeParse` fails; router returns parse-error fallback |
| CE-004 | LLM returns `confidenceScore > 1.0` | `IntentResponseSchema.safeParse` fails; router returns parse-error fallback |
| CE-005 | LLM returns `confidenceScore < 0.0` | `IntentResponseSchema.safeParse` fails; router returns parse-error fallback |

### 2.3 Test File

`src/tests/security/context-exhaustion.test.ts`

### 2.4 Pass Criteria

- All five scenarios resolve (do not throw).
- CE-003, CE-004, and CE-005 return a fallback result (isFallback: true).

---

## 3. Attack Section 2 — Identity State Fuzzing

### 3.1 Description

An attacker presents a user identity with an unusual or fabricated role value — either a role name outside the accepted `owner` / `admin` set, or a null/undefined role — to attempt bypassing RBAC. Additionally, this section covers confirmation gate identity binding: verifying that the userId stored at confirmation creation time is correctly scoped and that a mismatched userId on confirmation does not succeed.

### 3.2 Attack Scenarios

| ID | Scenario | Expected Behavior |
|---|---|---|
| IS-001 | `verifyAdminRole` called with role `'pending'` in API response | Returns `false` |
| IS-002 | `verifyAdminRole` called with role `'shadow'` in API response | Returns `false` |
| IS-003 | `verifyAdminRole` called with role `'unverified'` in API response | Returns `false` |
| IS-004 | `verifyAdminRole` called with `null` role in API response | Returns `false` |
| IS-005 | `createPendingConfirmation` stores the correct userId | Store entry userId matches the userId passed at creation |
| IS-006 (PF-001) | `handleConfirm` with mismatched userId | Documents current behavior: handler does not check userId — see Known Findings |

### 3.3 Test File

`src/tests/security/identity-state-fuzzing.test.ts`

### 3.4 Pass Criteria

- IS-001 through IS-004: `verifyAdminRole` returns `false` for all non-standard roles.
- IS-005: Store correctly binds userId at creation.
- IS-006: Test documents current behavior with a TODO comment pointing to the remediation tracked under PF-001.

---

## 4. Attack Section 3 — Cross-Tenant Intent Isolation

### 4.1 Description

An attacker in a multi-tenant environment attempts to trigger RBAC verification against a different organization's endpoint, or injects a foreign organization UUID into a message in hopes of redirecting the RBAC API call. This section also verifies that secrets are read from environment variables and not hardcoded.

### 4.2 Attack Scenarios

| ID | Scenario | Expected Behavior |
|---|---|---|
| CT-001 | RBAC fetch URL construction | URL contains `PERMASHIP_ORG_ID` env var value — not a hardcoded string |
| CT-002 | Message content contains a foreign UUID | RBAC URL is unchanged; foreign UUID in message does not alter the org segment of the URL |
| CT-003 | Authorization header construction | `Authorization` header uses `PERMASHIP_API_KEY` env var — not hardcoded |
| CT-004 | Positive control — owner role | `verifyAdminRole` returns `true` for `role: 'owner'` |

### 4.3 Test File

`src/tests/security/cross-tenant-intent.test.ts`

### 4.4 Pass Criteria

- CT-001 and CT-002: Confirm URL org segment is `PERMASHIP_ORG_ID` and not mutated by message content.
- CT-003: Confirm `Authorization` header contains `Bearer <PERMASHIP_API_KEY>`.
- CT-004: Positive control passes.

---

## 5. Definition of Done

The following checklist must be satisfied before marking a red teaming exercise as complete:

- [ ] All tests in `src/tests/security/context-exhaustion.test.ts` pass (`npx vitest run src/tests/security/context-exhaustion.test.ts`)
- [ ] All tests in `src/tests/security/identity-state-fuzzing.test.ts` pass (`npx vitest run src/tests/security/identity-state-fuzzing.test.ts`)
- [ ] All tests in `src/tests/security/cross-tenant-intent.test.ts` pass (`npx vitest run src/tests/security/cross-tenant-intent.test.ts`)
- [ ] `npx tsc --noEmit` exits with zero errors
- [ ] All Known Findings with status `Open` have been reviewed and either remediated or accepted with a documented owner and deadline
- [ ] CISO has signed off on any accepted risks
- [ ] Change log entry added to Section 7 of this document

---

## 6. Known Findings Register

### PF-001 — `handleConfirm` Does Not Enforce userId Binding

| Field | Value |
|---|---|
| Finding ID | PF-001 |
| Date Discovered | 2026-03-08 |
| Severity | High |
| STRIDE Category | Spoofing, Elevation of Privilege |
| Status | Open |
| Component | `src/services/intent/confirmation-handler.ts` |
| Owner | Security Team |

**Description:**

The `handleConfirm` function (`src/services/intent/confirmation-handler.ts`) accepts a `confirmationId` and an executor callback but does not accept or validate a `userId` parameter against the `userId` stored in the `PendingConfirmation`. Any caller that obtains a valid `confirmationId` can execute the confirmation regardless of their identity.

The threat model document (`docs/security/intent-recognition-threat-model.md`, Section 3, Attack Vector 4) describes userId binding as a primary mitigation against confirmation hijacking. However, the current implementation of `handleConfirm` does not enforce this binding.

**Reproduction:**

1. Call `createPendingConfirmation` with `userId: 'admin-user'`.
2. Call `handleConfirm(confirmation.id, executor)` with no userId validation.
3. The executor fires regardless of the calling user's identity.

**Impact:**

An attacker who obtains a `confirmationId` (e.g., through channel observation) can execute the confirmed action without being the original requestor.

**Remediation:**

Add a `userId` parameter to `handleConfirm`. Before executing, validate that the provided `userId` matches `pending.userId`. On mismatch: do not delete the pending entry, log an `rbac_rejection` telemetry event, and return a rejection error.

**References:**

- Threat Model, Section 3, Attack Vector 4: Confirmation Hijacking
- Regression test: `src/tests/security/identity-state-fuzzing.test.ts`, test IS-006

---

## 7. Change Log

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0.0 | 2026-03-08 | Security Team | Initial playbook with three attack sections, DoD checklist, and PF-001 finding |
