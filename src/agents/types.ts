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

/**
 * Thrown by tool executors when an external HTTP call returns a transient
 * infrastructure error (429, 502, 503). The multi-turn tool loop catches this
 * to circuit-break immediately instead of letting the LLM retry.
 */
export class TransientInfrastructureError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}
