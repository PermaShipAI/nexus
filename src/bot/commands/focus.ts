// src/bot/commands/focus.ts — !focus and !schedule command handlers

import { sendAgentMessage } from '../formatter.js';
import { getAllocationOverview } from '../../idle/allocator.js';
import { resolveProjectPolicy, setProjectPolicy } from '../../idle/policy-resolver.js';
import { getProjectSuppressionReport } from '../../idle/suppression.js';
import { parseScheduleShorthand, getEffectiveTicketsPerDay, type FocusLevel, type ProjectPolicy } from '../../idle/project-policy.js';
import { getProjectRegistry } from '../../adapters/registry.js';
import { logger } from '../../logger.js';

const VALID_FOCUS_LEVELS: FocusLevel[] = ['off', 'low', 'normal', 'high', 'custom'];

/**
 * Handle !focus commands. Returns true if handled.
 */
export async function handleFocusCommand(
  content: string,
  channelId: string,
  orgId: string,
  userName: string,
): Promise<boolean> {
  // Strip mention prefixes
  const cleaned = content.replace(/^@nexus\s+/i, '').trim();

  const focusMatch = cleaned.match(/^!focus\s*(.*)$/i);
  if (!focusMatch) return false;

  const args = focusMatch[1].trim();

  // !focus (no args) or !focus list
  if (!args || args === 'list') {
    await handleFocusList(channelId, orgId);
    return true;
  }

  // Parse: !focus <project> <level|status>
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    await sendAgentMessage(channelId, 'System',
      `Usage: \`!focus <project> <off|low|normal|high|N/day>\` or \`!focus list\``, orgId);
    return true;
  }

  const projectName = parts[0];
  const action = parts.slice(1).join(' ');

  // Resolve project
  const project = await resolveProject(projectName, orgId);
  if (!project) {
    await sendAgentMessage(channelId, 'System',
      `Project **${projectName}** not found. Use \`!focus list\` to see available projects.`, orgId);
    return true;
  }

  // !focus <project> status
  if (action === 'status') {
    await handleFocusStatus(channelId, orgId, project.id, project.name);
    return true;
  }

  // Parse level
  const customMatch = action.match(/^(\d+)\/day$/i);
  let newPolicy: Partial<ProjectPolicy>;

  if (customMatch) {
    const perDay = parseInt(customMatch[1], 10);
    newPolicy = { focusLevel: 'custom', customTicketsPerDay: perDay };
  } else if (VALID_FOCUS_LEVELS.includes(action.toLowerCase() as FocusLevel)) {
    newPolicy = { focusLevel: action.toLowerCase() as FocusLevel };
  } else {
    await sendAgentMessage(channelId, 'System',
      `Invalid focus level **${action}**. Options: off, low, normal, high, or N/day (e.g. 5/day)`, orgId);
    return true;
  }

  // Apply
  const currentPolicy = await resolveProjectPolicy(orgId, project.id);
  await setProjectPolicy(orgId, project.id, { ...currentPolicy, ...newPolicy });

  const effectivePerDay = getEffectiveTicketsPerDay({ ...currentPolicy, ...newPolicy } as ProjectPolicy);

  // Check if this would push above plan default and show forecast warning
  let forecastWarning = '';
  try {
    const forecast = await fetchForecast(orgId);
    if (forecast && forecast.computeImpactPercent > 0) {
      forecastWarning = `\n\n⚠️ This increases your projected monthly output to ~${forecast.projectedMonthlyOutput} tickets (plan default: ${forecast.planDefaultMonthly}). You may consume compute credits ${forecast.computeImpactPercent}% faster.`;
    }
  } catch { /* forecast not critical */ }

  await sendAgentMessage(channelId, 'System',
    `Focus for **${project.name}** set to **${newPolicy.focusLevel}** (${effectivePerDay}/day) by ${userName}.${forecastWarning}`, orgId);

  return true;
}

/**
 * Handle !schedule commands. Returns true if handled.
 */
