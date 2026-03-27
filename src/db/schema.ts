import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';

// --- Enums ---

export const taskStatusEnum = pgEnum('task_status', [
  'proposed',
  'approved',
  'in_progress',
  'completed',
]);

export const taskPriorityEnum = pgEnum('task_priority', [
  'critical',
  'high',
  'medium',
  'low',
]);

export const knowledgeKindEnum = pgEnum('knowledge_kind', [
  'shared',
  'agent_memory',
]);

export const ticketKindEnum = pgEnum('ticket_kind', ['bug', 'feature', 'task']);

export const missionStatusEnum = pgEnum('mission_status', [
  'draft',
  'planning',
  'active',
  'paused',
  'completed',
  'cancelled',
]);

// --- Tables ---

export const agents = pgTable('agents', {
  id: text('id').primaryKey(), // e.g. "ciso", "qa-manager"
  title: text('title').notNull(),
  version: text('version').notNull().default('1'),
  personaMd: text('persona_md').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

/** Links a physical workspace (Discord Guild, Slack Team) to an Org */
export const workspaceLinks = pgTable(
  'workspace_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    orgName: text('org_name'), // Human-readable org name for agent identity
    platform: text('platform').notNull(), // 'discord', 'slack'
    workspaceId: text('workspace_id').notNull(), // guild_id or team_id
    activatedAt: timestamp('activated_at').notNull().defaultNow(),
    activatedBy: text('activated_by').notNull(), // user_id
    internalChannelId: text('internal_channel_id'), // The "control" channel for this org
  },
  (table) => ({
    orgIdx: index('ws_link_org_idx').on(table.orgId),
    workspaceIdx: index('ws_link_workspace_idx').on(table.platform, table.workspaceId),
  }),
);

export type WorkspaceLink = typeof workspaceLinks.$inferSelect;
export type NewWorkspaceLink = typeof workspaceLinks.$inferInsert;

export const publicChannels = pgTable(
  'public_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    channelId: text('channel_id').notNull(),
    registeredBy: text('registered_by'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('public_channel_org_idx').on(table.orgId),
    channelIdx: index('public_channel_id_idx').on(table.channelId),
  }),
);

export type PublicChannel = typeof publicChannels.$inferSelect;
export type NewPublicChannel = typeof publicChannels.$inferInsert;

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    strategyId: uuid('strategy_id'), // Link tasks belonging to the same strategy session
    parentTaskId: uuid('parent_task_id'), // Support sub-tasks
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: taskStatusEnum('status').notNull().default('proposed'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    assignedAgentId: text('assigned_agent_id').references(() => agents.id),
    proposedByAgentId: text('proposed_by_agent_id').references(() => agents.id),
    discordMessageId: text('discord_message_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('task_org_idx').on(table.orgId),
    statusIdx: index('task_status_idx').on(table.status),
    assignedIdx: index('task_assigned_idx').on(table.assignedAgentId),
    strategyIdx: index('task_strategy_idx').on(table.strategyId),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    kind: knowledgeKindEnum('kind').notNull(),
    agentId: text('agent_id').references(() => agents.id),
    topic: text('topic').notNull(),
    content: text('content').notNull(),
    sourceId: text('source_id'), // e.g. "kb:<dashboard-doc-uuid>" for synced entries
    embedding: jsonb('embedding').$type<number[]>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('knowledge_org_idx').on(table.orgId),
    kindAgentIdx: index('knowledge_kind_agent_idx').on(table.kind, table.agentId),
    topicIdx: index('knowledge_topic_idx').on(table.topic),
    sourceIdx: index('knowledge_source_idx').on(table.sourceId),
  }),
);

export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type NewKnowledgeEntry = typeof knowledgeEntries.$inferInsert;

export const conversationHistory = pgTable(
  'conversation_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    channelId: text('channel_id').notNull(),
    discordMessageId: text('discord_message_id').notNull(),
    authorId: text('author_id').notNull(),
    authorName: text('author_name').notNull(),
    content: text('content').notNull(),
    isAgent: boolean('is_agent').notNull().default(false),
    agentId: text('agent_id').references(() => agents.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('conversation_org_idx').on(table.orgId),
    channelIdx: index('conversation_channel_idx').on(table.channelId),
    channelCreatedIdx: index('conversation_channel_created_idx').on(
      table.channelId,
      table.createdAt,
    ),
  }),
);

