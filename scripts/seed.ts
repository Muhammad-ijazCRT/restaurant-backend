import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { hashPassword } from "../src/lib/auth/password";
import { users, vendors, restaurantOrganizations } from "../src/db/schema.js";

const ids = {
  adminUser: "11111111-1111-1111-1111-111111111101",
  vendor: "22222222-2222-2222-2222-222222222201",
  restaurant: "33333333-3333-3333-3333-333333333301",
};

async function clearTables() {
  const tables = [
    "order_line_item_fulfillments",
    "order_substitutions",
    "order_line_items",
    "invoices",
    "order_sheet_items",
    "orders",
    "products",
    "vendor_restaurant_relationships",
    "activity_logs",
    "notification_clearances",
    "attachments",
    "internal_notes",
    "vendor_employees",
    "vendor_cutoff_settings",
    "restaurant_employees",
    "vendors",
    "restaurant_organizations",
    "users",
  ];
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY CASCADE`),
  );
}

async function main() {
  console.log("Clearing existing data...");
  await clearTables();

  const loginPassword = hashPassword("password");

  console.log("Seeding portal login accounts...");
  await db.insert(users).values({
    id: ids.adminUser,
    username: "admin@gmail.com",
    password: loginPassword,
  });

  await db.insert(vendors).values({
    id: ids.vendor,
    name: "Demo Vendor",
    contactName: "Vendor Admin",
    email: "vendor@gmail.com",
    loginPassword,
    phone: "2125550101",
    status: "active",
  });

  await db.insert(restaurantOrganizations).values({
    id: ids.restaurant,
    name: "Demo Restaurant",
    contactName: "Restaurant Admin",
    email: "restaurant@gmail.com",
    loginPassword,
    phone: "3125550101",
    status: "active",
  });

  console.log("\nPortal login credentials (password for all: password):");
  console.log("  Super Admin:  admin@gmail.com      → /super-admin/login");
  console.log("  Restaurant:   restaurant@gmail.com → /restaurant/login");
  console.log("  Vendor:       vendor@gmail.com      → /vendor/login");
  console.log("\nSeed complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
