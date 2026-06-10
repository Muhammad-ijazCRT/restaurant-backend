import {
  mysqlTable,
  text,
  varchar,
  timestamp,
  decimal,
  uniqueIndex,
  int,
  json,
  longtext,
} from "drizzle-orm/mysql-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const internalNotes = mysqlTable("internal_notes", {
  id: varchar("id", { length: 36 }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInternalNoteSchema = createInsertSchema(internalNotes).omit({
  id: true,
  createdAt: true,
}).extend({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  body: z.string().min(1, "Note text is required").max(5000, "Note must be 5,000 characters or fewer"),
});

export type InsertInternalNote = z.infer<typeof insertInternalNoteSchema>;
export type InternalNote = typeof internalNotes.$inferSelect;

export const attachments = mysqlTable("attachments", {
  id: varchar("id", { length: 36 }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: int("file_size").notNull(),
  fileData: longtext("file_data").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Attachment = typeof attachments.$inferSelect;
export type AttachmentMeta = Omit<Attachment, "fileData">;

export type ActivityAction = string;

export type ActivityEntityType = string;

export const activityLogs = mysqlTable("activity_logs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  entityName: text("entity_name").notNull(),
  vendorId: varchar("vendor_id", { length: 36 }),
  restaurantId: varchar("restaurant_id", { length: 36 }),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ActivityLog = typeof activityLogs.$inferSelect;

export const notificationClearances = mysqlTable("notification_clearances", {
  viewerKey: varchar("viewer_key", { length: 128 }).primaryKey(),
  clearedAt: timestamp("cleared_at").notNull(),
});

export type NotificationClearance = typeof notificationClearances.$inferSelect;

export function normalizePhoneDigits(phone: unknown): string {
  if (phone == null) return "";
  if (typeof phone === "string" || typeof phone === "number") {
    return String(phone).replace(/\D/g, "");
  }
  if (typeof phone === "object" && "toString" in phone) {
    return String(phone).replace(/\D/g, "");
  }
  return "";
}

const phoneSchema = z.coerce
  .string()
  .transform((val) => normalizePhoneDigits(val))
  .pipe(z.string().length(10, "Phone must be exactly 10 digits"));

export function formatPhone(phone: unknown): string {
  const digits = normalizePhoneDigits(phone);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return String(phone ?? "");
}

export const users = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  username: varchar("username", { length: 255 }).notNull().unique(), // Acts as email/login
  name: text("name"),
  phone: text("phone"),
  password: text("password").notNull(),
  image: longtext("image"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const vendors = mysqlTable("vendors", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  loginPassword: text("login_password"),
  phone: text("phone").notNull(),
  status: text("status").notNull().default("active"),
  image: longtext("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVendorSchema = createInsertSchema(vendors).omit({
  id: true,
  createdAt: true,
}).extend({
  name: z.string().min(1, "Name is required"),
  contactName: z.string().min(1, "Contact name is required"),
  email: z.string().trim().min(1, "Email is required").email("Please enter a valid email address"),
  phone: phoneSchema,
  status: z.enum(["active", "inactive", "archived"]).default("active"),
});

export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendors.$inferSelect;

export const vendorEmployees = mysqlTable("vendor_employees", {
  id: varchar("id", { length: 36 }).primaryKey(),
  vendorId: varchar("vendor_id", { length: 36 }).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  loginPassword: text("login_password").notNull(),
  roles: json("roles").notNull().$type<string[]>(),
  extraPermissions: json("extra_permissions").$type<string[]>().default([]),
  relationshipAssignments: json("relationship_assignments").$type<string[]>().default([]),
  image: longtext("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVendorEmployeeSchema = createInsertSchema(vendorEmployees).omit({
  id: true,
  createdAt: true,
}).extend({
  vendorId: z.string().min(1, "Vendor is required"),
  name: z.string().min(1, "Name is required"),
  email: z.string().trim().min(1, "Email is required").email("Please enter a valid email address"),
  phone: z.string().trim().optional().nullable(),
  loginPassword: z.string().min(8, "Password must be at least 8 characters"),
  roles: z
    .array(z.enum(["manager", "driver", "warehouse", "sales_representative"]))
    .min(1, "Select at least one role"),
  extraPermissions: z.array(z.string()).optional(),
  relationshipAssignments: z.array(z.string()).optional(),
});

export type InsertVendorEmployee = z.infer<typeof insertVendorEmployeeSchema>;
export type VendorEmployee = typeof vendorEmployees.$inferSelect;

export const vendorCutoffSettings = mysqlTable("vendor_cutoff_settings", {
  id: varchar("id", { length: 36 }).primaryKey(),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => vendors.id, { onDelete: "cascade" }).unique(),
  cutoffHour: int("cutoff_hour").notNull().default(17),
  cutoffMinute: int("cutoff_minute").notNull().default(0),
  isEnabled: int("is_enabled").notNull().default(1),
  reminderMessage: varchar("reminder_message", { length: 500 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorCutoffSettingsSchema = createInsertSchema(vendorCutoffSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  vendorId: z.string().min(1, "Vendor is required"),
  cutoffHour: z.number().int().min(0).max(23).default(17),
  cutoffMinute: z.number().int().min(0).max(59).default(0),
  isEnabled: z.boolean().default(true),
  reminderMessage: z.string().max(500).nullable().optional(),
});

export type InsertVendorCutoffSettings = z.infer<typeof insertVendorCutoffSettingsSchema>;
export type VendorCutoffSettings = typeof vendorCutoffSettings.$inferSelect;

export const restaurantOrganizations = mysqlTable("restaurant_organizations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  loginPassword: text("login_password"),
  phone: text("phone").notNull(),
  status: text("status").notNull().default("active"),
  image: longtext("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRestaurantOrgSchema = createInsertSchema(restaurantOrganizations).omit({
  id: true,
  createdAt: true,
}).extend({
  name: z.string().min(1, "Name is required"),
  contactName: z.string().min(1, "Contact name is required"),
  email: z.string().trim().min(1, "Email is required").email("Please enter a valid email address"),
  phone: phoneSchema,
  status: z.enum(["active", "inactive", "archived"]).default("active"),
});

export type InsertRestaurantOrg = z.infer<typeof insertRestaurantOrgSchema>;
export type RestaurantOrg = typeof restaurantOrganizations.$inferSelect;

export const restaurantEmployees = mysqlTable("restaurant_employees", {
  id: varchar("id", { length: 36 }).primaryKey(),
  restaurantOrgId: varchar("restaurant_org_id", { length: 36 }).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  loginPassword: text("login_password").notNull(),
  roles: json("roles").notNull().$type<string[]>(),
  extraPermissions: json("extra_permissions").$type<string[]>().default([]),
  image: longtext("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRestaurantEmployeeSchema = createInsertSchema(restaurantEmployees).omit({
  id: true,
  createdAt: true,
}).extend({
  restaurantOrgId: z.string().min(1, "Restaurant is required"),
  name: z.string().min(1, "Name is required"),
  email: z.string().trim().min(1, "Email is required").email("Please enter a valid email address"),
  phone: z.string().trim().optional().nullable(),
  loginPassword: z.string().min(8, "Password must be at least 8 characters"),
  roles: z
    .array(z.enum(["manager", "employee"]))
    .min(1, "Select at least one role"),
  extraPermissions: z.array(z.string()).optional(),
});

export type InsertRestaurantEmployee = z.infer<typeof insertRestaurantEmployeeSchema>;
export type RestaurantEmployee = typeof restaurantEmployees.$inferSelect;
export const vendorRestaurantRelationships = mysqlTable("vendor_restaurant_relationships", {
  id: varchar("id", { length: 36 }).primaryKey(),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => vendors.id, { onDelete: "cascade" }),
  restaurantOrgId: varchar("restaurant_org_id", { length: 36 }).notNull().references(() => restaurantOrganizations.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRelationshipSchema = createInsertSchema(vendorRestaurantRelationships).omit({
  id: true,
  createdAt: true,
}).extend({
  vendorId: z.string().min(1, "Vendor is required"),
  restaurantOrgId: z.string().min(1, "Restaurant organization is required"),
  status: z.enum(["active", "inactive", "archived"]).default("active"),
});

export type InsertRelationship = z.infer<typeof insertRelationshipSchema>;
export type VendorRestaurantRelationship = typeof vendorRestaurantRelationships.$inferSelect;

export const products = mysqlTable("products", {
  id: varchar("id", { length: 36 }).primaryKey(),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => vendors.id),
  name: text("name").notNull(),
  sku: text("sku"),
  stockType: text("stock_type"),
  unitType: text("unit_type").notNull(),
  unitSize: text("unit_size").notNull(),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("active"),
  sortOrder: int("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("unique_vendor_sku").on(table.vendorId, table.sku),
]);

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
}).extend({
  vendorId: z.string().min(1, "Vendor is required"),
  name: z.string().min(1, "Product name is required"),
  sku: z.string().nullable().optional(),
  stockType: z.enum(["Dry", "Refrigerated", "Frozen"]).nullable().optional(),
  unitType: z.string().min(1, "Unit type is required"),
  unitSize: z.string().min(1, "Unit size is required"),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/, "Valid price is required"),
  status: z.enum(["active", "inactive", "archived"]).default("active"),
});

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

export const orders = mysqlTable("orders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  displayId: int("display_id").unique(),
  restaurantOrgId: varchar("restaurant_org_id", { length: 36 }).notNull().references(() => restaurantOrganizations.id),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => vendors.id),
  status: text("status").notNull().default("draft"),
  warehouseWorkerId: varchar("warehouse_worker_id", { length: 36 }),
  driverId: varchar("driver_id", { length: 36 }),
  pickingStatus: text("picking_status"),
  readyForDeliveryAt: timestamp("ready_for_delivery_at"),
  driverNote: text("driver_note"),
  cutoffAt: timestamp("cutoff_at"),
  restaurantIssueStatus: text("restaurant_issue_status"),
  driverResolutionNote: text("driver_resolution_note"),
  driverResolvedAt: timestamp("driver_resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  vendorConfirmedAt: timestamp("vendor_confirmed_at"),
  restaurantConfirmedAt: timestamp("restaurant_confirmed_at"),
  restaurantReviewSubmittedAt: timestamp("restaurant_review_submitted_at"),
  vendorApprovedAt: timestamp("vendor_approved_at"),
  vendorRejectedAt: timestamp("vendor_rejected_at"),
  vendorRejectionReason: text("vendor_rejection_reason"),
  paidAt: timestamp("paid_at"),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  displayId: true,
  createdAt: true,
}).extend({
  restaurantOrgId: z.string().min(1, "Restaurant is required"),
  vendorId: z.string().min(1, "Vendor is required"),
  status: z.enum(["draft", "submitted", "picking_review", "ready_for_delivery", "delivered", "invoiced"]).default("draft"),
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

export const orderLineItems = mysqlTable("order_line_items", {
  id: varchar("id", { length: 36 }).primaryKey(),
  orderId: varchar("order_id", { length: 36 }).notNull().references(() => orders.id),
  productId: varchar("product_id", { length: 36 }).notNull().references(() => products.id),
  quantity: int("quantity").notNull(),
  unitPriceAtTimeOfOrder: decimal("unit_price_at_time_of_order", { precision: 10, scale: 2 }).notNull(),
});

export const insertOrderLineItemSchema = createInsertSchema(orderLineItems).omit({
  id: true,
}).extend({
  orderId: z.string().min(1, "Order is required"),
  productId: z.string().min(1, "Product is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
  unitPriceAtTimeOfOrder: z.string(),
});

export type InsertOrderLineItem = z.infer<typeof insertOrderLineItemSchema>;
export type OrderLineItem = typeof orderLineItems.$inferSelect;

export const orderLineItemFulfillments = mysqlTable("order_line_item_fulfillments", {
  id: varchar("id", { length: 36 }).primaryKey(),
  orderLineItemId: varchar("order_line_item_id", { length: 36 }).notNull().unique().references(() => orderLineItems.id, { onDelete: "cascade" }),
  orderId: varchar("order_id", { length: 36 }).notNull().references(() => orders.id, { onDelete: "cascade" }),
  fulfilledQuantity: int("fulfilled_quantity"),
  loadedQuantity: int("loaded_quantity"),
  reconciledUnitPrice: decimal("reconciled_unit_price", { precision: 10, scale: 2 }),
  fulfillmentStatus: text("fulfillment_status"),
  issueReason: varchar("issue_reason", { length: 255 }),
  warehouseNote: varchar("warehouse_note", { length: 500 }),
  restaurantReceivedQty: int("restaurant_received_qty"),
  restaurantNote: varchar("restaurant_note", { length: 500 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLineFulfillmentSchema = createInsertSchema(orderLineItemFulfillments).omit({
  id: true,
  updatedAt: true,
}).extend({
  orderLineItemId: z.string().min(1),
  orderId: z.string().min(1),
  fulfillmentStatus: z.enum(["loaded", "partial", "no_stock", "damaged", "spoiled", "wrong_item"]).nullable().optional(),
  fulfilledQuantity: z.number().int().min(0).nullable().optional(),
  loadedQuantity: z.number().int().min(0).nullable().optional(),
  reconciledUnitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/, "Valid price required").nullable().optional(),
  issueReason: z.string().max(255).nullable().optional(),
  warehouseNote: z.string().max(500).nullable().optional(),
});

export type InsertLineFulfillment = z.infer<typeof insertLineFulfillmentSchema>;
export type LineFulfillment = typeof orderLineItemFulfillments.$inferSelect;

export const orderSubstitutions = mysqlTable("order_substitutions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  orderId: varchar("order_id", { length: 36 }).notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderLineItemId: varchar("order_line_item_id", { length: 36 }).notNull().references(() => orderLineItems.id, { onDelete: "cascade" }),
  originalProductId: varchar("original_product_id", { length: 36 }).notNull().references(() => products.id),
  substituteProductId: varchar("substitute_product_id", { length: 36 }).notNull().references(() => products.id),
  proposedQty: int("proposed_qty").notNull(),
  note: text("note"),
  status: text("status").notNull().default("proposed"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type OrderSubstitution = typeof orderSubstitutions.$inferSelect;

export interface InvoiceLineItemSnapshot {
  orderLineItemId: string;
  productId: string;
  productName: string;
  sku: string | null;
  approvedQty: number;
  unitPrice: string;
  lineTotal: string;
  restaurantNote: string | null;
}

export const invoices = mysqlTable("invoices", {
  id: varchar("id", { length: 36 }).primaryKey(),
  orderId: varchar("order_id", { length: 36 }).notNull().unique().references(() => orders.id),
  displayOrderId: int("display_order_id"),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => vendors.id),
  restaurantOrgId: varchar("restaurant_org_id", { length: 36 }).notNull().references(() => restaurantOrganizations.id),
  approvedTotal: decimal("approved_total", { precision: 12, scale: 2 }).notNull(),
  approvedAt: timestamp("approved_at").notNull(),
  lineItems: json("line_items").notNull().$type<InvoiceLineItemSnapshot[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Invoice = typeof invoices.$inferSelect;

export const orderSheetItems = mysqlTable("order_sheet_items", {
  id: varchar("id", { length: 36 }).primaryKey(),
  relationshipId: varchar("relationship_id", { length: 36 }).notNull().references(() => vendorRestaurantRelationships.id, { onDelete: "cascade" }),
  productId: varchar("product_id", { length: 36 }).notNull().references(() => products.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("unique_order_sheet_item").on(table.relationshipId, table.productId),
]);

export type OrderSheetItem = typeof orderSheetItems.$inferSelect;

export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
}

function getMysqlErrorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as { code?: string | number; errno?: number; cause?: unknown };
  return err.code ?? err.errno ?? getMysqlErrorCode(err.cause);
}

export function isDuplicateKeyError(error: unknown): boolean {
  const code = getMysqlErrorCode(error);
  return code === "ER_DUP_ENTRY" || code === 1062;
}
