import type { LineFulfillment, Order } from "../db/schema.js";
import { isWarehousePickingSaved } from "./order-fulfillment.js";

export function getVendorAdjustedQty(
  fulfillment: LineFulfillment | undefined,
  orderedQty: number,
): number {
  if (fulfillment?.fulfilledQuantity != null) {
    return fulfillment.fulfilledQuantity;
  }
  return orderedQty;
}

export function getSavedLoadedQtyForOrder(
  fulfillment: LineFulfillment | undefined,
  order: Pick<Order, "pickingStatus">,
): number | null {
  if (!isWarehousePickingSaved(order)) return null;
  return fulfillment?.loadedQuantity ?? null;
}

export function getEffectiveLineQty(
  fulfillment: LineFulfillment | undefined,
  orderedQty: number,
  order: Pick<Order, "pickingStatus">,
): number {
  const warehouseQty = getSavedLoadedQtyForOrder(fulfillment, order);
  if (warehouseQty != null) return warehouseQty;
  return getVendorAdjustedQty(fulfillment, orderedQty);
}

export function hasRestaurantReviewAdjustment(
  lineItems: Array<{ id: string; quantity: number }>,
  fulfillmentMap: Map<string, LineFulfillment>,
  reviewItems: Array<{ lineItemId: string; receivedQty?: number | null }>,
  order: Pick<Order, "pickingStatus">,
): boolean {
  for (const lineItem of lineItems) {
    const fulfillment = fulfillmentMap.get(lineItem.id);
    const expectedQty = getEffectiveLineQty(fulfillment, lineItem.quantity, order);
    const reviewItem = reviewItems.find((item) => item.lineItemId === lineItem.id);
    const receivedQty = reviewItem?.receivedQty ?? expectedQty;
    if (receivedQty !== expectedQty) {
      return true;
    }
  }
  return false;
}
