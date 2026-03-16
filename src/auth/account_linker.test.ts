import { linkAccount, unlinkAccount, getLinkStatus } from './account_linker';

describe('account_linker', () => {
  it('links an account successfully', () => {
    const result = linkAccount('discord', 'disc-user-001', 'perma-001');
    expect(result).toEqual({ linked: true, userId: 'perma-001' });
  });

  it('returns AlreadyLinked if platform user is already linked', () => {
    linkAccount('discord', 'disc-user-002', 'perma-002');
    const result = linkAccount('discord', 'disc-user-002', 'perma-003');
    expect(result).toMatchObject({ error: 'AlreadyLinked', existingUserId: 'perma-002' });
  });

  it('returns correct link status', () => {
    linkAccount('slack', 'slack-user-001', 'perma-010');
    const status = getLinkStatus('slack', 'slack-user-001');
    expect(status.linked).toBe(true);
    expect(status.userId).toBe('perma-010');
  });

  it('returns linked: false for unknown user', () => {
    const status = getLinkStatus('discord', 'nonexistent-user');
    expect(status.linked).toBe(false);
  });

  it('allows owner to unlink their own account', () => {
    linkAccount('discord', 'disc-user-003', 'perma-003');
    const result = unlinkAccount('discord', 'disc-user-003', 'perma-003', 'MEMBER');
    expect(result).toEqual({ unlinked: true });
  });

  it('allows ADMIN to unlink any account', () => {
    linkAccount('discord', 'disc-user-004', 'perma-004');
    const result = unlinkAccount('discord', 'disc-user-004', 'admin-user', 'ADMIN');
    expect(result).toEqual({ unlinked: true });
  });

  it('blocks unauthorized unlinking', () => {
    linkAccount('discord', 'disc-user-005', 'perma-005');
    const result = unlinkAccount('discord', 'disc-user-005', 'some-other-user', 'MEMBER');
    expect(result).toMatchObject({ error: 'Forbidden' });
  });
});
