import type { ActivityLog } from "../shared/schema.js";
import {
  isOwnEmployeeLogin,
  isOwnRestaurantLogin,
  isOwnSuperAdminLogin,
  isOwnVendorLogin,
  normalizeNotificationRole,
  parseActivityMetadata,
} from "./notification-filters";

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isSelfActor(log: ActivityLog, viewerId: string, meta: Record<string, unknown>): boolean {
  const uid = normalizeId(viewerId);
  if (meta.actorId != null && normalizeId(meta.actorId) === uid) return true;
  return normalizeId(log.entityId) === uid;
}

const LOGIN_TITLE_BY_ACTION: Record<string, { self: string; audit: string }> = {
  employee_logged_in: { self: "You logged in", audit: "Employee signed in" },
  vendor_logged_in: { self: "You logged in", audit: "Vendor signed in" },
  restaurant_logged_in: { self: "You logged in", audit: "Restaurant signed in" },
  super_admin_logged_in: { self: "You logged in", audit: "Admin signed in" },
};

const PROFILE_TITLE_BY_ACTION: Record<string, { self: string; audit: string }> = {
  employee_profile_updated: { self: "Profile updated", audit: "Employee profile updated" },
  vendor_profile_updated: { self: "Profile updated", audit: "Vendor profile updated" },
  restaurant_profile_updated: { self: "Profile updated", audit: "Restaurant profile updated" },
  super_admin_profile_updated: { self: "Profile updated", audit: "Admin profile updated" },
};

function isOwnPortalLogin(log: ActivityLog, userId: string): boolean {
  return (
    isOwnEmployeeLogin(log, userId) ||
    isOwnVendorLogin(log, userId) ||
    isOwnRestaurantLogin(log, userId) ||
    isOwnSuperAdminLogin(log, userId)
  );
}

export function resolveNotificationDisplayMessage(
  log: ActivityLog,
  viewer: { userId: string; role: string },
): string {
  const meta = parseActivityMetadata(log.metadata);
  const role = normalizeNotificationRole(viewer.role);
  const viewerId = normalizeId(viewer.userId);
  const self = isSelfActor(log, viewerId, meta);

  if (role === "vendor_admin" && meta.vendorSelfMessage) {
    return String(meta.vendorSelfMessage);
  }

  if (self && meta.selfMessage) {
    return String(meta.selfMessage);
  }

  if (role === "super_admin" && meta.othersMessage) {
    return String(meta.othersMessage);
  }

  if (!self && meta.othersMessage) {
    const orderActions = log.entityType === "order" || log.action.startsWith("order_");
    if (
      orderActions &&
      (role === "vendor_admin" ||
        role === "manager" ||
        role === "sales_representative" ||
        role === "restaurant")
    ) {
      return String(meta.othersMessage);
    }
  }

  if (self && log.action.endsWith("_profile_updated")) {
    return "You updated your profile";
  }

  if (role === "super_admin" && log.action.endsWith("_logged_in")) {
    return log.entityName ?? "Activity";
  }

  return log.entityName ?? "Activity";
}

export function resolveNotificationDisplayTitle(
  log: ActivityLog,
  viewer: { userId: string; role: string },
): string | undefined {
  const role = normalizeNotificationRole(viewer.role);
  const self = isOwnPortalLogin(log, viewer.userId);

  const loginTitles = LOGIN_TITLE_BY_ACTION[log.action];
  if (loginTitles) {
    if (self) return loginTitles.self;
    if (role === "super_admin") return loginTitles.audit;
    return undefined;
  }

  const profileTitles = PROFILE_TITLE_BY_ACTION[log.action];
  if (profileTitles) {
    if (self) return profileTitles.self;
    if (role === "super_admin") return profileTitles.audit;
  }

  return undefined;
}

export function enrichNotificationsForViewer<T extends ActivityLog>(
  logs: T[],
  viewer: { userId: string; role: string },
): (T & { displayMessage: string; displayTitle?: string })[] {
  return logs.map((log) => {
    const displayTitle = resolveNotificationDisplayTitle(log, viewer);
    return {
      ...log,
      displayMessage: resolveNotificationDisplayMessage(log, viewer),
      ...(displayTitle ? { displayTitle } : {}),
    };
  });
}
