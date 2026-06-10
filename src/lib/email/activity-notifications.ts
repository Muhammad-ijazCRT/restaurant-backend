import { db } from "../../db/client.js";
import type { ActivityLog } from "../../db/schema.js";
import { users } from "../../db/schema.js";
import { storage } from "../../services/storage.js";
import {
  filterManagerNotifications,
  filterRestaurantNotifications,
  filterSuperAdminNotifications,
  filterVendorAdminNotifications,
  filterVendorEmployeeNotifications,
  normalizeNotificationRole,
  type VendorEmployeeNotificationRole,
} from "../notifications/filters.js";
import {
  resolveNotificationDisplayMessage,
  resolveNotificationDisplayTitle,
} from "../notifications/display.js";
import { buildPortalEmailHtml } from "./template.js";
import { isMailConfigured, sendMail } from "./mailer.js";
import { notificationActionLabel } from "../notifications/labels.js";

type PortalRecipient = {
  userId: string;
  roles: string[];
  email: string;
  name: string;
};

/** All order actions that mirror the notification bell. */
export const ORDER_EMAIL_ACTIONS = new Set([
  "order_created",
  "order_submitted",
  "order_assigned",
  "order_assigned_worker",
  "order_assigned_driver",
  "order_unassigned_worker",
  "order_unassigned_driver",
  "order_picking_saved",
  "order_picking_submitted",
  "order_picking_submitted_worker",
  "order_picking_approved",
  "order_substitution_proposed",
  "order_substitution_status_updated",
  "order_delivered",
  "order_delivered_driver",
  "order_issue_reported",
  "order_issue_pending_vendor",
  "order_review_forwarded_to_driver",
  "order_issue_pending_driver",
  "order_issue_resolved",
  "order_issue_resolved_driver",
  "order_review_submitted",
  "order_review_resubmitted",
  "order_review_rejected",
  "order_invoiced",
  "order_paid",
  "order_deleted",
  "order_draft_cleared",
  "order_draft_updated",
]);

const ROLE_PRIORITY = [
  "super_admin",
  "vendor_admin",
  "restaurant",
  "manager",
  "warehouse_worker",
  "driver",
] as const;

function parseEntryMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof metadata === "object") return metadata as Record<string, unknown>;
  return {};
}

function resolveOrderId(entry: {
  entityType: string;
  entityId: string;
  metadata?: unknown;
}): string | undefined {
  if (entry.entityType === "order") return entry.entityId;
  const meta = parseEntryMetadata(entry.metadata);
  if (meta.orderId != null) return String(meta.orderId);
  return undefined;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function normalizeEmployeeRoles(roles: unknown): string[] {
  if (Array.isArray(roles)) {
    return roles.map((role) => String(role).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof roles === "string") {
    try {
      const parsed = JSON.parse(roles);
      if (Array.isArray(parsed)) return parsed.map((role) => String(role).trim().toLowerCase()).filter(Boolean);
    } catch {
      return roles.split(",").map((role) => role.trim().toLowerCase()).filter(Boolean);
    }
  }
  return [];
}

function employeePortalRoles(roles: unknown): Array<"manager" | VendorEmployeeNotificationRole> {
  const normalized = normalizeEmployeeRoles(roles);
  const out = new Set<"manager" | VendorEmployeeNotificationRole>();
  if (normalized.includes("manager")) out.add("manager");
  if (normalized.includes("warehouse") || normalized.includes("warehouse_worker")) out.add("warehouse_worker");
  if (normalized.includes("driver")) out.add("driver");
  return [...out];
}

function syntheticActivityLog(entry: {
  action: string;
  entityType: string;
  entityId: string;
  entityName: string;
  vendorId?: string;
  restaurantId?: string;
  metadata?: unknown;
}): ActivityLog {
  return {
    id: "pending-email",
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityName: entry.entityName,
    vendorId: entry.vendorId ?? null,
    restaurantId: entry.restaurantId ?? null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    createdAt: new Date(),
  };
}

function passesNotificationFilter(
  log: ActivityLog,
  recipient: PortalRecipient,
  role: string,
  orderById: Map<string, { warehouseWorkerId: string | null; driverId: string | null }>,
): boolean {
  const normalizedRole = normalizeNotificationRole(role);
  const logs = [log];
  const viewer = { userId: recipient.userId, role: normalizedRole };

  if (normalizedRole === "super_admin") return filterSuperAdminNotifications(logs).length > 0;
  if (normalizedRole === "restaurant") return filterRestaurantNotifications(logs, viewer.userId).length > 0;
  if (normalizedRole === "vendor_admin") return filterVendorAdminNotifications(logs, viewer.userId).length > 0;
  if (normalizedRole === "manager" || normalizedRole === "sales_representative") {
    return filterManagerNotifications(logs, viewer.userId).length > 0;
  }
  if (normalizedRole === "warehouse_worker" || normalizedRole === "driver") {
    return filterVendorEmployeeNotifications(
      logs,
      normalizedRole,
      viewer.userId,
      orderById,
    ).length > 0;
  }

  return false;
}

function resolveMessageForRecipient(
  log: ActivityLog,
  recipient: PortalRecipient,
  orderById: Map<string, { warehouseWorkerId: string | null; driverId: string | null }>,
): { message: string; title: string; role: string } | null {
  for (const role of ROLE_PRIORITY) {
    if (!recipient.roles.includes(role)) continue;
    if (!passesNotificationFilter(log, recipient, role, orderById)) continue;

    const viewer = { userId: recipient.userId, role };
    const message = resolveNotificationDisplayMessage(log, viewer);
    const customTitle = resolveNotificationDisplayTitle(log, viewer);
    const title = customTitle ?? notificationActionLabel(log.action);
    return { message, title, role };
  }
  return null;
}

async function collectRecipients(scope: {
  vendorId?: string;
  restaurantId?: string;
}): Promise<PortalRecipient[]> {
  const byUser = new Map<string, PortalRecipient>();

  const upsert = (userId: string, email: string, name: string, role: string) => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) return;

    const existing = byUser.get(userId);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      return;
    }

    byUser.set(userId, {
      userId,
      roles: [role],
      email: normalizedEmail,
      name,
    });
  };

  const admins = await db.select().from(users);
  for (const admin of admins) {
    upsert(admin.id, admin.username, admin.name?.trim() || admin.username.trim(), "super_admin");
  }

  if (scope.restaurantId) {
    const restaurant = await storage.getRestaurantOrg(scope.restaurantId);
    if (restaurant?.email) {
      upsert(scope.restaurantId, restaurant.email, restaurant.name, "restaurant");
    }
  }

  if (scope.vendorId) {
    const vendor = await storage.getVendor(scope.vendorId);
    if (vendor?.email) {
      upsert(scope.vendorId, vendor.email, vendor.name, "vendor_admin");
    }

    const employees = await storage.getVendorEmployees(scope.vendorId);
    for (const employee of employees) {
      if (!employee.email) continue;
      for (const role of employeePortalRoles(employee.roles)) {
        upsert(employee.id, employee.email, employee.name, role);
      }
    }
  }

  return [...byUser.values()];
}

