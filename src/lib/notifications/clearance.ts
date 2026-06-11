import type { ActivityLog } from "../../db/schema.js";

export function buildNotificationViewerKey(role: string, userId: string): string {
  return `${role}:${userId}`;
}

const RESTAURANT_PORTAL_ROLES = new Set([
  "restaurant",
  "restaurant_manager",
  "restaurant_employee",
]);

const VENDOR_PORTAL_ROLES = new Set([
  "vendor_admin",
  "manager",
  "sales_representative",
]);

/** Shared clearance per portal org so clear resets the bell for the whole portal. */
export function buildPortalNotificationViewerKey(
  role: string,
  userId: string,
  scope: { restaurantOrgId?: string; vendorId?: string },
): string {
  if (RESTAURANT_PORTAL_ROLES.has(role) && scope.restaurantOrgId) {
    return `restaurant_portal:${scope.restaurantOrgId}`;
  }
  if (VENDOR_PORTAL_ROLES.has(role) && scope.vendorId) {
    return `vendor_portal:${scope.vendorId}`;
  }
  return buildNotificationViewerKey(role, userId);
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
