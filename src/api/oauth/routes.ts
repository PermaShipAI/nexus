import { FastifyPluginAsync } from 'fastify';
import { consumeLinkToken } from '../../auth/token_store.js';
import { linkAccount, unlinkAccount, getLinkStatus } from '../../auth/account_linker.js';
import { Role } from '../../rbac/types.js';
import featureFlags from '../../../config/feature_flags.json' with { type: 'json' };

const FEATURE_DISABLED_RESPONSE = { error: 'FeatureDisabled' };

interface LinkChatBody {
  platform: 'discord' | 'slack';
  platformUserId: string;
  linkToken: string;
}

interface UnlinkChatBody {
  platform: 'discord' | 'slack';
  platformUserId: string;
  requestingUserId: string;
  requestingRole: Role;
}

export const oauthRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/oauth/link-chat
  fastify.post<{ Body: LinkChatBody }>('/link-chat', async (request, reply) => {
    if (!featureFlags.ENABLE_ACCOUNT_LINKING) {
      return reply.status(503).send(FEATURE_DISABLED_RESPONSE);
    }

    const { platform, platformUserId, linkToken } = request.body;

    const tokenResult = consumeLinkToken(linkToken);
    if (!tokenResult) {
      return reply.status(401).send({ error: 'InvalidOrExpiredToken' });
    }

    const linkResult = linkAccount(platform, platformUserId, tokenResult.userId);

    if ('error' in linkResult && linkResult.error === 'AlreadyLinked') {
      return reply.status(409).send({
        error: 'AlreadyLinked',
        existingUserId: linkResult.existingUserId,
      });
    }

    return reply.status(200).send(linkResult);
  });

  // GET /api/oauth/link-status/:platform/:platformUserId
  fastify.get<{ Params: { platform: 'discord' | 'slack'; platformUserId: string } }>(
    '/link-status/:platform/:platformUserId',
    async (request, reply) => {
      if (!featureFlags.ENABLE_ACCOUNT_LINKING) {
        return reply.status(503).send(FEATURE_DISABLED_RESPONSE);
      }

      const { platform, platformUserId } = request.params;
      const status = getLinkStatus(platform, platformUserId);
      return reply.status(200).send(status);
    },
  );

  // DELETE /api/oauth/link-chat
  fastify.delete<{ Body: UnlinkChatBody }>('/link-chat', async (request, reply) => {
    if (!featureFlags.ENABLE_ACCOUNT_LINKING) {
      return reply.status(503).send(FEATURE_DISABLED_RESPONSE);
    }

    const { platform, platformUserId, requestingUserId, requestingRole } = request.body;
    const result = unlinkAccount(platform, platformUserId, requestingUserId, requestingRole);

    if ('error' in result) {
      if (result.error === 'Forbidden') {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      return reply.status(404).send({ error: 'NotFound' });
    }

    return reply.status(200).send(result);
  });
};