export async function handleScheduleCommand(
  content: string,
  channelId: string,
  orgId: string,
  userName: string,
): Promise<boolean> {
  const cleaned = content.replace(/^@nexus\s+/i, '').trim();

  const scheduleMatch = cleaned.match(/^!schedule\s+(\S+)\s+(.+)$/i);
  if (!scheduleMatch) return false;

  const projectName = scheduleMatch[1];
  const scheduleStr = scheduleMatch[2].trim();

  const project = await resolveProject(projectName, orgId);
  if (!project) {
    await sendAgentMessage(channelId, 'System',
      `Project **${projectName}** not found.`, orgId);
    return true;
  }

  // Parse timezone from end if present
  const parts = scheduleStr.split(/\s+/);
  let timezone = 'UTC';
  let scheduleInput = scheduleStr;

  // Check if last part looks like a timezone (contains /)
  if (parts.length > 1 && parts[parts.length - 1].includes('/')) {
    timezone = parts.pop()!;
    scheduleInput = parts.join(' ');
  }

  const window = parseScheduleShorthand(scheduleInput, timezone);

  const currentPolicy = await resolveProjectPolicy(orgId, project.id);
  await setProjectPolicy(orgId, project.id, { ...currentPolicy, operatingWindow: window });

  const windowDesc = window
    ? `${scheduleInput} (${timezone})`
    : 'always (no restriction)';

  await sendAgentMessage(channelId, 'System',
    `Operating window for **${project.name}** set to **${windowDesc}** by ${userName}.`, orgId);

  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function handleFocusList(channelId: string, orgId: string): Promise<void> {
  try {
    const overview = await getAllocationOverview(orgId);

    if (overview.projects.length === 0) {
      await sendAgentMessage(channelId, 'System',
        'No projects configured. Add projects first.', orgId);
      return;
    }

    const lines = overview.projects.map(p => {
      const bar = buildFocusBar(p.focusLevel, p.ticketsPerDay);
      const levelLabel = p.focusLevel === 'custom'
        ? `Custom (${p.ticketsPerDay}/day)`
        : `${capitalize(p.focusLevel)} (${p.ticketsPerDay}/day)`;
      const todayLabel = p.suppressed ? 'paused' : `${p.ticketsToday} today`;
      return `${padRight(p.name, 20)} ${bar}  ${padRight(levelLabel, 20)} — ${todayLabel}`;
    });

    // Get plan default from billing forecast (if available)
    const forecast = await fetchForecast(orgId);
    const planDailyDefault = forecast
      ? Math.round(forecast.planDefaultMonthly / 30)
      : null;

    let footer = `\nDaily total: ${overview.dailyTotal}/day`;
    if (planDailyDefault) {
      footer += `  |  Plan default: ${planDailyDefault}/day`;
    }

    if (forecast && forecast.computeImpactPercent > 0) {
      footer += `\n\n⚠️ Total allocation (${overview.dailyTotal}/day) exceeds your plan default (${planDailyDefault}/day). Excess usage will consume compute credits faster.`;
    }

    const message = `**Agent Focus**\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`${footer}`;
    await sendAgentMessage(channelId, 'System', message, orgId);
  } catch (err) {
    logger.error({ err, orgId }, 'Failed to generate focus list');
    await sendAgentMessage(channelId, 'System', 'Failed to load focus overview.', orgId);
  }
}

async function handleFocusStatus(channelId: string, orgId: string, projectId: string, projectName: string): Promise<void> {
  try {
    const report = await getProjectSuppressionReport(orgId, projectId);
    const policy = await resolveProjectPolicy(orgId, projectId);

    const lines = [
      `**${projectName}** — Focus Status`,
      ``,
      `Focus level: **${capitalize(policy.focusLevel)}** (${report.ticketsPerDay}/day)`,
      `Tickets today: ${report.ticketsToday}`,
      `Backpressure: ${Math.round(report.backpressure * 100)}%`,
    ];

    if (policy.operatingWindow) {
      const w = policy.operatingWindow.windows[0];
      if (w) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = w.days.map(d => dayNames[d]).join(', ');
        lines.push(`Operating window: ${days} ${w.startHour}:00-${w.endHour}:00 ${policy.operatingWindow.timezone}`);
      }
    } else {
      lines.push(`Operating window: always`);
    }

    if (report.suppressed) {
      lines.push('');
      lines.push('**Suppressed** — reasons:');
      for (const r of report.reasons) {
        lines.push(`  - ${r.description}`);
      }
    } else {
      lines.push('');
      lines.push('Status: **Active**');
    }

    await sendAgentMessage(channelId, 'System', lines.join('\n'), orgId);
  } catch (err) {
    logger.error({ err, orgId, projectId }, 'Failed to generate focus status');
    await sendAgentMessage(channelId, 'System', 'Failed to load project status.', orgId);
  }
}

async function resolveProject(nameOrSlug: string, orgId: string): Promise<{ id: string; name: string } | null> {
  const registry = getProjectRegistry();
  const lower = nameOrSlug.toLowerCase().trim();

  // Try the registry's built-in resolver first
  const resolvedId = await registry.resolveProjectId(lower, orgId);
  if (resolvedId) {
    // Get the name from project list
    const projects = await registry.listProjects(orgId);
    const project = projects.find(p => p.id === resolvedId);
    if (project) return { id: project.id, name: project.name };
  }

  // Fallback: fuzzy match against project list
  const projects = await registry.listProjects(orgId);
  const match = projects.find(p =>
    p.slug.toLowerCase() === lower || p.name.toLowerCase() === lower,
  );

  return match ? { id: match.id, name: match.name } : null;
}

function buildFocusBar(level: string, ticketsPerDay: number): string {
  const maxBar = 10;
  const filled = level === 'off' ? 0 : Math.min(maxBar, ticketsPerDay);
  return '█'.repeat(filled) + '░'.repeat(maxBar - filled);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + ' '.repeat(len - s.length);
}

interface ForecastResult {
  projectedMonthlyOutput: number;
  planDefaultMonthly: number;
  computeImpactPercent: number;
}

/** Fetch billing forecast via adapters (returns null in OSS mode) */
async function fetchForecast(orgId: string): Promise<ForecastResult | null> {
  try {
    const mod = await (Function('return import("@permaship/agents-adapters")')() as Promise<Record<string, unknown>>);
    const fetch = mod.fetchNexusForecast as
      ((id: string) => Promise<ForecastResult | null>) | undefined;
    if (fetch) return await fetch(orgId);
  } catch {
    // OSS mode — adapters package not installed
  }
  return null;
}