async function buildOrderAssignmentMap(
  orderId: string | undefined,
): Promise<Map<string, { warehouseWorkerId: string | null; driverId: string | null }>> {
  const orderById = new Map<string, { warehouseWorkerId: string | null; driverId: string | null }>();
  if (!orderId) return orderById;

  const order = await storage.getOrder(orderId);
  if (order) {
    orderById.set(order.id, {
      warehouseWorkerId: order.warehouseWorkerId ?? null,
      driverId: order.driverId ?? null,
    });
  }

  return orderById;
}

export async function sendActivityEmails(entry: {
  action: string;
  entityType: string;
  entityId: string;
  entityName: string;
  vendorId?: string;
  restaurantId?: string;
  metadata?: unknown;
}): Promise<void> {
  if (!isMailConfigured()) return;
  if (process.env.ENABLE_ACTIVITY_EMAILS === "false") return;
  if (!ORDER_EMAIL_ACTIONS.has(entry.action)) return;

  const log = syntheticActivityLog(entry);
  const meta = parseEntryMetadata(entry.metadata);
  const orderId = resolveOrderId(entry);
  const orderById = await buildOrderAssignmentMap(orderId);
  const recipients = await collectRecipients({
    vendorId: entry.vendorId,
    restaurantId: entry.restaurantId,
  });

  const displayId = meta.displayId ?? meta.displayOrderId;
  const restaurantName = meta.restaurantName != null ? String(meta.restaurantName) : undefined;
  const vendorName = meta.vendorName != null ? String(meta.vendorName) : undefined;

  const sentEmails = new Set<string>();

  for (const recipient of recipients) {
    const resolved = resolveMessageForRecipient(log, recipient, orderById);
    if (!resolved) continue;

    if (sentEmails.has(recipient.email)) continue;
    sentEmails.add(recipient.email);

    const html = buildPortalEmailHtml({
      title: resolved.title,
      message: resolved.message,
      recipientName: recipient.name,
      orderDisplayId: displayId as string | number | undefined,
      restaurantName,
      vendorName,
    });

    try {
      await sendMail({
        to: recipient.email,
        subject: `${resolved.title} — Russian Restaurant Portal`,
        html,
        text: `${resolved.title}\n\n${resolved.message}`,
      });
      console.log("[mail] sent", entry.action, "to", recipient.email, `(${resolved.role})`);
    } catch (err) {
      console.error("[mail] failed", entry.action, recipient.email, err);
    }
  }
}

export function queueActivityEmails(entry: {
  action: string;
  entityType: string;
  entityId: string;
  entityName: string;
  vendorId?: string;
  restaurantId?: string;
  metadata?: unknown;
}): void {
  sendActivityEmails(entry).catch((err) => {
    console.error("[mail] queue failed", entry.action, err);
  });
}
