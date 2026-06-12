import {
  type User, type InsertUser, users,
  type Vendor, type InsertVendor, vendors,
  type VendorEmployee, type InsertVendorEmployee, vendorEmployees,
  type RestaurantOrg, type InsertRestaurantOrg, restaurantOrganizations,
  type RestaurantEmployee, type InsertRestaurantEmployee, restaurantEmployees,
  type VendorRestaurantRelationship, type InsertRelationship, vendorRestaurantRelationships,
  type Product, type InsertProduct, products,
  type Order, type InsertOrder, orders,
  type OrderLineItem, orderLineItems,
  type LineFulfillment, orderLineItemFulfillments,
  type Invoice, type InvoiceLineItemSnapshot, invoices,
  orderSubstitutions,
  type ActivityLog, type ActivityAction, type ActivityEntityType, activityLogs,
  type ContactSubmission, type InsertContactSubmission, contactSubmissions,
  type Attachment, type AttachmentMeta, attachments,
  type InternalNote, type InsertInternalNote, internalNotes,
  type OrderSheetItem, orderSheetItems,
} from "../db/schema.js";
import { db } from "../db/client.js";
import {
  type DbExecutor,
  deleteManyWhere,
  deleteOneById,
  insertMany,
  insertOne,
  newId,
  toValidDate,
  updateOneById,
  updateOneWhere,
} from "../db/helpers.js";
import { eq, ne, and, or, asc, desc, inArray, isNull, sql } from "drizzle-orm";

