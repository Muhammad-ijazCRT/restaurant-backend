SET @column_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'vendor_employees'
    AND COLUMN_NAME = 'login_password'
);

SET @add_column_sql := IF(
  @column_exists = 0,
  'ALTER TABLE vendor_employees ADD COLUMN login_password TEXT NULL AFTER phone',
  'SELECT 1'
);

PREPARE add_column_stmt FROM @add_column_sql;
EXECUTE add_column_stmt;
DEALLOCATE PREPARE add_column_stmt;

UPDATE vendor_employees
SET login_password = ''
WHERE login_password IS NULL;

ALTER TABLE vendor_employees
  MODIFY login_password TEXT NOT NULL;
