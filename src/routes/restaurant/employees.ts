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

export function registerRestaurantEmployeeRoutes(app: CompatExpressApp) {
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
  
}
