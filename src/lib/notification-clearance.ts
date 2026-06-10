import type { ActivityLog } from "../shared/schema.js";

export function buildNotificationViewerKey(role: string, userId: string): string {
  return `${role}:${userId}`;
}

function parseLogTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export function countUnreadNotifications(
  logs: ActivityLog[],
  clearedAt: Date | string | null | undefined,
): number {
  if (!clearedAt) return logs.length;
  const clearedTime = parseLogTime(clearedAt);
  if (clearedTime == null) return logs.length;
  return logs.filter((log) => {
    const createdTime = parseLogTime(log.createdAt);
    return createdTime != null && createdTime > clearedTime;
  }).length;
}
