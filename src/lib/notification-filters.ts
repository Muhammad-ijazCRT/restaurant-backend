import type { ActivityLog } from "../shared/schema.js";

export type VendorEmployeeNotificationRole = "warehouse_worker" | "driver";

const WORKER_EMPLOYEE_ACTIONS = new Set([
  "employee_profile_updated",
  "order_assigned_worker",
  "order_picking_submitted_worker",
]);

const DRIVER_EMPLOYEE_ACTIONS = new Set([
  "employee_profile_updated",
  "order_assigned_driver",
  "order_issue_pending_driver",
  "order_delivered_driver",
  "order_issue_resolved_driver",
]);

/** Login events — activity log only, never shown in any portal notification bell. */
export const AUDIT_ONLY_LOGIN_ACTIONS = new Set([
  "employee_logged_in",
  "vendor_logged_in",
  "restaurant_logged_in",
  "super_admin_logged_in",
]);

export function isPortalLoginActivity(log: ActivityLog): boolean {
  return AUDIT_ONLY_LOGIN_ACTIONS.has(log.action);
}

export function isOwnEmployeeLogin(log: ActivityLog, userId: string): boolean {
  return (
    log.action === "employee_logged_in" &&
    normalizeId(log.entityId) === normalizeId(userId)
  );
}

export function isOwnVendorLogin(log: ActivityLog, userId: string): boolean {
  return log.action === "vendor_logged_in" && normalizeId(log.entityId) === normalizeId(userId);
}

export function isOwnRestaurantLogin(log: ActivityLog, userId: string): boolean {
  return (
    log.action === "restaurant_logged_in" &&
    normalizeId(log.entityId) === normalizeId(userId)
  );
}

export function isOwnSuperAdminLogin(log: ActivityLog, userId: string): boolean {
  return (
    log.action === "super_admin_logged_in" &&
    normalizeId(log.entityId) === normalizeId(userId)
  );
}

export function isOwnPortalLogin(log: ActivityLog, userId: string): boolean {
  return (
    isOwnEmployeeLogin(log, userId) ||
    isOwnVendorLogin(log, userId) ||
    isOwnRestaurantLogin(log, userId) ||
    isOwnSuperAdminLogin(log, userId)
  );
}

function isOwnProfileUpdate(log: ActivityLog, userId: string): boolean {
  return log.action.endsWith("_profile_updated") && normalizeId(log.entityId) === normalizeId(userId);
}

/** Order-level logs for workers — picking submit uses order_picking_submitted_worker only (no duplicate). */
const WORKER_ORDER_ACTIONS = new Set([
  "order_picking_saved",
  "order_substitution_proposed",
  "order_substitution_status_updated",
]);

/** Order-level logs for drivers — assign/deliver/issue use *_driver employee logs only. */
const DRIVER_ORDER_ACTIONS = new Set([
  "order_picking_approved",
  "order_invoiced",
  "order_review_submitted",
  "order_review_resubmitted",
]);

type OrderAssignment = {
  warehouseWorkerId: string | null;
  driverId: string | null;
};

