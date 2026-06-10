import { storage } from "../services/storage.js";
import { mergeOrderNotificationMetadata } from "./order-notification-metadata";
import { queueActivityEmails } from "./activity-email-notifications";

export type PortalActivityEntry = {
  action: string;
  entityType: string;
  entityId: string;
  entityName: string;
  vendorId?: string;
  restaurantId?: string;
  metadata?: unknown;
};

async function getOrderLogScope(entityType: string, entityId: string) {
  if (entityType !== "order") return {};
  const order = await storage.getOrder(entityId);
  if (!order) return {};
  return { vendorId: order.vendorId, restaurantId: order.restaurantOrgId };
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
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

export async function enrichPortalActivityEntry(entry: PortalActivityEntry): Promise<PortalActivityEntry> {
  const scope = entry.vendorId && entry.restaurantId
    ? { vendorId: entry.vendorId, restaurantId: entry.restaurantId }
    : await getOrderLogScope(entry.entityType, entry.entityId);

  const vendorId = entry.vendorId ?? scope.vendorId;
  const restaurantId = entry.restaurantId ?? scope.restaurantId;
  const meta = parseMetadata(entry.metadata);

  const orderId = entry.entityType === "order"
    ? entry.entityId
    : meta.orderId != null
      ? String(meta.orderId)
      : undefined;

  let order = orderId ? await storage.getOrder(orderId) : undefined;
  if (!order && entry.entityType === "order") {
    order = await storage.getOrder(entry.entityId);
  }

  const enrichedMeta: Record<string, unknown> = {
    ...(order ? mergeOrderNotificationMetadata(order) : {}),
    ...meta,
  };

  if (orderId && enrichedMeta.orderId == null) enrichedMeta.orderId = orderId;
  if (order?.displayId != null && enrichedMeta.displayId == null) {
    enrichedMeta.displayId = order.displayId;
  }

  if (vendorId && enrichedMeta.vendorName == null) {
    const vendor = await storage.getVendor(vendorId);
    if (vendor?.name) enrichedMeta.vendorName = vendor.name;
  }

  if (restaurantId && enrichedMeta.restaurantName == null) {
    const restaurant = await storage.getRestaurantOrg(restaurantId);
    if (restaurant?.name) enrichedMeta.restaurantName = restaurant.name;
  }

  return {
    ...entry,
    vendorId,
    restaurantId,
    metadata: enrichedMeta,
  };
}

/** Persist activity + queue role-filtered emails (same rules as notification bell). */
export async function recordPortalActivity(entry: PortalActivityEntry): Promise<void> {
  const enriched = await enrichPortalActivityEntry(entry);
  try {
    await storage.createActivityLog({
      action: enriched.action,
      entityType: enriched.entityType,
      entityId: enriched.entityId,
      entityName: enriched.entityName,
      vendorId: enriched.vendorId,
      restaurantId: enriched.restaurantId,
      metadata: enriched.metadata ? JSON.stringify(enriched.metadata) : undefined,
    });
    queueActivityEmails(enriched);
  } catch (err) {
    console.error("[activity]", enriched.action, err);
  }
}

export function recordPortalActivityAsync(entry: PortalActivityEntry): void {
  recordPortalActivity(entry).catch((err) => {
    console.error("[activity] async failed", entry.action, err);
  });
}