export type ConversationMessage = typeof conversationHistory.$inferSelect;
export type NewConversationMessage = typeof conversationHistory.$inferInsert;

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    kind: text('kind').notNull(), // "message", "tool_call", "idle_prompt"
    agentId: text('agent_id').references(() => agents.id),
    channelId: text('channel_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('activity_org_idx').on(table.orgId),
    createdAtIdx: index('activity_created_at_idx').on(table.createdAt),
  }),
);

export type ActivityEntry = typeof activityLog.$inferSelect;
export type NewActivityEntry = typeof activityLog.$inferInsert;

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    remoteTicketId: text('remote_ticket_id'), // ID returned by external API
    kind: ticketKindEnum('kind').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    repoKey: text('repo_key').notNull(),
    priority: integer('priority').default(3),
    labels: jsonb('labels').$type<string[]>().default([]),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    executionStatus: text('execution_status').default('pending'),
    executionBackend: text('execution_backend'),
    executionOutput: text('execution_output'),
    executionDiff: text('execution_diff'),
    executionReview: text('execution_review'),
    executionBranch: text('execution_branch'),
    mergeStatus: text('merge_status'),
    executedAt: timestamp('executed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('ticket_org_idx').on(table.orgId),
    agentIdx: index('ticket_agent_idx').on(table.createdByAgentId),
  }),
);

/** @deprecated Use `tickets` instead */
export const permashipTickets = tickets;

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
/** @deprecated Use `Ticket` instead */
export type PermashipTicket = Ticket;
/** @deprecated Use `NewTicket` instead */
export type NewPermashipTicket = NewTicket;

export const idleSuggestions = pgTable(
  'idle_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    content: text('content').notNull(),
    ticketData: jsonb('ticket_data'), // Optional metadata for ticket creation
    status: text('status').notNull().default('queued'), // 'queued', 'sent', 'approved', 'rejected'
    createdAt: timestamp('created_at').notNull().defaultNow(),
    sentAt: timestamp('sent_at'),
  },
  (table) => ({
    orgIdx: index('idle_suggestion_org_idx').on(table.orgId),
    statusIdx: index('idle_suggestion_status_idx').on(table.status),
  }),
);

export type IdleSuggestion = typeof idleSuggestions.$inferSelect;
export type NewIdleSuggestion = typeof idleSuggestions.$inferInsert;

export const pendingActions = pgTable(
  'pending_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    originalActionId: uuid('original_action_id'), // For steering: link to the action being revised
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    command: text('command').notNull(), // The CLI command that was attempted
    args: jsonb('args').notNull(), // Arguments for the command
    description: text('description').notNull(), // Friendly description for the human
    status: text('status').notNull().default('pending'), // 'pending', 'approved', 'rejected', 'superseded'
    suggestionId: text('suggestion_id'), // PermaShip suggestion ID (non-autonomous flow)
    channelId: text('channel_id'),
    discordMessageId: text('discord_message_id'),
    fileContext: jsonb('file_context').$type<{
      repoKey: string;
      filePaths: string[];
      commitSha?: string;
    }>(),
    source: text('source'), // 'user' | 'idle' | null (legacy, treated as 'idle')
    projectId: uuid('project_id'), // Links to the target project for per-project tracking
    lastStalenessCheckAt: timestamp('last_staleness_check_at'),
    stalenessCount: integer('staleness_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at'),
  },
  (table) => ({
    orgIdx: index('pending_action_org_idx').on(table.orgId),
    statusIdx: index('pending_action_status_idx').on(table.status),
    projectIdx: index('pending_action_project_idx').on(table.projectId),
  }),
);

export type PendingAction = typeof pendingActions.$inferSelect;
export type NewPendingAction = typeof pendingActions.$inferInsert;

export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    key: text('key').notNull(), // e.g. "PERMASHIP_STAGING_PASSWORD"
    value: text('value').notNull(), // Should be encrypted in a real app, but for now we store it
    environment: text('environment').notNull().default('production'),
    agentId: text('agent_id').references(() => agents.id), // Optional: secret specific to an agent
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('secret_org_idx').on(table.orgId),
    keyEnvIdx: index('secret_key_env_idx').on(table.key, table.environment),
  }),
);

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;

