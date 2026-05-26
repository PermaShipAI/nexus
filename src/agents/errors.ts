export class WaitingForHumanError extends Error {
  readonly requiredRole?: string;
  readonly rawPayload?: unknown;

  constructor(options: { requiredRole?: string; rawPayload?: unknown } = {}) {
    super('Agent execution halted: waiting_for_human approval required');
    this.name = 'WaitingForHumanError';
    this.requiredRole = options.requiredRole;
    this.rawPayload = options.rawPayload;
  }
}
