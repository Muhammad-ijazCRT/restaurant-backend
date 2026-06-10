import { storage } from "../../services/storage.js";
import {
  employeeCanManageAssignments,
  normalizeExtraPermissions,
  normalizeRelationshipAssignments,
} from "../../lib/permissions/vendor-employee.js";
import {
  normalizeEmployeeRoleList as normalizeRestaurantEmployeeRoles,
  normalizeExtraPermissions as normalizeRestaurantExtraPermissions,
} from "../../lib/permissions/restaurant-employee.js";
import { mergeOrderNotificationMetadata } from "../../lib/activity/order-metadata.js";
import { recordPortalActivity } from "../../lib/activity/portal-activity.js";
import { withActorMessages, type ActivityActor } from "../../lib/activity/notification-messages.js";

function normalizeEmployeeRoles(roles: unknown): string[] {
  if (Array.isArray(roles)) return roles.map(String);
  if (typeof roles !== "string") return [];
  try {
    const parsed = JSON.parse(roles);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return roles.split(",").map((role) => role.trim()).filter(Boolean);
  }
}

function serializeEmployee<T extends { roles: unknown; extraPermissions?: unknown; relationshipAssignments?: unknown }>(
  employee: T,
): Omit<T, "roles" | "extraPermissions" | "relationshipAssignments"> & {
  roles: string[];
  extraPermissions: string[];
  relationshipAssignments: string[];
  canManageAssignments: boolean;
} {
  const roles = normalizeEmployeeRoles(employee.roles);
  return {
    ...employee,
    roles,
    extraPermissions: normalizeExtraPermissions(employee.extraPermissions),
    relationshipAssignments: normalizeRelationshipAssignments(employee.relationshipAssignments),
    canManageAssignments: employeeCanManageAssignments(roles),
  };
}

function serializeRestaurantEmployee<T extends { roles: unknown; extraPermissions?: unknown }>(
  employee: T,
): Omit<T, "roles" | "extraPermissions"> & {
  roles: string[];
  extraPermissions: string[];
} {
  return {
    ...employee,
    roles: normalizeRestaurantEmployeeRoles(employee.roles),
    extraPermissions: normalizeRestaurantExtraPermissions(employee.extraPermissions),
  };
}

async function getOrderLogScope(entityType: string, entityId: string) {
  if (entityType !== "order") return {};
  const order = await storage.getOrder(entityId);
  if (!order) return {};
  return { vendorId: order.vendorId, restaurantId: order.restaurantOrgId };
}

const logPortalActivity = recordPortalActivity;

async function logRestaurantReviewApproved(
  order: { id: string; displayId: number | null; vendorId: string; restaurantOrgId: string },
  restaurantId: string,
  extra: { approvedTotal?: string; lineItemCount?: number } = {},
) {
  const displayId = order.displayId ?? order.id;
  const restaurantOrg = await storage.getRestaurantOrg(restaurantId);
  const restaurantActor: ActivityActor = {
    id: restaurantId,
    name: restaurantOrg?.name ?? "Restaurant",
    role: "restaurant",
  };
  const orderMeta = mergeOrderNotificationMetadata(order, { displayId });
  const reviewMessages = withActorMessages(
    restaurantActor,
    `You submitted the review for order #${displayId} — invoice created`,
    `${restaurantActor.name} submitted the review for order #${displayId} — invoice created`,
    orderMeta,
  );
  const invoiceMessages = withActorMessages(
    restaurantActor,
    `You submitted the review for order #${displayId} — invoice created`,
    `Invoice created for order #${displayId} after ${restaurantActor.name} submitted the review`,
    { ...orderMeta, ...extra },
  );
  await Promise.all([
    logPortalActivity({
      action: "order_review_submitted",
      entityType: "order",
      entityId: order.id,
      entityName: reviewMessages.entityName,
      vendorId: order.vendorId,
      restaurantId: order.restaurantOrgId,
      metadata: reviewMessages.metadata,
    }),
    logPortalActivity({
      action: "order_invoiced",
      entityType: "order",
      entityId: order.id,
      entityName: invoiceMessages.entityName,
      vendorId: order.vendorId,
      restaurantId: order.restaurantOrgId,
      metadata: invoiceMessages.metadata,
    }),
  ]);
}


export {
  normalizeEmployeeRoles,
  serializeEmployee,
  serializeRestaurantEmployee,
  getOrderLogScope,
  logPortalActivity,
  logRestaurantReviewApproved,
};