export const botSettings = pgTable(
  'bot_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('bot_settings_org_idx').on(table.orgId),
    keyIdx: index('bot_settings_key_idx').on(table.key),
  }),
);

export type BotSetting = typeof botSettings.$inferSelect;
export type NewBotSetting = typeof botSettings.$inferInsert;

export const codebaseSnapshots = pgTable(
  'codebase_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    repoKey: text('repo_key').notNull(),
    latestCommitSha: text('latest_commit_sha'),
    commitFrequency: real('commit_frequency'), // avg commits/day over last 30 days
    checkedAt: timestamp('checked_at').notNull().defaultNow(),
  },
  (table) => ({
    orgRepoIdx: uniqueIndex('codebase_snapshot_org_repo_idx').on(table.orgId, table.repoKey),
  }),
);

export type CodebaseSnapshot = typeof codebaseSnapshots.$inferSelect;
export type NewCodebaseSnapshot = typeof codebaseSnapshots.$inferInsert;

// --- Local Projects ---

export const localProjects = pgTable(
  'local_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sourceType: text('source_type').notNull(), // 'local' | 'git'
    localPath: text('local_path').notNull(),
    remoteUrl: text('remote_url'),
    repoKey: text('repo_key').notNull(),
    cloneStatus: text('clone_status').notNull().default('ready'), // 'ready' | 'cloning' | 'error'
    cloneError: text('clone_error'),
    autonomousMode: boolean('autonomous_mode'), // null = inherit from org
    policy: jsonb('policy'), // ProjectPolicy JSON — focus level, operating window, etc.
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('local_project_org_idx').on(table.orgId),
    slugOrgIdx: uniqueIndex('local_project_slug_org_idx').on(table.slug, table.orgId),
  }),
);

export type LocalProject = typeof localProjects.$inferSelect;
export type NewLocalProject = typeof localProjects.$inferInsert;

// --- Missions ---

export const missions = pgTable(
  'missions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    channelId: text('channel_id').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: missionStatusEnum('status').notNull().default('draft'),
    heartbeatIntervalMs: integer('heartbeat_interval_ms').notNull().default(600_000),
    lastHeartbeatAt: timestamp('last_heartbeat_at'),
    nextHeartbeatAt: timestamp('next_heartbeat_at'),
    cronExpression: text('cron_expression'),
    recurringParentId: uuid('recurring_parent_id'),
    autonomousMode: boolean('autonomous_mode'), // null = inherit from org
    completedAt: timestamp('completed_at'),
    cancelledAt: timestamp('cancelled_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('mission_org_idx').on(table.orgId),
    statusIdx: index('mission_status_idx').on(table.status),
    nextHeartbeatIdx: index('mission_next_heartbeat_idx').on(table.nextHeartbeatAt),
  }),
);

export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;

export const missionItems = pgTable(
  'mission_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull().default('pending'),
    assignedAgentId: text('assigned_agent_id'),
    completedByAgentId: text('completed_by_agent_id'),
    verifiedAt: timestamp('verified_at'),
    heartbeatCount: integer('heartbeat_count').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    missionIdx: index('mission_item_mission_idx').on(table.missionId),
  }),
);

export type MissionItem = typeof missionItems.$inferSelect;
export type NewMissionItem = typeof missionItems.$inferInsert;

export const missionProjects = pgTable(
  'mission_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id').notNull(),
    projectId: uuid('project_id').notNull(),
  },
  (table) => ({
    missionIdx: index('mission_project_mission_idx').on(table.missionId),
  }),
);

export type MissionProject = typeof missionProjects.$inferSelect;
export type NewMissionProject = typeof missionProjects.$inferInsert;

// --- ADR Drafts ---

export const adrDrafts = pgTable(
  'adr_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(), // Full ADR markdown
    failureClass: text('failure_class').notNull(), // Semantic failure class label
    evidenceActionIds: jsonb('evidence_action_ids').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('pending_review'), // 'pending_review' | 'approved' | 'rejected'
    committedPath: text('committed_path'), // e.g. agents/decisions/adr-001-no-auth-changes.md (set on approve)
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('adr_draft_org_idx').on(table.orgId),
    statusIdx: index('adr_draft_status_idx').on(table.status),
  }),
);

export type AdrDraft = typeof adrDrafts.$inferSelect;
export type NewAdrDraft = typeof adrDrafts.$inferInsert;
