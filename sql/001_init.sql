CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id VARCHAR(36) PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_organizations (
  id VARCHAR(36) PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendor_restaurant_relationships (
  id VARCHAR(36) PRIMARY KEY,
  vendor_id VARCHAR(36) NOT NULL,
  restaurant_org_id VARCHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_relationship_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
  CONSTRAINT fk_relationship_restaurant FOREIGN KEY (restaurant_org_id) REFERENCES restaurant_organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(36) PRIMARY KEY,
  vendor_id VARCHAR(36) NOT NULL,
  name TEXT NOT NULL,
  sku VARCHAR(255) NULL,
  stock_type VARCHAR(50) NULL,
  unit_type TEXT NOT NULL,
  unit_size TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  UNIQUE KEY unique_vendor_sku (vendor_id, sku)
);

CREATE TABLE IF NOT EXISTS vendor_employees (
  id VARCHAR(36) PRIMARY KEY,
  vendor_id VARCHAR(36) NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NULL,
  login_password TEXT NOT NULL,
  roles JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(36) PRIMARY KEY,
  display_id INT NULL UNIQUE,
  restaurant_org_id VARCHAR(36) NOT NULL,
  vendor_id VARCHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  vendor_confirmed_at TIMESTAMP NULL,
  restaurant_confirmed_at TIMESTAMP NULL,
  restaurant_review_submitted_at TIMESTAMP NULL,
  vendor_approved_at TIMESTAMP NULL,
  vendor_rejected_at TIMESTAMP NULL,
  vendor_rejection_reason TEXT NULL,
  paid_at TIMESTAMP NULL,
  CONSTRAINT fk_orders_restaurant FOREIGN KEY (restaurant_org_id) REFERENCES restaurant_organizations(id),
  CONSTRAINT fk_orders_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE TABLE IF NOT EXISTS order_line_items (
  id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  quantity INT NOT NULL,
  unit_price_at_time_of_order DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_oli_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_oli_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS order_line_item_fulfillments (
  id VARCHAR(36) PRIMARY KEY,
  order_line_item_id VARCHAR(36) NOT NULL UNIQUE,
  order_id VARCHAR(36) NOT NULL,
  fulfilled_quantity INT NULL,
  reconciled_unit_price DECIMAL(10,2) NULL,
  fulfillment_status VARCHAR(50) NULL,
  issue_reason VARCHAR(255) NULL,
  restaurant_received_qty INT NULL,
  restaurant_note VARCHAR(500) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fulfillments_line FOREIGN KEY (order_line_item_id) REFERENCES order_line_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_fulfillments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoices (
  id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL UNIQUE,
  display_order_id INT NULL,
  vendor_id VARCHAR(36) NOT NULL,
  restaurant_org_id VARCHAR(36) NOT NULL,
  approved_total DECIMAL(12,2) NOT NULL,
  approved_at TIMESTAMP NOT NULL,
  line_items JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_invoices_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_invoices_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT fk_invoices_restaurant FOREIGN KEY (restaurant_org_id) REFERENCES restaurant_organizations(id)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id VARCHAR(36) PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  entity_name TEXT NOT NULL,
  metadata TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attachments (
  id VARCHAR(36) PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INT NOT NULL,
  file_data LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS internal_notes (
  id VARCHAR(36) PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_sheet_items (
  id VARCHAR(36) PRIMARY KEY,
  relationship_id VARCHAR(36) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_sheet_relationship FOREIGN KEY (relationship_id) REFERENCES vendor_restaurant_relationships(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_sheet_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE KEY unique_order_sheet_item (relationship_id, product_id)
);
