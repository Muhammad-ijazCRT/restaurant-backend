CREATE TABLE IF NOT EXISTS restaurant_employees (
  id VARCHAR(36) PRIMARY KEY,
  restaurant_org_id VARCHAR(36) NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NULL,
  login_password TEXT NOT NULL,
  roles JSON NOT NULL,
  extra_permissions JSON NULL,
  image LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
