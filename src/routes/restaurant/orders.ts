import { storage } from "../../services/storage.js";
import { db } from "../../db/client.js";
import { newId } from "../../db/helpers.js";
import {
  insertVendorSchema,
  insertVendorEmployeeSchema,
  insertRestaurantOrgSchema,
  insertRestaurantEmployeeSchema,
  insertRelationshipSchema,
  insertProductSchema,
  insertOrderSchema,
  insertVendorCutoffSettingsSchema,
  isDuplicateKeyError,
  orders,
  orderLineItems,
  orderLineItemFulfillments,
  orderSubstitutions,
  type InvoiceLineItemSnapshot,
  invoices,
  internalNotes,
  attachments,
  products,
  vendorCutoffSettings,
} from "../../db/schema.js";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { hashPassword, resolvePortalPassword } from "../../lib/auth/password.js";
import { normalizePortalEmail } from "../../lib/email/mailer.js";
import {
  sendRestaurantEmployeeWelcomeEmail,
  sendRestaurantWelcomeEmail,
  sendRelationshipCreatedEmails,
  sendVendorWelcomeEmail,
} from "../../lib/email/onboarding.js";
import {
  getRequestActor,
  withActorMessages,
  withVendorSelfMessage,
  type ActivityActor,
} from "../../lib/activity/notification-messages.js";
import { buildOrderPlacedMessages } from "../../lib/activity/session-messages.js";
import { mergeOrderNotificationMetadata } from "../../lib/activity/order-metadata.js";
import { recordPortalActivity } from "../../lib/activity/portal-activity.js";
import { buildEmployeeDashboardStats, type DashboardPeriod } from "../../lib/dashboard/employee-stats.js";
import {
  ALL_VENDOR_PERMISSION_KEYS,
  employeeCanManageAssignments,
  getEffectivePermissions,
  getPrimaryRoleLabel,
  getRoleDefaultPermissions,
  normalizeExtraPermissions,
  normalizeRelationshipAssignments,
  VENDOR_PERMISSION_GROUPS,
} from "../../lib/permissions/vendor-employee.js";
import {
  ALL_RESTAURANT_PERMISSION_KEYS,
  getPrimaryRoleLabel as getRestaurantPrimaryRoleLabel,
  getRoleDefaultPermissions as getRestaurantRoleDefaultPermissions,
  normalizeEmployeeRoleList as normalizeRestaurantEmployeeRoles,
  normalizeExtraPermissions as normalizeRestaurantExtraPermissions,
  RESTAURANT_PERMISSION_GROUPS,
} from "../../lib/permissions/restaurant-employee.js";
import { getAuthSession } from "../../lib/auth/tokens.js";
import type { CompatExpressApp } from "../../lib/express-compat.js";
import { eq, and } from "drizzle-orm";
import { serializeEmployee, serializeRestaurantEmployee, logPortalActivity, logRestaurantReviewApproved, getOrderLogScope } from "../shared/helpers.js";

