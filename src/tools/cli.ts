import 'dotenv/config';
import { loadAdapters } from '../adapters/loader.js';
import { initializeAgents } from '../agents/registry.js';

// Initialize adapters for standalone CLI execution
await loadAdapters();
await initializeAgents();

import { parseArgs } from 'node:util';
import { createTask, updateTaskStatus, listTasks } from '../tasks/service.js';
import { addSharedKnowledge, addAgentMemory, queryKnowledge } from '../knowledge/service.js';
import { getProjectRegistry, getTicketTracker } from '../adapters/registry.js';
import { db } from '../db/index.js';
import { pendingActions, tasks as tasksTable } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { setSecret } from '../secrets/service.js';
import { axonQuery, axonContext, axonImpact, axonDeadCode } from './axon.js';
import type { AgentId } from '../agents/types.js';
import { AGENT_IDS } from '../agents/types.js';
import { createTicketProposal } from './proposal-service.js';
import { getTenantResolver } from '../adapters/registry.js';
import { updateProjectSettings } from './update_project_settings.js';
import { queryDecisionLog } from './query_decision_log.js';
import { logWaitingForHumanFallback } from '../../agents/telemetry/logger.js';

const COMMANDS = [
  'create-task',
  'create-ticket',
  'add-knowledge',
  'add-memory',
  'query-knowledge',
  'update-task',
  'list-tasks',
  'list-projects',
  'approve-action',
  'approve-proposal',
  'reject-proposal',
  'set-secret',
  'browse',
  'status',
  'activate',
  'axon-query',
  'axon-context',
  'axon-impact',
  'axon-dead-code',
  'update-project-settings',
  'request-admin-action',
  'query-decision-log',
  'execute-agent',
] as const;


type Command = (typeof COMMANDS)[number];

