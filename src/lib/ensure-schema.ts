import { sql } from "drizzle-orm";
import { db } from "./db.js";

export async function ensureNotificationClearancesTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS notification_clearances (
      viewer_key VARCHAR(128) NOT NULL PRIMARY KEY,
      cleared_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function ensureRestaurantEmployeesTable(): Promise<void> {
  await db.execute(sql`
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
    )
  `);

  try {
    await db.execute(sql`
      ALTER TABLE restaurant_employees
      ADD COLUMN phone TEXT NULL AFTER email
    `);
  } catch {
    // Column already exists.
  }

  try {
    await db.execute(sql`
      ALTER TABLE restaurant_employees
      ADD COLUMN image LONGTEXT NULL AFTER extra_permissions
    `);
  } catch {
    // Column already exists.
  }
}

export async function ensureVendorEmployeePermissionColumns(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE vendor_employees
      ADD COLUMN extra_permissions JSON NULL AFTER roles
    `);
  } catch {
    // Column already exists.
  }

  try {
    await db.execute(sql`
      ALTER TABLE vendor_employees
      ADD COLUMN relationship_assignments JSON NULL AFTER extra_permissions
    `);
  } catch {
    // Column already exists.
  }
}
