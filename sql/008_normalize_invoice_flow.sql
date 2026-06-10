-- Normalize existing order states for the restaurant-first invoicing flow.
-- Restaurant review submission or driver resolution should end in invoiced.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'restaurant_issue_status'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN restaurant_issue_status TEXT NULL AFTER cutoff_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'driver_resolution_note'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN driver_resolution_note TEXT NULL AFTER restaurant_issue_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'driver_resolved_at'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN driver_resolved_at TIMESTAMP NULL AFTER driver_resolution_note', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE orders
SET status = 'invoiced'
WHERE vendor_approved_at IS NOT NULL;

UPDATE orders
SET status = 'delivered'
WHERE status IS NULL OR status = '';

UPDATE orders
SET restaurant_issue_status = 'pending_driver'
WHERE restaurant_review_submitted_at IS NOT NULL
  AND restaurant_issue_status IS NULL
  AND vendor_approved_at IS NULL
  AND vendor_rejected_at IS NULL
  AND driver_resolved_at IS NULL;

UPDATE orders
SET restaurant_issue_status = 'resolved_by_driver',
    status = 'invoiced'
WHERE driver_resolved_at IS NOT NULL
  AND vendor_approved_at IS NULL;

-- Ensure invoices exist for every invoiced order.
INSERT INTO invoices (id, order_id, display_order_id, vendor_id, restaurant_org_id, approved_total, approved_at, line_items, created_at)
SELECT
  UUID(),
  o.id,
  o.display_id,
  o.vendor_id,
  o.restaurant_org_id,
  '0.00',
  COALESCE(o.vendor_approved_at, o.driver_resolved_at, o.restaurant_review_submitted_at, o.created_at),
  JSON_ARRAY(),
  NOW()
FROM orders o
WHERE o.vendor_approved_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.order_id = o.id
  );
