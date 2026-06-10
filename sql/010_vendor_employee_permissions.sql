SET @extra_permissions_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'vendor_employees'
    AND COLUMN_NAME = 'extra_permissions'
);
SET @sql := IF(
  @extra_permissions_exists = 0,
  'ALTER TABLE vendor_employees ADD COLUMN extra_permissions JSON NULL AFTER roles',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @relationship_assignments_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'vendor_employees'
    AND COLUMN_NAME = 'relationship_assignments'
);
SET @sql := IF(
  @relationship_assignments_exists = 0,
  'ALTER TABLE vendor_employees ADD COLUMN relationship_assignments JSON NULL AFTER extra_permissions',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE vendor_employees
SET extra_permissions = JSON_ARRAY()
WHERE extra_permissions IS NULL;

UPDATE vendor_employees
SET relationship_assignments = JSON_ARRAY()
WHERE relationship_assignments IS NULL;
