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

export function registerRelationshipRoutes(app: CompatExpressApp) {
  // --- Vendor-Restaurant Relationships ---
  app.get("/api/relationships", async (_req, res) => {
    try {
      const relationships = await storage.getRelationships();
      res.json(relationships);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch relationships" });
    }
  });
  
  app.get("/api/relationships/:id", async (req, res) => {
    try {
      const rel = await storage.getRelationship(req.params.id);
      if (!rel) return res.status(404).json({ message: "Relationship not found" });
      res.json(rel);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch relationship" });
    }
  });
  
  app.post("/api/relationships", async (req, res) => {
    try {
      const data = insertRelationshipSchema.parse(req.body);
      const rel = await storage.createRelationship(data);
      // Fetch vendor and restaurant names for a meaningful log entry
      const [vendor, restaurant] = await Promise.all([
        storage.getVendor(rel.vendorId),
        storage.getRestaurantOrg(rel.restaurantOrgId),
      ]);
      const entityName = `${vendor?.name ?? rel.vendorId} ↔ ${restaurant?.name ?? rel.restaurantOrgId}`;
      storage.createActivityLog({ action: "relationship_created", entityType: "relationship", entityId: rel.id, entityName, vendorId: rel.vendorId, restaurantId: rel.restaurantOrgId }).catch(console.error);
      if (vendor && restaurant) {
        const actor = getRequestActor();
        void sendRelationshipCreatedEmails({
          vendorId: rel.vendorId,
          restaurantOrgId: rel.restaurantOrgId,
          createdByName: actor.name,
        }).catch(console.error);
      }
      res.status(201).json(rel);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to create relationship" });
    }
  });
  
  app.patch("/api/relationships/:id", async (req, res) => {
    try {
      const data = insertRelationshipSchema.partial().parse(req.body);
      if (data.status === "archived") {
        return res.status(400).json({ message: "Relationships cannot be archived directly. Archive the vendor or restaurant organization instead." });
      }
      const rel = await storage.updateRelationship(req.params.id, data);
      if (!rel) return res.status(404).json({ message: "Relationship not found" });
      if (data.status === "inactive" || data.status === "active") {
        const [vendor, restaurant] = await Promise.all([
          storage.getVendor(rel.vendorId),
          storage.getRestaurantOrg(rel.restaurantOrgId),
        ]);
        const entityName = `${vendor?.name ?? rel.vendorId} ↔ ${restaurant?.name ?? rel.restaurantOrgId}`;
        const action = data.status === "inactive" ? "relationship_deactivated" : "relationship_reactivated";
        storage.createActivityLog({ action, entityType: "relationship", entityId: rel.id, entityName, vendorId: rel.vendorId, restaurantId: rel.restaurantOrgId }).catch(console.error);
      }
      res.json(rel);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update relationship" });
    }
  });
  
  app.delete("/api/relationships/:id", async (req, res) => {
    try {
      const rel = await storage.getRelationship(req.params.id);
      if (!rel) return res.status(404).json({ message: "Relationship not found" });
      const hasActive = await storage.hasActiveOrdersForPair(rel.vendorId, rel.restaurantOrgId);
      if (hasActive) {
        return res.status(409).json({ message: "Cannot remove a relationship that has active orders. Ensure all submitted and in-progress orders are completed and paid first." });
      }
      const deleted = await storage.deleteRelationship(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Relationship not found" });
      if (rel) {
        const [vendor, restaurant] = await Promise.all([
          storage.getVendor(rel.vendorId),
          storage.getRestaurantOrg(rel.restaurantOrgId),
        ]);
        const entityName = `${vendor?.name ?? rel.vendorId} ↔ ${restaurant?.name ?? rel.restaurantOrgId}`;
        storage.createActivityLog({ action: "relationship_deleted", entityType: "relationship", entityId: rel.id, entityName, vendorId: rel.vendorId, restaurantId: rel.restaurantOrgId }).catch(console.error);
      }
      res.json({ message: "Relationship removed" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove relationship" });
    }
  });
  
}