function normalizeInvoiceLineItems(value: unknown): InvoiceLineItemSnapshot[] {
  if (Array.isArray(value)) return value as InvoiceLineItemSnapshot[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as InvoiceLineItemSnapshot[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getVendors(includeArchived?: boolean): Promise<Vendor[]>;
  getVendor(id: string): Promise<Vendor | undefined>;
  createVendor(vendor: InsertVendor): Promise<Vendor>;
  updateVendor(id: string, vendor: Partial<InsertVendor>): Promise<Vendor | undefined>;
  archiveVendor(id: string): Promise<Vendor | undefined>;
  restoreVendor(id: string): Promise<Vendor | undefined>;
  deleteVendor(id: string): Promise<boolean>;

  getVendorEmployees(vendorId: string): Promise<VendorEmployee[]>;
  getVendorEmployee(id: string): Promise<VendorEmployee | undefined>;
  createVendorEmployee(employee: InsertVendorEmployee): Promise<VendorEmployee>;
  updateVendorEmployee(id: string, employee: Partial<InsertVendorEmployee>): Promise<VendorEmployee | undefined>;
  deleteVendorEmployee(id: string): Promise<boolean>;

  getRestaurantOrgs(includeArchived?: boolean): Promise<RestaurantOrg[]>;
  getRestaurantOrg(id: string): Promise<RestaurantOrg | undefined>;
  createRestaurantOrg(org: InsertRestaurantOrg): Promise<RestaurantOrg>;
  updateRestaurantOrg(id: string, org: Partial<InsertRestaurantOrg>): Promise<RestaurantOrg | undefined>;
  archiveRestaurantOrg(id: string): Promise<RestaurantOrg | undefined>;
  restoreRestaurantOrg(id: string): Promise<RestaurantOrg | undefined>;
  deleteRestaurantOrg(id: string): Promise<boolean>;

  getRestaurantEmployees(restaurantOrgId: string): Promise<RestaurantEmployee[]>;
  getRestaurantEmployee(id: string): Promise<RestaurantEmployee | undefined>;
  createRestaurantEmployee(employee: InsertRestaurantEmployee): Promise<RestaurantEmployee>;
  updateRestaurantEmployee(id: string, employee: Partial<InsertRestaurantEmployee>): Promise<RestaurantEmployee | undefined>;
  deleteRestaurantEmployee(id: string): Promise<boolean>;

  getRelationships(): Promise<VendorRestaurantRelationship[]>;
  getRelationship(id: string): Promise<VendorRestaurantRelationship | undefined>;
  createRelationship(rel: InsertRelationship): Promise<VendorRestaurantRelationship>;
  updateRelationship(id: string, rel: Partial<InsertRelationship>): Promise<VendorRestaurantRelationship | undefined>;
  deleteRelationship(id: string): Promise<boolean>;

  isPhoneInUse(phone: string, excludeId?: string, excludeTable?: "vendor" | "restaurant"): Promise<boolean>;

  getProductsByVendor(vendorId: string, includeArchived?: boolean): Promise<Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  createProduct(product: InsertProduct): Promise<Product>;
  createProducts(items: InsertProduct[]): Promise<Product[]>;
  updateProduct(id: string, product: Partial<InsertProduct>): Promise<Product | undefined>;
  archiveProduct(id: string): Promise<Product | undefined>;
  getExistingSkus(vendorId: string): Promise<string[]>;
  reorderProducts(vendorId: string, items: { id: string; sortOrder: number }[]): Promise<void>;
  hasRelationship(vendorId: string, restaurantOrgId: string): Promise<boolean>;
  hasActiveOrdersForPair(vendorId: string, restaurantOrgId: string): Promise<boolean>;
  getRecentActivity(limit: number): Promise<{
    vendors: Vendor[];
    restaurantOrgs: RestaurantOrg[];
    relationships: VendorRestaurantRelationship[];
    products: Product[];
  }>;

  getOrdersByRestaurant(restaurantOrgId: string): Promise<Order[]>;
  getOrdersByVendor(vendorId: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  getDraftOrder(restaurantOrgId: string, vendorId: string): Promise<Order | undefined>;
  getSubmittedOrder(restaurantOrgId: string, vendorId: string): Promise<Order | undefined>;
  getSubmittedOrders(restaurantOrgId: string, vendorId: string): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  createOrderWithLineItems(order: InsertOrder, items: Omit<OrderLineItem, "id">[]): Promise<{ order: Order; lineItems: OrderLineItem[] }>;
  backfillDisplayIds(): Promise<void>;
  submitOrder(id: string): Promise<Order | undefined>;
  markOrderDelivered(id: string): Promise<Order | undefined>;
  getOrderLineItems(orderId: string): Promise<OrderLineItem[]>;
  createOrderLineItems(items: Omit<OrderLineItem, "id">[]): Promise<OrderLineItem[]>;
  replaceOrderLineItems(orderId: string, items: Omit<OrderLineItem, "id">[]): Promise<OrderLineItem[]>;
  deleteDraftOrder(orderId: string): Promise<boolean>;
  getOrderFulfillments(orderId: string): Promise<LineFulfillment[]>;
  upsertOrderReview(orderId: string, items: Array<{ orderLineItemId: string; receivedQty: number | null; note: string | null }>): Promise<Order>;
  markOrderReviewSubmitted(orderId: string): Promise<Order | undefined>;
  approveOrderReview(orderId: string): Promise<Order | undefined>;
  approveOrderAndCreateInvoice(orderId: string, vendorId: string): Promise<Order>;
  rejectOrderReview(orderId: string, reason: string): Promise<Order | undefined>;
  resubmitDisputedReview(orderId: string, items: Array<{ orderLineItemId: string; receivedQty: number | null; note: string | null }>): Promise<Order>;
  markOrderPaid(orderId: string): Promise<Order | undefined>;

  createInvoice(data: {
    orderId: string;
    displayOrderId: number | null;
    vendorId: string;
    restaurantOrgId: string;
    approvedTotal: string;
    approvedAt: Date;
    lineItems: InvoiceLineItemSnapshot[];
  }): Promise<Invoice>;
  getInvoiceByOrderId(orderId: string): Promise<Invoice | undefined>;
  ensureInvoiceForOrder(order: Order): Promise<Invoice | undefined>;
  normalizeInvoicedOrderState(order: Order): Promise<Order>;
  backfillInvoices(): Promise<void>;

  createActivityLog(entry: { action: ActivityAction; entityType: ActivityEntityType; entityId: string; entityName: string; metadata?: string; vendorId?: number; restaurantId?: number; }): Promise<ActivityLog>;
  getActivityLogs(limit?: number): Promise<ActivityLog[]>;
  getActivityLogsByAction(action: ActivityAction, limit: number): Promise<ActivityLog[]>;

  createContactSubmission(submission: InsertContactSubmission): Promise<ContactSubmission>;
  getContactSubmission(id: string): Promise<ContactSubmission | undefined>;

  getAttachments(entityType: string, entityId: string): Promise<AttachmentMeta[]>;
  getAttachment(id: string): Promise<Attachment | undefined>;
  createAttachment(attachment: { entityType: string; entityId: string; fileName: string; fileType: string; fileSize: number; fileData: string }): Promise<Attachment>;
  deleteAttachment(id: string): Promise<boolean>;

  getNotes(entityType: string, entityId: string): Promise<InternalNote[]>;
  createNote(note: InsertInternalNote): Promise<InternalNote>;
  deleteNote(id: string): Promise<boolean>;

  getAllProductCounts(): Promise<Record<string, number>>;

  getOrderSheetItemsEnriched(relationshipId: string): Promise<Array<{
    id: string; relationshipId: string; productId: string;
    productName: string; sku: string | null; unitType: string; unitSize: string; price: string;
  }>>;
  addOrderSheetItem(relationshipId: string, productId: string): Promise<OrderSheetItem>;
  removeOrderSheetItem(relationshipId: string, productId: string): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    return insertOne<User>(db, users, insertUser);
  }

  async getVendors(includeArchived = false): Promise<Vendor[]> {
    if (includeArchived) {
      return db.select().from(vendors);
    }
    return db.select().from(vendors).where(ne(vendors.status, "archived"));
  }

  async getVendor(id: string): Promise<Vendor | undefined> {
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, id));
    return vendor;
  }

  async createVendor(vendor: InsertVendor): Promise<Vendor> {
    return insertOne<Vendor>(db, vendors, vendor);
  }

  async updateVendor(id: string, vendor: Partial<InsertVendor>): Promise<Vendor | undefined> {
    return updateOneById<Vendor>(db, vendors, id, vendor);
  }

  async archiveVendor(id: string): Promise<Vendor | undefined> {
    return db.transaction(async (tx) => {
      // Block on submitted orders or delivered orders not yet fully paid (Bug #4)
      const activeOrders = await tx.select({ id: orders.id })
        .from(orders)
        .where(and(
          eq(orders.vendorId, id),
          or(
            eq(orders.status, "submitted"),
            and(eq(orders.status, "delivered"), isNull(orders.paidAt))
          )
        ));
      if (activeOrders.length > 0) throw new Error("ACTIVE_ORDERS_EXIST");
      // Soft-archive relationships instead of hard-deleting (Bug #4 fix)
      await tx.update(vendorRestaurantRelationships)
        .set({ status: "archived" })
        .where(eq(vendorRestaurantRelationships.vendorId, id));
      return updateOneById<Vendor>(tx, vendors, id, { status: "archived" });
    });
  }

  async restoreVendor(id: string): Promise<Vendor | undefined> {
    return updateOneById<Vendor>(db, vendors, id, { status: "active" });
  }

  async deleteVendor(id: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      // Check invoices.vendorId directly — this FK has no onDelete so delete would crash (Bug #3)
      const existingInvoices = await tx.select({ id: invoices.id })
        .from(invoices).where(eq(invoices.vendorId, id));
      if (existingInvoices.length > 0) throw new Error("INVOICES_EXIST");
      const vendorOrders = await tx.select({ id: orders.id }).from(orders).where(eq(orders.vendorId, id));
      if (vendorOrders.length > 0) {
        await tx.delete(orderLineItems).where(inArray(orderLineItems.orderId, vendorOrders.map(o => o.id)));
      }
      await tx.delete(orders).where(eq(orders.vendorId, id));
      await tx.delete(products).where(eq(products.vendorId, id));
      return deleteOneById(tx, vendors, id);
    });
  }

  async getVendorEmployees(vendorId: string): Promise<VendorEmployee[]> {
    return db.select().from(vendorEmployees)
      .where(eq(vendorEmployees.vendorId, vendorId))
      .orderBy(asc(vendorEmployees.createdAt));
  }

  async getVendorEmployee(id: string): Promise<VendorEmployee | undefined> {
    const [employee] = await db.select().from(vendorEmployees).where(eq(vendorEmployees.id, id));
    return employee;
  }

  async createVendorEmployee(employee: InsertVendorEmployee): Promise<VendorEmployee> {
    return insertOne<VendorEmployee>(db, vendorEmployees, employee);
  }

  async updateVendorEmployee(id: string, employee: Partial<InsertVendorEmployee>): Promise<VendorEmployee | undefined> {
    return updateOneById<VendorEmployee>(db, vendorEmployees, id, employee);
  }

  async deleteVendorEmployee(id: string): Promise<boolean> {
    return deleteOneById(db, vendorEmployees, id);
  }

  async getRestaurantOrgs(includeArchived = false): Promise<RestaurantOrg[]> {
    if (includeArchived) {
      return db.select().from(restaurantOrganizations);
    }
    return db.select().from(restaurantOrganizations).where(ne(restaurantOrganizations.status, "archived"));
  }

  async getRestaurantOrg(id: string): Promise<RestaurantOrg | undefined> {
    const [org] = await db.select().from(restaurantOrganizations).where(eq(restaurantOrganizations.id, id));
    return org;
  }

  async getRestaurantEmployees(restaurantOrgId: string): Promise<RestaurantEmployee[]> {
    return db.select().from(restaurantEmployees)
      .where(eq(restaurantEmployees.restaurantOrgId, restaurantOrgId))
      .orderBy(asc(restaurantEmployees.createdAt));
  }

  async getRestaurantEmployee(id: string): Promise<RestaurantEmployee | undefined> {
    const [employee] = await db.select().from(restaurantEmployees).where(eq(restaurantEmployees.id, id));
    return employee;
  }

  async createRestaurantEmployee(employee: InsertRestaurantEmployee): Promise<RestaurantEmployee> {
    return insertOne<RestaurantEmployee>(db, restaurantEmployees, employee);
  }

  async updateRestaurantEmployee(
    id: string,
    employee: Partial<InsertRestaurantEmployee>,
  ): Promise<RestaurantEmployee | undefined> {
    return updateOneById<RestaurantEmployee>(db, restaurantEmployees, id, employee);
  }

  async deleteRestaurantEmployee(id: string): Promise<boolean> {
    return deleteOneById(db, restaurantEmployees, id);
  }

  async createRestaurantOrg(org: InsertRestaurantOrg): Promise<RestaurantOrg> {
    return insertOne<RestaurantOrg>(db, restaurantOrganizations, org);
  }

  async updateRestaurantOrg(id: string, org: Partial<InsertRestaurantOrg>): Promise<RestaurantOrg | undefined> {
    return updateOneById<RestaurantOrg>(db, restaurantOrganizations, id, org);
  }

  async archiveRestaurantOrg(id: string): Promise<RestaurantOrg | undefined> {
    return db.transaction(async (tx) => {
      // Block on submitted orders or delivered orders not yet fully paid (Bug #4)
      const activeOrders = await tx.select({ id: orders.id })
        .from(orders)
        .where(and(
          eq(orders.restaurantOrgId, id),
          or(
            eq(orders.status, "submitted"),
            and(eq(orders.status, "delivered"), isNull(orders.paidAt))
          )
        ));
      if (activeOrders.length > 0) throw new Error("ACTIVE_ORDERS_EXIST");
      // Soft-archive relationships instead of hard-deleting (Bug #4 fix)
      await tx.update(vendorRestaurantRelationships)
        .set({ status: "archived" })
        .where(eq(vendorRestaurantRelationships.restaurantOrgId, id));
      return updateOneById<RestaurantOrg>(tx, restaurantOrganizations, id, { status: "archived" });
    });
  }

  async restoreRestaurantOrg(id: string): Promise<RestaurantOrg | undefined> {
    return updateOneById<RestaurantOrg>(db, restaurantOrganizations, id, { status: "active" });
  }

  async deleteRestaurantOrg(id: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      // Check invoices.restaurantOrgId directly — this FK has no onDelete so delete would crash (Bug #3)
      const existingInvoices = await tx.select({ id: invoices.id })
        .from(invoices).where(eq(invoices.restaurantOrgId, id));
      if (existingInvoices.length > 0) throw new Error("INVOICES_EXIST");
      const orgOrders = await tx.select({ id: orders.id }).from(orders).where(eq(orders.restaurantOrgId, id));
      if (orgOrders.length > 0) {
        await tx.delete(orderLineItems).where(inArray(orderLineItems.orderId, orgOrders.map(o => o.id)));
      }
      await tx.delete(orders).where(eq(orders.restaurantOrgId, id));
      return deleteOneById(tx, restaurantOrganizations, id);
    });
  }

  async getRelationships(): Promise<VendorRestaurantRelationship[]> {
    return db.select().from(vendorRestaurantRelationships)
      .where(ne(vendorRestaurantRelationships.status, "archived"));
  }

  async getRelationship(id: string): Promise<VendorRestaurantRelationship | undefined> {
    const [rel] = await db.select().from(vendorRestaurantRelationships).where(eq(vendorRestaurantRelationships.id, id));
    return rel;
  }

  async createRelationship(rel: InsertRelationship): Promise<VendorRestaurantRelationship> {
    return insertOne<VendorRestaurantRelationship>(db, vendorRestaurantRelationships, rel);
  }

  async updateRelationship(id: string, rel: Partial<InsertRelationship>): Promise<VendorRestaurantRelationship | undefined> {
    return updateOneById<VendorRestaurantRelationship>(db, vendorRestaurantRelationships, id, rel);
  }

  async deleteRelationship(id: string): Promise<boolean> {
    return deleteOneById(db, vendorRestaurantRelationships, id);
  }

  async isPhoneInUse(phone: string, excludeId?: string, excludeTable?: "vendor" | "restaurant"): Promise<boolean> {
    const normalizedPhone = String(phone).replace(/\D/g, "");
    const vendorResults = await db.select({ id: vendors.id, phone: vendors.phone }).from(vendors);
    const restaurantResults = await db.select({ id: restaurantOrganizations.id, phone: restaurantOrganizations.phone }).from(restaurantOrganizations);

    for (const v of vendorResults) {
      if (excludeTable === "vendor" && excludeId === v.id) continue;
      if (String(v.phone).replace(/\D/g, "") === normalizedPhone) return true;
    }
    for (const r of restaurantResults) {
      if (excludeTable === "restaurant" && excludeId === r.id) continue;
      if (String(r.phone).replace(/\D/g, "") === normalizedPhone) return true;
    }
    return false;
  }

  async getProductsByVendor(vendorId: string, includeArchived = false): Promise<Product[]> {
    if (includeArchived) {
      return db.select().from(products).where(eq(products.vendorId, vendorId))
        .orderBy(asc(products.sortOrder), asc(products.createdAt));
    }
    return db.select().from(products).where(
      and(eq(products.vendorId, vendorId), ne(products.status, "archived"))
    ).orderBy(asc(products.sortOrder), asc(products.createdAt));
  }

  private async getNextSortOrder(vendorId: string): Promise<number> {
    const [row] = await db
      .select({ max: sql<number>`coalesce(max(${products.sortOrder}), -1)` })
      .from(products)
      .where(eq(products.vendorId, vendorId));
    return (row?.max ?? -1) + 1;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    return product;
  }

  async createProduct(product: InsertProduct): Promise<Product> {
    const sortOrder = await this.getNextSortOrder(product.vendorId);
    return insertOne<Product>(db, products, { ...product, sortOrder });
  }

  async createProducts(items: InsertProduct[]): Promise<Product[]> {
    if (items.length === 0) return [];
    const base = await this.getNextSortOrder(items[0].vendorId);
    const valued = items.map((item, i) => ({ ...item, sortOrder: base + i }));
    return insertMany<Product>(db, products, valued);
  }

  async reorderProducts(vendorId: string, items: { id: string; sortOrder: number }[]): Promise<void> {
    await db.transaction(async (tx) => {
      for (const { id, sortOrder } of items) {
        await tx.update(products).set({ sortOrder }).where(
          and(eq(products.id, id), eq(products.vendorId, vendorId))
        );
      }
    });
  }

  async getExistingSkus(vendorId: string): Promise<string[]> {
    const rows = await db.select({ sku: products.sku }).from(products).where(eq(products.vendorId, vendorId));
    return rows.map(r => r.sku).filter((s): s is string => !!s);
  }

  async updateProduct(id: string, product: Partial<InsertProduct>): Promise<Product | undefined> {
    return updateOneById<Product>(db, products, id, product);
  }

  async archiveProduct(id: string): Promise<Product | undefined> {
    return updateOneById<Product>(db, products, id, { status: "archived" });
  }

  async hasRelationship(vendorId: string, restaurantOrgId: string): Promise<boolean> {
    const [rel] = await db.select({ id: vendorRestaurantRelationships.id })
      .from(vendorRestaurantRelationships)
      .where(and(
        eq(vendorRestaurantRelationships.vendorId, vendorId),
        eq(vendorRestaurantRelationships.restaurantOrgId, restaurantOrgId),
        eq(vendorRestaurantRelationships.status, "active"),
      ));
    return !!rel;
  }

  async hasActiveOrdersForPair(vendorId: string, restaurantOrgId: string): Promise<boolean> {
    const activeOrders = await db.select({ id: orders.id })
      .from(orders)
      .where(and(
        eq(orders.vendorId, vendorId),
        eq(orders.restaurantOrgId, restaurantOrgId),
        or(
          eq(orders.status, "submitted"),
          and(eq(orders.status, "delivered"), isNull(orders.paidAt))
        )
      ))
      .limit(1);
    return activeOrders.length > 0;
  }

  async getRecentActivity(limit: number = 5): Promise<{
    vendors: Vendor[];
    restaurantOrgs: RestaurantOrg[];
    relationships: VendorRestaurantRelationship[];
    products: Product[];
  }> {
    const [recentVendors, recentOrgs, recentRels, recentProducts] = await Promise.all([
      db.select().from(vendors).orderBy(desc(vendors.createdAt)).limit(limit),
      db.select().from(restaurantOrganizations).orderBy(desc(restaurantOrganizations.createdAt)).limit(limit),
      db.select().from(vendorRestaurantRelationships).orderBy(desc(vendorRestaurantRelationships.createdAt)).limit(limit),
      db.select().from(products).orderBy(desc(products.createdAt)).limit(limit),
    ]);
    return { vendors: recentVendors, restaurantOrgs: recentOrgs, relationships: recentRels, products: recentProducts };
  }

  async getOrdersByRestaurant(restaurantOrgId: string): Promise<Order[]> {
    return db.select().from(orders)
      .where(eq(orders.restaurantOrgId, restaurantOrgId))
      .orderBy(desc(orders.createdAt));
  }

  async getOrdersByVendor(vendorId: string): Promise<Order[]> {
    return db.select().from(orders)
      .where(and(eq(orders.vendorId, vendorId), ne(orders.status, "draft")))
      .orderBy(desc(orders.createdAt));
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order;
  }

  private async allocateNextOrderDisplayId(tx: DbExecutor): Promise<number> {
    const [maxResult] = await tx
      .select({ max: sql<number>`COALESCE(MAX(display_id), 1000)` })
      .from(orders);
    return Number(maxResult.max) + 1;
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    return db.transaction(async (tx) => {
      const displayId = await this.allocateNextOrderDisplayId(tx);
      const created = await insertOne<Order>(tx, orders, { ...order, displayId });
      return created;
    });
  }

  async backfillDisplayIds(): Promise<void> {
    const nullOrders = await db.select({ id: orders.id, createdAt: orders.createdAt })
      .from(orders)
      .where(sql`display_id IS NULL`)
      .orderBy(asc(orders.createdAt));
    if (nullOrders.length === 0) return;
    const [maxResult] = await db
      .select({ max: sql<number>`COALESCE(MAX(display_id), 1000)` })
      .from(orders);
    let next = Number(maxResult.max) + 1;
    for (const o of nullOrders) {
      await db.update(orders).set({ displayId: next++ }).where(eq(orders.id, o.id));
    }
  }

  async getOrderLineItems(orderId: string): Promise<OrderLineItem[]> {
    return db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  }

  async createOrderLineItems(items: Omit<OrderLineItem, "id">[]): Promise<OrderLineItem[]> {
    if (items.length === 0) return [];
    return insertMany<OrderLineItem>(db, orderLineItems, items as unknown as Record<string, unknown>[]);
  }

  async createOrderWithLineItems(order: InsertOrder, items: Omit<OrderLineItem, "id">[]): Promise<{ order: Order; lineItems: OrderLineItem[] }> {
    return db.transaction(async (tx) => {
      const displayId = await this.allocateNextOrderDisplayId(tx);
      const created = await insertOne<Order>(tx, orders, { ...order, displayId });
      if (items.length === 0) return { order: created, lineItems: [] };
      const lineItems = await insertMany<OrderLineItem>(tx, orderLineItems, items.map(item => ({ ...item, orderId: created.id })) as unknown as Record<string, unknown>[]);
      return { order: created, lineItems };
    });
  }

  async getDraftOrder(restaurantOrgId: string, vendorId: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(and(
      eq(orders.restaurantOrgId, restaurantOrgId),
      eq(orders.vendorId, vendorId),
      eq(orders.status, "draft"),
    ));
    return order;
  }

  async getSubmittedOrder(restaurantOrgId: string, vendorId: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(and(
      eq(orders.restaurantOrgId, restaurantOrgId),
      eq(orders.vendorId, vendorId),
      eq(orders.status, "submitted"),
    )).orderBy(desc(orders.createdAt)).limit(1);
    return order;
  }

  async getSubmittedOrders(restaurantOrgId: string, vendorId: string): Promise<Order[]> {
    return db.select().from(orders).where(and(
      eq(orders.restaurantOrgId, restaurantOrgId),
      eq(orders.vendorId, vendorId),
      ne(orders.status, "draft"),
    )).orderBy(desc(orders.createdAt));
  }

  async submitOrder(id: string): Promise<Order | undefined> {
    return updateOneById<Order>(db, orders, id, { status: "submitted" });
  }

  async markOrderDelivered(id: string): Promise<Order | undefined> {
    return updateOneById<Order>(db, orders, id, { status: "delivered", vendorConfirmedAt: new Date() });
  }

  async deleteDraftOrder(orderId: string): Promise<boolean> {
    await db.delete(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    return deleteOneById(db, orders, orderId);
  }

  async getOrderFulfillments(orderId: string): Promise<LineFulfillment[]> {
    return db.select().from(orderLineItemFulfillments)
      .where(eq(orderLineItemFulfillments.orderId, orderId));
  }

  async upsertOrderReview(orderId: string, items: Array<{ orderLineItemId: string; receivedQty: number | null; note: string | null }>): Promise<Order> {
    return db.transaction(async (tx) => {
      const ownedLineItems = await tx.select({ id: orderLineItems.id })
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId));
      const validIds = new Set(ownedLineItems.map(li => li.id));
      for (const item of items) {
        if (!validIds.has(item.orderLineItemId)) {
          throw new Error("INVALID_LINE_ITEM_ID");
        }
      }
      for (const item of items) {
        await tx.insert(orderLineItemFulfillments)
          .values({
            id: newId(),
            orderLineItemId: item.orderLineItemId,
            orderId,
            restaurantReceivedQty: item.receivedQty,
            restaurantNote: item.note,
          })
          .onConflictDoUpdate({
            target: orderLineItemFulfillments.orderLineItemId,
            set: {
              restaurantReceivedQty: item.receivedQty,
              restaurantNote: item.note,
              updatedAt: new Date(),
            },
          });
      }
      const updated = await updateOneById<Order>(tx, orders, orderId, { restaurantReviewSubmittedAt: new Date() });
      if (!updated) throw new Error("Order not found");
      return updated;
    });
  }

  async markOrderReviewSubmitted(orderId: string): Promise<Order | undefined> {
    return updateOneById<Order>(db, orders, orderId, { restaurantReviewSubmittedAt: new Date() });
  }

  async approveOrderReview(orderId: string): Promise<Order | undefined> {
    return updateOneById<Order>(db, orders, orderId, { vendorApprovedAt: new Date() });
  }

  // H2 fix: approve + create invoice atomically; all snapshot reads happen INSIDE the tx
  // to prevent TOCTOU race where restaurant re-submits review between snapshot read and commit.
  async approveOrderAndCreateInvoice(orderId: string, vendorId: string): Promise<Order> {
    return db.transaction(async (tx) => {
      // WHERE vendorApprovedAt IS NULL guards against duplicate concurrent approvals
      const updated = await updateOneWhere<Order>(
        tx,
        orders,
        {
          vendorApprovedAt: new Date(),
          vendorRejectedAt: null,
          vendorRejectionReason: null,
          status: "invoiced",
        },
        and(eq(orders.id, orderId), isNull(orders.vendorApprovedAt))!,
      );
      if (!updated) throw new Error("ORDER_ALREADY_APPROVED_OR_NOT_FOUND");

      // Read all snapshot data INSIDE the transaction — prevents stale invoice
      const rawLineItems = await tx.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
      const fulfillmentRows = await tx.select().from(orderLineItemFulfillments).where(eq(orderLineItemFulfillments.orderId, orderId));
      const allVendorProducts = await tx.select().from(products).where(eq(products.vendorId, vendorId));
      const acceptedSubstitutions = await tx.select().from(orderSubstitutions).where(and(eq(orderSubstitutions.orderId, orderId), eq(orderSubstitutions.status, "accepted")));

      const fulfillmentMap = new Map(fulfillmentRows.map(f => [f.orderLineItemId, f]));
      const productMap = new Map(allVendorProducts.map(p => [p.id, p]));

      const snapshotLineItems: InvoiceLineItemSnapshot[] = rawLineItems.map(li => {
        const f = fulfillmentMap.get(li.id);
        const approvedQty = f?.restaurantReceivedQty ?? li.quantity;
        const unitPrice = li.unitPriceAtTimeOfOrder;
        const lineTotal = (parseFloat(unitPrice) * approvedQty).toFixed(2);
        const product = productMap.get(li.productId);
        return {
          orderLineItemId: li.id,
          productId: li.productId,
          productName: product?.name ?? li.productId,
          sku: product?.sku ?? null,
          approvedQty,
          unitPrice,
          lineTotal,
          restaurantNote: f?.restaurantNote ?? null,
        };
      });
      for (const sub of acceptedSubstitutions) {
        const product = productMap.get(sub.substituteProductId);
        if (!product) continue;
        const lineTotal = (parseFloat(product.price) * sub.proposedQty).toFixed(2);
        snapshotLineItems.push({
          orderLineItemId: sub.orderLineItemId,
          productId: sub.substituteProductId,
          productName: product.name,
          sku: product.sku ?? null,
          approvedQty: sub.proposedQty,
          unitPrice: product.price,
          lineTotal,
          restaurantNote: `Accepted substitute${sub.note ? `: ${sub.note}` : ""}`,
        });
      }

      const approvedTotal = snapshotLineItems
        .reduce((s, li) => s + parseFloat(li.lineTotal), 0)
        .toFixed(2);

      const existingInvoice = await tx.select().from(invoices).where(eq(invoices.orderId, orderId)).limit(1);
      if (existingInvoice.length === 0) {
        await tx.insert(invoices).values({
          id: newId(),
          orderId,
          displayOrderId: updated.displayId,
          vendorId,
          restaurantOrgId: updated.restaurantOrgId,
          approvedTotal,
          approvedAt: toValidDate(updated.vendorApprovedAt),
          lineItems: snapshotLineItems,
        });
      }

      return updated;
    });
  }

  async rejectOrderReview(orderId: string, reason: string): Promise<Order | undefined> {
    return updateOneById<Order>(db, orders, orderId, { vendorRejectedAt: new Date(), vendorRejectionReason: reason });
  }

  async resubmitDisputedReview(orderId: string, items: Array<{ orderLineItemId: string; receivedQty: number | null; note: string | null }>): Promise<Order> {
    return db.transaction(async (tx) => {
      const ownedLineItems = await tx.select({ id: orderLineItems.id })
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId));
      const validIds = new Set(ownedLineItems.map(li => li.id));
      for (const item of items) {
        if (!validIds.has(item.orderLineItemId)) {
          throw new Error("INVALID_LINE_ITEM_ID");
        }
      }
      for (const item of items) {
        await tx.insert(orderLineItemFulfillments)
          .values({
            id: newId(),
            orderLineItemId: item.orderLineItemId,
            orderId,
            restaurantReceivedQty: item.receivedQty,
            restaurantNote: item.note,
          })
          .onConflictDoUpdate({
            target: orderLineItemFulfillments.orderLineItemId,
            set: {
              restaurantReceivedQty: item.receivedQty,
              restaurantNote: item.note,
              updatedAt: new Date(),
            },
          });
      }
      const updated = await updateOneById<Order>(tx, orders, orderId, {
        restaurantReviewSubmittedAt: new Date(),
        vendorRejectedAt: null,
        vendorRejectionReason: null,
      });
      if (!updated) throw new Error("Order not found");
      return updated;
    });
  }

  async markOrderPaid(orderId: string): Promise<Order | undefined> {
    return updateOneById<Order>(db, orders, orderId, { paidAt: new Date() });
  }

  async createInvoice(data: {
    orderId: string;
    displayOrderId: number | null;
    vendorId: string;
    restaurantOrgId: string;
    approvedTotal: string;
    approvedAt: Date;
    lineItems: InvoiceLineItemSnapshot[];
  }): Promise<Invoice> {
    return insertOne<Invoice>(db, invoices, {
      orderId: data.orderId,
      displayOrderId: data.displayOrderId,
      vendorId: data.vendorId,
      restaurantOrgId: data.restaurantOrgId,
      approvedTotal: data.approvedTotal,
      approvedAt: toValidDate(data.approvedAt),
      lineItems: data.lineItems,
    });
  }

  async getInvoiceByOrderId(orderId: string): Promise<Invoice | undefined> {
    const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, orderId));
    if (!invoice) return undefined;
    return {
      ...invoice,
      lineItems: normalizeInvoiceLineItems(invoice.lineItems),
    };
  }

  private async buildInvoiceSnapshotForOrder(
    orderId: string,
    vendorId: string,
  ): Promise<{ snapshotLineItems: InvoiceLineItemSnapshot[]; approvedTotal: string }> {
    const lineItems = await this.getOrderLineItems(orderId);
    const fulfillments = await this.getOrderFulfillments(orderId);
    const allProducts = await this.getProductsByVendor(vendorId, true);
    const fulfillmentMap = new Map(fulfillments.map((f) => [f.orderLineItemId, f]));
    const productMap = new Map(allProducts.map((p) => [p.id, p]));
    const snapshotLineItems: InvoiceLineItemSnapshot[] = lineItems.map((li) => {
      const fulfillment = fulfillmentMap.get(li.id);
      const approvedQty = fulfillment?.restaurantReceivedQty ?? li.quantity;
      const unitPrice = li.unitPriceAtTimeOfOrder;
      const lineTotal = (parseFloat(unitPrice) * approvedQty).toFixed(2);
      const product = productMap.get(li.productId);
      return {
        orderLineItemId: li.id,
        productId: li.productId,
        productName: product?.name ?? li.productId,
        sku: product?.sku ?? null,
        approvedQty,
        unitPrice,
        lineTotal,
        restaurantNote: fulfillment?.restaurantNote ?? null,
      };
    });
    const approvedTotal = snapshotLineItems
      .reduce((sum, line) => sum + parseFloat(line.lineTotal), 0)
      .toFixed(2);
    return { snapshotLineItems, approvedTotal };
  }

  async ensureInvoiceForOrder(order: Order): Promise<Invoice | undefined> {
    if (order.status !== "invoiced" && !order.vendorApprovedAt && !order.paidAt) {
      return undefined;
    }

    const existing = await this.getInvoiceByOrderId(order.id);
    if (existing) return existing;

    const { snapshotLineItems, approvedTotal } = await this.buildInvoiceSnapshotForOrder(
      order.id,
      order.vendorId,
    );
    if (snapshotLineItems.length === 0) return undefined;

    return this.createInvoice({
      orderId: order.id,
      displayOrderId: order.displayId,
      vendorId: order.vendorId,
      restaurantOrgId: order.restaurantOrgId,
      approvedTotal,
      approvedAt: toValidDate(order.vendorApprovedAt) ?? new Date(),
      lineItems: snapshotLineItems,
    });
  }

  async normalizeInvoicedOrderState(order: Order): Promise<Order> {
    const invoice = await this.getInvoiceByOrderId(order.id);
    const isInvoiced =
      order.status === "invoiced" ||
      !!order.vendorApprovedAt ||
      !!order.paidAt ||
      !!invoice;

    if (!isInvoiced) return order;

    const patch: Record<string, unknown> = {};
    if (order.vendorRejectedAt) {
      patch.vendorRejectedAt = null;
      patch.vendorRejectionReason = null;
    }
    if (!order.vendorApprovedAt && !order.paidAt) {
      patch.vendorApprovedAt =
        toValidDate(invoice?.approvedAt) ??
        toValidDate(order.driverResolvedAt) ??
        new Date();
    }
    if (order.status !== "invoiced" && !order.paidAt) {
      patch.status = "invoiced";
    }

    if (Object.keys(patch).length === 0) return order;
    const updated = await updateOneById<Order>(db, orders, order.id, patch);
    return updated ?? order;
  }

  async backfillInvoices(): Promise<void> {
    const { isNotNull } = await import("drizzle-orm");
    const approvedOrders = await db.select().from(orders).where(
      or(isNotNull(orders.vendorApprovedAt), eq(orders.status, "invoiced")),
    );
    for (const order of approvedOrders) {
      const existing = await this.getInvoiceByOrderId(order.id);
      if (existing) continue;
      const { snapshotLineItems, approvedTotal } = await this.buildInvoiceSnapshotForOrder(
        order.id,
        order.vendorId,
      );
      if (snapshotLineItems.length === 0) continue;
      await this.createInvoice({
        orderId: order.id,
        displayOrderId: order.displayId,
        vendorId: order.vendorId,
        restaurantOrgId: order.restaurantOrgId,
        approvedTotal,
        approvedAt: toValidDate(order.vendorApprovedAt) ?? new Date(),
        lineItems: snapshotLineItems,
      });
    }
  }

  async replaceOrderLineItems(orderId: string, items: Omit<OrderLineItem, "id">[]): Promise<OrderLineItem[]> {
    return db.transaction(async (tx) => {
      await tx.delete(orderLineItems).where(eq(orderLineItems.orderId, orderId));
      if (items.length === 0) return [];
      return insertMany<OrderLineItem>(tx, orderLineItems, items as unknown as Record<string, unknown>[]);
    });
  }

  async createActivityLog(entry: { action: ActivityAction; entityType: ActivityEntityType; entityId: string; entityName: string; metadata?: string; vendorId?: string; restaurantId?: string; }): Promise<ActivityLog> {
    return insertOne<ActivityLog>(db, activityLogs, entry);
  }

  async getActivityLogs(limit = 100): Promise<ActivityLog[]> {
    return db.select().from(activityLogs).orderBy(desc(activityLogs.createdAt)).limit(limit);
  }

  async getActivityLogsByAction(action: ActivityAction, limit: number): Promise<ActivityLog[]> {
    return db.select().from(activityLogs)
      .where(eq(activityLogs.action, action))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit);
  }

  async createContactSubmission(submission: InsertContactSubmission): Promise<ContactSubmission> {
    const id = newId();
    await db.insert(contactSubmissions).values({
      id,
      name: submission.name,
      email: submission.email,
      message: submission.message,
      status: "new",
    });
    const [row] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.id, id));
    if (!row) throw new Error("Contact submission insert failed");
    return row;
  }

  async getContactSubmission(id: string): Promise<ContactSubmission | undefined> {
    const [row] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.id, id));
    return row;
  }

  async getAttachments(entityType: string, entityId: string): Promise<AttachmentMeta[]> {
    const rows = await db.select({
      id: attachments.id,
      entityType: attachments.entityType,
      entityId: attachments.entityId,
      fileName: attachments.fileName,
      fileType: attachments.fileType,
      fileSize: attachments.fileSize,
      createdAt: attachments.createdAt,
    }).from(attachments).where(
      and(eq(attachments.entityType, entityType), eq(attachments.entityId, entityId))
    ).orderBy(desc(attachments.createdAt));
    return rows;
  }

  async getAttachment(id: string): Promise<Attachment | undefined> {
    const [attachment] = await db.select().from(attachments).where(eq(attachments.id, id));
    return attachment;
  }

  async createAttachment(attachment: { entityType: string; entityId: string; fileName: string; fileType: string; fileSize: number; fileData: string }): Promise<Attachment> {
    return insertOne<Attachment>(db, attachments, attachment);
  }

  async deleteAttachment(id: string): Promise<boolean> {
    return deleteOneById(db, attachments, id);
  }

  async getNotes(entityType: string, entityId: string): Promise<InternalNote[]> {
    return db.select().from(internalNotes).where(
      and(eq(internalNotes.entityType, entityType), eq(internalNotes.entityId, entityId))
    ).orderBy(desc(internalNotes.createdAt));
  }

  async createNote(note: InsertInternalNote): Promise<InternalNote> {
    return insertOne<InternalNote>(db, internalNotes, note);
  }

  async deleteNote(id: string): Promise<boolean> {
    return deleteOneById(db, internalNotes, id);
  }

  async getAllProductCounts(): Promise<Record<string, number>> {
    const rows = await db
      .select({ vendorId: products.vendorId, count: sql<number>`count(*)` })
      .from(products)
      .where(ne(products.status, "archived"))
      .groupBy(products.vendorId);
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.vendorId] = row.count;
    }
    return result;
  }

  async getOrderSheetItemsEnriched(relationshipId: string) {
    return db
      .select({
        id: orderSheetItems.id,
        relationshipId: orderSheetItems.relationshipId,
        productId: orderSheetItems.productId,
        productName: products.name,
        sku: products.sku,
        unitType: products.unitType,
        unitSize: products.unitSize,
        price: products.price,
      })
      .from(orderSheetItems)
      .innerJoin(products, eq(orderSheetItems.productId, products.id))
      .where(eq(orderSheetItems.relationshipId, relationshipId))
      .orderBy(asc(orderSheetItems.createdAt));
  }

  async addOrderSheetItem(relationshipId: string, productId: string): Promise<OrderSheetItem> {
    return insertOne<OrderSheetItem>(db, orderSheetItems, { relationshipId, productId });
  }

  async removeOrderSheetItem(relationshipId: string, productId: string): Promise<boolean> {
    const rows = await db
      .select({ id: orderSheetItems.id })
      .from(orderSheetItems)
      .where(and(eq(orderSheetItems.relationshipId, relationshipId), eq(orderSheetItems.productId, productId)));
    if (rows.length === 0) return false;
    await db
      .delete(orderSheetItems)
      .where(and(eq(orderSheetItems.relationshipId, relationshipId), eq(orderSheetItems.productId, productId)));
    return true;
  }
}

export const storage = new DatabaseStorage();
