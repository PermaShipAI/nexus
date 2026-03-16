export type AgentId =
  | 'ciso'
  | 'qa-manager'
  | 'sre'
  | 'ux-designer'
  | 'agentops'
  | 'finops'
  | 'product-manager'
  | 'release-engineering'
  | 'voc'
  | 'nexus'
  | 'support';

export const AGENT_IDS: AgentId[] = [
  'ciso',
  'qa-manager',
  'sre',
  'ux-designer',
  'agentops',
  'finops',
  'product-manager',
  'release-engineering',
  'voc',
  'nexus',
  'support',
];

export interface AgentDefinition {
  id: AgentId;
  title: string;
  summary: string;
  personaMd: string;
}

export interface AgentContext {
  agentId: AgentId;
  channelId: string;
  userId: string;
  userName: string;
}
