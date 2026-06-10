import { db } from "../src/lib/db.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    console.log("🔧 Fixing ALL database tables to match Drizzle schema...\n");
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

    // ─── USERS ───
    console.log("=== Fixing users table ===");
    await db.execute(sql`ALTER TABLE users MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE users MODIFY COLUMN username VARCHAR(255) NOT NULL`);
    await db.execute(sql`ALTER TABLE users MODIFY COLUMN password TEXT NOT NULL`);
    console.log("✅ users fixed\n");

    // ─── VENDORS ───
    console.log("=== Fixing vendors table ===");
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN contact_name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN email TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN login_password TEXT`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN phone TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    await db.execute(sql`ALTER TABLE vendors MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ vendors fixed\n");

    // ─── RESTAURANT ORGANIZATIONS ───
    console.log("=== Fixing restaurant_organizations table ===");
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN contact_name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN email TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN login_password TEXT`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN phone TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    await db.execute(sql`ALTER TABLE restaurant_organizations MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ restaurant_organizations fixed\n");

    // ─── VENDOR RESTAURANT RELATIONSHIPS ───
    console.log("=== Fixing vendor_restaurant_relationships table ===");
    await db.execute(sql`ALTER TABLE vendor_restaurant_relationships MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE vendor_restaurant_relationships MODIFY COLUMN vendor_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE vendor_restaurant_relationships MODIFY COLUMN restaurant_org_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE vendor_restaurant_relationships MODIFY COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    await db.execute(sql`ALTER TABLE vendor_restaurant_relationships MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ vendor_restaurant_relationships fixed\n");

    // ─── ORDERS ───
    console.log("=== Fixing orders table ===");
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN display_id INT`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN restaurant_org_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN vendor_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN status TEXT NOT NULL DEFAULT 'draft'`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN vendor_confirmed_at TIMESTAMP NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN restaurant_confirmed_at TIMESTAMP NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN restaurant_review_submitted_at TIMESTAMP NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN vendor_approved_at TIMESTAMP NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN vendor_rejected_at TIMESTAMP NULL`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN vendor_rejection_reason TEXT`);
    await db.execute(sql`ALTER TABLE orders MODIFY COLUMN paid_at TIMESTAMP NULL`);
    console.log("✅ orders fixed\n");

    // ─── ORDER LINE ITEMS ───
    console.log("=== Fixing order_line_items table ===");
    await db.execute(sql`ALTER TABLE order_line_items MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE order_line_items MODIFY COLUMN order_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE order_line_items MODIFY COLUMN product_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE order_line_items MODIFY COLUMN quantity INT NOT NULL`);
    await db.execute(sql`ALTER TABLE order_line_items MODIFY COLUMN unit_price_at_time_of_order DECIMAL(10,2) NOT NULL`);
    console.log("✅ order_line_items fixed\n");

    // ─── INTERNAL NOTES ───
    console.log("=== Fixing internal_notes table ===");
    await db.execute(sql`ALTER TABLE internal_notes MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE internal_notes MODIFY COLUMN entity_type TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE internal_notes MODIFY COLUMN entity_id TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE internal_notes MODIFY COLUMN body TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE internal_notes MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ internal_notes fixed\n");

    // ─── ATTACHMENTS ───
    console.log("=== Fixing attachments table ===");
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN entity_type TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN entity_id TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN file_name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN file_type TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN file_size INT NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN file_data LONGTEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE attachments MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ attachments fixed\n");

    // ─── ACTIVITY LOGS ───
    console.log("=== Fixing activity_logs table ===");
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN action TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN entity_type TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN entity_id TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN entity_name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN vendor_id VARCHAR(36)`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN restaurant_id VARCHAR(36)`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN metadata TEXT`);
    await db.execute(sql`ALTER TABLE activity_logs MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ activity_logs fixed\n");

    // ─── PRODUCTS (already fixed but re-ensure) ───
    console.log("=== Ensuring products table ===");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN vendor_id VARCHAR(36) NOT NULL`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN name TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN sku TEXT`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN stock_type TEXT`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN unit_type TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN unit_size TEXT NOT NULL`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN price DECIMAL(10,2) NOT NULL`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN sort_order INT NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    console.log("✅ products ensured\n");

    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    // Re-seed login data since the id column types changed
    console.log("=== Re-seeding login accounts ===");
    const { hashPassword } = await import("../lib/password");
    const { v4: uuidv4 } = await import("uuid");

    const hashed = hashPassword("password");

    // Check if admin user exists
    const [adminRows] = await db.execute(sql`SELECT id FROM users WHERE username = 'admin'`);
    if (Array.isArray(adminRows) && adminRows.length === 0) {
      await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${uuidv4()}, 'admin', ${hashed})`);
      console.log("  Created admin user");
    } else {
      await db.execute(sql`UPDATE users SET password = ${hashed} WHERE username = 'admin'`);
      console.log("  Updated admin user password");
    }

    // Check vendor
    const [vendorRows] = await db.execute(sql`SELECT id FROM vendors WHERE email = 'vendor@gmail.com'`);
    if (Array.isArray(vendorRows) && vendorRows.length === 0) {
      const vid = uuidv4();
      await db.execute(sql`INSERT INTO vendors (id, name, contact_name, email, login_password, phone, status) VALUES (${vid}, 'Demo Vendor', 'Demo Vendor', 'vendor@gmail.com', ${hashed}, '5551234567', 'active')`);
      console.log("  Created demo vendor");
    } else {
      await db.execute(sql`UPDATE vendors SET login_password = ${hashed} WHERE email = 'vendor@gmail.com'`);
      console.log("  Updated demo vendor password");
    }

    // Check restaurant
    const [restRows] = await db.execute(sql`SELECT id FROM restaurant_organizations WHERE email = 'resturent@gmail.com'`);
    if (Array.isArray(restRows) && restRows.length === 0) {
      const rid = uuidv4();
      await db.execute(sql`INSERT INTO restaurant_organizations (id, name, contact_name, email, login_password, phone, status) VALUES (${rid}, 'Demo Restaurant', 'Demo Restaurant', 'resturent@gmail.com', ${hashed}, '5559876543', 'active')`);
      console.log("  Created demo restaurant");
    } else {
      await db.execute(sql`UPDATE restaurant_organizations SET login_password = ${hashed} WHERE email = 'resturent@gmail.com'`);
      console.log("  Updated demo restaurant password");
    }

    console.log("\n🎉 ALL TABLES FIXED SUCCESSFULLY! Database is now ready.");
  } catch (error) {
    console.error("❌ Error:", error);
  }
  process.exit(0);
}

run();
