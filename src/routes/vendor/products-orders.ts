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
import {
  clearWarehousePickingFields,
  reconcileFulfillmentsForOrder,
  sanitizeFulfillmentsForOrder,
} from "../../lib/order-fulfillment.js";
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
import { getEffectiveLineQty } from "../../lib/restaurant-order-review.js";
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
import { eq, and, sql } from "drizzle-orm";
import { serializeEmployee, serializeRestaurantEmployee, logPortalActivity, logRestaurantReviewApproved, getOrderLogScope } from "../shared/helpers.js";

export function registerVendorProductOrderRoutes(app: CompatExpressApp) {
  // --- Products (vendor-scoped) ---
  app.get("/api/vendors/:vendorId/products", async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const products = await storage.getProductsByVendor(req.params.vendorId, includeArchived);
      res.json(products);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch products" });
    }
  });
  
  app.get("/api/vendors/:vendorId/orders", async (req, res) => {
    try {
      const { vendorId } = req.params;
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const vendorOrders = await storage.getOrdersByVendor(vendorId);
      const allRestaurants = await storage.getRestaurantOrgs();
      const restaurantMap = new Map(allRestaurants.map(r => [r.id, r.name]));
      const vendorProducts = await storage.getProductsByVendor(vendorId, true);
      const productMap = new Map(vendorProducts.map(p => [p.id, p]));
      const result = await Promise.all(
        vendorOrders.map(async (order) => {
          const rawLineItems = await storage.getOrderLineItems(order.id);
          const lineItems = rawLineItems.map(li => {
            const product = productMap.get(li.productId);
            return {
              ...li,
              productName: product?.name ?? li.productId,
              sku: product?.sku ?? null,
            };
          });
          const rawFulfillments = await storage.getOrderFulfillments(order.id);
          await reconcileFulfillmentsForOrder(order, rawFulfillments);
          const refreshedOrder = (await storage.getOrder(order.id)) ?? order;
          const fulfillments = sanitizeFulfillmentsForOrder(
            refreshedOrder,
            await storage.getOrderFulfillments(order.id),
          );
          // Include invoice snapshot for approved/invoiced/paid orders
          let invoice =
            refreshedOrder.status === "invoiced" || refreshedOrder.vendorApprovedAt || refreshedOrder.paidAt
              ? await storage.getInvoiceByOrderId(refreshedOrder.id)
              : undefined;
          if (!invoice && (refreshedOrder.status === "invoiced" || refreshedOrder.vendorApprovedAt)) {
            invoice = await storage.ensureInvoiceForOrder(refreshedOrder);
          }
          return {
            order: refreshedOrder,
            lineItems,
            restaurantName: restaurantMap.get(refreshedOrder.restaurantOrgId) ?? "Unknown Restaurant",
            fulfillments,
            invoice: invoice ?? null,
          };
        })
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vendor orders" });
    }
  });
  
  app.get("/api/vendors/:vendorId/employee-dashboard", async (req, res) => {
    try {
      const { vendorId } = req.params;
      const token = req.headers.authorization?.split(" ")[1];
      const session = getAuthSession(token);
      if (!session?.userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }
  
      const periodRaw = String(req.query.period ?? "today");
      const period: DashboardPeriod =
        periodRaw === "week" || periodRaw === "month" ? periodRaw : "today";
  
      const role = session.role === "warehouse" ? "warehouse_worker" : session.role;
      const allowedRoles = new Set(["warehouse_worker", "driver", "manager", "vendor_admin"]);
      if (!allowedRoles.has(role)) {
        return res.status(403).json({ message: "Dashboard is only available for vendor team roles" });
      }
      if (session.vendorId && session.vendorId !== vendorId && role !== "vendor_admin") {
        return res.status(403).json({ message: "Access denied" });
      }
  
      const data = await buildEmployeeDashboardStats({
        vendorId,
        employeeId: session.userId,
        role,
        period,
      });
      res.json(data);
    } catch (error: any) {
      if (error?.message === "EMPLOYEE_NOT_FOUND") {
        return res.status(404).json({ message: "Employee not found for this vendor" });
      }
      console.error(error);
      res.status(500).json({ message: "Failed to load employee dashboard" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/reject", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const { reason } = z.object({ reason: z.string().min(1, "Rejection reason is required") }).parse(req.body);
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.vendorId !== vendorId) return res.status(403).json({ message: "Access denied" });
      if (!order.restaurantReviewSubmittedAt) {
        return res.status(409).json({ message: "Order has not been reviewed by the restaurant yet" });
      }
      if (order.vendorApprovedAt) {
        return res.status(409).json({ message: "Order has already been approved" });
      }
      if (order.vendorRejectedAt) {
        return res.status(409).json({ message: "Order review has already been rejected" });
      }
      const updated = await storage.rejectOrderReview(orderId, reason);
      if (!updated) return res.status(500).json({ message: "Failed to reject order review" });
      const rejectDisplayId = order.displayId ?? orderId;
      const rejectActor = getRequestActor();
      const rejectMessages = withActorMessages(
        rejectActor,
        `You rejected the restaurant review for order #${rejectDisplayId}`,
        `${rejectActor.name} rejected the restaurant review for order #${rejectDisplayId}`,
        mergeOrderNotificationMetadata(order, { displayId: rejectDisplayId, reason }),
      );
      logPortalActivity({
        action: "order_review_rejected",
        entityType: "order",
        entityId: orderId,
        entityName: rejectMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: rejectMessages.metadata,
      });
      res.json({ order: updated });
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to reject order review" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/approve", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.vendorId !== vendorId) return res.status(403).json({ message: "Access denied" });
      return res.status(405).json({
        message: "Vendor approval is disabled. Restaurant review or driver issue resolution creates the invoice automatically.",
      });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to approve order review" });
    }
  });

  app.patch("/api/vendors/:vendorId/orders/:orderId/forward-review-to-driver", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.vendorId !== vendorId) return res.status(403).json({ message: "Access denied" });
      if (order.restaurantIssueStatus !== "pending_vendor") {
        return res.status(409).json({ message: "Order is not pending vendor review." });
      }

      const [updated] = await db
        .update(orders)
        .set({
          restaurantIssueStatus: "pending_driver",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId))
        .returning();

      if (!updated) return res.status(500).json({ message: "Failed to forward review to driver" });

      const displayId = order.displayId ?? orderId;
      const forwardActor = getRequestActor();
      const forwardMessages = withActorMessages(
        forwardActor,
        `You forwarded restaurant review changes for order #${displayId} to the driver`,
        `${forwardActor.name} forwarded restaurant review changes for order #${displayId} to the driver`,
        mergeOrderNotificationMetadata(order, { displayId, orderId }),
      );
      logPortalActivity({
        action: "order_review_forwarded_to_driver",
        entityType: "order",
        entityId: orderId,
        entityName: forwardMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: forwardMessages.metadata,
      });

      if (updated.driverId) {
        logPortalActivity({
          action: "order_issue_pending_driver",
          entityType: "vendor_employee",
          entityId: updated.driverId,
          entityName: `${forwardActor.name} forwarded review changes on order #${displayId} — please review`,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: {
            ...forwardMessages.metadata,
            employeeId: updated.driverId,
            orderId,
            selfMessage: `Vendor forwarded restaurant review changes on order #${displayId} — please review and resolve`,
            othersMessage: `${forwardActor.name} forwarded review changes on order #${displayId} — assigned to you for resolution`,
          },
        });
      }

      res.json({ order: updated });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to forward review to driver" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:restaurantId/orders/:orderId/pay", async (req, res) => {
    try {
      const { restaurantId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.restaurantOrgId !== restaurantId) return res.status(403).json({ message: "Access denied" });
      if (order.vendorRejectedAt && !order.vendorApprovedAt) {
        return res.status(409).json({ message: "Order is in dispute and cannot be marked as paid" });
      }
      if (!order.vendorApprovedAt) {
        return res.status(409).json({ message: "Order has not been approved by the vendor yet" });
      }
      if (order.paidAt) {
        return res.status(409).json({ message: "Order has already been marked as paid" });
      }
      const updated = await storage.markOrderPaid(orderId);
      if (updated) {
        // Create admin activity log entry for the payment event
        const [invoice, restaurant, vendor] = await Promise.all([
          storage.getInvoiceByOrderId(orderId),
          storage.getRestaurantOrg(order.restaurantOrgId),
          storage.getVendor(order.vendorId),
        ]);
        if (restaurant && vendor) {
          const paidDisplayId = updated.displayId ?? orderId;
          const paidMessages = withActorMessages(
            { id: restaurantId, name: restaurant.name, role: "restaurant" },
            `You recorded payment for order #${paidDisplayId}`,
            `Payment received for order #${paidDisplayId} from ${restaurant.name}`,
            {
              restaurantName: restaurant.name,
              vendorName: vendor.name,
              amount: invoice?.approvedTotal ?? "0",
              displayId: paidDisplayId,
            },
          );
          logPortalActivity({
            action: "order_paid",
            entityType: "order",
            entityId: orderId,
            entityName: paidMessages.entityName,
            vendorId: order.vendorId,
            restaurantId: order.restaurantOrgId,
            metadata: paidMessages.metadata,
          });
        }
      }
      res.json({ order: updated });
    } catch (error) {
      res.status(500).json({ message: "Failed to mark order as paid" });
    }
  });
  
  app.get("/api/vendors/:vendorId/orders/:orderId", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.vendorId !== vendorId) return res.status(403).json({ message: "Access denied" });
      const rawLineItems = await storage.getOrderLineItems(orderId);
      const vendorProducts = await storage.getProductsByVendor(vendorId, true);
      const productMap = new Map(vendorProducts.map(p => [p.id, p]));
      const lineItems = rawLineItems.map(li => {
        const product = productMap.get(li.productId);
        return { ...li, productName: product?.name ?? li.productId, sku: product?.sku ?? null };
      });
      const allRestaurants = await storage.getRestaurantOrgs();
      const restaurantMap = new Map(allRestaurants.map(r => [r.id, r.name]));
      const rawFulfillments = await storage.getOrderFulfillments(orderId);
      await reconcileFulfillmentsForOrder(order, rawFulfillments);
      const refreshedOrder = (await storage.getOrder(orderId)) ?? order;
      const fulfillments = sanitizeFulfillmentsForOrder(
        refreshedOrder,
        await storage.getOrderFulfillments(orderId),
      );
      res.json({
        order: refreshedOrder,
        lineItems,
        fulfillments,
        restaurantName: restaurantMap.get(order.restaurantOrgId) ?? "Unknown Restaurant",
        vendorName: vendor.name,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vendor order" });
    }
  });
  
  app.get("/api/vendors/:vendorId/orders/:orderId/fulfillments", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });
      const fulfillments = sanitizeFulfillmentsForOrder(
        order,
        await reconcileFulfillmentsForOrder(order, await storage.getOrderFulfillments(orderId)),
      );
      res.json(fulfillments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch fulfillments" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/assign", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const body = z.object({
        warehouseWorkerId: z.string().min(1),
        driverId: z.string().min(1),
      }).parse(req.body);
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });
      if (!["submitted", "picking_review", "ready_for_delivery"].includes(order.status)) {
        return res.status(409).json({ message: "This order cannot be reassigned in its current status." });
      }

      const previousWorkerId = order.warehouseWorkerId ?? null;
      const previousDriverId = order.driverId ?? null;
      const workerChanged = previousWorkerId !== body.warehouseWorkerId;
      const driverChanged = previousDriverId !== body.driverId;
      if (!workerChanged && !driverChanged) {
        return res.json(order);
      }

      const [worker, driver] = await Promise.all([
        storage.getVendorEmployee(body.warehouseWorkerId),
        storage.getVendorEmployee(body.driverId),
      ]);
      if (!worker || worker.vendorId !== vendorId) return res.status(400).json({ message: "Warehouse worker not found for this vendor." });
      if (!driver || driver.vendorId !== vendorId) return res.status(400).json({ message: "Driver not found for this vendor." });

      const vendor = await storage.getVendor(vendorId);
      const vendorName = vendor?.name ?? "Vendor";
      const displayId = order.displayId ?? orderId;
      const assignmentMeta = mergeOrderNotificationMetadata(
        { warehouseWorkerId: body.warehouseWorkerId, driverId: body.driverId },
        {
          workerName: worker.name,
          driverName: driver.name,
          vendorName,
          displayId,
          orderId,
        },
      );

      await db.update(orders).set({
        warehouseWorkerId: body.warehouseWorkerId,
        driverId: body.driverId,
        ...(order.status === "submitted"
          ? { pickingStatus: "assigned" }
          : {}),
      }).where(eq(orders.id, orderId));

      if (order.status === "submitted" && workerChanged) {
        await clearWarehousePickingFields(orderId);
      }

      const assignActor = getRequestActor();
      const isReassignment = Boolean(previousWorkerId || previousDriverId);
      const assignSummary = isReassignment
        ? `You updated assignments for order #${displayId}: ${worker.name} (warehouse) and ${driver.name} (driver)`
        : `You assigned order #${displayId} to ${worker.name} (warehouse) and ${driver.name} (driver)`;
      const assignOthers = isReassignment
        ? `${vendorName} updated assignments for order #${displayId}: ${worker.name} (warehouse) and ${driver.name} (driver)`
        : `${vendorName} assigned order #${displayId} to ${worker.name} (warehouse) and ${driver.name} (driver)`;

      const assignMessages = withVendorSelfMessage(
        assignActor,
        assignSummary,
        assignOthers,
        assignSummary,
        assignmentMeta,
      );
      await logPortalActivity({
        action: "order_assigned",
        entityType: "order",
        entityId: orderId,
        entityName: assignMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: assignMessages.metadata,
      });

      if (workerChanged) {
        if (previousWorkerId) {
          const previousWorker = await storage.getVendorEmployee(previousWorkerId);
          if (previousWorker) {
            const unassignMessages = withActorMessages(
              { id: previousWorker.id, name: previousWorker.name, role: "warehouse_worker" },
              `Order #${displayId} was unassigned from you`,
              `${vendorName} unassigned order #${displayId} from ${previousWorker.name} (warehouse)`,
              {
                ...assignmentMeta,
                employeeId: previousWorkerId,
                assignerId: assignActor.id,
                assignerName: assignActor.name,
                assignerRole: assignActor.role,
              },
            );
            await logPortalActivity({
              action: "order_unassigned_worker",
              entityType: "vendor_employee",
              entityId: previousWorkerId,
              entityName: unassignMessages.entityName,
              vendorId: order.vendorId,
              restaurantId: order.restaurantOrgId,
              metadata: unassignMessages.metadata,
            });
          }
        }

        const workerAssignMessages = withActorMessages(
          { id: worker.id, name: worker.name, role: "warehouse_worker" },
          `${vendorName} assigned you order #${displayId} (driver: ${driver.name})`,
          `${vendorName} assigned order #${displayId} to ${worker.name} (warehouse)`,
          {
            ...assignmentMeta,
            employeeId: body.warehouseWorkerId,
            assignerId: assignActor.id,
            assignerName: assignActor.name,
            assignerRole: assignActor.role,
          },
        );
        await logPortalActivity({
          action: "order_assigned_worker",
          entityType: "vendor_employee",
          entityId: body.warehouseWorkerId,
          entityName: workerAssignMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: workerAssignMessages.metadata,
        });
      }

      if (driverChanged) {
        if (previousDriverId) {
          const previousDriver = await storage.getVendorEmployee(previousDriverId);
          if (previousDriver) {
            const unassignMessages = withActorMessages(
              { id: previousDriver.id, name: previousDriver.name, role: "driver" },
              `Order #${displayId} was unassigned from you`,
              `${vendorName} unassigned order #${displayId} from ${previousDriver.name} (driver)`,
              {
                ...assignmentMeta,
                employeeId: previousDriverId,
                assignerId: assignActor.id,
                assignerName: assignActor.name,
                assignerRole: assignActor.role,
              },
            );
            await logPortalActivity({
              action: "order_unassigned_driver",
              entityType: "vendor_employee",
              entityId: previousDriverId,
              entityName: unassignMessages.entityName,
              vendorId: order.vendorId,
              restaurantId: order.restaurantOrgId,
              metadata: unassignMessages.metadata,
            });
          }
        }

        const driverAssignMessages = withActorMessages(
          { id: driver.id, name: driver.name, role: "driver" },
          `${vendorName} assigned you order #${displayId} (warehouse: ${worker.name})`,
          `${vendorName} assigned order #${displayId} to ${driver.name} (driver)`,
          {
            ...assignmentMeta,
            employeeId: body.driverId,
            assignerId: assignActor.id,
            assignerName: assignActor.name,
            assignerRole: assignActor.role,
          },
        );
        await logPortalActivity({
          action: "order_assigned_driver",
          entityType: "vendor_employee",
          entityId: body.driverId,
          entityName: driverAssignMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: driverAssignMessages.metadata,
        });
      }

      res.json(await storage.getOrder(orderId));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to assign order" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/picking", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const body = z.object({
        items: z.array(z.object({
          lineItemId: z.string().min(1),
          status: z.enum(["loaded", "partial", "no_stock"]),
          loadedQty: z.number().int().min(0),
          note: z.string().max(500).optional().nullable(),
          warehouseTouched: z.boolean().optional(),
        })).min(1),
        submitForReview: z.boolean().optional(),
        vendorAdjust: z.boolean().optional(),
      }).parse(req.body);
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });

      const actor = getRequestActor();
      const actorRole = actor.role === "warehouse" ? "warehouse_worker" : actor.role;
      const isVendorManager =
        actorRole === "vendor_admin" || actorRole === "vendor" || actorRole === "manager";
      const wantsVendorAdjust = body.vendorAdjust === true;
      const canAdjustWithoutAssignment = isVendorManager && order.status === "submitted";
      const isManagerAdjust = canAdjustWithoutAssignment;

      if (wantsVendorAdjust) {
        if (actorRole === "guest" || actorRole === "system") {
          return res.status(401).json({ message: "You must be logged in to save vendor adjustments." });
        }
        if (!isVendorManager) {
          return res.status(403).json({ message: "Only vendor managers can save vendor adjustments." });
        }
        if (order.status !== "submitted") {
          return res.status(409).json({ message: "Vendor adjustments can only be saved on submitted orders." });
        }
      }

      if (!order.warehouseWorkerId && !canAdjustWithoutAssignment) {
        return res.status(409).json({ message: "Assign a warehouse worker before picking." });
      }

      const lineItems = await storage.getOrderLineItems(orderId);
      const validLineItemIds = new Set(lineItems.map((item) => item.id));
      for (const item of body.items) {
        if (!validLineItemIds.has(item.lineItemId)) return res.status(400).json({ message: "One or more line items do not belong to this order." });
      }
  
      let persistedItemCount = 0;

      await db.transaction(async (tx) => {
        for (const item of body.items) {
          if (isManagerAdjust) {
            await tx.insert(orderLineItemFulfillments).values({
              id: newId(),
              orderLineItemId: item.lineItemId,
              orderId,
              fulfilledQuantity: item.loadedQty,
              warehouseNote: item.note?.trim() ? item.note.trim() : null,
              fulfillmentStatus: item.status,
            }).onConflictDoUpdate({
              target: orderLineItemFulfillments.orderLineItemId,
              set: {
                fulfilledQuantity: item.loadedQty,
                warehouseNote: item.note?.trim() ? item.note.trim() : null,
                fulfillmentStatus: item.status,
                updatedAt: new Date(),
              },
            });
            persistedItemCount += 1;
          } else {
            if (!item.warehouseTouched) {
              continue;
            }
            await tx.insert(orderLineItemFulfillments).values({
              id: newId(),
              orderLineItemId: item.lineItemId,
              orderId,
              loadedQuantity: item.loadedQty,
              fulfillmentStatus: item.status,
              issueReason: item.note?.trim() ? item.note.trim() : null,
            }).onConflictDoUpdate({
              target: orderLineItemFulfillments.orderLineItemId,
              set: {
                loadedQuantity: item.loadedQty,
                fulfillmentStatus: item.status,
                issueReason: item.note?.trim() ? item.note.trim() : null,
                updatedAt: new Date(),
              },
            });
            persistedItemCount += 1;
          }
        }
        if (isManagerAdjust && order.warehouseWorkerId) {
          await tx
            .update(orderLineItemFulfillments)
            .set({
              loadedQuantity: null,
              issueReason: null,
              updatedAt: new Date(),
            })
            .where(eq(orderLineItemFulfillments.orderId, orderId));
        }
        await tx.update(orders)
          .set({
            ...(order.warehouseWorkerId
              ? {
                  pickingStatus: body.submitForReview
                    ? "review"
                    : isManagerAdjust
                      ? "assigned"
                      : "in_progress",
                  ...(body.submitForReview ? { status: "picking_review" } : {}),
                }
              : {}),
          })
          .where(eq(orders.id, orderId));
      });

      if (persistedItemCount === 0) {
        return res.status(400).json({
          message: wantsVendorAdjust
            ? "Vendor adjustments could not be saved. Please sign in again and retry."
            : "No picking changes to save. Update loaded qty or add a worker note first.",
        });
      }

      const updatedOrder = await storage.getOrder(orderId);
      const displayId = updatedOrder?.displayId ?? orderId;
      const picker = order.warehouseWorkerId
        ? await storage.getVendorEmployee(order.warehouseWorkerId)
        : undefined;
      const pickerActor: ActivityActor = picker
        ? { id: picker.id, name: picker.name, role: "warehouse_worker" }
        : {
            id: actor.id,
            name: actor.name,
            role: actorRole,
          };
      const pickerName = picker?.name ?? actor.name;
      const pickMeta = mergeOrderNotificationMetadata(order, {
        orderId,
        itemCount: body.items.length,
        submitForReview: Boolean(body.submitForReview),
        displayId,
      });
  
      if (body.submitForReview) {
        const pickMessages = withActorMessages(
          pickerActor,
          `You submitted picking for order #${displayId} for manager review`,
          `${pickerName} submitted picking for order #${displayId} for review`,
          pickMeta,
        );
        logPortalActivity({
          action: "order_picking_submitted",
          entityType: "order",
          entityId: orderId,
          entityName: pickMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: pickMessages.metadata,
        });
  
        if (order.warehouseWorkerId) {
          logPortalActivity({
            action: "order_picking_submitted_worker",
            entityType: "vendor_employee",
            entityId: order.warehouseWorkerId,
            entityName: pickMessages.entityName,
            vendorId: order.vendorId,
            restaurantId: order.restaurantOrgId,
            metadata: {
              ...pickMessages.metadata,
              employeeId: order.warehouseWorkerId,
            },
          });
        }
      } else {
        const saveMessages = withActorMessages(
          pickerActor,
          `You saved picking progress for order #${displayId}`,
          `${pickerName} saved picking progress for order #${displayId}`,
          pickMeta,
        );
        logPortalActivity({
          action: "order_picking_saved",
          entityType: "order",
          entityId: orderId,
          entityName: saveMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: saveMessages.metadata,
        });
      }
  
      res.json({
        order: updatedOrder,
        fulfillments: sanitizeFulfillmentsForOrder(
          updatedOrder ?? order,
          await storage.getOrderFulfillments(orderId),
        ),
      });
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to save picking" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/approve-picking", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });
      if (order.pickingStatus !== "review") return res.status(409).json({ message: "Order is not in picking review." });
      await db.update(orders).set({
        status: "ready_for_delivery",
        pickingStatus: "approved",
        readyForDeliveryAt: new Date(),
      }).where(eq(orders.id, orderId));
      const displayId = order.displayId ?? orderId;
      const approver = getRequestActor();
      const approveMessages = withActorMessages(
        approver,
        `You approved picking for order #${displayId} — ready for driver delivery`,
        `${approver.name} approved picking for order #${displayId} — ready for delivery`,
        mergeOrderNotificationMetadata(order, { displayId }),
      );
      logPortalActivity({
        action: "order_picking_approved",
        entityType: "order",
        entityId: orderId,
        entityName: approveMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: approveMessages.metadata,
      });
      const updatedOrder = await storage.getOrder(orderId);
      if (updatedOrder?.driverId) {
        const driver = await storage.getVendorEmployee(updatedOrder.driverId);
        const vendor = await storage.getVendor(vendorId);
        const vendorName = vendor?.name ?? "Vendor";
        if (driver) {
          const driverMessages = withActorMessages(
            { id: driver.id, name: driver.name, role: "driver" },
            `${vendorName} released order #${displayId} — ready for delivery`,
            `${approver.name} released order #${displayId} to ${driver.name} for delivery`,
            mergeOrderNotificationMetadata(updatedOrder, {
              displayId,
              employeeId: driver.id,
              driverName: driver.name,
            }),
          );
          await logPortalActivity({
            action: "order_picking_approved",
            entityType: "vendor_employee",
            entityId: driver.id,
            entityName: driverMessages.entityName,
            vendorId: updatedOrder.vendorId,
            restaurantId: updatedOrder.restaurantOrgId,
            metadata: driverMessages.metadata,
          });
        }
      }
      res.json(updatedOrder ?? await storage.getOrder(orderId));
    } catch {
      res.status(500).json({ message: "Failed to approve picking" });
    }
  });
  
  app.post("/api/vendors/:vendorId/orders/:orderId/substitutions", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const body = z.object({
        lineItemId: z.string().min(1),
        substituteProductId: z.string().min(1),
        proposedQty: z.number().int().min(1),
        note: z.string().max(500).optional().nullable(),
      }).parse(req.body);
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });
      const lineItems = await storage.getOrderLineItems(orderId);
      const lineItem = lineItems.find((item) => item.id === body.lineItemId);
      if (!lineItem) return res.status(400).json({ message: "Line item not found in this order." });
      const product = await storage.getProduct(body.substituteProductId);
      if (!product || product.vendorId !== vendorId) return res.status(400).json({ message: "Substitute product not found in this vendor catalog." });
      await db.insert(orderSubstitutions).values({
        id: newId(),
        orderId,
        orderLineItemId: body.lineItemId,
        originalProductId: lineItem.productId,
        substituteProductId: body.substituteProductId,
        proposedQty: body.proposedQty,
        note: body.note ?? null,
        status: "proposed",
      });
      const subDisplayId = order.displayId ?? orderId;
      const subActor = getRequestActor();
      const subMessages = withActorMessages(
        subActor,
        `You proposed a substitution for order #${subDisplayId}`,
        `${subActor.name} proposed a substitution for order #${subDisplayId}`,
        mergeOrderNotificationMetadata(order, { displayId: subDisplayId, orderId }),
      );
      logPortalActivity({
        action: "order_substitution_proposed",
        entityType: "order",
        entityId: orderId,
        entityName: subMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: subMessages.metadata,
      });
      res.status(201).json({ message: "Substitution proposed" });
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to propose substitution" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/deliver", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const body = z.object({
        note: z.string().trim().min(1, "Driver delivery note is required").max(1000),
      }).parse(req.body ?? {});
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.vendorId !== vendorId) return res.status(403).json({ message: "Access denied" });
      if (order.status !== "ready_for_delivery") {
        return res.status(409).json({ message: "Only ready-for-delivery orders can be marked as delivered" });
      }
      await db.update(orders).set({
        status: "delivered",
        vendorConfirmedAt: new Date(),
        driverNote: body.note,
      }).where(and(eq(orders.id, orderId), eq(orders.vendorId, vendorId)));
      const updated = await storage.getOrder(orderId);
      if (updated) {
        const displayId = updated.displayId ?? orderId;
        const driver = updated.driverId ? await storage.getVendorEmployee(updated.driverId) : undefined;
        const actor = getRequestActor();
        const driverName = driver?.name ?? actor.name;
        const driverActor: ActivityActor = {
          id: driver?.id ?? actor.id,
          name: driverName,
          role: "driver",
        };
        const deliverMeta = mergeOrderNotificationMetadata(updated, { displayId });
        const deliverMessages = withActorMessages(
          driverActor,
          `You marked order #${displayId} as delivered`,
          `${driverName} delivered order #${displayId}`,
          deliverMeta,
        );
        logPortalActivity({
          action: "order_delivered",
          entityType: "order",
          entityId: orderId,
          entityName: deliverMessages.entityName,
          vendorId: updated.vendorId,
          restaurantId: updated.restaurantOrgId,
          metadata: deliverMessages.metadata,
        });
        if (updated.driverId) {
          logPortalActivity({
            action: "order_delivered_driver",
            entityType: "vendor_employee",
            entityId: updated.driverId,
            entityName: deliverMessages.entityName,
            vendorId: updated.vendorId,
            restaurantId: updated.restaurantOrgId,
            metadata: {
              ...deliverMessages.metadata,
              employeeId: updated.driverId,
              orderId,
            },
          });
        }
      }
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to mark order as delivered" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/orders/:orderId/resolve-issue", async (req, res) => {
    try {
      const { vendorId, orderId } = req.params;
      const body = z.object({ note: z.string().min(1).max(1000) }).parse(req.body);
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });
      if (order.restaurantIssueStatus !== "pending_driver") return res.status(409).json({ message: "Order is not pending driver issue resolution." });
      const updated = await db.transaction(async (tx) => {
        const current = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
        const currentOrder = current[0];
        if (!currentOrder) throw new Error("ORDER_NOT_FOUND");
        if (currentOrder.restaurantIssueStatus !== "pending_driver") {
          throw new Error("ORDER_NOT_PENDING_DRIVER");
        }
  
        const fulfillmentRows = await tx.select().from(orderLineItemFulfillments).where(eq(orderLineItemFulfillments.orderId, orderId));
        const allVendorProducts = await tx.select().from(products).where(eq(products.vendorId, vendorId));
        const acceptedSubstitutions = await tx.select().from(orderSubstitutions).where(and(eq(orderSubstitutions.orderId, orderId), eq(orderSubstitutions.status, "accepted")));
        const fulfillmentMap = new Map(fulfillmentRows.map(f => [f.orderLineItemId, f]));
        const productMap = new Map(allVendorProducts.map(p => [p.id, p]));
        const lineItems = await tx.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  
        const snapshotLineItems: InvoiceLineItemSnapshot[] = lineItems.map(li => {
          const f = fulfillmentMap.get(li.id);
          const expectedQty = getEffectiveLineQty(f, li.quantity, currentOrder);
          const approvedQty = f?.restaurantReceivedQty ?? expectedQty;
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
  
        await tx.update(orders).set({
          restaurantIssueStatus: "resolved_by_driver",
          driverResolutionNote: body.note,
          driverResolvedAt: new Date(),
          vendorApprovedAt: new Date(),
          vendorRejectedAt: null,
          vendorRejectionReason: null,
          status: "invoiced",
        }).where(eq(orders.id, orderId));
  
        const existingInvoice = await tx.select().from(invoices).where(eq(invoices.orderId, orderId)).limit(1);
        if (existingInvoice.length === 0) {
          await tx.insert(invoices).values({
            id: newId(),
            orderId,
            displayOrderId: currentOrder.displayId ?? orderId,
            vendorId,
            restaurantOrgId: currentOrder.restaurantOrgId,
            approvedTotal,
            approvedAt: new Date(),
            lineItems: snapshotLineItems,
          });
          const invoiceDisplayId = currentOrder.displayId ?? orderId;
          const invoiceActor = getRequestActor();
          const invoiceMessages = withActorMessages(
            invoiceActor,
            `You created the invoice for order #${invoiceDisplayId} after resolving the issue`,
            `Invoice created for order #${invoiceDisplayId} — issue resolved by ${invoiceActor.name}`,
            {
              ...mergeOrderNotificationMetadata(currentOrder, { displayId: invoiceDisplayId }),
              approvedTotal,
              lineItemCount: snapshotLineItems.length,
            },
          );
          logPortalActivity({
            action: "order_invoiced",
            entityType: "order",
            entityId: orderId,
            entityName: invoiceMessages.entityName,
            vendorId,
            restaurantId: currentOrder.restaurantOrgId,
            metadata: invoiceMessages.metadata,
          });
        }
  
        const [fresh] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
        if (!fresh) throw new Error("ORDER_NOT_FOUND");
        return fresh;
      });
      const displayId = order.displayId ?? orderId;
      const driver = order.driverId ? await storage.getVendorEmployee(order.driverId) : undefined;
      const actor = getRequestActor();
      const driverName = driver?.name ?? actor.name;
      const driverActor: ActivityActor = {
        id: driver?.id ?? actor.id,
        name: driverName,
        role: "driver",
      };
      const resolveMeta = mergeOrderNotificationMetadata(order, { note: body.note, displayId });
      const resolveMessages = withActorMessages(
        driverActor,
        `You resolved the delivery issue for order #${displayId} and submitted the invoice`,
        `${driverName} resolved the delivery issue for order #${displayId}`,
        resolveMeta,
      );
      logPortalActivity({
        action: "order_issue_resolved",
        entityType: "order",
        entityId: orderId,
        entityName: resolveMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: resolveMessages.metadata,
      });
      if (order.driverId) {
        logPortalActivity({
          action: "order_issue_resolved_driver",
          entityType: "vendor_employee",
          entityId: order.driverId,
          entityName: resolveMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: {
            ...resolveMessages.metadata,
            employeeId: order.driverId,
            orderId,
          },
        });
      }
      res.json({ order: updated });
    } catch (error: any) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      if (error?.message === "ORDER_NOT_PENDING_DRIVER") return res.status(409).json({ message: "Order is not pending driver issue resolution." });
      res.status(500).json({ message: "Failed to resolve issue" });
    }
  });
  
  app.post("/api/vendors/:vendorId/products", async (req, res) => {
    try {
      const data = insertProductSchema.parse({ ...req.body, vendorId: req.params.vendorId });
      if (!data.sku?.trim()) data.sku = null;
      const product = await storage.createProduct(data);
      storage.createActivityLog({ action: "vendor_updated", entityType: "vendor", entityId: req.params.vendorId, entityName: `Product added: ${product.name}`, vendorId: req.params.vendorId }).catch(console.error);
      res.status(201).json(product);
    } catch (error: any) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      if (isDuplicateKeyError(error)) {
        return res.status(409).json({ message: `SKU "${req.body.sku}" already exists for this vendor. Each product must have a unique SKU within the same vendor.` });
      }
      res.status(500).json({ message: "Failed to create product" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/products/:id", async (req, res) => {
    try {
      const existing = await storage.getProduct(req.params.id);
      if (!existing || existing.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Product not found" });
      }
      const data = insertProductSchema.partial().parse(req.body);
      if (data.sku !== undefined && !data.sku?.trim()) data.sku = null;
      const product = await storage.updateProduct(req.params.id, data);
      if (!product) return res.status(404).json({ message: "Product not found" });
      storage.createActivityLog({ action: "vendor_updated", entityType: "vendor", entityId: req.params.vendorId, entityName: `Product updated: ${product.name}`, vendorId: req.params.vendorId }).catch(console.error);
      res.json(product);
    } catch (error: any) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      if (isDuplicateKeyError(error)) {
        return res.status(409).json({ message: `SKU "${req.body.sku}" already exists for this vendor. Each product must have a unique SKU within the same vendor.` });
      }
      res.status(500).json({ message: "Failed to update product" });
    }
  });
  
  app.post("/api/vendors/:vendorId/products/reorder", async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "items array is required" });
      }
      const parsed = items.map((item: any, i: number) => {
        if (typeof item.id !== "string" || typeof item.sortOrder !== "number") {
          throw new Error(`Invalid item at index ${i}`);
        }
        return { id: item.id, sortOrder: item.sortOrder };
      });
      await storage.reorderProducts(req.params.vendorId, parsed);
      logPortalActivity({
        action: "product_reordered",
        entityType: "vendor",
        entityId: req.params.vendorId,
        entityName: `Product sort order updated for vendor ${req.params.vendorId}`,
        vendorId: req.params.vendorId,
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to reorder products" });
    }
  });
  
  app.post("/api/vendors/:vendorId/products/import", async (req, res) => {
    try {
      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows provided" });
      }
  
      const vendorId = req.params.vendorId;
      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
  
      const existingSkus = new Set(await storage.getExistingSkus(vendorId));
      const seenSkus = new Set<string>();
      const results: Array<{ row: number; status: "imported" | "rejected"; errors?: string[] }> = [];
      const validProducts: Array<any> = [];
  
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = row._rowNum || (i + 1);
        const clientErrors: string[] = row._clientErrors || [];
  
        if (clientErrors.length > 0) {
          results.push({ row: rowNum, status: "rejected", errors: clientErrors });
          continue;
        }
  
        const errors: string[] = [];
        const name = (row.name || "").toString().trim();
        const sku = (row.sku || "").toString().trim();
        const unitType = (row.unit_type || "").toString().trim();
        const unitSize = (row.unit_size || "").toString().trim();
        const priceStr = (row.price || "").toString().trim();
  
        if (!name) errors.push("Name is required");
        if (!unitType) errors.push("Unit type is required");
        if (!unitSize) errors.push("Unit size is required");
        if (!priceStr) {
          errors.push("Price is required");
        } else if (!/^\d+(\.\d{1,2})?$/.test(priceStr)) {
          errors.push("Price must be a valid number (e.g. 12.99)");
        }
  
        if (sku && seenSkus.has(sku.toUpperCase())) {
          errors.push(`Duplicate SKU "${sku}" within this file`);
        }
        if (sku && existingSkus.has(sku)) {
          errors.push(`SKU "${sku}" already exists for this vendor`);
        }
  
        if (errors.length > 0) {
          results.push({ row: rowNum, status: "rejected", errors });
        } else {
          if (sku) seenSkus.add(sku.toUpperCase());
          validProducts.push({
            vendorId,
            name,
            sku: sku || null,
            unitType,
            unitSize,
            price: priceStr,
            status: "active",
          });
          results.push({ row: rowNum, status: "imported" });
        }
      }
  
      if (validProducts.length > 0) {
        await storage.createProducts(validProducts);
      }
  
      const importedCount = results.filter(r => r.status === "imported").length;
      const rejectedCount = results.filter(r => r.status === "rejected").length;
  
      if (importedCount > 0) {
        storage.createActivityLog({
          action: "csv_import_completed",
          entityType: "vendor",
          entityId: vendorId,
          entityName: vendor.name,
          vendorId,
          metadata: JSON.stringify({ imported: importedCount, rejected: rejectedCount, total: rows.length }),
        }).catch(console.error);
      }
  
      res.json({
        summary: { total: rows.length, imported: importedCount, rejected: rejectedCount },
        results,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to import products" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/products/:id/archive", async (req, res) => {
    try {
      const existing = await storage.getProduct(req.params.id);
      if (!existing || existing.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Product not found" });
      }
      const product = await storage.archiveProduct(req.params.id);
      if (!product) return res.status(404).json({ message: "Product not found" });
      logPortalActivity({
        action: "product_archived",
        entityType: "product",
        entityId: req.params.id,
        entityName: `Product archived: ${product.name}`,
        vendorId: req.params.vendorId,
      });
      res.json(product);
    } catch (error) {
      res.status(500).json({ message: "Failed to archive product" });
    }
  });
  
}