export function registerRestaurantOrderRoutes(app: CompatExpressApp) {
  // --- Orders ---
  app.get("/api/restaurant-orgs/:restaurantId/orders", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const restaurant = await storage.getRestaurantOrg(restaurantId);
      if (!restaurant) return res.status(404).json({ message: "Restaurant organization not found" });
      const allOrders = await storage.getOrdersByRestaurant(restaurantId);
      const enriched = await Promise.all(
        allOrders.map(async (order) => {
          const lineItems = await storage.getOrderLineItems(order.id);
          const invoice =
            order.paidAt || order.status === "invoiced" || order.vendorApprovedAt
              ? await storage.getInvoiceByOrderId(order.id)
              : undefined;
          const lineTotal = lineItems.reduce(
            (sum, lineItem) =>
              sum + Number(lineItem.quantity) * Number(lineItem.unitPriceAtTimeOfOrder),
            0,
          );
          const total = invoice?.approvedTotal ? Number(invoice.approvedTotal) : lineTotal;
          return {
            order,
            itemCount: lineItems.length,
            total: total.toFixed(2),
          };
        }),
      );
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch orders" });
    }
  });
  
  app.get("/api/restaurant-orgs/:restaurantId/draft-order/:vendorId", async (req, res) => {
    try {
      const { restaurantId, vendorId } = req.params;
      const draft = await storage.getDraftOrder(restaurantId, vendorId);
      if (!draft) return res.json(null);
      const lineItems = await storage.getOrderLineItems(draft.id);
      res.json({ order: draft, lineItems });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch draft order" });
    }
  });
  
  app.get("/api/restaurant-orgs/:restaurantId/submitted-order/:vendorId", async (req, res) => {
    try {
      const { restaurantId, vendorId } = req.params;
      const order = await storage.getSubmittedOrder(restaurantId, vendorId);
      if (!order) return res.json(null);
      const lineItems = await storage.getOrderLineItems(order.id);
      res.json({ order, lineItems });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch submitted order" });
    }
  });
  
  app.get("/api/restaurant-orgs/:restaurantId/submitted-orders/:vendorId", async (req, res) => {
    try {
      const { restaurantId, vendorId } = req.params;
      const allOrders = await storage.getSubmittedOrders(restaurantId, vendorId);
      const result = await Promise.all(
        allOrders.map(async (rawOrder) => {
          const order = await storage.normalizeInvoicedOrderState(rawOrder);
          const lineItems = await storage.getOrderLineItems(order.id);
          const fulfillments = order.restaurantReviewSubmittedAt
            ? await storage.getOrderFulfillments(order.id)
            : [];
          let invoice =
            order.status === "invoiced" || order.vendorApprovedAt || order.paidAt
              ? await storage.getInvoiceByOrderId(order.id)
              : undefined;
          if (!invoice && (order.status === "invoiced" || order.vendorApprovedAt)) {
            invoice = await storage.ensureInvoiceForOrder(order);
          }
          return { order, lineItems, fulfillments, invoice: invoice ?? null };
        })
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch submitted orders" });
    }
  });
  
  app.get("/api/restaurant-orgs/:restaurantId/orders/:orderId", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const rawOrder = await storage.getOrder(orderId);
      if (!rawOrder || rawOrder.restaurantOrgId !== restaurantId) {
        return res.status(404).json({ message: "Order not found" });
      }
      const order = await storage.normalizeInvoicedOrderState(rawOrder);
      const lineItems = await storage.getOrderLineItems(orderId);
      const productDetails = await Promise.all(
        lineItems.map(li => storage.getProduct(li.productId))
      );
      const lineItemsWithProducts = lineItems.map((li, i) => ({
        ...li,
        product: productDetails[i] || null,
      }));
      res.json({ order, lineItems: lineItemsWithProducts });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch order" });
    }
  });
  
  // Shared validation helper for order items
  async function validateOrderItems(
    vendorId: string,
    restaurantId: string,
    items: { productId: string; quantity: number }[],
    res: any
  ): Promise<Map<string, any> | null> {
    const hasLink = await storage.hasRelationship(vendorId, restaurantId);
    if (!hasLink) {
      res.status(403).json({ message: "This vendor is not linked to this restaurant organization." });
      return null;
    }
    const vendorProducts = await storage.getProductsByVendor(vendorId, false);
    const vendorProductMap = new Map(vendorProducts.map(p => [p.id, p]));
    for (const item of items) {
      const product = vendorProductMap.get(item.productId);
      if (!product) {
        res.status(400).json({ message: `Product ${item.productId} does not belong to this vendor or is not available.` });
        return null;
      }
      if (item.quantity < 1 || !Number.isInteger(item.quantity)) {
        res.status(400).json({ message: "All quantities must be positive integers." });
        return null;
      }
    }
    return vendorProductMap;
  }
  
  app.post("/api/restaurant-orgs/:restaurantId/orders", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const restaurant = await storage.getRestaurantOrg(restaurantId);
      if (!restaurant) return res.status(404).json({ message: "Restaurant organization not found" });
  
      const body = req.body as { vendorId: string; items: { productId: string; quantity: number }[]; status?: "draft" | "submitted" };
      const status = body.status === "draft" ? "draft" : "submitted";
  
      if (!body.vendorId || !Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ message: "vendorId and at least one item are required" });
      }
  
      const vendorProductMap = await validateOrderItems(body.vendorId, restaurantId, body.items, res);
      if (!vendorProductMap) return;
  
      const lineItemsToInsert = body.items.map(item => ({
        orderId: "",
        productId: item.productId,
        quantity: item.quantity,
        unitPriceAtTimeOfOrder: vendorProductMap.get(item.productId)!.price,
      }));
  
      const cutoffSetting = await db.select().from(vendorCutoffSettings).where(eq(vendorCutoffSettings.vendorId, body.vendorId)).limit(1);
      const cutoffAt = cutoffSetting.length > 0
        ? (() => {
            const setting = cutoffSetting[0];
            const now = new Date();
            const cutoff = new Date(now);
            cutoff.setHours(setting.cutoffHour, setting.cutoffMinute, 0, 0);
            if (cutoff.getTime() <= now.getTime()) cutoff.setDate(cutoff.getDate() + 1);
            return cutoff;
          })()
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
      const { order, lineItems: createdLineItems } = await storage.createOrderWithLineItems(
        { restaurantOrgId: restaurantId, vendorId: body.vendorId, status, cutoffAt } as any,
        lineItemsToInsert
      );
      if (status === "submitted") {
        const placed = buildOrderPlacedMessages(
          { id: restaurantId, name: restaurant.name },
          order.displayId ?? order.id,
          { itemCount: createdLineItems.length, vendorId: body.vendorId },
        );
        logPortalActivity({
          action: "order_submitted",
          entityType: "order",
          entityId: order.id,
          entityName: placed.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: placed.metadata,
        });
      } else {
        logPortalActivity({
          action: "order_created",
          entityType: "order",
          entityId: order.id,
          entityName: `Draft order created: #${order.displayId ?? order.id}`,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: { restaurantName: restaurant.name, status, itemCount: createdLineItems.length },
        });
      }
      res.status(201).json({ order, lineItems: createdLineItems });
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to create order" });
    }
  });
  
  app.delete("/api/restaurant-orgs/:restaurantId/orders/:orderId", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.restaurantOrgId !== restaurantId) return res.status(403).json({ message: "Forbidden" });
      if (order.status !== "draft") return res.status(400).json({ message: "Only draft orders can be deleted" });
      await storage.deleteDraftOrder(orderId);
      logPortalActivity({
        action: "order_deleted",
        entityType: "order",
        entityId: orderId,
        entityName: `Draft order deleted: #${order.displayId ?? orderId}`,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
      });
      return res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to delete draft order" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:restaurantId/orders/:orderId", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.restaurantOrgId !== restaurantId) {
        return res.status(404).json({ message: "Order not found" });
      }
      if (order.status !== "draft") {
        return res.status(409).json({ message: "Only draft orders can be modified." });
      }
      if (order.cutoffAt && new Date(order.cutoffAt).getTime() < Date.now()) {
        return res.status(409).json({ message: "Order cutoff has passed. This order is locked." });
      }
  
      const body = req.body as { items?: { productId: string; quantity: number }[]; status?: "submitted" };
  
      if (body.status === "submitted") {
        // Submit the draft: re-fetch prices from DB at submit time and replace line items
        const currentLineItems = await storage.getOrderLineItems(orderId);
        if (currentLineItems.length === 0) {
          return res.status(400).json({ message: "Cannot submit an order with no line items." });
        }
        const vendorProducts = await storage.getProductsByVendor(order.vendorId, false);
        const vendorProductMap = new Map(vendorProducts.map(p => [p.id, p]));
        const unavailableItems = currentLineItems.filter(li => !vendorProductMap.has(li.productId));
        if (unavailableItems.length > 0) {
          return res.status(400).json({ message: "Your draft contains products that are no longer available. Please review your order and remove unavailable items before submitting." });
        }
        const refreshedItems = currentLineItems.map(li => ({
          orderId,
          productId: li.productId,
          quantity: li.quantity,
          unitPriceAtTimeOfOrder: vendorProductMap.get(li.productId)!.price,
        }));
        await storage.replaceOrderLineItems(orderId, refreshedItems);
        const submitted = await storage.submitOrder(orderId);
        if (!submitted) return res.status(500).json({ message: "Failed to submit order" });
        const finalLineItems = await storage.getOrderLineItems(orderId);
        const restaurantOrg = await storage.getRestaurantOrg(order.restaurantOrgId);
        if (restaurantOrg) {
          const placed = buildOrderPlacedMessages(
            { id: order.restaurantOrgId, name: restaurantOrg.name },
            submitted.displayId ?? submitted.id,
            { itemCount: finalLineItems.length },
          );
          logPortalActivity({
            action: "order_submitted",
            entityType: "order",
            entityId: orderId,
            entityName: placed.entityName,
            vendorId: order.vendorId,
            restaurantId: order.restaurantOrgId,
            metadata: placed.metadata,
          });
        }
        return res.json({ order: submitted, lineItems: finalLineItems });
      }
  
      if (Array.isArray(body.items)) {
        if (body.items.length === 0) {
          await storage.replaceOrderLineItems(orderId, []);
          logPortalActivity({
            action: "order_draft_cleared",
            entityType: "order",
            entityId: orderId,
            entityName: `Draft order cleared: #${order.displayId ?? orderId}`,
            vendorId: order.vendorId,
            restaurantId: order.restaurantOrgId,
          });
          return res.json({ order, lineItems: [] });
        }
        const vendorProductMap = await validateOrderItems(order.vendorId, restaurantId, body.items, res);
        if (!vendorProductMap) return;
        const newItems = body.items.map(item => ({
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          unitPriceAtTimeOfOrder: vendorProductMap.get(item.productId)!.price,
        }));
        const updatedLineItems = await storage.replaceOrderLineItems(orderId, newItems);
        logPortalActivity({
          action: "order_draft_updated",
          entityType: "order",
          entityId: orderId,
          entityName: `Draft order updated: #${order.displayId ?? orderId}`,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: { itemCount: updatedLineItems.length },
        });
        return res.json({ order, lineItems: updatedLineItems });
      }
  
      res.status(400).json({ message: "Provide items or status to update." });
    } catch (error) {
      res.status(500).json({ message: "Failed to update order" });
    }
  });
  
}
