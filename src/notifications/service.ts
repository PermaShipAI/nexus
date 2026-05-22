import { db } from '../db/index.js';
import { notifications } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { localBus } from '../local/communication-adapter.js';
import { logger } from '../logger.js';

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface CreateNotificationOptions {
  orgId: string;
  type: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  metadata?: Record<string, unknown>;
}

/**
 * Create a persisted notification and broadcast it over WebSocket.
 * Agents and schedulers call this to proactively surface important events.
 */
export async function createNotification(opts: CreateNotificationOptions) {
  const { orgId, type, title, body, severity = 'info', metadata } = opts;

  try {
    const [notification] = await db
      .insert(notifications)
      .values({ orgId, type, title, body, severity, metadata })
      .returning();

    // Broadcast to all connected browser clients via the localBus → WebSocket bridge
    localBus.emit('notification', notification);

    logger.info({ notificationId: notification.id, type, severity }, 'Notification created');
    return notification;
  } catch (err) {
    logger.error({ err, type, title }, 'Failed to create notification');
    throw err;
  }
}

export async function listNotifications(orgId: string, opts: { limit?: number; unreadOnly?: boolean } = {}) {
  const { limit = 50, unreadOnly = false } = opts;

  const conditions = [eq(notifications.orgId, orgId)];
  if (unreadOnly) conditions.push(eq(notifications.read, false));

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function markNotificationRead(id: string, orgId: string) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, id), eq(notifications.orgId, orgId)));
}

export async function markAllNotificationsRead(orgId: string) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.orgId, orgId), eq(notifications.read, false)));
}

export async function getUnreadCount(orgId: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.orgId, orgId), eq(notifications.read, false)))
    .limit(100);
  return rows.length;
}
