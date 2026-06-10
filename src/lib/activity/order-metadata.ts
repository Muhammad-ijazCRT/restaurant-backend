export function orderAssignmentMetadata(order: {
  warehouseWorkerId?: string | null;
  driverId?: string | null;
}): {
  warehouseWorkerId?: string;
  driverId?: string;
} {
  const metadata: { warehouseWorkerId?: string; driverId?: string } = {};
  if (order.warehouseWorkerId) metadata.warehouseWorkerId = order.warehouseWorkerId;
  if (order.driverId) metadata.driverId = order.driverId;
  return metadata;
}

export function mergeOrderNotificationMetadata(
  order: { warehouseWorkerId?: string | null; driverId?: string | null },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...orderAssignmentMetadata(order), ...extra };
}
