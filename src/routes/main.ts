import type { Server } from "http";
import { registerAuthRoutes } from "./auth.js";
import { registerProfileRoutes } from "./profile.js";
import { storage } from "../services/storage.js";
import { db } from "../lib/db.js";
import { newId } from "../lib/db-helpers.js";
import { insertVendorSchema, insertVendorEmployeeSchema, insertRestaurantOrgSchema, insertRestaurantEmployeeSchema, insertRelationshipSchema, insertProductSchema, insertOrderSchema, insertVendorCutoffSettingsSchema, isDuplicateKeyError, orders, orderLineItems, orderLineItemFulfillments, orderSubstitutions, type InvoiceLineItemSnapshot, invoices, internalNotes, attachments, products, vendorCutoffSettings } from "../shared/schema.js";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { hashPassword, resolvePortalPassword } from "../lib/password.js";
import { normalizePortalEmail } from "../lib/mailer.js";
import {
  sendRestaurantEmployeeWelcomeEmail,
  sendRestaurantWelcomeEmail,
  sendRelationshipCreatedEmails,
  sendVendorWelcomeEmail,
} from "../lib/onboarding-emails.js";
import {
  getRequestActor,
  withActorMessages,
  withVendorSelfMessage,
  type ActivityActor,
} from "../lib/activity-notification-messages.js";
import { buildOrderPlacedMessages } from "../lib/portal-session-messages.js";
import { mergeOrderNotificationMetadata } from "../lib/order-notification-metadata.js";
import { recordPortalActivity } from "../lib/portal-activity.js";
import { buildEmployeeDashboardStats, type DashboardPeriod } from "../lib/employee-dashboard-stats.js";
import { ensureNotificationClearancesTable, ensureRestaurantEmployeesTable, ensureVendorEmployeePermissionColumns } from "../lib/ensure-schema.js";
import {
  ALL_VENDOR_PERMISSION_KEYS,
  employeeCanManageAssignments,
  getEffectivePermissions,
  getPrimaryRoleLabel,
  getRoleDefaultPermissions,
  normalizeExtraPermissions,
  normalizeRelationshipAssignments,
  VENDOR_PERMISSION_GROUPS,
} from "../lib/vendor-employee-permissions.js";
import {
  ALL_RESTAURANT_PERMISSION_KEYS,
  getPrimaryRoleLabel as getRestaurantPrimaryRoleLabel,
  getRoleDefaultPermissions as getRestaurantRoleDefaultPermissions,
  normalizeEmployeeRoleList as normalizeRestaurantEmployeeRoles,
  normalizeExtraPermissions as normalizeRestaurantExtraPermissions,
  RESTAURANT_PERMISSION_GROUPS,
} from "../lib/restaurant-employee-permissions.js";
import { getAuthSession } from "../lib/auth-tokens.js";
import type { CompatExpressApp } from "../lib/express-compat.js";
import { eq, and } from "drizzle-orm";