export function normalizeNotificationRole(role: string): string {
  if (role === "warehouse") return "warehouse_worker";
  if (role === "vendor") return "vendor_admin";
  return role;
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function parseActivityMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function orderAssignmentFromMetadata(
  meta: Record<string, unknown>,
): OrderAssignment | null {
  const warehouseWorkerId = meta.warehouseWorkerId ?? meta.warehouse_worker_id;
  const driverId = meta.driverId ?? meta.driver_id;
  if (warehouseWorkerId == null && driverId == null) return null;
  return {
    warehouseWorkerId: warehouseWorkerId != null ? String(warehouseWorkerId) : null,
    driverId: driverId != null ? String(driverId) : null,
  };
}

function isEmployeeDirectNotification(
  log: ActivityLog,
  role: VendorEmployeeNotificationRole,
  userId: string,
): boolean {
  const actions = role === "warehouse_worker" ? WORKER_EMPLOYEE_ACTIONS : DRIVER_EMPLOYEE_ACTIONS;
  if (!actions.has(log.action)) return false;

  const uid = normalizeId(userId);
  const meta = parseActivityMetadata(log.metadata);
  if (meta.employeeId != null && normalizeId(meta.employeeId) === uid) return true;
  if (normalizeId(log.entityId) === uid) {
    return log.entityType === "vendor_employee" || log.action.startsWith("order_assigned_");
  }
  return false;
}

function isMetadataTarget(
  log: ActivityLog,
  role: VendorEmployeeNotificationRole,
  userId: string,
): boolean {
  const meta = parseActivityMetadata(log.metadata);
  const uid = normalizeId(userId);
  const assignment = orderAssignmentFromMetadata(meta);

  if (role === "warehouse_worker") {
    return assignment?.warehouseWorkerId != null && normalizeId(assignment.warehouseWorkerId) === uid;
  }

  return assignment?.driverId != null && normalizeId(assignment.driverId) === uid;
}

function matchesOrderRole(
  log: ActivityLog,
  role: VendorEmployeeNotificationRole,
  userId: string,
  orderById: Map<string, OrderAssignment>,
): boolean {
  if (log.entityType !== "order") return false;

  const actionSet = role === "warehouse_worker" ? WORKER_ORDER_ACTIONS : DRIVER_ORDER_ACTIONS;
  if (!actionSet.has(log.action)) return false;

  if (isMetadataTarget(log, role, userId)) return true;

  const order = orderById.get(log.entityId);
  if (!order) return false;

  const uid = normalizeId(userId);
  if (role === "warehouse_worker") {
    return order.warehouseWorkerId != null && normalizeId(order.warehouseWorkerId) === uid;
  }

  return order.driverId != null && normalizeId(order.driverId) === uid;
}

export function filterVendorEmployeeNotifications(
  logs: ActivityLog[],
  role: VendorEmployeeNotificationRole,
  userId: string,
  orderById: Map<string, OrderAssignment>,
): ActivityLog[] {
  return logs.filter((log) => {
    if (isPortalLoginActivity(log)) return false;
    if (isOwnProfileUpdate(log, userId)) return true;
    if (isEmployeeDirectNotification(log, role, userId)) return true;
    return matchesOrderRole(log, role, userId, orderById);
  });
}

const MANAGER_EXCLUDED_ACTIONS = new Set(["order_picking_saved"]);

const VENDOR_PORTAL_ORDER_ACTIONS = new Set([
  "order_created",
  "order_submitted",
  "order_assigned",
  "order_assigned_worker",
  "order_assigned_driver",
  "order_picking_submitted",
  "order_picking_approved",
  "order_substitution_proposed",
  "order_substitution_status_updated",
  "order_delivered",
  "order_issue_reported",
  "order_issue_resolved",
  "order_review_submitted",
  "order_review_resubmitted",
  "order_review_rejected",
  "order_invoiced",
  "order_paid",
  "order_deleted",
  "order_draft_cleared",
  "order_draft_updated",
]);

/** Driver/worker-only alerts — hidden from restaurant (and vendor/super-admin) bells. */
const EMPLOYEE_TARGETED_ACTIONS = new Set([
  "order_assigned_worker",
  "order_assigned_driver",
  "order_picking_submitted_worker",
  "order_issue_pending_driver",
  "order_delivered_driver",
  "order_issue_resolved_driver",
]);

export function filterRestaurantNotifications(logs: ActivityLog[], userId: string): ActivityLog[] {
  return logs.filter((log) => {
    if (isPortalLoginActivity(log)) return false;
    if (isOwnProfileUpdate(log, userId)) return true;
    if (EMPLOYEE_TARGETED_ACTIONS.has(log.action)) return false;
    return true;
  });
}

export function filterManagerNotifications(logs: ActivityLog[], userId: string): ActivityLog[] {
  return logs.filter((log) => {
    if (isPortalLoginActivity(log)) return false;
    if (isOwnProfileUpdate(log, userId)) return true;
    if (MANAGER_EXCLUDED_ACTIONS.has(log.action)) return false;
    if (EMPLOYEE_TARGETED_ACTIONS.has(log.action)) return false;
    if (log.entityType === "order") return VENDOR_PORTAL_ORDER_ACTIONS.has(log.action);
    if (log.entityType === "vendor" || log.entityType === "vendor_employee") return true;
    if (log.entityType === "relationship" || log.entityType === "product") return true;
    return log.action.startsWith("vendor_") || log.action.startsWith("employee_");
  });
}

const SUPER_ADMIN_EXCLUDED_ACTIONS = EMPLOYEE_TARGETED_ACTIONS;

export function filterSuperAdminNotifications(logs: ActivityLog[]): ActivityLog[] {
  return logs.filter(
    (log) => !SUPER_ADMIN_EXCLUDED_ACTIONS.has(log.action) && !isPortalLoginActivity(log),
  );
}

export function filterVendorAdminNotifications(logs: ActivityLog[], userId: string): ActivityLog[] {
  return logs.filter((log) => {
    if (isPortalLoginActivity(log)) return false;
    if (isOwnProfileUpdate(log, userId)) return true;
    if (EMPLOYEE_TARGETED_ACTIONS.has(log.action)) return false;
    if (log.entityType === "order") return VENDOR_PORTAL_ORDER_ACTIONS.has(log.action);
    if (log.entityType === "relationship" || log.entityType === "product") return true;
    if (log.action === "vendor_updated" || log.action === "csv_import_completed") return true;
    return false;
  });
}
