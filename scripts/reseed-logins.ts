import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";
import crypto from "crypto";

function generateId(): string {
  return crypto.randomUUID();
}

async function run() {
  try {
    const { hashPassword } = await import("../lib/password");
    const hashed = hashPassword("password");

    console.log("=== Re-seeding login accounts ===");

    // Check if admin user exists
    const [adminRows] = await db.execute(sql`SELECT id FROM users WHERE username = 'admin'`);
    if (Array.isArray(adminRows) && adminRows.length === 0) {
      await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${generateId()}, 'admin', ${hashed})`);
      console.log("  Created admin user");
    } else {
      await db.execute(sql`UPDATE users SET password = ${hashed} WHERE username = 'admin'`);
      console.log("  Updated admin user password");
    }

    // Check vendor
    const [vendorRows] = await db.execute(sql`SELECT id FROM vendors WHERE email = 'vendor@gmail.com'`);
    if (Array.isArray(vendorRows) && vendorRows.length === 0) {
      await db.execute(sql`INSERT INTO vendors (id, name, contact_name, email, login_password, phone, status) VALUES (${generateId()}, 'Demo Vendor', 'Demo Vendor', 'vendor@gmail.com', ${hashed}, '5551234567', 'active')`);
      console.log("  Created demo vendor");
    } else {
      await db.execute(sql`UPDATE vendors SET login_password = ${hashed} WHERE email = 'vendor@gmail.com'`);
      console.log("  Updated demo vendor password");
    }

    // Check restaurant
    const [restRows] = await db.execute(sql`SELECT id FROM restaurant_organizations WHERE email = 'resturent@gmail.com'`);
    if (Array.isArray(restRows) && restRows.length === 0) {
      await db.execute(sql`INSERT INTO restaurant_organizations (id, name, contact_name, email, login_password, phone, status) VALUES (${generateId()}, 'Demo Restaurant', 'Demo Restaurant', 'resturent@gmail.com', ${hashed}, '5559876543', 'active')`);
      console.log("  Created demo restaurant");
    } else {
      await db.execute(sql`UPDATE restaurant_organizations SET login_password = ${hashed} WHERE email = 'resturent@gmail.com'`);
      console.log("  Updated demo restaurant password");
    }

    console.log("\n🎉 Login accounts ready!");
    console.log("  Admin: admin / password");
    console.log("  Vendor: vendor@gmail.com / password");
    console.log("  Restaurant: resturent@gmail.com / password");
  } catch (error) {
    console.error("❌ Error:", error);
  }
  process.exit(0);
}

run();
