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

export function registerOrderSheetRoutes(app: CompatExpressApp) {
  app.get("/api/relationships/:id/order-sheet", async (req, res) => {
    try {
      const rel = await storage.getRelationship(req.params.id);
      if (!rel) return res.status(404).json({ message: "Relationship not found" });
      const items = await storage.getOrderSheetItemsEnriched(req.params.id);
      res.json(items);
    } catch {
      res.status(500).json({ message: "Failed to fetch order sheet" });
    }
  });
  
  app.post("/api/relationships/:id/order-sheet", async (req, res) => {
    try {
      const rel = await storage.getRelationship(req.params.id);
      if (!rel) return res.status(404).json({ message: "Relationship not found" });
      const { productId } = req.body;
      if (!productId || typeof productId !== "string") {
        return res.status(400).json({ message: "productId is required" });
      }
      const product = await storage.getProduct(productId);
      if (!product || product.vendorId !== rel.vendorId) {
        return res.status(400).json({ message: "Product not found in this vendor's catalog" });
      }
      const item = await storage.addOrderSheetItem(req.params.id, productId);
      storage.createActivityLog({ action: "relationship_created", entityType: "relationship", entityId: req.params.id, entityName: `Order sheet item added: ${product.name}`, vendorId: rel.vendorId, restaurantId: rel.restaurantOrgId }).catch(console.error);
      res.status(201).json(item);
    } catch (err: any) {
      if (isDuplicateKeyError(err)) {
        return res.status(409).json({ message: "Product already in Order Sheet" });
      }
      res.status(500).json({ message: "Failed to add to order sheet" });
    }
  });
  
  app.delete("/api/relationships/:id/order-sheet/:productId", async (req, res) => {
    try {
      const rel = await storage.getRelationship(req.params.id);
      if (!rel) return res.status(404).json({ message: "Relationship not found" });
      const removed = await storage.removeOrderSheetItem(req.params.id, req.params.productId);
      if (!removed) return res.status(404).json({ message: "Item not found in Order Sheet" });
      storage.createActivityLog({ action: "relationship_deleted", entityType: "relationship", entityId: req.params.id, entityName: `Order sheet item removed: ${req.params.productId}`, vendorId: rel.vendorId, restaurantId: rel.restaurantOrgId }).catch(console.error);
      res.status(204).end();
    } catch {
      res.status(500).json({ message: "Failed to remove from order sheet" });
    }
  });
  
}
