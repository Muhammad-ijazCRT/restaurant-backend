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

export function registerRestaurantOrgRoutes(app: CompatExpressApp) {
  // --- Restaurant Organizations ---
  app.get("/api/restaurant-orgs", async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const orgs = await storage.getRestaurantOrgs(includeArchived);
      res.json(orgs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch restaurant organizations" });
    }
  });
  
  app.get("/api/restaurant-orgs/completeness", async (_req, res) => {
    try {
      const [allOrgs, relationships] = await Promise.all([
        storage.getRestaurantOrgs(true),
        storage.getRelationships(),
      ]);
      const vendorCountByOrg: Record<string, number> = {};
      for (const rel of relationships) {
        if (rel.status !== "archived") {
          vendorCountByOrg[rel.restaurantOrgId] = (vendorCountByOrg[rel.restaurantOrgId] || 0) + 1;
        }
      }
      const result: Record<string, { complete: boolean; missing: string[] }> = {};
      for (const org of allOrgs) {
        const hasVendors = (vendorCountByOrg[org.id] || 0) > 0;
        const missing: string[] = [];
        if (!hasVendors) missing.push("No linked vendors");
        result[org.id] = { complete: missing.length === 0, missing };
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to compute restaurant completeness" });
    }
  });
  
  app.get("/api/restaurant-orgs/:id", async (req, res) => {
    try {
      const org = await storage.getRestaurantOrg(req.params.id);
      if (!org) return res.status(404).json({ message: "Restaurant organization not found" });
      res.json(org);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch restaurant organization" });
    }
  });
  
  app.post("/api/restaurant-orgs", async (req, res) => {
    try {
      const data = insertRestaurantOrgSchema.parse(req.body);
      data.email = normalizePortalEmail(data.email) ?? data.email;
      if (await storage.isPhoneInUse(data.phone)) {
        return res.status(409).json({ message: "This phone number is already in use by another vendor or restaurant organization." });
      }
      const { plain: plainPassword, hashed } = resolvePortalPassword(data.loginPassword);
      data.loginPassword = hashed;
      const org = await storage.createRestaurantOrg(data);
      storage.createActivityLog({ action: "restaurant_created", entityType: "restaurant_org", entityId: org.id, entityName: org.name, restaurantId: org.id }).catch(console.error);
      void sendRestaurantWelcomeEmail({ restaurant: org, loginPassword: plainPassword }).catch(console.error);
      res.status(201).json(org);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to create restaurant organization" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:id", async (req, res) => {
    try {
      const data = insertRestaurantOrgSchema.partial().parse(req.body);
      if (data.phone && await storage.isPhoneInUse(data.phone, req.params.id, "restaurant")) {
        return res.status(409).json({ message: "This phone number is already in use by another vendor or restaurant organization." });
      }
      if (data.loginPassword) {
        data.loginPassword = hashPassword(data.loginPassword);
      }
      const org = await storage.updateRestaurantOrg(req.params.id, data);
      if (!org) return res.status(404).json({ message: "Restaurant organization not found" });
      storage.createActivityLog({ action: "restaurant_updated", entityType: "restaurant_org", entityId: org.id, entityName: org.name, restaurantId: org.id }).catch(console.error);
      res.json(org);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update restaurant organization" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:id/archive", async (req, res) => {
    try {
      const org = await storage.archiveRestaurantOrg(req.params.id);
      if (!org) return res.status(404).json({ message: "Restaurant organization not found" });
      storage.createActivityLog({ action: "restaurant_archived", entityType: "restaurant_org", entityId: org.id, entityName: org.name, restaurantId: org.id }).catch(console.error);
      res.json(org);
    } catch (error: any) {
      if (error?.message === "ACTIVE_ORDERS_EXIST") {
        return res.status(409).json({ message: "Cannot archive an organization with active orders. Wait for all submitted and delivered orders to complete first." });
      }
      res.status(500).json({ message: "Failed to archive restaurant organization" });
    }
  });
  
  app.patch("/api/restaurant-orgs/:id/restore", async (req, res) => {
    try {
      const org = await storage.restoreRestaurantOrg(req.params.id);
      if (!org) return res.status(404).json({ message: "Restaurant organization not found" });
      storage.createActivityLog({ action: "restaurant_restored", entityType: "restaurant_org", entityId: org.id, entityName: org.name, restaurantId: org.id }).catch(console.error);
      res.json(org);
    } catch (error) {
      res.status(500).json({ message: "Failed to restore restaurant organization" });
    }
  });
  
  app.delete("/api/restaurant-orgs/:id", async (req, res) => {
    try {
      const org = await storage.getRestaurantOrg(req.params.id);
      const deleted = await storage.deleteRestaurantOrg(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Restaurant organization not found" });
      if (org) storage.createActivityLog({ action: "restaurant_deleted", entityType: "restaurant_org", entityId: org.id, entityName: org.name, restaurantId: org.id }).catch(console.error);
      res.status(204).send();
    } catch (error: any) {
      if (error?.message === "INVOICES_EXIST") {
        return res.status(409).json({ message: "Cannot delete an organization with invoice history. Archive instead to preserve financial records." });
      }
      res.status(500).json({ message: "Failed to delete restaurant organization" });
    }
  });
  
}
