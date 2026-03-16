import { checkChannelSafety } from './channel_safety';
import { ClassifiedIntent } from '../../agents/schemas/intent';
import { RequestContext } from '../rbac/types';

const baseContext: RequestContext = {
  platformUserId: 'user123',
  platform: 'discord',
  channelType: 'public',
  messageId: 'msg001',
};

describe('checkChannelSafety', () => {
  it('blocks ManageProject in public channels', () => {
    const intent: ClassifiedIntent = { kind: 'ManageProject', confidenceScore: 0.9, params: {} };
    const result = checkChannelSafety(intent, baseContext);
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.reason).toBe('PublicChannelRestriction');
  });

  it('blocks AccessSecrets in public channels', () => {
    const intent: ClassifiedIntent = { kind: 'AccessSecrets', confidenceScore: 0.9, params: {} };
    const result = checkChannelSafety(intent, baseContext);
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('allows QueryKnowledge in public channels', () => {
    const intent: ClassifiedIntent = { kind: 'QueryKnowledge', confidenceScore: 0.9, params: {} };
    const result = checkChannelSafety(intent, baseContext);
    expect(result).toBeNull();
  });

  it('blocks intents with deleteTarget param in public channels', () => {
    const intent: ClassifiedIntent = {
      kind: 'QueryKnowledge',
      confidenceScore: 0.9,
      params: { deleteTarget: 'staging' },
    };
    const result = checkChannelSafety(intent, baseContext);
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('blocks intents with secretName param in public channels', () => {
    const intent: ClassifiedIntent = {
      kind: 'QueryKnowledge',
      confidenceScore: 0.9,
      params: { secretName: 'DB_PASS' },
    };
    const result = checkChannelSafety(intent, baseContext);
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('allows ManageProject in private channels', () => {
    const intent: ClassifiedIntent = { kind: 'ManageProject', confidenceScore: 0.9, params: {} };
    const result = checkChannelSafety(intent, { ...baseContext, channelType: 'private' });
    expect(result).toBeNull();
  });

  it('allows ManageProject in DMs', () => {
    const intent: ClassifiedIntent = { kind: 'ManageProject', confidenceScore: 0.9, params: {} };
    const result = checkChannelSafety(intent, { ...baseContext, channelType: 'dm' });
    expect(result).toBeNull();
  });
});
