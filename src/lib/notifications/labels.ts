export const NOTIFICATION_ACTION_LABELS: Record<string, string> = {
  order_created: "Order created",
  order_submitted: "Order placed",
  order_assigned: "Order assigned",
  order_assigned_worker: "Order assigned to you",
  order_assigned_driver: "Order assigned to you",
  order_picking_submitted_worker: "Picking submitted",
  order_issue_pending_driver: "Issue needs your review",
  order_delivered_driver: "Order delivered",
  order_issue_resolved_driver: "Issue resolved",
  order_delivered: "Order delivered",
  order_paid: "Order payment recorded",
  order_review_rejected: "Order review rejected",
  order_picking_saved: "Picking saved",
  order_picking_submitted: "Picking submitted",
  order_picking_approved: "Ready for delivery",
  order_substitution_proposed: "Substitution proposed",
  order_invoiced: "Order invoiced",
  order_issue_resolved: "Issue resolved",
  order_review_submitted: "Review submitted",
  order_review_resubmitted: "Review resubmitted",
  order_issue_reported: "Issue reported",
  order_draft_cleared: "Draft order cleared",
  order_draft_updated: "Draft order updated",
  order_substitution_status_updated: "Substitution status updated",
  order_deleted: "Order deleted",
};

export function notificationActionLabel(action: string): string {
  return NOTIFICATION_ACTION_LABELS[action] ?? "Portal update";
}
