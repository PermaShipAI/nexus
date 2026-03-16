import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { logger } from '../../logger.js';

/** No-op backend — ticket is stored in DB but no code execution happens */
export class NoopBackend implements ExecutionBackend {
  name = 'noop';

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    logger.info({ ticketId: ticket.ticketId, title: ticket.title }, 'Noop backend: ticket stored, no execution');
    return { success: true };
  }
}
