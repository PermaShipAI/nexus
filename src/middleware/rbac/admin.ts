import { pino } from 'pino';

const logger = pino({ name: 'rbac' });

const ORG_API_BASE = process.env['ORG_API_BASE'] ?? process.env['PERMASHIP_API_BASE'] ?? '';
const ORG_ID = process.env['DEFAULT_ORG_ID'] ?? process.env['PERMASHIP_ORG_ID'] ?? '';
const API_KEY = process.env['INTERNAL_SECRET'] ?? process.env['PERMASHIP_API_KEY'] ?? '';
const TIMEOUT_MS = 3000;

export async function verifyAdminRole(userId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(
        `${ORG_API_BASE}/api/orgs/${ORG_ID}/members/${userId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      logger.warn({ userId, status: response.status }, 'rbac:member_check_failed');
      return false;
    }

    const data = await response.json() as { role?: string };
    const role = data.role;
    return role === 'owner' || role === 'admin';
  } catch (err) {
    logger.warn({ userId, err }, 'rbac:verify_admin_role_error');
    return false;
  }
}
