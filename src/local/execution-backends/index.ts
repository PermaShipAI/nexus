export interface TicketSpec {
  ticketId: string;
  kind: 'bug' | 'feature' | 'task';
  title: string;
  description: string;
  repoPath: string;
  repoKey: string;
  branch?: string;
}

export interface ExecutionResult {
  success: boolean;
  branch?: string;
  commitSha?: string;
  output?: string;
  error?: string;
}

export interface ExecutionBackend {
  name: string;
  execute(ticket: TicketSpec): Promise<ExecutionResult>;
}

/** Sanitize text for inclusion in execution prompts (C4) */
function sanitize(text: string, maxLength: number): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, maxLength)
    .trim();
}

/** Build a structured prompt from a ticket spec */
export function buildPrompt(ticket: TicketSpec): string {
  const title = sanitize(ticket.title, 200);
  const description = sanitize(ticket.description, 4000);
  const repoKey = ticket.repoKey.replace(/[^a-zA-Z0-9._-]/g, '');

  return `You are working on the "${repoKey}" repository.

Task: ${title}
Type: ${ticket.kind}

Description:
${description}

IMPORTANT SAFETY RULES — you MUST follow these:
1. Create a new git branch for this work
2. Make ONLY the code changes described above
3. Commit with a descriptive message
4. Do NOT push changes to any remote
5. Do NOT delete files unless the task explicitly requires it
6. Do NOT modify files outside the repository
7. Do NOT execute arbitrary shell commands beyond what is needed for the task
8. Do NOT access or modify .env, credentials, or secret files`;
}
