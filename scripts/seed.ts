import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import mysql from "mysql2/promise";
import { db } from "../src/db/client.js";
import { getDatabaseConfig } from "../src/db/config";
import { hashPassword } from "../src/lib/auth/password";
import {
  users,
  vendors,
  restaurantOrganizations,
  vendorRestaurantRelationships,
  products,
  orders,
  orderLineItems,
  orderLineItemFulfillments,
  invoices,
  activityLogs,
  attachments,
  internalNotes,
  orderSheetItems,
  type InvoiceLineItemSnapshot,
} from "../src/db/schema.js";

const ids = {
  adminUser: "11111111-1111-1111-1111-111111111101",
  vendor1: "22222222-2222-2222-2222-222222222201",
  vendor2: "22222222-2222-2222-2222-222222222202",
  vendor3: "22222222-2222-2222-2222-222222222203",
  restaurant1: "33333333-3333-3333-3333-333333333301",
  restaurant2: "33333333-3333-3333-3333-333333333302",
  restaurant3: "33333333-3333-3333-3333-333333333303",
  rel1: "44444444-4444-4444-4444-444444444401",
  rel2: "44444444-4444-4444-4444-444444444402",
  rel3: "44444444-4444-4444-4444-444444444403",
  rel4: "44444444-4444-4444-4444-444444444404",
  prodV1A: "55555555-5555-5555-5555-555555555501",
  prodV1B: "55555555-5555-5555-5555-555555555502",
  prodV1C: "55555555-5555-5555-5555-555555555503",
  prodV2A: "55555555-5555-5555-5555-555555555504",
  prodV2B: "55555555-5555-5555-5555-555555555505",
  prodV3A: "55555555-5555-5555-5555-555555555506",
  prodV3B: "55555555-5555-5555-5555-555555555507",
  orderDraft: "66666666-6666-6666-6666-666666666601",
  orderSubmitted: "66666666-6666-6666-6666-666666666602",
  orderDelivered: "66666666-6666-6666-6666-666666666603",
  orderApproved: "66666666-6666-6666-6666-666666666604",
  orderPaid: "66666666-6666-6666-6666-666666666605",
  orderDisputed: "66666666-6666-6666-6666-666666666606",
  oliDraft1: "77777777-7777-7777-7777-777777777701",
  oliSubmitted1: "77777777-7777-7777-7777-777777777702",
  oliSubmitted2: "77777777-7777-7777-7777-777777777703",
  oliDelivered1: "77777777-7777-7777-7777-777777777704",
  oliDelivered2: "77777777-7777-7777-7777-777777777705",
  oliApproved1: "77777777-7777-7777-7777-777777777706",
  oliApproved2: "77777777-7777-7777-7777-777777777707",
  oliPaid1: "77777777-7777-7777-7777-777777777708",
  oliPaid2: "77777777-7777-7777-7777-777777777709",
  oliDisputed1: "77777777-7777-7777-7777-777777777710",
  invoiceApproved: "88888888-8888-8888-8888-888888888801",
  invoicePaid: "88888888-8888-8888-8888-888888888802",
};

async function ensureDatabaseExists() {
  const config = getDatabaseConfig();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: true,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }
}

