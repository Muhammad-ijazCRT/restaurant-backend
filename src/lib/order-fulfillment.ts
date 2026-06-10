import { db } from "../db/client.js";
import { orderLineItemFulfillments, orders, type LineFulfillment, type Order } from "../db/schema.js";
import { eq } from "drizzle-orm";

export function isWarehousePickingSaved(
  order: Pick<Order, "pickingStatus"> | null | undefined,
): boolean {
  const status = order?.pickingStatus;
  return status === "in_progress" || status === "review" || status === "approved";
}

function isContaminatedWorkerData(fulfillment: LineFulfillment): boolean {
  const workerNote = fulfillment.issueReason?.trim() ?? "";
  if (!workerNote) return false;
  const vendorNote = fulfillment.warehouseNote?.trim() ?? "";
  if (vendorNote && workerNote === vendorNote) return true;
  if (/^vendor\s+qty/i.test(workerNote)) return true;
  return false;
}

function hasContaminatedWorkerData(fulfillments: LineFulfillment[]): boolean {
  return fulfillments.some(isContaminatedWorkerData);
}

export function sanitizeFulfillmentsForOrder<T extends LineFulfillment>(
  order: Pick<Order, "pickingStatus">,
  fulfillments: T[],
): T[] {
  if (isWarehousePickingSaved(order)) return fulfillments;
  return fulfillments.map((fulfillment) => ({
    ...fulfillment,
    loadedQuantity: null,
    issueReason: null,
  }));
}

export async function clearWarehousePickingFields(orderId: string): Promise<void> {
  await db
    .update(orderLineItemFulfillments)
    .set({
      loadedQuantity: null,
      issueReason: null,
      updatedAt: new Date(),
    })
    .where(eq(orderLineItemFulfillments.orderId, orderId));
}

export async function reconcileFulfillmentsForOrder(
  order: Order,
  fulfillments: LineFulfillment[],
): Promise<LineFulfillment[]> {
  if (order.pickingStatus === "review" || order.pickingStatus === "approved") {
    return fulfillments;
  }

  const contaminated = hasContaminatedWorkerData(fulfillments);
  const hasStaleWorkerData =
    contaminated ||
    fulfillments.some(
      (fulfillment) =>
        fulfillment.loadedQuantity != null ||
        (fulfillment.issueReason != null && fulfillment.issueReason.trim() !== ""),
    );

  if (!hasStaleWorkerData) {
    return fulfillments;
  }

  if (isWarehousePickingSaved(order) && !contaminated) {
    return fulfillments;
  }

  await clearWarehousePickingFields(order.id);
  if (order.status === "submitted" && order.pickingStatus === "in_progress") {
    await db
      .update(orders)
      .set({ pickingStatus: "assigned", updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    order.pickingStatus = "assigned";
  }

  return sanitizeFulfillmentsForOrder(order, fulfillments);
}