function printResult(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printError(message: string): void {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function requireArg(args: Record<string, unknown>, name: string): string {
  const val = args[name];
  if (typeof val !== 'string' || val.length === 0) {
    printError(`Missing required argument: --${name}`);
  }
  return val as string;
}

function validateAgentId(id: string): AgentId {
  if (!AGENT_IDS.includes(id as AgentId)) {
    printError(`Invalid agent ID: ${id}. Valid: ${AGENT_IDS.join(', ')}`);
  }
  return id as AgentId;
}

function str(val: string | boolean | undefined): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

async function run(): Promise<void> {
  const command = process.argv[2] as Command | undefined;

  if (!command || !COMMANDS.includes(command)) {
    printError(`Usage: cli.ts <command> [options]\nCommands: ${COMMANDS.join(', ')}`);
    return;
  }

  const rawArgs = process.argv.slice(3);

  switch (command) {
    case 'activate': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          token: { type: 'string' },
          platform: { type: 'string' },
          workspace: { type: 'string' },
          user: { type: 'string' },
          channel: { type: 'string' },
        },
        strict: false,
      });
      const res = await getTenantResolver().activateWorkspace(
        requireArg(values, 'token'),
        requireArg(values, 'platform') as 'discord' | 'slack',
        requireArg(values, 'workspace'),
        requireArg(values, 'user'),
        requireArg(values, 'channel')
      );
      printResult(res);
      break;
    }

    case 'create-task': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });
      const task = await createTask({
        orgId: requireArg(values, 'org'),
        title: requireArg(values, 'title'),
        description: requireArg(values, 'description'),
        priority: (str(values.priority) as 'critical' | 'high' | 'medium' | 'low') ?? undefined,
        proposedByAgentId: str(values.agent) ? validateAgentId(str(values.agent)!) : undefined,
      });
      printResult({
        success: true,
        taskId: task.id,
        message: `Task "${task.title}" created with status "proposed". Awaiting human approval.`,
      });
      break;
    }

    case 'update-task': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          id: { type: 'string' },
          status: { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });
      const orgId = requireArg(values, 'org');
      const task = await updateTaskStatus(
        requireArg(values, 'id'),
        orgId,
        requireArg(values, 'status') as any,
        str(values.agent) ? validateAgentId(str(values.agent)!) : undefined,
      );
      printResult({ success: !!task, task });
      break;
    }

    case 'list-tasks': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          status: { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });
      const tasks = await listTasks({
        orgId: requireArg(values, 'org'),
        status: str(values.status) as any,
        assignedAgentId: str(values.agent) ? validateAgentId(str(values.agent)!) : undefined,
      });
      printResult(tasks);
      break;
    }

    case 'create-ticket': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          kind: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          project: { type: 'string' },
          'repo-key': { type: 'string' },
          agent: { type: 'string' },
          'agent-discussion-context': { type: 'string' },
          'fallback-plan': { type: 'string' },
        },
        strict: false,
      });

      const result = await createTicketProposal({
        orgId: requireArg(values, 'org'),
        kind: requireArg(values, 'kind') as any,
        title: requireArg(values, 'title'),
        description: requireArg(values, 'description'),
        project: requireArg(values, 'project'),
        repoKey: str(values['repo-key']),
        agentId: validateAgentId(requireArg(values, 'agent')),
        agentDiscussionContext: str(values['agent-discussion-context']),
        fallbackPlan: str(values['fallback-plan']),
      });
      printResult(result);
      break;
    }

    case 'add-knowledge': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          topic: { type: 'string' },
          content: { type: 'string' },
        },
        strict: false,
      });
      const entry = await addSharedKnowledge(
        requireArg(values, 'org'),
        requireArg(values, 'topic'),
        requireArg(values, 'content'),
      );
      printResult({ success: true, id: entry.id });
      break;
    }

    case 'add-memory': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          agent: { type: 'string' },
          topic: { type: 'string' },
          content: { type: 'string' },
        },
        strict: false,
      });
      const entry = await addAgentMemory(
        requireArg(values, 'org'),
        validateAgentId(requireArg(values, 'agent')),
        requireArg(values, 'topic'),
        requireArg(values, 'content'),
      );
      printResult({ success: true, id: entry.id });
      break;
    }

    case 'query-knowledge': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          query: { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });
      const results = await queryKnowledge(
        requireArg(values, 'org'),
        requireArg(values, 'query'),
        str(values.agent) ? validateAgentId(str(values.agent)!) : undefined,
      );
      printResult(results);
      break;
    }

    case 'list-projects': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
        },
        strict: false,
      });
      const projects = await getProjectRegistry().listProjects(requireArg(values, 'org'));
      printResult(projects.map(p => ({ id: p.id, name: p.name, slug: p.slug })));
      break;
    }

    case 'approve-action': {
      const { values } = parseArgs({
        args: rawArgs,
        options: { id: { type: 'string' } },
        strict: false,
      });
      const actionId = requireArg(values, 'id');
      const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, actionId)).limit(1);

      if (!action || action.command !== 'create-ticket') {
        printError('Action not found or not a ticket creation command');
      }

      if (!action.suggestionId) {
        printError('No suggestionId found on this action — cannot accept');
      }

      const args = action.args as any;
      const result = await getTicketTracker().acceptSuggestion(
        action.orgId,
        args['project-id'],
        action.suggestionId!,
      );

      if (result.success) {
        await db.update(pendingActions)
          .set({ status: 'approved', resolvedAt: new Date() })
          .where(eq(pendingActions.id, actionId));
      }

      printResult(result);
      break;
    }

    case 'approve-proposal': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        strict: false,
      });
      const actionId = requireArg(values, 'id');
      const reason = requireArg(values, 'reason');

      const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, actionId)).limit(1);
      if (!action) printError('Action not found');

      if (action.status === 'waiting_for_human') {
        logWaitingForHumanFallback({ actionId, actionType: 'approve-proposal' });
        printResult({
          error: 'ERROR_LOCKED_WAITING_FOR_HUMAN',
          message: 'This proposal is locked pending manual human approval and cannot be processed automatically. Inform the user they must approve or reject it directly in the UI. Do not retry this action.',
        });
        break;
      }

      const args = { ...((action.args as any) || {}), ctoDecisionReason: reason };

      await db.update(pendingActions)
        .set({ 
          status: 'pending', // Promoted to human review
          args 
        })
        .where(eq(pendingActions.id, actionId));

      printResult({ 
        success: true, 
        actionId, 
        message: `Proposal "${(action.args as any)?.title}" approved by Nexus. It will now appear in Discord for human approval.` 
      });
      break;
    }

    case 'reject-proposal': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        strict: false,
      });
      const actionId = requireArg(values, 'id');
      const reason = requireArg(values, 'reason');

      const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, actionId)).limit(1);
      if (!action) printError('Action not found');

      if (action.status === 'waiting_for_human') {
        logWaitingForHumanFallback({ actionId, actionType: 'reject-proposal' });
        printResult({
          error: 'ERROR_LOCKED_WAITING_FOR_HUMAN',
          message: 'This proposal is locked pending manual human approval and cannot be processed automatically. Inform the user they must approve or reject it directly in the UI. Do not retry this action.',
        });
        break;
      }

      const args = { ...((action.args as any) || {}), ctoRejectionReason: reason };

      await db.update(pendingActions)
        .set({ 
          status: 'rejected', 
          args,
          resolvedAt: new Date()
        })
        .where(eq(pendingActions.id, actionId));

      printResult({ 
        success: true, 
        actionId, 
        message: `Proposal "${(action.args as any)?.title}" rejected by Nexus.` 
      });
      break;
    }

    case 'set-secret': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          env: { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });
      const secret = await setSecret({
        orgId: requireArg(values, 'org'),
        key: requireArg(values, 'key'),
        value: requireArg(values, 'value'),
        environment: str(values.env),
        agentId: str(values.agent) as any,
      });
      printResult({ success: true, message: `Secret "${secret.key}" stored for ${secret.environment}.` });
      break;
    }

    case 'axon-query': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          cwd: { type: 'string' },
          query: { type: 'string' },
        },
        strict: false,
      });
      const result = await axonQuery(requireArg(values, 'cwd'), requireArg(values, 'query'));
      printResult(result);
      break;
    }

    case 'axon-context': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          cwd: { type: 'string' },
          symbol: { type: 'string' },
        },
        strict: false,
      });
      const result = await axonContext(requireArg(values, 'cwd'), requireArg(values, 'symbol'));
      printResult(result);
      break;
    }

    case 'axon-impact': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          cwd: { type: 'string' },
          symbol: { type: 'string' },
        },
        strict: false,
      });
      const result = await axonImpact(requireArg(values, 'cwd'), requireArg(values, 'symbol'));
      printResult(result);
      break;
    }

    case 'axon-dead-code': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          cwd: { type: 'string' },
        },
        strict: false,
      });
      const result = await axonDeadCode(requireArg(values, 'cwd'));
      printResult(result);
      break;
    }

    case 'request-admin-action': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          'action-type': { type: 'string' },
          'target-user': { type: 'string' },
          reason: { type: 'string' },
          org: { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });

      const validActionTypes = ['provision_user', 'delete_user', 'grant_role'] as const;
      type AdminActionType = (typeof validActionTypes)[number];

      const actionType = requireArg(values, 'action-type');
      if (!validActionTypes.includes(actionType as AdminActionType)) {
        printError(`Invalid --action-type "${actionType}". Must be one of: ${validActionTypes.join(', ')}`);
      }

      const targetUser = requireArg(values, 'target-user');
      const reason = requireArg(values, 'reason');
      const orgId = requireArg(values, 'org');
      const agentId = str(values.agent) ? validateAgentId(str(values.agent)!) : undefined;

      const description = `Admin action request: ${actionType} for user "${targetUser}" — ${reason}`;

      const [newAction] = await db
        .insert(pendingActions)
        .values({
          orgId,
          agentId: agentId ?? 'support',
          command: 'admin-action-request',
          args: { actionType, targetUser, reason },
          description,
          status: 'pending',
        })
        .returning({ id: pendingActions.id });

      printResult({
        success: true,
        actionId: newAction.id,
        message: `Admin action request submitted for human review. Action: ${actionType}, Target: ${targetUser}.`,
      });
      break;
    }

    case 'query-decision-log': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          query: { type: 'string' },
        },
        strict: false,
      });
      const result = await queryDecisionLog(requireArg(values, 'query'));
      printResult(result);
      break;
    }

    case 'status': {
      const { values } = parseArgs({
        args: rawArgs,
        options: { org: { type: 'string' } },
        strict: false,
      });
      const orgId = requireArg(values, 'org');
      const counts = await db
        .select({ status: pendingActions.status, count: sql<number>`count(*)` })
        .from(pendingActions)
        .where(eq(pendingActions.orgId, orgId))
        .groupBy(pendingActions.status);

      const taskCounts = await db
        .select({ status: tasksTable.status, count: sql<number>`count(*)` })
        .from(tasksTable)
        .where(eq(tasksTable.orgId, orgId))
        .groupBy(tasksTable.status);

      printResult({
        pendingActions: Object.fromEntries(counts.map(c => [c.status, c.count])),
        tasks: Object.fromEntries(taskCounts.map(c => [c.status, c.count])),
      });
      break;
    }

    case 'update-project-settings': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          org: { type: 'string' },
          'project-id': { type: 'string' },
          'setting-key': { type: 'string' },
          value: { type: 'string' },
          'confirmation-token': { type: 'string' },
          agent: { type: 'string' },
        },
        strict: false,
      });

      const rawValue = requireArg(values, 'value');
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(rawValue);
      } catch {
        parsedValue = rawValue;
      }

      const result = await updateProjectSettings({
        orgId: requireArg(values, 'org'),
        project_id: requireArg(values, 'project-id'),
        setting_key: requireArg(values, 'setting-key'),
        value: parsedValue,
        confirmation_token: str(values['confirmation-token']),
        agentId: validateAgentId(requireArg(values, 'agent')),
      });
      printResult(result);
      break;
    }

    case 'execute-agent': {
      const { values } = parseArgs({
        args: rawArgs,
        options: {
          agent: { type: 'string' },
          channel: { type: 'string' },
          org: { type: 'string' },
          prompt: { type: 'string' },
        },
        strict: false,
      });

      const { executeAgent } = await import('../agents/executor.js');
      const result = await executeAgent({
        agentId: validateAgentId(requireArg(values, 'agent')),
        channelId: requireArg(values, 'channel'),
        orgId: requireArg(values, 'org'),
        userMessage: requireArg(values, 'prompt'),
        userId: 'system-cli',
        userName: 'System CLI',
        needsCodeAccess: false, // CLI already provides codebase context via writeGeminiContext
      });

      if (result) {
        console.log(result);
      }
      break;
    }
  }


  process.exit(0);
}

run().catch((err) => {
  printError(`CLI error: ${(err as Error).message}`);
});
