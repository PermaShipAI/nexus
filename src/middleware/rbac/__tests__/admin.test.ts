import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyAdminRole } from '../admin.js';
import { checkAgentCommandPermission } from '../index.js';
import { RbacRejectionError } from '../errors.js';

describe('verifyAdminRole', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for owner role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'owner' }),
    } as Response);
    expect(await verifyAdminRole('user-1')).toBe(true);
  });

  it('returns true for admin role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'admin' }),
    } as Response);
    expect(await verifyAdminRole('user-2')).toBe(true);
  });

  it('returns false for member role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'member' }),
    } as Response);
    expect(await verifyAdminRole('user-3')).toBe(false);
  });

  it('returns false when response is not ok (403)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    } as Response);
    expect(await verifyAdminRole('user-4')).toBe(false);
  });

  it('returns false when response is not ok (404)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not Found' }),
    } as Response);
    expect(await verifyAdminRole('user-5')).toBe(false);
  });

  it('returns false on network error (fail-closed)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));
    expect(await verifyAdminRole('user-6')).toBe(false);
  });

  it('returns false on AbortError (timeout)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );
    expect(await verifyAdminRole('user-7')).toBe(false);
  });

  it('returns false when role field is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'user-8' }),
    } as Response);
    expect(await verifyAdminRole('user-8')).toBe(false);
  });
});

describe('checkAgentCommandPermission', () => {
  it('throws RbacRejectionError when support agent attempts provision_user', () => {
    expect(() => checkAgentCommandPermission('support', 'provision_user')).toThrow(RbacRejectionError);
  });

  it('throws RbacRejectionError when support agent attempts delete_user', () => {
    expect(() => checkAgentCommandPermission('support', 'delete_user')).toThrow(RbacRejectionError);
  });

  it('throws RbacRejectionError when support agent attempts grant_role', () => {
    expect(() => checkAgentCommandPermission('support', 'grant_role')).toThrow(RbacRejectionError);
  });

  it('throws RbacRejectionError when support agent attempts approve-proposal', () => {
    expect(() => checkAgentCommandPermission('support', 'approve-proposal')).toThrow(RbacRejectionError);
  });

  it('throws RbacRejectionError when support agent attempts reject-proposal', () => {
    expect(() => checkAgentCommandPermission('support', 'reject-proposal')).toThrow(RbacRejectionError);
  });

  it('throws RbacRejectionError when support agent attempts approve-action', () => {
    expect(() => checkAgentCommandPermission('support', 'approve-action')).toThrow(RbacRejectionError);
  });

  it('does NOT throw when support agent uses create-task', () => {
    expect(() => checkAgentCommandPermission('support', 'create-task')).not.toThrow();
  });

  it('does NOT throw when support agent uses add-memory', () => {
    expect(() => checkAgentCommandPermission('support', 'add-memory')).not.toThrow();
  });

  it('does NOT throw when support agent uses query-knowledge', () => {
    expect(() => checkAgentCommandPermission('support', 'query-knowledge')).not.toThrow();
  });

  it('does NOT throw when support agent uses request-admin-action', () => {
    expect(() => checkAgentCommandPermission('support', 'request-admin-action')).not.toThrow();
  });

  it('does NOT throw when nexus agent uses approve-proposal', () => {
    expect(() => checkAgentCommandPermission('nexus', 'approve-proposal')).not.toThrow();
  });

  it('does NOT throw when nexus agent uses reject-proposal', () => {
    expect(() => checkAgentCommandPermission('nexus', 'reject-proposal')).not.toThrow();
  });

  it('does NOT throw when a non-support agent uses grant_role', () => {
    expect(() => checkAgentCommandPermission('ciso', 'grant_role')).not.toThrow();
  });
});
