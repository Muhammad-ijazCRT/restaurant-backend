import type { Server } from "http";
import type { CompatExpressApp } from "../lib/express-compat.js";
import { ensureNotificationClearancesTable, ensureRestaurantEmployeesTable, ensureVendorEmployeePermissionColumns, ensureContactSubmissionsTable } from "../db/ensure-schema.js";
import { storage } from "../services/storage.js";
import { registerHealthRoutes } from "./shared/health.js";
import { registerAuthRoutes } from "./shared/auth.js";
import { registerProfileRoutes } from "./shared/profile.js";
import { registerVendorRoutes } from "./vendor/vendors.js";
import { registerVendorEmployeeRoutes } from "./vendor/employees.js";
import { registerVendorProductOrderRoutes } from "./vendor/products-orders.js";
import { registerRestaurantOrgRoutes } from "./restaurant/orgs.js";
import { registerRestaurantEmployeeRoutes } from "./restaurant/employees.js";
import { registerRestaurantCatalogRoutes } from "./restaurant/catalog.js";
import { registerRestaurantOrderRoutes } from "./restaurant/orders.js";
import { registerRestaurantReviewRoutes } from "./restaurant/review.js";
import { registerRelationshipRoutes } from "./shared/relationships.js";
import { registerNotesRoutes } from "./shared/notes.js";
import { registerAttachmentRoutes } from "./shared/attachments.js";
import { registerOrderSheetRoutes } from "./shared/order-sheet.js";
import { registerAdminOrderRoutes } from "./admin/orders.js";
import { registerAdminRelationshipOrderRoutes } from "./admin/relationship-orders.js";
import { registerAdminDashboardRoutes } from "./admin/dashboard.js";
import { registerContactRoutes } from "./shared/contact.js";

export async function registerRoutes(
  httpServer: Server,
  app: CompatExpressApp,
): Promise<Server> {
  try {
    await ensureNotificationClearancesTable();
    await ensureRestaurantEmployeesTable();
    await ensureVendorEmployeePermissionColumns();
    await ensureContactSubmissionsTable();
  } catch (err) {
    console.error("[startup] Failed to ensure notification_clearances table:", err);
  }

  try {
    await storage.backfillDisplayIds();
    await storage.backfillInvoices();
  } catch (err) {
    console.error("[startup] Skipped order backfill:", err);
  }

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerProfileRoutes(app);
  registerContactRoutes(app);
  registerVendorRoutes(app);
  registerVendorEmployeeRoutes(app);
  registerVendorProductOrderRoutes(app);
  registerRestaurantOrgRoutes(app);
  registerRestaurantEmployeeRoutes(app);
  registerRestaurantCatalogRoutes(app);
  registerRestaurantOrderRoutes(app);
  registerRestaurantReviewRoutes(app);
  registerRelationshipRoutes(app);
  registerNotesRoutes(app);
  registerAttachmentRoutes(app);
  registerOrderSheetRoutes(app);
  registerAdminOrderRoutes(app);
  registerAdminRelationshipOrderRoutes(app);
  registerAdminDashboardRoutes(app);

  return httpServer;
}
