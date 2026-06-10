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
import { normalizeEmployeeRoles, serializeEmployee, serializeRestaurantEmployee, logPortalActivity, logRestaurantReviewApproved, getOrderLogScope } from "../shared/helpers.js";

export function registerVendorEmployeeRoutes(app: CompatExpressApp) {
  // --- Vendor Employees ---
  app.get("/api/vendors/:vendorId/employees", async (req, res) => {
    try {
      const vendor = await storage.getVendor(req.params.vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const employees = await storage.getVendorEmployees(req.params.vendorId);
      res.json(employees.map(serializeEmployee));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch employees" });
    }
  });
  
  app.post("/api/vendors/:vendorId/employees", async (req, res) => {
    try {
      const vendor = await storage.getVendor(req.params.vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      const data = insertVendorEmployeeSchema.parse({
        ...req.body,
        vendorId: req.params.vendorId,
        extraPermissions: [],
        relationshipAssignments: [],
      });
      data.loginPassword = hashPassword(data.loginPassword);
      const employee = await storage.createVendorEmployee(data);
      storage.createActivityLog({ action: "vendor_created", entityType: "vendor", entityId: req.params.vendorId, entityName: `Employee added: ${employee.name}`, vendorId: req.params.vendorId }).catch(console.error);
      res.status(201).json(serializeEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to create employee" });
    }
  });
  
  app.get("/api/vendors/:vendorId/cutoff-settings", async (req, res) => {
    try {
      const settings = await db.select().from(vendorCutoffSettings).where(eq(vendorCutoffSettings.vendorId, req.params.vendorId)).limit(1);
      res.json(settings[0] ?? null);
    } catch {
      res.status(500).json({ message: "Failed to fetch cutoff settings" });
    }
  });
  
  app.put("/api/vendors/:vendorId/cutoff-settings", async (req, res) => {
    try {
      const data = insertVendorCutoffSettingsSchema.parse({ ...req.body, vendorId: req.params.vendorId });
      const existing = await db.select().from(vendorCutoffSettings).where(eq(vendorCutoffSettings.vendorId, req.params.vendorId)).limit(1);
      const payload = {
        vendorId: req.params.vendorId,
        cutoffHour: data.cutoffHour,
        cutoffMinute: data.cutoffMinute,
        isEnabled: data.isEnabled ? 1 : 0,
        reminderMessage: data.reminderMessage ?? null,
        updatedAt: new Date(),
      };
      if (existing.length > 0) {
        await db.update(vendorCutoffSettings).set(payload).where(eq(vendorCutoffSettings.vendorId, req.params.vendorId));
      } else {
        await db.insert(vendorCutoffSettings).values({
          id: newId(),
          ...payload,
          createdAt: new Date(),
        });
      }
      const [saved] = await db.select().from(vendorCutoffSettings).where(eq(vendorCutoffSettings.vendorId, req.params.vendorId)).limit(1);
      if (saved) {
        logPortalActivity({
          action: existing.length > 0 ? "vendor_cutoff_settings_updated" : "vendor_cutoff_settings_created",
          entityType: "vendor",
          entityId: req.params.vendorId,
          entityName: `Cutoff settings ${existing.length > 0 ? "updated" : "saved"} for vendor ${req.params.vendorId}`,
          vendorId: req.params.vendorId,
        });
      }
      res.json(saved ?? null);
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to save cutoff settings" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/employees/:employeeId", async (req, res) => {
    try {
      const existing = await storage.getVendorEmployee(req.params.employeeId);
      if (!existing || existing.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Employee not found" });
      }
      const data = insertVendorEmployeeSchema.partial().parse({
        ...req.body,
        vendorId: req.params.vendorId,
      });
      delete data.vendorId;
      if (data.loginPassword) {
        data.loginPassword = hashPassword(data.loginPassword);
      } else {
        delete data.loginPassword;
      }
      const employee = await storage.updateVendorEmployee(req.params.employeeId, data);
      if (!employee) return res.status(404).json({ message: "Employee not found" });
      storage.createActivityLog({ action: "vendor_updated", entityType: "vendor", entityId: req.params.vendorId, entityName: `Employee updated: ${employee.name}`, vendorId: req.params.vendorId }).catch(console.error);
      res.json(serializeEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update employee" });
    }
  });
  
  app.delete("/api/vendors/:vendorId/employees/:employeeId", async (req, res) => {
    try {
      const existing = await storage.getVendorEmployee(req.params.employeeId);
      if (!existing || existing.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Employee not found" });
      }
      const deleted = await storage.deleteVendorEmployee(req.params.employeeId);
      if (!deleted) return res.status(404).json({ message: "Employee not found" });
      storage.createActivityLog({ action: "vendor_deleted", entityType: "vendor", entityId: req.params.vendorId, entityName: `Employee deleted: ${existing.name}`, vendorId: req.params.vendorId }).catch(console.error);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete employee" });
    }
  });
  
  app.get("/api/vendors/:vendorId/employees/:employeeId/permissions", async (req, res) => {
    try {
      const employee = await storage.getVendorEmployee(req.params.employeeId);
      if (!employee || employee.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Employee not found" });
      }
  
      const roleDefaults = [...getRoleDefaultPermissions(employee.roles)];
      const extraPermissions = normalizeExtraPermissions(employee.extraPermissions);
      const effectivePermissions = [...getEffectivePermissions(employee.roles, extraPermissions)];
  
      res.json({
        employeeId: employee.id,
        employeeName: employee.name,
        roles: normalizeEmployeeRoles(employee.roles),
        primaryRoleLabel: getPrimaryRoleLabel(employee.roles),
        permissionGroups: VENDOR_PERMISSION_GROUPS,
        roleDefaults,
        extraPermissions,
        effectivePermissions,
        allPermissionKeys: ALL_VENDOR_PERMISSION_KEYS,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch employee permissions" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/employees/:employeeId/permissions", async (req, res) => {
    try {
      const existing = await storage.getVendorEmployee(req.params.employeeId);
      if (!existing || existing.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Employee not found" });
      }
  
      const bodySchema = z.object({
        extraPermissions: z.array(z.string()),
      });
      const { extraPermissions } = bodySchema.parse(req.body);
      const roleDefaults = getRoleDefaultPermissions(existing.roles);
      const sanitized = normalizeExtraPermissions(extraPermissions).filter(
        (permission) => !roleDefaults.has(permission),
      );
  
      const employee = await storage.updateVendorEmployee(req.params.employeeId, {
        extraPermissions: sanitized,
      });
      if (!employee) return res.status(404).json({ message: "Employee not found" });
  
      storage.createActivityLog({
        action: "vendor_updated",
        entityType: "vendor",
        entityId: req.params.vendorId,
        entityName: `Employee permissions updated: ${employee.name}`,
        vendorId: req.params.vendorId,
      }).catch(console.error);
  
      res.json(serializeEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update employee permissions" });
    }
  });
  
  app.get("/api/vendors/:vendorId/employees/:employeeId/assignments", async (req, res) => {
    try {
      const employee = await storage.getVendorEmployee(req.params.employeeId);
      if (!employee || employee.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Employee not found" });
      }
  
      if (!employeeCanManageAssignments(employee.roles)) {
        return res.status(400).json({ message: "Assignments are only available for manager and sales representative roles" });
      }
  
      const relationships = (await storage.getRelationships()).filter(
        (relationship) => relationship.vendorId === req.params.vendorId,
      );
      const activeRelationships = relationships.filter((relationship) => relationship.status !== "archived");
      const restaurants = await storage.getRestaurantOrgs();
      const restaurantMap = new Map(restaurants.map((restaurant) => [restaurant.id, restaurant]));
      const assignedIds = new Set(normalizeRelationshipAssignments(employee.relationshipAssignments));
  
      res.json({
        employeeId: employee.id,
        employeeName: employee.name,
        roles: normalizeEmployeeRoles(employee.roles),
        primaryRoleLabel: getPrimaryRoleLabel(employee.roles),
        relationshipAssignments: [...assignedIds],
        relationships: activeRelationships.map((relationship) => ({
          id: relationship.id,
          restaurantOrgId: relationship.restaurantOrgId,
          restaurantName: restaurantMap.get(relationship.restaurantOrgId)?.name ?? "Restaurant",
          status: relationship.status,
          assigned: assignedIds.has(relationship.id),
        })),
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch employee assignments" });
    }
  });
  
  app.patch("/api/vendors/:vendorId/employees/:employeeId/assignments", async (req, res) => {
    try {
      const existing = await storage.getVendorEmployee(req.params.employeeId);
      if (!existing || existing.vendorId !== req.params.vendorId) {
        return res.status(404).json({ message: "Employee not found" });
      }
  
      if (!employeeCanManageAssignments(existing.roles)) {
        return res.status(400).json({ message: "Assignments are only available for manager and sales representative roles" });
      }
  
      const bodySchema = z.object({
        relationshipIds: z.array(z.string()),
      });
      const { relationshipIds } = bodySchema.parse(req.body);
      const vendorRelationships = (await storage.getRelationships()).filter(
        (relationship) => relationship.vendorId === req.params.vendorId,
      );
      const allowedIds = new Set(
        vendorRelationships
          .filter((relationship) => relationship.status !== "archived")
          .map((relationship) => relationship.id),
      );
      const sanitized = relationshipIds.filter((id) => allowedIds.has(id));
  
      const employee = await storage.updateVendorEmployee(req.params.employeeId, {
        relationshipAssignments: sanitized,
      });
      if (!employee) return res.status(404).json({ message: "Employee not found" });
  
      storage.createActivityLog({
        action: "vendor_updated",
        entityType: "vendor",
        entityId: req.params.vendorId,
        entityName: `Employee assignments updated: ${employee.name}`,
        vendorId: req.params.vendorId,
      }).catch(console.error);
  
      res.json(serializeEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update employee assignments" });
    }
  });
  
}
