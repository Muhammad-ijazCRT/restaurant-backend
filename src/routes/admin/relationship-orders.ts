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

export function registerAdminRelationshipOrderRoutes(app: CompatExpressApp) {
  // --- Relationship orders (admin audit view) ---
  app.get("/api/admin/relationships/:id/orders", async (req, res) => {
    try {
      const { id } = req.params;
      const relationship = await storage.getRelationship(id);
      if (!relationship) return res.status(404).json({ message: "Relationship not found" });
  
      const allOrders = await storage.getSubmittedOrders(relationship.restaurantOrgId, relationship.vendorId);
  
      const enriched = await Promise.all(allOrders.map(async order => {
        const lineItems = await storage.getOrderLineItems(order.id);
        const fulfillments = await storage.getOrderFulfillments(order.id);
        const invoice = await storage.getInvoiceByOrderId(order.id);
        const allProducts = await storage.getProductsByVendor(order.vendorId, true);
        const productMap = new Map(allProducts.map(p => [p.id, p]));
        const enrichedItems = lineItems.map(li => ({
          ...li,
          productName: productMap.get(li.productId)?.name ?? li.productId,
        }));
        const orderedTotal = lineItems.reduce(
          (sum, li) => sum + parseFloat(li.unitPriceAtTimeOfOrder) * li.quantity, 0
        );
        const fulfillmentMap = new Map(fulfillments.map(f => [f.orderLineItemId, f]));
        const reviewedTotal = lineItems.reduce((sum, li) => {
          const f = fulfillmentMap.get(li.id);
          const qty = f?.restaurantReceivedQty ?? li.quantity;
          return sum + parseFloat(li.unitPriceAtTimeOfOrder) * qty;
        }, 0);
        return { order, lineItems: enrichedItems, fulfillments, invoice, orderedTotal, reviewedTotal };
      }));
  
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch relationship orders" });
    }
  });
  
}
