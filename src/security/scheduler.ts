import { db } from '../db/index.js';
import { workspaceLinks, activityLog } from '../db/schema.js';
import { and, eq, desc } from 'drizzle-orm';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { executeAgent } from '../agents/executor.js';
import { getAgent } from '../agents/registry.js';
import { sendAgentMessage } from '../bot/formatter.js';
import { sendApprovalMessage } from '../bot/interactions.js';
import { storeMessage } from '../conversation/service.js';
import { logActivity } from '../idle/activity.js';
import { isAutonomousMode } from '../settings/service.js';

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

const WEEKLY_DIGEST_PROMPT = `Perform the weekly vulnerability and dependency triage for all registered project repositories.

Produce a **Weekly Tactical Security Digest** with all findings grouped by severity:

- **Critical**
- **High**
- **Medium**
- **Low**

For each **Critical** or **High** finding that is not yet tracked as a ticket, include a \`<ticket-proposal>\` block using the following format:

<ticket-proposal>
{"kind":"task","title":"Short title describing the security finding","description":"Detailed description of the vulnerability or dependency issue, affected component, and recommended remediation","project":"Security"}
</ticket-proposal>

Set priority to **high** for all Critical and High findings.

Be concise and actionable. Focus on new or changed findings since the last digest.`;

export function startSecurityDigestScheduler(): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    runDigestCheck().catch((err) => {
      logger.error({ err }, 'Security digest check sweep failed');
    });
  }, config.SECURITY_DIGEST_CHECK_INTERVAL_MS);

  logger.info(
    { checkIntervalMs: config.SECURITY_DIGEST_CHECK_INTERVAL_MS, digestIntervalMs: config.SECURITY_DIGEST_INTERVAL_MS },
    'Security digest scheduler started',
  );
}

export function stopSecurityDigestScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Security digest scheduler stopped');
  }
}

async function runDigestCheck(): Promise<void> {
  if (running) {
    logger.debug('Security digest check already running, skipping');
    return;
  }
  running = true;

  try {
    const links = await db.select().from(workspaceLinks);

    for (const link of links) {
      const channelId = link.internalChannelId || config.DISCORD_CHANNEL_ID;
      if (!channelId) continue;

      try {
        await checkOrgDigest(link.orgId, channelId);
      } catch (err) {
        logger.warn({ err, orgId: link.orgId }, 'Security digest check failed for org');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Security digest check failed');
  } finally {
    running = false;
  }
}

async function checkOrgDigest(orgId: string, channelId: string): Promise<void> {
  const [lastRun] = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.orgId, orgId),
        eq(activityLog.kind, 'security_digest'),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);

  if (lastRun && Date.now() - lastRun.createdAt.getTime() < config.SECURITY_DIGEST_INTERVAL_MS) {
    logger.debug(
      { event: 'security_digest.skipped', orgId, lastRunAt: lastRun.createdAt },
      'Security digest skipped — not yet due',
    );
    return;
  }

  await runDigest(orgId, channelId);
}

async function runDigest(orgId: string, channelId: string): Promise<void> {
  const agent = getAgent('ciso');
  if (!agent) {
    logger.warn({ orgId }, 'CISO agent not found in registry, skipping security digest');
    return;
  }

  const autonomous = await isAutonomousMode(orgId);

  logger.info({ orgId, channelId }, 'Running weekly security digest');

  const response = await executeAgent({
    orgId,
    agentId: 'ciso',
    channelId,
    userId: 'system',
    userName: 'Security Digest Scheduler',
    userMessage: WEEKLY_DIGEST_PROMPT,
    source: 'idle',
    needsCodeAccess: false,
    onActionQueued: async (actionId, description) => {
      if (!autonomous) {
        await sendApprovalMessage(channelId, agent.title, actionId, description);
      }
    },
  });

  if (response) {
    await sendAgentMessage(channelId, agent.title, response, orgId);

    await storeMessage({
      orgId,
      channelId,
      discordMessageId: `security-digest-${Date.now()}`,
      authorId: 'agent',
      authorName: agent.title,
      content: response,
      isAgent: true,
      agentId: 'ciso',
    });

    await logActivity('security_digest', 'ciso', channelId, orgId, { responseLength: response.length });

    logger.info({ orgId, responseLength: response.length }, 'Security digest sent successfully');
  } else {
    logger.warn({ event: 'security_digest.no_response', orgId }, 'Security digest produced no response');
  }
}