async function clearTables() {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  const tables = [
    "order_line_item_fulfillments",
    "order_line_items",
    "invoices",
    "order_sheet_items",
    "orders",
    "products",
    "vendor_restaurant_relationships",
    "activity_logs",
    "attachments",
    "internal_notes",
    "vendors",
    "restaurant_organizations",
    "users",
  ];
  for (const table of tables) {
    await db.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function main() {
  await ensureDatabaseExists();
  console.log("Clearing existing data...");
  await clearTables();

  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  const loginPassword = hashPassword("password");

  console.log("Seeding portal login accounts...");
  await db.insert(users).values({
    id: ids.adminUser,
    username: "admin@gmail.com",
    password: loginPassword,
  });

  console.log("Seeding vendors...");
  await db.insert(vendors).values([
    {
      id: ids.vendor1,
      name: "Demo Vendor",
      contactName: "Ali Raza",
      email: "vendor@gmail.com",
      loginPassword,
      phone: "2125550101",
      status: "active",
      createdAt: daysAgo(30),
    },
    {
      id: ids.vendor2,
      name: "Metro Dairy Co.",
      contactName: "Sarah Johnson",
      email: "metro@example.com",
      phone: "2125550102",
      status: "active",
      createdAt: daysAgo(25),
    },
    {
      id: ids.vendor3,
      name: "Coastal Seafood",
      contactName: "Mike Chen",
      email: "coastal@example.com",
      phone: "2125550103",
      status: "active",
      createdAt: daysAgo(20),
    },
  ]);

  console.log("Seeding restaurant organizations...");
  await db.insert(restaurantOrganizations).values([
    {
      id: ids.restaurant1,
      name: "Demo Restaurant",
      contactName: "Ahmed Khan",
      email: "restaurant@gmail.com",
      loginPassword,
      phone: "3125550101",
      status: "active",
      createdAt: daysAgo(28),
    },
    {
      id: ids.restaurant2,
      name: "Urban Bites",
      contactName: "Emily Davis",
      email: "urban@example.com",
      phone: "3125550102",
      status: "active",
      createdAt: daysAgo(22),
    },
    {
      id: ids.restaurant3,
      name: "Harbor Grill",
      contactName: "James Wilson",
      email: "harbor@example.com",
      phone: "3125550103",
      status: "active",
      createdAt: daysAgo(15),
    },
  ]);

  console.log("Seeding relationships...");
  await db.insert(vendorRestaurantRelationships).values([
    { id: ids.rel1, vendorId: ids.vendor1, restaurantOrgId: ids.restaurant1, status: "active", createdAt: daysAgo(27) },
    { id: ids.rel2, vendorId: ids.vendor1, restaurantOrgId: ids.restaurant2, status: "active", createdAt: daysAgo(20) },
    { id: ids.rel3, vendorId: ids.vendor2, restaurantOrgId: ids.restaurant1, status: "active", createdAt: daysAgo(18) },
    { id: ids.rel4, vendorId: ids.vendor3, restaurantOrgId: ids.restaurant3, status: "active", createdAt: daysAgo(12) },
  ]);

  console.log("Seeding products...");
  await db.insert(products).values([
    { id: ids.prodV1A, vendorId: ids.vendor1, name: "Chicken Breast", sku: "CHK-BRST-01", stockType: "Refrigerated", unitType: "lb", unitSize: "1", price: "8.50", status: "active", sortOrder: 0, createdAt: daysAgo(26) },
    { id: ids.prodV1B, vendorId: ids.vendor1, name: "Roma Tomatoes", sku: "VEG-TOM-01", stockType: "Dry", unitType: "case", unitSize: "25", price: "32.00", status: "active", sortOrder: 1, createdAt: daysAgo(26) },
    { id: ids.prodV1C, vendorId: ids.vendor1, name: "Cooking Oil", sku: "OIL-5GAL-01", stockType: "Dry", unitType: "gal", unitSize: "5", price: "22.00", status: "active", sortOrder: 2, createdAt: daysAgo(25) },
    { id: ids.prodV2A, vendorId: ids.vendor2, name: "Whole Milk", sku: "MLK-WHL-01", stockType: "Refrigerated", unitType: "gal", unitSize: "1", price: "4.25", status: "active", sortOrder: 0, createdAt: daysAgo(24) },
    { id: ids.prodV2B, vendorId: ids.vendor2, name: "Cheddar Cheese", sku: "CHS-CHD-01", stockType: "Refrigerated", unitType: "lb", unitSize: "5", price: "18.75", status: "active", sortOrder: 1, createdAt: daysAgo(24) },
    { id: ids.prodV3A, vendorId: ids.vendor3, name: "Atlantic Salmon", sku: "FSH-SAL-01", stockType: "Frozen", unitType: "lb", unitSize: "1", price: "14.99", status: "active", sortOrder: 0, createdAt: daysAgo(19) },
    { id: ids.prodV3B, vendorId: ids.vendor3, name: "Jumbo Shrimp", sku: "FSH-SHR-01", stockType: "Frozen", unitType: "lb", unitSize: "2", price: "19.50", status: "active", sortOrder: 1, createdAt: daysAgo(19) },
  ]);

  console.log("Seeding order sheet items...");
  await db.insert(orderSheetItems).values([
    { id: randomUUID(), relationshipId: ids.rel1, productId: ids.prodV1A, createdAt: daysAgo(15) },
    { id: randomUUID(), relationshipId: ids.rel1, productId: ids.prodV1B, createdAt: daysAgo(15) },
    { id: randomUUID(), relationshipId: ids.rel1, productId: ids.prodV1C, createdAt: daysAgo(14) },
    { id: randomUUID(), relationshipId: ids.rel3, productId: ids.prodV2A, createdAt: daysAgo(10) },
  ]);

  console.log("Seeding orders...");
  await db.insert(orders).values([
    {
      id: ids.orderDraft,
      displayId: 1001,
      restaurantOrgId: ids.restaurant1,
      vendorId: ids.vendor1,
      status: "draft",
      createdAt: daysAgo(2),
    },
    {
      id: ids.orderSubmitted,
      displayId: 1002,
      restaurantOrgId: ids.restaurant2,
      vendorId: ids.vendor1,
      status: "submitted",
      createdAt: daysAgo(5),
    },
    {
      id: ids.orderDelivered,
      displayId: 1003,
      restaurantOrgId: ids.restaurant1,
      vendorId: ids.vendor1,
      status: "delivered",
      createdAt: daysAgo(8),
      vendorConfirmedAt: daysAgo(6),
      restaurantReviewSubmittedAt: daysAgo(5),
    },
    {
      id: ids.orderApproved,
      displayId: 1004,
      restaurantOrgId: ids.restaurant1,
      vendorId: ids.vendor2,
      status: "delivered",
      createdAt: daysAgo(12),
      vendorConfirmedAt: daysAgo(10),
      restaurantReviewSubmittedAt: daysAgo(9),
      vendorApprovedAt: daysAgo(8),
    },
    {
      id: ids.orderPaid,
      displayId: 1005,
      restaurantOrgId: ids.restaurant3,
      vendorId: ids.vendor3,
      status: "delivered",
      createdAt: daysAgo(14),
      vendorConfirmedAt: daysAgo(12),
      restaurantReviewSubmittedAt: daysAgo(11),
      vendorApprovedAt: daysAgo(10),
      paidAt: daysAgo(7),
    },
    {
      id: ids.orderDisputed,
      displayId: 1006,
      restaurantOrgId: ids.restaurant2,
      vendorId: ids.vendor1,
      status: "delivered",
      createdAt: daysAgo(9),
      vendorConfirmedAt: daysAgo(7),
      restaurantReviewSubmittedAt: daysAgo(6),
      vendorRejectedAt: daysAgo(5),
      vendorRejectionReason: "Received quantities do not match delivery receipt.",
    },
  ]);

  console.log("Seeding order line items...");
  await db.insert(orderLineItems).values([
    { id: ids.oliDraft1, orderId: ids.orderDraft, productId: ids.prodV1A, quantity: 20, unitPriceAtTimeOfOrder: "8.50" },
    { id: ids.oliSubmitted1, orderId: ids.orderSubmitted, productId: ids.prodV1B, quantity: 4, unitPriceAtTimeOfOrder: "32.00" },
    { id: ids.oliSubmitted2, orderId: ids.orderSubmitted, productId: ids.prodV1C, quantity: 2, unitPriceAtTimeOfOrder: "22.00" },
    { id: ids.oliDelivered1, orderId: ids.orderDelivered, productId: ids.prodV1A, quantity: 15, unitPriceAtTimeOfOrder: "8.50" },
    { id: ids.oliDelivered2, orderId: ids.orderDelivered, productId: ids.prodV1C, quantity: 3, unitPriceAtTimeOfOrder: "22.00" },
    { id: ids.oliApproved1, orderId: ids.orderApproved, productId: ids.prodV2A, quantity: 10, unitPriceAtTimeOfOrder: "4.25" },
    { id: ids.oliApproved2, orderId: ids.orderApproved, productId: ids.prodV2B, quantity: 2, unitPriceAtTimeOfOrder: "18.75" },
    { id: ids.oliPaid1, orderId: ids.orderPaid, productId: ids.prodV3A, quantity: 8, unitPriceAtTimeOfOrder: "14.99" },
    { id: ids.oliPaid2, orderId: ids.orderPaid, productId: ids.prodV3B, quantity: 5, unitPriceAtTimeOfOrder: "19.50" },
    { id: ids.oliDisputed1, orderId: ids.orderDisputed, productId: ids.prodV1A, quantity: 12, unitPriceAtTimeOfOrder: "8.50" },
  ]);

  console.log("Seeding fulfillments...");
  await db.insert(orderLineItemFulfillments).values([
    {
      id: randomUUID(),
      orderLineItemId: ids.oliDelivered1,
      orderId: ids.orderDelivered,
      restaurantReceivedQty: 14,
      restaurantNote: "One case short",
      fulfillmentStatus: "partial",
      updatedAt: daysAgo(5),
    },
    {
      id: randomUUID(),
      orderLineItemId: ids.oliDelivered2,
      orderId: ids.orderDelivered,
      restaurantReceivedQty: 3,
      restaurantNote: null,
      fulfillmentStatus: "fulfilled",
      updatedAt: daysAgo(5),
    },
    {
      id: randomUUID(),
      orderLineItemId: ids.oliApproved1,
      orderId: ids.orderApproved,
      restaurantReceivedQty: 10,
      restaurantNote: null,
      fulfillmentStatus: "fulfilled",
      updatedAt: daysAgo(9),
    },
    {
      id: randomUUID(),
      orderLineItemId: ids.oliApproved2,
      orderId: ids.orderApproved,
      restaurantReceivedQty: 2,
      restaurantNote: null,
      fulfillmentStatus: "fulfilled",
      updatedAt: daysAgo(9),
    },
    {
      id: randomUUID(),
      orderLineItemId: ids.oliPaid1,
      orderId: ids.orderPaid,
      restaurantReceivedQty: 8,
      restaurantNote: null,
      fulfillmentStatus: "fulfilled",
      updatedAt: daysAgo(11),
    },
    {
      id: randomUUID(),
      orderLineItemId: ids.oliPaid2,
      orderId: ids.orderPaid,
      restaurantReceivedQty: 5,
      restaurantNote: null,
      fulfillmentStatus: "fulfilled",
      updatedAt: daysAgo(11),
    },
    {
      id: randomUUID(),
      orderLineItemId: ids.oliDisputed1,
      orderId: ids.orderDisputed,
      restaurantReceivedQty: 8,
      restaurantNote: "Only 8 of 12 received",
      fulfillmentStatus: "partial",
      updatedAt: daysAgo(6),
    },
  ]);

  console.log("Seeding invoices...");
  const approvedLineItems: InvoiceLineItemSnapshot[] = [
    {
      orderLineItemId: ids.oliApproved1,
      productId: ids.prodV2A,
      productName: "Whole Milk",
      sku: "MLK-WHL-01",
      approvedQty: 10,
      unitPrice: "4.25",
      lineTotal: "42.50",
      restaurantNote: null,
    },
    {
      orderLineItemId: ids.oliApproved2,
      productId: ids.prodV2B,
      productName: "Cheddar Cheese",
      sku: "CHS-CHD-01",
      approvedQty: 2,
      unitPrice: "18.75",
      lineTotal: "37.50",
      restaurantNote: null,
    },
  ];

  const paidLineItems: InvoiceLineItemSnapshot[] = [
    {
      orderLineItemId: ids.oliPaid1,
      productId: ids.prodV3A,
      productName: "Atlantic Salmon",
      sku: "FSH-SAL-01",
      approvedQty: 8,
      unitPrice: "14.99",
      lineTotal: "119.92",
      restaurantNote: null,
    },
    {
      orderLineItemId: ids.oliPaid2,
      productId: ids.prodV3B,
      productName: "Jumbo Shrimp",
      sku: "FSH-SHR-01",
      approvedQty: 5,
      unitPrice: "19.50",
      lineTotal: "97.50",
      restaurantNote: null,
    },
  ];

  await db.insert(invoices).values([
    {
      id: ids.invoiceApproved,
      orderId: ids.orderApproved,
      displayOrderId: 1004,
      vendorId: ids.vendor2,
      restaurantOrgId: ids.restaurant1,
      approvedTotal: "80.00",
      approvedAt: daysAgo(8),
      lineItems: approvedLineItems,
      createdAt: daysAgo(8),
    },
    {
      id: ids.invoicePaid,
      orderId: ids.orderPaid,
      displayOrderId: 1005,
      vendorId: ids.vendor3,
      restaurantOrgId: ids.restaurant3,
      approvedTotal: "217.42",
      approvedAt: daysAgo(10),
      lineItems: paidLineItems,
      createdAt: daysAgo(10),
    },
  ]);

  console.log("Seeding activity logs...");
  await db.insert(activityLogs).values([
    { id: randomUUID(), action: "vendor_created", entityType: "vendor", entityId: ids.vendor1, entityName: "Fresh Farms Supply", createdAt: daysAgo(30) },
    { id: randomUUID(), action: "vendor_created", entityType: "vendor", entityId: ids.vendor2, entityName: "Metro Dairy Co.", createdAt: daysAgo(25) },
    { id: randomUUID(), action: "restaurant_created", entityType: "restaurant_org", entityId: ids.restaurant1, entityName: "Spice Kitchen", createdAt: daysAgo(28) },
    { id: randomUUID(), action: "restaurant_created", entityType: "restaurant_org", entityId: ids.restaurant2, entityName: "Urban Bites", createdAt: daysAgo(22) },
    { id: randomUUID(), action: "relationship_created", entityType: "relationship", entityId: ids.rel1, entityName: "Fresh Farms Supply ↔ Spice Kitchen", createdAt: daysAgo(27) },
    { id: randomUUID(), action: "relationship_created", entityType: "relationship", entityId: ids.rel2, entityName: "Fresh Farms Supply ↔ Urban Bites", createdAt: daysAgo(20) },
    {
      id: randomUUID(),
      action: "order_paid",
      entityType: "order",
      entityId: ids.orderPaid,
      entityName: "#1005",
      metadata: JSON.stringify({
        restaurantName: "Harbor Grill",
        vendorName: "Coastal Seafood",
        amount: "217.42",
        displayOrderId: 1005,
      }),
      createdAt: daysAgo(7),
    },
    {
      id: randomUUID(),
      action: "csv_import_completed",
      entityType: "vendor",
      entityId: ids.vendor1,
      entityName: "Fresh Farms Supply",
      metadata: JSON.stringify({ imported: 12, rejected: 1, total: 13 }),
      createdAt: daysAgo(24),
    },
  ]);

  console.log("Seeding internal notes...");
  await db.insert(internalNotes).values([
    {
      id: randomUUID(),
      entityType: "vendor",
      entityId: ids.vendor1,
      body: "Preferred delivery window: 6–9 AM. Contact Ali for urgent orders.",
      createdAt: daysAgo(20),
    },
    {
      id: randomUUID(),
      entityType: "restaurant_org",
      entityId: ids.restaurant1,
      body: "New location opening next month — may need additional vendor links.",
      createdAt: daysAgo(10),
    },
    {
      id: randomUUID(),
      entityType: "relationship",
      entityId: ids.rel1,
      body: "Standing weekly order every Monday. Review pricing quarterly.",
      createdAt: daysAgo(14),
    },
  ]);

  console.log("Seeding attachments...");
  const tinyPdfBase64 = Buffer.from("%PDF-1.0 sample contract").toString("base64");
  await db.insert(attachments).values([
    {
      id: randomUUID(),
      entityType: "vendor",
      entityId: ids.vendor1,
      fileName: "supply-agreement.pdf",
      fileType: "application/pdf",
      fileSize: 128,
      fileData: tinyPdfBase64,
      createdAt: daysAgo(18),
    },
    {
      id: randomUUID(),
      entityType: "restaurant_org",
      entityId: ids.restaurant1,
      fileName: "health-permit.pdf",
      fileType: "application/pdf",
      fileSize: 128,
      fileData: tinyPdfBase64,
      createdAt: daysAgo(12),
    },
  ]);

  console.log("\nPortal login credentials (password for all: password):");
  console.log("  Super Admin:  admin@gmail.com      → /super-admin/login");
  console.log("  Restaurant:   restaurant@gmail.com → /restaurant/login");
  console.log("  Vendor:       vendor@gmail.com      → /vendor/login");

  console.log("\nSeed complete! Summary:");
  console.log("  users:                        1");
  console.log("  vendors:                      3");
  console.log("  restaurant_organizations:     3");
  console.log("  vendor_restaurant_relationships: 4");
  console.log("  products:                     7");
  console.log("  order_sheet_items:            4");
  console.log("  orders:                       6 (draft, submitted, delivered, approved, paid, disputed)");
  console.log("  order_line_items:            10");
  console.log("  order_line_item_fulfillments: 7");
  console.log("  invoices:                     2");
  console.log("  activity_logs:                8");
  console.log("  internal_notes:               3");
  console.log("  attachments:                  2");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  if (err && typeof err === "object" && "code" in err && err.code === "ECONNREFUSED") {
    console.error("\nCould not connect to MySQL. Start XAMPP, create database in .env (DB_NAME), then run: pnpm run db:migrate && pnpm run db:seed");
  }
  process.exit(1);
});
