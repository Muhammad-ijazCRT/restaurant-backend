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
import { serializeEmployee, serializeRestaurantEmployee, logPortalActivity, logRestaurantReviewApproved, getOrderLogScope } from "./helpers.js";

export function registerNotesRoutes(app: CompatExpressApp) {
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
  
}
