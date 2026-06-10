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
import {
  getEffectiveLineQty,
  hasRestaurantReviewAdjustment,
} from "../../lib/restaurant-order-review.js";

export function registerRestaurantReviewRoutes(app: CompatExpressApp) {
  // --- Order Review (Restaurant side) ---
  
  const reviewBodySchema = z.object({
    items: z.array(z.object({
      lineItemId: z.string().min(1),
      receivedQty: z.number().int().min(0).nullable().optional(),
      note: z.string().max(500).nullable().optional(),
    })),
    reportIssue: z.boolean().optional().default(false),
  });
  
  app.get("/api/restaurant-orgs/:restaurantId/orders/:orderId/review", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.restaurantOrgId !== restaurantId) {
        return res.status(404).json({ message: "Order not found" });
      }
      const fulfillments = await storage.getOrderFulfillments(orderId);
      res.json(fulfillments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch order review" });
    }
  });
  
  app.get("/api/restaurant-orgs/:restaurantId/orders/:orderId/substitutions", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.restaurantOrgId !== restaurantId) return res.status(404).json({ message: "Order not found" });
      const rows = await db.select().from(orderSubstitutions).where(eq(orderSubstitutions.orderId, orderId));
      res.json(rows);
    } catch {
      res.status(500).json({ message: "Failed to fetch substitutions" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:restaurantId/orders/:orderId/substitutions/:substitutionId", async (req, res) => {
    try {
      const { restaurantId, orderId, substitutionId } = req.params;
      const body = z.object({ status: z.enum(["accepted", "rejected"]) }).parse(req.body);
      const order = await storage.getOrder(orderId);
      if (!order || order.restaurantOrgId !== restaurantId) return res.status(404).json({ message: "Order not found" });
      await db.update(orderSubstitutions).set({ status: body.status }).where(and(eq(orderSubstitutions.id, substitutionId), eq(orderSubstitutions.orderId, orderId)));
      const subStatusDisplayId = order.displayId ?? orderId;
      const restaurantOrg = await storage.getRestaurantOrg(restaurantId);
      const subStatusActor: ActivityActor = {
        id: restaurantId,
        name: restaurantOrg?.name ?? "Restaurant",
        role: "restaurant",
      };
      const subStatusMessages = withActorMessages(
        subStatusActor,
        `You ${body.status} a substitution for order #${subStatusDisplayId}`,
        `${subStatusActor.name} ${body.status} a substitution for order #${subStatusDisplayId}`,
        mergeOrderNotificationMetadata(order, { displayId: subStatusDisplayId, orderId, status: body.status }),
      );
      logPortalActivity({
        action: "order_substitution_status_updated",
        entityType: "order",
        entityId: orderId,
        entityName: subStatusMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: subStatusMessages.metadata,
      });
      res.json({ message: "Substitution updated" });
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update substitution" });
    }
  });
  
  app.post("/api/restaurant-orgs/:restaurantId/orders/:orderId/review", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.restaurantOrgId !== restaurantId) {
        return res.status(404).json({ message: "Order not found" });
      }
      const body = reviewBodySchema.parse(req.body);
      if (!body.reportIssue && (order.vendorApprovedAt || order.status === "invoiced")) {
        const patch: Record<string, unknown> = {};
        if (order.status !== "invoiced") patch.status = "invoiced";
        if (!order.restaurantReviewSubmittedAt) patch.restaurantReviewSubmittedAt = new Date();
        if (Object.keys(patch).length > 0) {
          await db.update(orders).set(patch).where(eq(orders.id, orderId));
        }
        const fixedOrder = (await storage.getOrder(orderId)) ?? order;
        const invoice = await storage.getInvoiceByOrderId(orderId);
        if (!order.restaurantReviewSubmittedAt) {
          await logRestaurantReviewApproved(fixedOrder, restaurantId, {
            approvedTotal: invoice?.approvedTotal,
            lineItemCount: Array.isArray(invoice?.lineItems) ? invoice.lineItems.length : undefined,
          });
        }
        const fulfillments = await storage.getOrderFulfillments(orderId);
        return res.json({ order: fixedOrder, fulfillments });
      }
      if (order.status !== "delivered" && order.status !== "submitted") {
        return res.status(409).json({ message: "Only delivered or submitted orders can be reviewed" });
      }
      const updatedOrder = await db.transaction(async (tx) => {
        const ownedLineItems = await tx.select({ id: orderLineItems.id, productId: orderLineItems.productId, quantity: orderLineItems.quantity, unitPriceAtTimeOfOrder: orderLineItems.unitPriceAtTimeOfOrder })
          .from(orderLineItems)
          .where(eq(orderLineItems.orderId, orderId));
        const validIds = new Set(ownedLineItems.map(li => li.id));
        for (const item of body.items) {
          if (!validIds.has(item.lineItemId)) throw new Error("INVALID_LINE_ITEM_ID");
        }
  
        for (const item of body.items) {
          await tx.insert(orderLineItemFulfillments)
            .values({
              id: newId(),
              orderId,
              orderLineItemId: item.lineItemId,
              restaurantReceivedQty: item.receivedQty ?? null,
              restaurantNote: item.note ?? null,
            })
            .onConflictDoUpdate({
              target: orderLineItemFulfillments.orderLineItemId,
              set: {
                restaurantReceivedQty: item.receivedQty ?? null,
                restaurantNote: item.note ?? null,
                updatedAt: new Date(),
              },
            });
        }
  
        const fulfillmentRows = await tx.select().from(orderLineItemFulfillments).where(eq(orderLineItemFulfillments.orderId, orderId));
        const fulfillmentMap = new Map(fulfillmentRows.map(f => [f.orderLineItemId, f]));
        const needsVendorReview =
          body.reportIssue ||
          hasRestaurantReviewAdjustment(ownedLineItems, fulfillmentMap, body.items, order);

        await tx.update(orders)
          .set({
            restaurantReviewSubmittedAt: new Date(),
            restaurantIssueStatus: needsVendorReview ? "pending_vendor" : null,
            ...(needsVendorReview
              ? {
                  status: "delivered",
                  vendorApprovedAt: null,
                  vendorRejectedAt: null,
                  vendorRejectionReason: null,
                  driverResolutionNote: null,
                  driverResolvedAt: null,
                }
              : {}),
          })
          .where(eq(orders.id, orderId));

        if (needsVendorReview) {
          const [pendingOrder] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
          if (!pendingOrder) throw new Error("Order not found");
          return { pendingVendorReview: true as const, order: pendingOrder };
        }

        const refreshedOrder = await storage.getOrder(orderId);
        if (!refreshedOrder) throw new Error("Order not found");

        const allVendorProducts = await tx.select().from(products).where(eq(products.vendorId, order.vendorId));
        const acceptedSubstitutions = await tx.select().from(orderSubstitutions).where(and(eq(orderSubstitutions.orderId, orderId), eq(orderSubstitutions.status, "accepted")));
        const productMap = new Map(allVendorProducts.map(p => [p.id, p]));

        const snapshotLineItems = ownedLineItems.map(li => {
          const f = fulfillmentMap.get(li.id);
          const expectedQty = getEffectiveLineQty(f, li.quantity, order);
          const approvedQty = f?.restaurantReceivedQty ?? expectedQty;
          const unitPrice = li.unitPriceAtTimeOfOrder;
          return {
            orderLineItemId: li.id,
            productId: li.productId,
            productName: productMap.get(li.productId)?.name ?? li.productId,
            sku: productMap.get(li.productId)?.sku ?? null,
            approvedQty,
            unitPrice,
            lineTotal: (parseFloat(unitPrice) * approvedQty).toFixed(2),
            restaurantNote: f?.restaurantNote ?? null,
          };
        });
        for (const sub of acceptedSubstitutions) {
          const product = productMap.get(sub.substituteProductId);
          if (!product) continue;
          snapshotLineItems.push({
            orderLineItemId: sub.orderLineItemId,
            productId: sub.substituteProductId,
            productName: product.name,
            sku: product.sku ?? null,
            approvedQty: sub.proposedQty,
            unitPrice: product.price,
            lineTotal: (parseFloat(product.price) * sub.proposedQty).toFixed(2),
            restaurantNote: `Accepted substitute${sub.note ? `: ${sub.note}` : ""}`,
          });
        }
  
        const approvedTotal = snapshotLineItems.reduce((sum, li) => sum + parseFloat(li.lineTotal), 0).toFixed(2);
        await tx.update(orders)
          .set({
            vendorApprovedAt: new Date(),
            vendorRejectedAt: null,
            vendorRejectionReason: null,
            status: "invoiced",
          })
          .where(and(eq(orders.id, orderId), eq(orders.vendorId, order.vendorId)));
        const existingInvoice = await tx.select().from(invoices).where(eq(invoices.orderId, orderId)).limit(1);
        if (existingInvoice.length === 0) {
          await tx.insert(invoices).values({
            id: newId(),
            orderId,
            displayOrderId: refreshedOrder.displayId ?? orderId,
            vendorId: order.vendorId,
            restaurantOrgId: refreshedOrder.restaurantOrgId,
            approvedTotal,
            approvedAt: new Date(),
            lineItems: snapshotLineItems,
          });
        }
        return { order: refreshedOrder, approvedTotal, lineItemCount: snapshotLineItems.length };
      });

      if ("pendingVendorReview" in updatedOrder && updatedOrder.pendingVendorReview) {
        const displayId = order.displayId ?? orderId;
        const restaurantOrg = await storage.getRestaurantOrg(restaurantId);
        const restaurantActor: ActivityActor = {
          id: restaurantId,
          name: restaurantOrg?.name ?? "Restaurant",
          role: "restaurant",
        };
        const issueMessages = withActorMessages(
          restaurantActor,
          `You submitted a review with quantity changes for order #${displayId}`,
          `${restaurantActor.name} submitted a review with quantity changes for order #${displayId} — vendor review required`,
          mergeOrderNotificationMetadata(order, { displayId }),
        );
        await logPortalActivity({
          action: "order_issue_pending_vendor",
          entityType: "order",
          entityId: orderId,
          entityName: issueMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: issueMessages.metadata,
        });
        const fulfillments = await storage.getOrderFulfillments(orderId);
        return res.json({ order: updatedOrder.order, fulfillments, pendingVendorReview: true });
      }

      const finalizedOrder = (await storage.getOrder(orderId)) ?? updatedOrder.order;
      await logRestaurantReviewApproved(finalizedOrder, restaurantId, {
        approvedTotal: updatedOrder.approvedTotal,
        lineItemCount: updatedOrder.lineItemCount,
      });
      const fulfillments = await storage.getOrderFulfillments(orderId);
      res.json({ order: finalizedOrder, fulfillments, invoiced: true });
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: fromZodError(error).message });
      }
      if (error?.message === "INVALID_LINE_ITEM_ID") {
        return res.status(400).json({ message: "One or more line items do not belong to this order." });
      }
      if (isDuplicateKeyError(error)) {
        const fixedOrder = await storage.getOrder(orderId);
        if (fixedOrder) {
          await logRestaurantReviewApproved(fixedOrder, restaurantId);
          const fulfillments = await storage.getOrderFulfillments(orderId);
          return res.json({ order: fixedOrder, fulfillments });
        }
      }
      res.status(500).json({ message: "Failed to save review" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:restaurantId/orders/:orderId/resubmit-review", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.restaurantOrgId !== restaurantId) {
        return res.status(404).json({ message: "Order not found" });
      }
      if (!order.vendorRejectedAt || order.vendorApprovedAt) {
        return res.status(409).json({ message: "Order is not in a disputed state" });
      }
      const body = reviewBodySchema.parse(req.body);
      const updatedOrder = await storage.resubmitDisputedReview(orderId, body.items.map(item => ({
        orderLineItemId: item.lineItemId,
        receivedQty: item.receivedQty ?? null,
        note: item.note ?? null,
      })));
      const resubmitDisplayId = order.displayId ?? orderId;
      const resubmitRestaurant = await storage.getRestaurantOrg(restaurantId);
      const resubmitActor: ActivityActor = {
        id: restaurantId,
        name: resubmitRestaurant?.name ?? "Restaurant",
        role: "restaurant",
      };
      const resubmitMessages = withActorMessages(
        resubmitActor,
        `You resubmitted the review for order #${resubmitDisplayId}`,
        `${resubmitActor.name} resubmitted the review for order #${resubmitDisplayId}`,
        mergeOrderNotificationMetadata(order, { displayId: resubmitDisplayId, orderId }),
      );
      logPortalActivity({
        action: "order_review_resubmitted",
        entityType: "order",
        entityId: orderId,
        entityName: resubmitMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: resubmitMessages.metadata,
      });
      const fulfillments = await storage.getOrderFulfillments(orderId);
      res.json({ order: updatedOrder, fulfillments });
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: fromZodError(error).message });
      }
      if (error?.message === "INVALID_LINE_ITEM_ID") {
        return res.status(400).json({ message: "One or more line items do not belong to this order." });
      }
      res.status(500).json({ message: "Failed to resubmit review" });
    }
  });
  
}
