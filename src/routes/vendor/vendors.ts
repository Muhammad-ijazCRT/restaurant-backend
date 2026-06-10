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

export function registerVendorRoutes(app: CompatExpressApp) {
  // --- Vendors ---
  app.get("/api/vendors", async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const vendors = await storage.getVendors(includeArchived);
      res.json(vendors);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vendors" });
    }
  });
  
  app.get("/api/vendors/completeness", async (_req, res) => {
    try {
      const [allVendors, relationships, productCounts] = await Promise.all([
        storage.getVendors(true),
        storage.getRelationships(),
        storage.getAllProductCounts(),
      ]);
      const restaurantCountByVendor: Record<string, number> = {};
      for (const rel of relationships) {
        if (rel.status !== "archived") {
          restaurantCountByVendor[rel.vendorId] = (restaurantCountByVendor[rel.vendorId] || 0) + 1;
        }
      }
      const result: Record<string, { complete: boolean; missing: string[] }> = {};
      for (const vendor of allVendors) {
        const hasProducts = (productCounts[vendor.id] || 0) > 0;
        const hasRestaurants = (restaurantCountByVendor[vendor.id] || 0) > 0;
        const missing: string[] = [];
        if (!hasProducts) missing.push("No products in catalog");
        if (!hasRestaurants) missing.push("No linked restaurants");
        result[vendor.id] = { complete: missing.length === 0, missing };
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to compute vendor completeness" });
    }
  });
  
  app.get("/api/vendors/:id", async (req, res) => {
    try {
      const vendor = await storage.getVendor(req.params.id);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      res.json(vendor);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vendor" });
    }
  });
  
  app.post("/api/vendors", async (req, res) => {
    try {
      const data = insertVendorSchema.parse(req.body);
      data.email = normalizePortalEmail(data.email) ?? data.email;
      if (await storage.isPhoneInUse(data.phone)) {
        return res.status(409).json({ message: "This phone number is already in use by another vendor or restaurant organization." });
      }
      const { plain: plainPassword, hashed } = resolvePortalPassword(data.loginPassword);
      data.loginPassword = hashed;
      const vendor = await storage.createVendor(data);
      storage.createActivityLog({ action: "vendor_created", entityType: "vendor", entityId: vendor.id, entityName: vendor.name, vendorId: vendor.id }).catch(console.error);
      void sendVendorWelcomeEmail({ vendor, loginPassword: plainPassword }).catch(console.error);
      res.status(201).json(vendor);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to create vendor" });
    }
  });
  
  app.patch("/api/vendors/:id", async (req, res) => {
    try {
      const data = insertVendorSchema.partial().parse(req.body);
      if (data.phone && await storage.isPhoneInUse(data.phone, req.params.id, "vendor")) {
        return res.status(409).json({ message: "This phone number is already in use by another vendor or restaurant organization." });
      }
      if (data.loginPassword) {
        data.loginPassword = hashPassword(data.loginPassword);
      }
      const vendor = await storage.updateVendor(req.params.id, data);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      storage.createActivityLog({ action: "vendor_updated", entityType: "vendor", entityId: vendor.id, entityName: vendor.name, vendorId: vendor.id }).catch(console.error);
      res.json(vendor);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update vendor" });
    }
  });
  
  app.patch("/api/vendors/:id/archive", async (req, res) => {
    try {
      const vendor = await storage.archiveVendor(req.params.id);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      storage.createActivityLog({ action: "vendor_archived", entityType: "vendor", entityId: vendor.id, entityName: vendor.name, vendorId: vendor.id }).catch(console.error);
      res.json(vendor);
    } catch (error: any) {
      if (error?.message === "ACTIVE_ORDERS_EXIST") {
        return res.status(409).json({ message: "Cannot archive a vendor with active orders. Wait for all submitted and delivered orders to complete first." });
      }
      res.status(500).json({ message: "Failed to archive vendor" });
    }
  });
  
  app.patch("/api/vendors/:id/restore", async (req, res) => {
    try {
      const vendor = await storage.restoreVendor(req.params.id);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      storage.createActivityLog({ action: "vendor_restored", entityType: "vendor", entityId: vendor.id, entityName: vendor.name, vendorId: vendor.id }).catch(console.error);
      res.json(vendor);
    } catch (error) {
      res.status(500).json({ message: "Failed to restore vendor" });
    }
  });
  
  app.delete("/api/vendors/:id", async (req, res) => {
    try {
      const vendor = await storage.getVendor(req.params.id);
      const deleted = await storage.deleteVendor(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Vendor not found" });
      if (vendor) storage.createActivityLog({ action: "vendor_deleted", entityType: "vendor", entityId: vendor.id, entityName: vendor.name, vendorId: vendor.id }).catch(console.error);
      res.status(204).send();
    } catch (error: any) {
      if (error?.message === "INVOICES_EXIST") {
        return res.status(409).json({ message: "Cannot delete a vendor with invoice history. Archive instead to preserve financial records." });
      }
      res.status(500).json({ message: "Failed to delete vendor" });
    }
  });
  
}
