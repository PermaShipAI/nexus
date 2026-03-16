import { checkPermission } from './checker';
import { ClassifiedIntent } from '../../agents/schemas/intent';
import { RequestContext } from './types';

const baseContext: RequestContext = {
  platformUserId: 'user123',
  platform: 'discord',
  channelType: 'private',
  messageId: 'msg001',
};

describe('checkPermission', () => {
  it('allows VIEWER to QueryKnowledge without linking', () => {
    const intent: ClassifiedIntent = { kind: 'QueryKnowledge', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: undefined });
    expect(result.allowed).toBe(true);
  });

  it('allows VIEWER role for SystemStatus', () => {
    const intent: ClassifiedIntent = { kind: 'SystemStatus', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'VIEWER' });
    expect(result.allowed).toBe(true);
  });

  it('blocks unlinked user from InvestigateBug', () => {
    const intent: ClassifiedIntent = { kind: 'InvestigateBug', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: undefined });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('AccountNotLinked');
  });

  it('blocks VIEWER from InvestigateBug', () => {
    const intent: ClassifiedIntent = { kind: 'InvestigateBug', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'VIEWER' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('InsufficientRole');
    expect(result.requiredRole).toBe('MEMBER');
  });

  it('allows MEMBER to InvestigateBug', () => {
    const intent: ClassifiedIntent = { kind: 'InvestigateBug', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'MEMBER' });
    expect(result.allowed).toBe(true);
  });

  it('allows MEMBER to ProposeTask', () => {
    const intent: ClassifiedIntent = { kind: 'ProposeTask', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'MEMBER' });
    expect(result.allowed).toBe(true);
  });

  it('blocks MEMBER from ManageProject', () => {
    const intent: ClassifiedIntent = { kind: 'ManageProject', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'MEMBER' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('InsufficientRole');
    expect(result.requiredRole).toBe('ADMIN');
  });

  it('allows ADMIN to ManageProject', () => {
    const intent: ClassifiedIntent = { kind: 'ManageProject', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'ADMIN' });
    expect(result.allowed).toBe(true);
  });

  it('blocks ADMIN from AccessSecrets', () => {
    const intent: ClassifiedIntent = { kind: 'AccessSecrets', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'ADMIN' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('InsufficientRole');
    expect(result.requiredRole).toBe('OWNER');
  });

  it('allows OWNER to AccessSecrets', () => {
    const intent: ClassifiedIntent = { kind: 'AccessSecrets', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'OWNER' });
    expect(result.allowed).toBe(true);
  });

  it('does not leak internal user IDs in rejection messages', () => {
    const intent: ClassifiedIntent = { kind: 'ManageProject', confidenceScore: 0.9, params: {} };
    const result = checkPermission(intent, { ...baseContext, role: 'MEMBER' });
    expect(result.userMessage).not.toMatch(/user123/);
    expect(result.userMessage).not.toMatch(/platformUserId/);
  });
});
