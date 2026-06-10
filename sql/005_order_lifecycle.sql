SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'warehouse_worker_id'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN warehouse_worker_id VARCHAR(36) NULL AFTER status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'driver_id'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN driver_id VARCHAR(36) NULL AFTER warehouse_worker_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'picking_status'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN picking_status TEXT NULL AFTER driver_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'ready_for_delivery_at'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN ready_for_delivery_at TIMESTAMP NULL AFTER picking_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'driver_note'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN driver_note TEXT NULL AFTER ready_for_delivery_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_item_fulfillments' AND COLUMN_NAME = 'loaded_quantity'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE order_line_item_fulfillments ADD COLUMN loaded_quantity INT NULL AFTER fulfilled_quantity', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_item_fulfillments' AND COLUMN_NAME = 'warehouse_note'
);
SET @sql := IF(@col_exists = 0, 'ALTER TABLE order_line_item_fulfillments ADD COLUMN warehouse_note VARCHAR(500) NULL AFTER issue_reason', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
