-- Clear stale dispute flags on orders that are already invoiced.
-- Some driver-resolved orders kept vendor_rejected_at while status moved to invoiced.

UPDATE orders
SET
  vendor_rejected_at = NULL,
  vendor_rejection_reason = NULL,
  vendor_approved_at = COALESCE(vendor_approved_at, driver_resolved_at, restaurant_review_submitted_at),
  status = 'invoiced'
WHERE (status = 'invoiced' OR driver_resolved_at IS NOT NULL)
  AND vendor_rejected_at IS NOT NULL
  AND paid_at IS NULL;

UPDATE orders o
INNER JOIN invoices i ON i.order_id = o.id
SET
  o.vendor_rejected_at = NULL,
  o.vendor_rejection_reason = NULL,
  o.vendor_approved_at = COALESCE(o.vendor_approved_at, i.approved_at),
  o.status = CASE WHEN o.paid_at IS NOT NULL THEN o.status ELSE 'invoiced' END
WHERE o.vendor_rejected_at IS NOT NULL
  AND o.paid_at IS NULL;
