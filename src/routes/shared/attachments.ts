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

export function registerAttachmentRoutes(app: CompatExpressApp) {
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
}
