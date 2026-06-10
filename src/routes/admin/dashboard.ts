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

export function registerAdminDashboardRoutes(app: CompatExpressApp) {
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
  
}
