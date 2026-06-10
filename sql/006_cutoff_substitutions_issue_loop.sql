SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'cutoff_at');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN cutoff_at TIMESTAMP NULL AFTER driver_note', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'restaurant_issue_status');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN restaurant_issue_status TEXT NULL AFTER cutoff_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'driver_resolution_note');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN driver_resolution_note TEXT NULL AFTER restaurant_issue_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'driver_resolved_at');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN driver_resolved_at TIMESTAMP NULL AFTER driver_resolution_note', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS order_substitutions (
  id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL,
  order_line_item_id VARCHAR(36) NOT NULL,
  original_product_id VARCHAR(36) NOT NULL,
  substitute_product_id VARCHAR(36) NOT NULL,
  proposed_qty INT NOT NULL,
  note TEXT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
