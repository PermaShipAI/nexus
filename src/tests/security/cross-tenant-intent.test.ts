import '../env.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyAdminRole } from '../../middleware/rbac/admin.js';

// env.ts sets:
//   DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000000'
//   INTERNAL_SECRET = '0123456789abcdef...' (used as API key by admin.ts)
// These are used by admin.ts via process.env at module load time via
//   const ORG_ID = process.env['DEFAULT_ORG_ID'] ?? process.env['PERMASHIP_ORG_ID'] ?? '';
//   const API_KEY = process.env['INTERNAL_SECRET'] ?? process.env['PERMASHIP_API_KEY'] ?? '';

describe('Security: Cross-Tenant Intent Isolation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // CT-001: RBAC URL contains DEFAULT_ORG_ID env var (not hardcoded)
  // ---------------------------------------------------------------------------
  it('CT-001: RBAC fetch URL contains the DEFAULT_ORG_ID env var value', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'owner' }),
    } as Response);

    await verifyAdminRole('user-ct-1');

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain(process.env['DEFAULT_ORG_ID']);
    expect(calledUrl).toContain('00000000-0000-0000-0000-000000000000');
  });

  // ---------------------------------------------------------------------------
  // CT-002: URL is unchanged when message content contains a foreign UUID
  //
  // The RBAC URL is constructed from the DEFAULT_ORG_ID env var at module
  // load time. A foreign UUID present in a Discord message cannot influence
  // which org segment is used in the RBAC API call.
  // ---------------------------------------------------------------------------
  it('CT-002: RBAC URL is unchanged when a foreign org UUID appears in the userId argument', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'member' }),
    } as Response);

    // An attacker passes a userId that embeds a different org UUID. The RBAC
    // URL's org segment must still be DEFAULT_ORG_ID from env — not the
    // foreign UUID injected via the userId parameter.
    const foreignOrgId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await verifyAdminRole(`${foreignOrgId}/../../admin`);

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;

    // The org segment of the URL comes from the env var, not from the userId
    expect(calledUrl).toContain(process.env['DEFAULT_ORG_ID']);

    // The URL must not contain the foreign org UUID in the org segment position
    // (it may appear in the userId segment as a literal string, which is harmless
    // since it's passed to the remote API, not parsed locally)
    const orgSegmentMatch = calledUrl.match(/\/api\/orgs\/([^/]+)\//);
    expect(orgSegmentMatch).not.toBeNull();
    expect(orgSegmentMatch![1]).toBe(process.env['DEFAULT_ORG_ID']);
  });

  // ---------------------------------------------------------------------------
  // CT-003: Authorization header uses INTERNAL_SECRET env var
  // ---------------------------------------------------------------------------
  it('CT-003: Authorization header uses the INTERNAL_SECRET env var value', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'owner' }),
    } as Response);

    await verifyAdminRole('user-ct-3');

    const calledInit = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const authHeader = (calledInit.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe(`Bearer ${process.env['INTERNAL_SECRET']}`);
    expect(authHeader).toBe('Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  // ---------------------------------------------------------------------------
  // CT-004: Positive control — returns true for owner role
  // ---------------------------------------------------------------------------
  it('CT-004: returns true for owner role (positive control)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'owner' }),
    } as Response);

    expect(await verifyAdminRole('user-owner')).toBe(true);
  });
});