export async function registerRoutes(
  httpServer: Server,
  app: CompatExpressApp,
): Promise<Server> {

  try {
    await ensureNotificationClearancesTable();
    await ensureRestaurantEmployeesTable();
    await ensureVendorEmployeePermissionColumns();
  } catch (err) {
    console.error("[startup] Failed to ensure notification_clearances table:", err);
  }

  try {
    await storage.backfillDisplayIds();
    await storage.backfillInvoices();
  } catch (err) {
    console.error("[startup] Skipped order backfill:", err);
  }

  registerAuthRoutes(app);
  registerProfileRoutes(app);

  function normalizeEmployeeRoles(roles: unknown): string[] {
    if (Array.isArray(roles)) return roles.map(String);
    if (typeof roles !== "string") return [];
    try {
      const parsed = JSON.parse(roles);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return roles.split(",").map((role) => role.trim()).filter(Boolean);
    }
  }

  function serializeEmployee<T extends { roles: unknown; extraPermissions?: unknown; relationshipAssignments?: unknown }>(
    employee: T,
  ): Omit<T, "roles" | "extraPermissions" | "relationshipAssignments"> & {
    roles: string[];
    extraPermissions: string[];
    relationshipAssignments: string[];
    canManageAssignments: boolean;
  } {
    const roles = normalizeEmployeeRoles(employee.roles);
    return {
      ...employee,
      roles,
      extraPermissions: normalizeExtraPermissions(employee.extraPermissions),
      relationshipAssignments: normalizeRelationshipAssignments(employee.relationshipAssignments),
      canManageAssignments: employeeCanManageAssignments(roles),
    };
  }

  function serializeRestaurantEmployee<T extends { roles: unknown; extraPermissions?: unknown }>(
    employee: T,
  ): Omit<T, "roles" | "extraPermissions"> & {
    roles: string[];
    extraPermissions: string[];
  } {
    return {
      ...employee,
      roles: normalizeRestaurantEmployeeRoles(employee.roles),
      extraPermissions: normalizeRestaurantExtraPermissions(employee.extraPermissions),
    };
  }

  async function getOrderLogScope(entityType: string, entityId: string) {
    if (entityType !== "order") return {};
    const order = await storage.getOrder(entityId);
    if (!order) return {};
    return { vendorId: order.vendorId, restaurantId: order.restaurantOrgId };
  }

  const logPortalActivity = recordPortalActivity;

  async function logRestaurantReviewApproved(
    order: { id: string; displayId: number | null; vendorId: string; restaurantOrgId: string },
    restaurantId: string,
    extra: { approvedTotal?: string; lineItemCount?: number } = {},
  ) {
    const displayId = order.displayId ?? order.id;
    const restaurantOrg = await storage.getRestaurantOrg(restaurantId);
    const restaurantActor: ActivityActor = {
      id: restaurantId,
      name: restaurantOrg?.name ?? "Restaurant",
      role: "restaurant",
    };
    const orderMeta = mergeOrderNotificationMetadata(order, { displayId });
    const reviewMessages = withActorMessages(
      restaurantActor,
      `You submitted the review for order #${displayId} — invoice created`,
      `${restaurantActor.name} submitted the review for order #${displayId} — invoice created`,
      orderMeta,
    );
    const invoiceMessages = withActorMessages(
      restaurantActor,
      `You submitted the review for order #${displayId} — invoice created`,
      `Invoice created for order #${displayId} after ${restaurantActor.name} submitted the review`,
      { ...orderMeta, ...extra },
    );
    await Promise.all([
      logPortalActivity({
        action: "order_review_submitted",
        entityType: "order",
        entityId: order.id,
        entityName: reviewMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: reviewMessages.metadata,
      }),
      logPortalActivity({
        action: "order_invoiced",
        entityType: "order",
        entityId: order.id,
        entityName: invoiceMessages.entityName,
        vendorId: order.vendorId,
        restaurantId: order.restaurantOrgId,
        metadata: invoiceMessages.metadata,
      }),
    ]);
  }

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

  // --- Restaurant Employees ---
  app.get("/api/restaurant-orgs/:restaurantId/employees", async (req, res) => {
    try {
      const restaurant = await storage.getRestaurantOrg(req.params.restaurantId);
      if (!restaurant) return res.status(404).json({ message: "Restaurant organization not found" });
      const employees = await storage.getRestaurantEmployees(req.params.restaurantId);
      res.json(employees.map(serializeRestaurantEmployee));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch employees" });
    }
  });

  app.post("/api/restaurant-orgs/:restaurantId/employees", async (req, res) => {
    try {
      const restaurant = await storage.getRestaurantOrg(req.params.restaurantId);
      if (!restaurant) return res.status(404).json({ message: "Restaurant organization not found" });
      const data = insertRestaurantEmployeeSchema.parse({
        ...req.body,
        restaurantOrgId: req.params.restaurantId,
        extraPermissions: [],
      });
      const plainPassword = data.loginPassword;
      data.loginPassword = hashPassword(data.loginPassword);
      const employee = await storage.createRestaurantEmployee(data);
      void sendRestaurantEmployeeWelcomeEmail({
        employee,
        restaurant,
        loginPassword: plainPassword,
      }).catch(console.error);
      storage.createActivityLog({
        action: "restaurant_updated",
        entityType: "restaurant_org",
        entityId: req.params.restaurantId,
        entityName: `Employee added: ${employee.name}`,
        restaurantId: req.params.restaurantId,
      }).catch(console.error);
      res.status(201).json(serializeRestaurantEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to create employee" });
    }
  });

  app.patch("/api/restaurant-orgs/:restaurantId/employees/:employeeId", async (req, res) => {
    try {
      const existing = await storage.getRestaurantEmployee(req.params.employeeId);
      if (!existing || existing.restaurantOrgId !== req.params.restaurantId) {
        return res.status(404).json({ message: "Employee not found" });
      }
      const data = insertRestaurantEmployeeSchema.partial().parse({
        ...req.body,
        restaurantOrgId: req.params.restaurantId,
      });
      delete data.restaurantOrgId;
      if (data.loginPassword) {
        data.loginPassword = hashPassword(data.loginPassword);
      } else {
        delete data.loginPassword;
      }
      const employee = await storage.updateRestaurantEmployee(req.params.employeeId, data);
      if (!employee) return res.status(404).json({ message: "Employee not found" });
      storage.createActivityLog({
        action: "restaurant_updated",
        entityType: "restaurant_org",
        entityId: req.params.restaurantId,
        entityName: `Employee updated: ${employee.name}`,
        restaurantId: req.params.restaurantId,
      }).catch(console.error);
      res.json(serializeRestaurantEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update employee" });
    }
  });

  app.delete("/api/restaurant-orgs/:restaurantId/employees/:employeeId", async (req, res) => {
    try {
      const existing = await storage.getRestaurantEmployee(req.params.employeeId);
      if (!existing || existing.restaurantOrgId !== req.params.restaurantId) {
        return res.status(404).json({ message: "Employee not found" });
      }
      const deleted = await storage.deleteRestaurantEmployee(req.params.employeeId);
      if (!deleted) return res.status(404).json({ message: "Employee not found" });
      storage.createActivityLog({
        action: "restaurant_updated",
        entityType: "restaurant_org",
        entityId: req.params.restaurantId,
        entityName: `Employee deleted: ${existing.name}`,
        restaurantId: req.params.restaurantId,
      }).catch(console.error);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete employee" });
    }
  });

  app.get("/api/restaurant-orgs/:restaurantId/employees/:employeeId/permissions", async (req, res) => {
    try {
      const employee = await storage.getRestaurantEmployee(req.params.employeeId);
      if (!employee || employee.restaurantOrgId !== req.params.restaurantId) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const roleDefaults = [...getRestaurantRoleDefaultPermissions(employee.roles)];
      const extraPermissions = normalizeRestaurantExtraPermissions(employee.extraPermissions);

      res.json({
        employeeId: employee.id,
        employeeName: employee.name,
        roles: normalizeRestaurantEmployeeRoles(employee.roles),
        primaryRoleLabel: getRestaurantPrimaryRoleLabel(employee.roles),
        permissionGroups: RESTAURANT_PERMISSION_GROUPS,
        roleDefaults,
        extraPermissions,
        allPermissionKeys: ALL_RESTAURANT_PERMISSION_KEYS,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch employee permissions" });
    }
  });

  app.patch("/api/restaurant-orgs/:restaurantId/employees/:employeeId/permissions", async (req, res) => {
    try {
      const existing = await storage.getRestaurantEmployee(req.params.employeeId);
      if (!existing || existing.restaurantOrgId !== req.params.restaurantId) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const bodySchema = z.object({
        extraPermissions: z.array(z.string()),
      });
      const { extraPermissions } = bodySchema.parse(req.body);
      const roleDefaults = getRestaurantRoleDefaultPermissions(existing.roles);
      const sanitized = normalizeRestaurantExtraPermissions(extraPermissions).filter(
        (permission) => !roleDefaults.has(permission),
      );

      const employee = await storage.updateRestaurantEmployee(req.params.employeeId, {
        extraPermissions: sanitized,
      });
      if (!employee) return res.status(404).json({ message: "Employee not found" });

      storage.createActivityLog({
        action: "restaurant_updated",
        entityType: "restaurant_org",
        entityId: req.params.restaurantId,
        entityName: `Employee permissions updated: ${employee.name}`,
        restaurantId: req.params.restaurantId,
      }).catch(console.error);

      res.json(serializeRestaurantEmployee(employee));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ message: fromZodError(error).message });
      res.status(500).json({ message: "Failed to update employee permissions" });
    }
  });

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
          const fulfillments = await storage.getOrderFulfillments(order.id);
          // Include invoice snapshot for approved/invoiced/paid orders
          let invoice =
            order.status === "invoiced" || order.vendorApprovedAt || order.paidAt
              ? await storage.getInvoiceByOrderId(order.id)
              : undefined;
          if (!invoice && (order.status === "invoiced" || order.vendorApprovedAt)) {
            invoice = await storage.ensureInvoiceForOrder(order);
          }
          return {
            order,
            lineItems,
            restaurantName: restaurantMap.get(order.restaurantOrgId) ?? "Unknown Restaurant",
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
      const fulfillments = await storage.getOrderFulfillments(orderId);
      res.json({
        order,
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
      const fulfillments = await storage.getOrderFulfillments(orderId);
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
      if (order.status !== "submitted") return res.status(409).json({ message: "Only submitted orders can be assigned." });
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
        pickingStatus: "assigned",
      }).where(eq(orders.id, orderId));

      const assignActor = getRequestActor();
      const assignMessages = withVendorSelfMessage(
        assignActor,
        `You assigned order #${displayId} to ${worker.name} (warehouse) and ${driver.name} (driver)`,
        `${vendorName} assigned order #${displayId} to ${worker.name} (warehouse) and ${driver.name} (driver)`,
        `You assigned order #${displayId} to ${worker.name} (warehouse) and ${driver.name} (driver)`,
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
        })).min(1),
        submitForReview: z.boolean().optional(),
      }).parse(req.body);
      const order = await storage.getOrder(orderId);
      if (!order || order.vendorId !== vendorId) return res.status(404).json({ message: "Order not found" });
      if (!order.warehouseWorkerId) return res.status(409).json({ message: "Assign a warehouse worker before picking." });
      const lineItems = await storage.getOrderLineItems(orderId);
      const validLineItemIds = new Set(lineItems.map((item) => item.id));
      for (const item of body.items) {
        if (!validLineItemIds.has(item.lineItemId)) return res.status(400).json({ message: "One or more line items do not belong to this order." });
      }

      await db.transaction(async (tx) => {
        for (const item of body.items) {
          await tx.insert(orderLineItemFulfillments).values({
            id: newId(),
            orderLineItemId: item.lineItemId,
            orderId,
            loadedQuantity: item.loadedQty,
            fulfilledQuantity: item.loadedQty,
            fulfillmentStatus: item.status,
            warehouseNote: item.note ?? null,
          }).onConflictDoUpdate({
            target: orderLineItemFulfillments.orderLineItemId,
            set: {
              loadedQuantity: item.loadedQty,
              fulfilledQuantity: item.loadedQty,
              fulfillmentStatus: item.status,
              warehouseNote: item.note ?? null,
              updatedAt: new Date(),
            },
          });
        }
        await tx.update(orders)
          .set({ 
            pickingStatus: body.submitForReview ? "review" : "in_progress",
            ...(body.submitForReview ? { status: "picking_review" } : {})
          })
          .where(eq(orders.id, orderId));
      });

      const updatedOrder = await storage.getOrder(orderId);
      const displayId = updatedOrder?.displayId ?? orderId;
      const picker = order.warehouseWorkerId
        ? await storage.getVendorEmployee(order.warehouseWorkerId)
        : undefined;
      const actor = getRequestActor();
      const pickerName = picker?.name ?? actor.name;
      const pickerActor: ActivityActor = {
        id: picker?.id ?? actor.id,
        name: pickerName,
        role: "warehouse_worker",
      };
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
        fulfillments: await storage.getOrderFulfillments(orderId),
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
      res.json(await storage.getOrder(orderId));
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
      const body = z.object({ note: z.string().max(1000).optional().nullable() }).parse(req.body ?? {});
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.vendorId !== vendorId) return res.status(403).json({ message: "Access denied" });
      if (order.status !== "ready_for_delivery") {
        return res.status(409).json({ message: "Only ready-for-delivery orders can be marked as delivered" });
      }
      await db.update(orders).set({
        status: "delivered",
        vendorConfirmedAt: new Date(),
        driverNote: body.note ?? null,
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

  // --- Restaurant-scoped catalog browsing ---
  app.get("/api/restaurant-orgs/:restaurantId/catalog/:vendorId", async (req, res) => {
    try {
      const { restaurantId, vendorId } = req.params;

      const restaurant = await storage.getRestaurantOrg(restaurantId);
      if (!restaurant) return res.status(404).json({ message: "Restaurant organization not found" });

      const hasLink = await storage.hasRelationship(vendorId, restaurantId);
      if (!hasLink) return res.status(403).json({ message: "This vendor is not linked to this restaurant organization." });

      const vendor = await storage.getVendor(vendorId);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });

      const products = await storage.getProductsByVendor(vendorId, false);

      res.json({ vendor, products });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch catalog" });
    }
  });

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
      if (body.reportIssue) {
        await db.update(orders).set({
          restaurantReviewSubmittedAt: new Date(),
          restaurantIssueStatus: "pending_driver",
          vendorApprovedAt: null,
          vendorRejectedAt: null,
          vendorRejectionReason: null,
          driverResolvedAt: null,
          driverResolutionNote: null,
        }).where(eq(orders.id, orderId));
        const displayId = order.displayId ?? orderId;
        const restaurantOrg = await storage.getRestaurantOrg(restaurantId);
        const restaurantActor: ActivityActor = {
          id: restaurantId,
          name: restaurantOrg?.name ?? "Restaurant",
          role: "restaurant",
        };
        const issueMessages = withActorMessages(
          restaurantActor,
          `You reported a delivery issue for order #${displayId}`,
          `${restaurantActor.name} reported a delivery issue for order #${displayId} — driver review required`,
          mergeOrderNotificationMetadata(order, { displayId }),
        );
        await logPortalActivity({
          action: "order_issue_reported",
          entityType: "order",
          entityId: orderId,
          entityName: issueMessages.entityName,
          vendorId: order.vendorId,
          restaurantId: order.restaurantOrgId,
          metadata: issueMessages.metadata,
        });
        if (order.driverId) {
          logPortalActivity({
            action: "order_issue_pending_driver",
            entityType: "vendor_employee",
            entityId: order.driverId,
            entityName: `${restaurantActor.name} reported an issue on order #${displayId} — please review`,
            vendorId: order.vendorId,
            restaurantId: order.restaurantOrgId,
            metadata: {
              ...issueMessages.metadata,
              employeeId: order.driverId,
              orderId,
              selfMessage: `Restaurant reported an issue on order #${displayId} — please review and resolve`,
              othersMessage: `${restaurantActor.name} reported an issue on order #${displayId} — assigned to you for resolution`,
            },
          });
        }
        const refreshedOrder = await storage.getOrder(orderId);
        const fulfillments = await storage.getOrderFulfillments(orderId);
        return res.json({ order: refreshedOrder, fulfillments });
      }
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

        await tx.update(orders)
          .set({
            restaurantReviewSubmittedAt: new Date(),
            restaurantIssueStatus: body.reportIssue ? "pending_driver" : null,
          })
          .where(eq(orders.id, orderId));

        if (body.reportIssue) {
          await tx.update(orders).set({
            status: "delivered",
            vendorApprovedAt: null,
            vendorRejectedAt: null,
            vendorRejectionReason: null,
            driverResolutionNote: null,
            driverResolvedAt: null,
          }).where(eq(orders.id, orderId));
          const [pendingOrder] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
          if (!pendingOrder) throw new Error("Order not found");
          return pendingOrder;
        }

        const refreshedOrder = await storage.getOrder(orderId);
        if (!refreshedOrder) throw new Error("Order not found");

        const fulfillmentRows = await tx.select().from(orderLineItemFulfillments).where(eq(orderLineItemFulfillments.orderId, orderId));
        const allVendorProducts = await tx.select().from(products).where(eq(products.vendorId, order.vendorId));
        const acceptedSubstitutions = await tx.select().from(orderSubstitutions).where(and(eq(orderSubstitutions.orderId, orderId), eq(orderSubstitutions.status, "accepted")));
        const fulfillmentMap = new Map(fulfillmentRows.map(f => [f.orderLineItemId, f]));
        const productMap = new Map(allVendorProducts.map(p => [p.id, p]));

        const snapshotLineItems = ownedLineItems.map(li => {
          const f = fulfillmentMap.get(li.id);
          const approvedQty = f?.restaurantReceivedQty ?? li.quantity;
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
      const finalizedOrder = (await storage.getOrder(orderId)) ?? updatedOrder.order;
      await logRestaurantReviewApproved(finalizedOrder, restaurantId, {
        approvedTotal: updatedOrder.approvedTotal,
        lineItemCount: updatedOrder.lineItemCount,
      });
      const fulfillments = await storage.getOrderFulfillments(orderId);
      res.json({ order: finalizedOrder, fulfillments });
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

  // --- Single order audit view (admin) ---
  app.get("/api/admin/orders/:orderId", async (req, res) => {
    try {
      const { orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });

      const [lineItems, fulfillments, invoice, vendor, restaurant, allRelationships] = await Promise.all([
        storage.getOrderLineItems(orderId),
        storage.getOrderFulfillments(orderId),
        storage.getInvoiceByOrderId(orderId),
        storage.getVendor(order.vendorId),
        storage.getRestaurantOrg(order.restaurantOrgId),
        storage.getRelationships(),
      ]);

      const relationship = allRelationships.find(
        r => r.vendorId === order.vendorId && r.restaurantOrgId === order.restaurantOrgId
      ) ?? null;

      const allProducts = await storage.getProductsByVendor(order.vendorId, true);
      const productMap = new Map(allProducts.map(p => [p.id, p]));
      const enrichedItems = lineItems.map(li => ({
        ...li,
        productName: productMap.get(li.productId)?.name ?? li.productId,
        productSku: productMap.get(li.productId)?.sku ?? null,
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

      res.json({
        order,
        vendor: vendor ?? null,
        restaurant: restaurant ?? null,
        relationship,
        lineItems: enrichedItems,
        fulfillments,
        invoice: invoice ?? null,
        orderedTotal,
        reviewedTotal,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch order details" });
    }
  });

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

  // --- Dashboard stats ---
  app.get("/api/admin/stats", async (_req, res) => {
    try {
      const [allVendors, allOrgs, relationships] = await Promise.all([
        storage.getVendors(true),
        storage.getRestaurantOrgs(true),
        storage.getRelationships(),
      ]);
      res.json({
        vendors: {
          total: allVendors.length,
          active: allVendors.filter(v => v.status === "active").length,
          archived: allVendors.filter(v => v.status === "archived").length,
        },
        restaurantOrgs: {
          total: allOrgs.length,
          active: allOrgs.filter(o => o.status === "active").length,
          archived: allOrgs.filter(o => o.status === "archived").length,
        },
        relationships: {
          total: relationships.length,
          active: relationships.filter(r => r.status === "active").length,
          inactive: relationships.filter(r => r.status === "inactive").length,
        },
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
  });

  app.get("/api/admin/recent-activity", async (_req, res) => {
    try {
      const [activity, allVendors, allOrgs, recentPayments] = await Promise.all([
        storage.getRecentActivity(6),
        storage.getVendors(true),
        storage.getRestaurantOrgs(true),
        storage.getActivityLogsByAction("order_paid", 6),
      ]);
      const vendorMap = new Map(allVendors.map(v => [v.id, v.name]));
      const orgMap = new Map(allOrgs.map(o => [o.id, o.name]));
      res.json({
        vendors: activity.vendors,
        restaurantOrgs: activity.restaurantOrgs,
        relationships: activity.relationships.map(r => ({
          ...r,
          vendorName: vendorMap.get(r.vendorId) ?? "Unknown Vendor",
          restaurantName: orgMap.get(r.restaurantOrgId) ?? "Unknown Organization",
        })),
        products: activity.products.map(p => ({
          ...p,
          vendorName: vendorMap.get(p.vendorId) ?? "Unknown Vendor",
        })),
        payments: recentPayments,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch recent activity" });
    }
  });

  app.get("/api/admin/activity-log", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const logs = await storage.getActivityLogs(limit);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch activity log" });
    }
  });

  // --- Internal Notes ---
  // DELETE /:id must come before GET /:entityType/:entityId to avoid route collision.

  app.delete("/api/notes/:id", async (req, res) => {
    try {
      const [note] = await db.select().from(internalNotes).where(eq(internalNotes.id, req.params.id)).limit(1);
      if (!note) return res.status(404).json({ message: "Note not found" });

      const deleted = await storage.deleteNote(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Note not found" });

      const scope = await getOrderLogScope(note.entityType, note.entityId);
      logPortalActivity({
        action: "note_deleted",
        entityType: note.entityType,
        entityId: note.entityId,
        entityName: `Note deleted from ${note.entityType}`,
        vendorId: scope.vendorId,
        restaurantId: scope.restaurantId,
      });

      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete note" });
    }
  });

  app.get("/api/notes/:entityType/:entityId", async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const notes = await storage.getNotes(entityType, entityId);
      res.json(notes);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch notes" });
    }
  });

  app.post("/api/notes/:entityType/:entityId", async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const { body } = req.body;

      if (!body || typeof body !== "string" || body.trim().length === 0) {
        return res.status(400).json({ message: "Note text is required" });
      }
      if (body.trim().length > 5000) {
        return res.status(400).json({ message: "Note must be 5,000 characters or fewer" });
      }

      const note = await storage.createNote({ entityType, entityId, body: body.trim() });
      const orderScope = await getOrderLogScope(entityType, entityId);
      logPortalActivity({
        action: "note_created",
        entityType,
        entityId,
        entityName: `Note added to ${entityType}`,
        vendorId: orderScope.vendorId,
        restaurantId: orderScope.restaurantId,
      });
      res.status(201).json(note);
    } catch (error) {
      res.status(500).json({ message: "Failed to create note" });
    }
  });

  // --- Attachments ---
  // NOTE: Single-ID routes (/view, /download, DELETE /:id) MUST be registered
  // before the two-segment list route (/:entityType/:entityId) to avoid
  // Express matching "download" or "delete" as `:entityId`.

  const INLINE_MIME_PREFIXES = ["image/", "video/", "audio/", "text/"];
  const INLINE_MIME_EXACT = new Set(["application/pdf", "application/json"]);

  function resolveDisposition(fileType: string, fileName: string, forceDownload: boolean): string {
    const safe = encodeURIComponent(fileName);
    if (forceDownload) return `attachment; filename="${safe}"`;
    const isInline =
      INLINE_MIME_PREFIXES.some((p) => fileType.startsWith(p)) ||
      INLINE_MIME_EXACT.has(fileType);
    return `${isInline ? "inline" : "attachment"}; filename="${safe}"`;
  }

  // Serve file inline for browser-viewable types (PDF, images, text, etc.)
  app.get("/api/attachments/:id/view", async (req, res) => {
    try {
      const attachment = await storage.getAttachment(req.params.id);
      if (!attachment) return res.status(404).json({ message: "Attachment not found" });

      const buffer = Buffer.from(attachment.fileData, "base64");
      res.setHeader("Content-Type", attachment.fileType || "application/octet-stream");
      res.setHeader("Content-Disposition", resolveDisposition(attachment.fileType, attachment.fileName, false));
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ message: "Failed to open attachment" });
    }
  });

  // Force-download the file regardless of type
  app.get("/api/attachments/:id/download", async (req, res) => {
    try {
      const attachment = await storage.getAttachment(req.params.id);
      if (!attachment) return res.status(404).json({ message: "Attachment not found" });

      const buffer = Buffer.from(attachment.fileData, "base64");
      res.setHeader("Content-Type", attachment.fileType || "application/octet-stream");
      res.setHeader("Content-Disposition", resolveDisposition(attachment.fileType, attachment.fileName, true));
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ message: "Failed to download attachment" });
    }
  });

  app.delete("/api/attachments/:id", async (req, res) => {
    try {
      const [attachment] = await db.select().from(attachments).where(eq(attachments.id, req.params.id)).limit(1);
      if (!attachment) return res.status(404).json({ message: "Attachment not found" });

      const deleted = await storage.deleteAttachment(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Attachment not found" });

      const scope = await getOrderLogScope(attachment.entityType, attachment.entityId);
      logPortalActivity({
        action: "attachment_deleted",
        entityType: attachment.entityType,
        entityId: attachment.entityId,
        entityName: `Attachment deleted from ${attachment.entityType}`,
        vendorId: scope.vendorId,
        restaurantId: scope.restaurantId,
      });

      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete attachment" });
    }
  });

  // List attachments for an entity — registered AFTER single-ID routes
  app.get("/api/attachments/:entityType/:entityId", async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const list = await storage.getAttachments(entityType, entityId);
      res.json(list);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch attachments" });
    }
  });

  app.post("/api/attachments/:entityType/:entityId", async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const { fileName, fileType, fileSize, fileData } = req.body;

      if (!fileName || !fileType || !fileData || typeof fileSize !== "number") {
        return res.status(400).json({ message: "fileName, fileType, fileSize, and fileData are required" });
      }
      if (fileSize > 10 * 1024 * 1024) {
        return res.status(413).json({ message: "File size exceeds the 10 MB limit" });
      }

      const attachment = await storage.createAttachment({ entityType, entityId, fileName, fileType, fileSize, fileData });
      const { fileData: _omit, ...meta } = attachment;
      const orderScope = await getOrderLogScope(entityType, entityId);
      logPortalActivity({
        action: "attachment_created",
        entityType,
        entityId,
        entityName: `Attachment added to ${entityType}`,
        vendorId: orderScope.vendorId,
        restaurantId: orderScope.restaurantId,
      });
      res.status(201).json(meta);
    } catch (error) {
      res.status(500).json({ message: "Failed to upload attachment" });
    }
  });

  // ─── Order Sheet ─────────────────────────────────────────────────────────────

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

  return httpServer;
}
