import { db } from "../../db/client.js";
import {
  users,
  vendors,
  vendorEmployees,
  restaurantEmployees,
  restaurantOrganizations,
  activityLogs,
  orders,
  notificationClearances,
} from "../../db/schema.js";
import {
  buildNotificationViewerKey,
  countUnreadNotifications,
} from "../../lib/notifications/clearance.js";
import { desc, eq, or, and, not, inArray } from "drizzle-orm";
import {
  filterManagerNotifications,
  filterRestaurantNotifications,
  filterVendorAdminNotifications,
  filterVendorEmployeeNotifications,
  normalizeNotificationRole,
} from "../../lib/notifications/filters.js";
import { enrichNotificationsForViewer } from "../../lib/notifications/display.js";
import { buildProfileUpdateMetadata } from "../../lib/activity/session-messages.js";
import { getAuthSession } from "../../lib/auth/tokens.js";
import { storage } from "../../services/storage.js";
import fs from "fs";
import path from "path";
import { newId, updateOneById } from "../../db/helpers.js";
import type { CompatExpressApp } from "../../lib/express-compat.js";

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function processImageUpload(base64Image: string | null | undefined): string | null {
  if (!base64Image) return null;
  if (base64Image.startsWith("http") || base64Image.startsWith("/uploads")) return base64Image;

  const matches = base64Image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return null;
  }

  const ext = matches[1].split("/")[1] || "png";
  const data = Buffer.from(matches[2], "base64");
  const fileName = `${newId()}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, data);

  return `/uploads/${fileName}`;
}

function buildProfilePatch(body: {
  name?: string;
  email?: string;
  phone?: string | null;
  image?: string | null;
}) {
  const updateData: Record<string, unknown> = {};
  const { name, email, phone, image } = body;

  if (name !== undefined && name !== "") updateData.name = name;
  if (email !== undefined && email !== "") updateData.email = email;
  if (phone !== undefined) updateData.phone = phone === "" ? null : phone;
  if (image) {
    const savedImagePath = processImageUpload(image);
    if (savedImagePath) updateData.image = savedImagePath;
  }

  return updateData;
}

async function loadUserProfile(role: string, userId: string) {
  if (role === "super_admin") {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) return null;
    return { name: u.name || u.username, email: u.username, phone: u.phone, image: u.image, role };
  }
  if (role === "restaurant") {
    const [r] = await db.select().from(restaurantOrganizations).where(eq(restaurantOrganizations.id, userId));
    if (!r) return null;
    return { name: r.name, email: r.email, phone: r.phone, image: r.image, role };
  }
  if (role === "vendor_admin") {
    const [v] = await db.select().from(vendors).where(eq(vendors.id, userId));
    if (!v) return null;
    return { name: v.name, email: v.email, phone: v.phone, image: v.image, role };
  }
  if (role === "restaurant_manager" || role === "restaurant_employee") {
    const [e] = await db.select().from(restaurantEmployees).where(eq(restaurantEmployees.id, userId));
    if (!e) return null;
    return { name: e.name, email: e.email, phone: e.phone, image: e.image, role };
  }

  const [e] = await db.select().from(vendorEmployees).where(eq(vendorEmployees.id, userId));
  if (!e) return null;
  return { name: e.name, email: e.email, phone: e.phone, image: e.image, role };
}

export function registerProfileRoutes(app: CompatExpressApp) {
  const requireAuth = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];
    const session = getAuthSession(token);
    if (!session) return res.status(401).json({ message: "Unauthorized" });
    req.session = session;
    next();
  };

  app.get("/api/profile", requireAuth, async (req: any, res: any) => {
    const { role, userId } = req.session;
    try {
      const userProfile = await loadUserProfile(role, userId);
      if (!userProfile) return res.status(404).json({ message: "User not found" });
      res.json(userProfile);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Failed to fetch profile" });
    }
  });

  app.put("/api/profile", requireAuth, async (req: any, res: any) => {
    const { role, userId, name: sessionName } = req.session;
    const { name, email, phone, image } = req.body;
    const normalizedRole = normalizeNotificationRole(role);

    try {
      const actor = { id: userId, name: String(sessionName ?? name ?? "User"), role: normalizedRole };

      if (role === "super_admin") {
        const updateData: Record<string, unknown> = {};
        if (name !== undefined && name !== "") updateData.name = name;
        if (email !== undefined && email !== "") updateData.username = email;
        if (phone !== undefined) updateData.phone = phone === "" ? null : phone;
        if (image) {
          const savedImagePath = processImageUpload(image);
          if (savedImagePath) updateData.image = savedImagePath;
        }
        if (Object.keys(updateData).length > 0) {
          await updateOneById(db, users, userId, updateData);
        }
        const profileMeta = buildProfileUpdateMetadata(actor, "Super Admin");
        storage.createActivityLog({
          action: "super_admin_profile_updated",
          entityType: "user",
          entityId: userId,
          entityName: profileMeta.othersMessage as string,
          metadata: JSON.stringify(profileMeta),
        }).catch(console.error);
      } else if (role === "restaurant") {
        const updateData = buildProfilePatch({ name, email, phone, image });
        if (Object.keys(updateData).length > 0) {
          await updateOneById(db, restaurantOrganizations, userId, updateData);
        }
        const profileMeta = buildProfileUpdateMetadata(actor, "Restaurant");
        storage.createActivityLog({
          action: "restaurant_profile_updated",
          entityType: "restaurant_org",
          entityId: userId,
          entityName: profileMeta.othersMessage as string,
          restaurantId: userId,
          metadata: JSON.stringify(profileMeta),
        }).catch(console.error);
      } else if (role === "vendor_admin") {
        const updateData = buildProfilePatch({ name, email, phone, image });
        if (Object.keys(updateData).length > 0) {
          await updateOneById(db, vendors, userId, updateData);
        }
        const profileMeta = buildProfileUpdateMetadata(actor, "Vendor");
        storage.createActivityLog({
          action: "vendor_profile_updated",
          entityType: "vendor",
          entityId: userId,
          entityName: profileMeta.othersMessage as string,
          vendorId: userId,
          metadata: JSON.stringify(profileMeta),
        }).catch(console.error);
      } else if (role === "restaurant_manager" || role === "restaurant_employee") {
        const updateData = buildProfilePatch({ name, email, phone, image });
        if (Object.keys(updateData).length > 0) {
          await updateOneById(db, restaurantEmployees, userId, updateData);
        }
        const [employee] = await db
          .select()
          .from(restaurantEmployees)
          .where(eq(restaurantEmployees.id, userId))
          .limit(1);
        const profileMeta = buildProfileUpdateMetadata(actor, "Employee");
        storage.createActivityLog({
          action: "employee_profile_updated",
          entityType: "restaurant_employee",
          entityId: userId,
          entityName: profileMeta.othersMessage as string,
          restaurantId: employee?.restaurantOrgId ?? undefined,
          metadata: JSON.stringify({ ...profileMeta, employeeId: userId, role: normalizedRole }),
        }).catch(console.error);
      } else {
        const updateData = buildProfilePatch({ name, email, phone, image });
        if (Object.keys(updateData).length > 0) {
          await updateOneById(db, vendorEmployees, userId, updateData);
        }
        const [employee] = await db.select().from(vendorEmployees).where(eq(vendorEmployees.id, userId)).limit(1);
        const profileMeta = buildProfileUpdateMetadata(actor, "Employee");
        storage.createActivityLog({
          action: "employee_profile_updated",
          entityType: "vendor_employee",
          entityId: userId,
          entityName: profileMeta.othersMessage as string,
          vendorId: employee?.vendorId ?? undefined,
          metadata: JSON.stringify({ ...profileMeta, employeeId: userId, role: normalizedRole }),
        }).catch(console.error);
      }
      const updatedProfile = await loadUserProfile(role, userId);
      if (!updatedProfile) return res.status(404).json({ message: "User not found" });
      res.json({ message: "Profile updated successfully", ...updatedProfile });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });
  
  async function resolveSessionVendorId(role: string, userId: string, vendorId?: string): Promise<string | undefined> {
    if (vendorId) return vendorId;
    if (role === "vendor_admin") return userId;
    if (!userId) return undefined;

    const [employee] = await db.select().from(vendorEmployees).where(eq(vendorEmployees.id, userId)).limit(1);
    return employee?.vendorId ?? undefined;
  }

  async function resolveSessionRestaurantId(role: string, userId: string): Promise<string | undefined> {
    if (role === "restaurant") return userId;
    if (!userId) return undefined;

    const [employee] = await db
      .select()
      .from(restaurantEmployees)
      .where(eq(restaurantEmployees.id, userId))
      .limit(1);
    return employee?.restaurantOrgId ?? undefined;
  }

  function isRestaurantPortalRole(role: string): boolean {
    return role === "restaurant" || role === "restaurant_manager" || role === "restaurant_employee";
  }

  app.get("/api/notifications", requireAuth, async (req: any, res: any) => {
    const { userId, vendorId } = req.session;
    const role = normalizeNotificationRole(req.session.role);
    try {
      let logs;
      let total = 0;
      const crudFilter = and(
        not(eq(activityLogs.action, "INSERT")),
        not(eq(activityLogs.action, "UPDATE")),
        not(eq(activityLogs.action, "DELETE")),
      );

      if (role === "super_admin") {
        logs = [];
        total = 0;
      } else if (isRestaurantPortalRole(role)) {
        const restaurantOrgId = await resolveSessionRestaurantId(role, userId);
        if (!restaurantOrgId) {
          logs = [];
          total = 0;
        } else {
          logs = await db
            .select()
            .from(activityLogs)
            .where(and(eq(activityLogs.restaurantId, restaurantOrgId), crudFilter))
            .orderBy(desc(activityLogs.createdAt))
            .limit(200);
          logs = filterRestaurantNotifications(logs, userId);
          total = logs.length;
        }
      } else {
        const effectiveVendorId = await resolveSessionVendorId(role, userId, vendorId);
        if (!effectiveVendorId) {
          console.warn("[notifications] vendorId missing for session", { role, userId, vendorId });
          logs = [];
          total = 0;
        } else {
          const vendorOrderIds = db
            .select({ id: orders.id })
            .from(orders)
            .where(eq(orders.vendorId, effectiveVendorId));

          const vendorScope = or(
            eq(activityLogs.vendorId, effectiveVendorId),
            and(eq(activityLogs.entityType, "vendor"), eq(activityLogs.entityId, effectiveVendorId)),
            and(
              eq(activityLogs.entityType, "order"),
              inArray(activityLogs.entityId, vendorOrderIds),
            ),
          );

          const scopeFilter =
            role === "warehouse_worker" ||
            role === "driver" ||
            role === "manager" ||
            role === "sales_representative"
              ? or(
                  vendorScope,
                  and(
                    eq(activityLogs.entityType, "vendor_employee"),
                    eq(activityLogs.entityId, userId),
                  ),
                )
              : vendorScope;

          logs = await db
            .select()
            .from(activityLogs)
            .where(and(scopeFilter, crudFilter))
            .orderBy(desc(activityLogs.createdAt))
            .limit(200);

          if (role === "vendor_admin") {
            logs = filterVendorAdminNotifications(logs, userId);
          } else if (role === "manager" || role === "sales_representative") {
            logs = filterManagerNotifications(logs, userId);
          } else if (role === "warehouse_worker" || role === "driver") {
            const orderById = new Map<string, { warehouseWorkerId: string | null; driverId: string | null }>();

            const assignedOrderRows = await db
              .select({
                id: orders.id,
                warehouseWorkerId: orders.warehouseWorkerId,
                driverId: orders.driverId,
              })
              .from(orders)
              .where(
                and(
                  eq(orders.vendorId, effectiveVendorId),
                  role === "warehouse_worker"
                    ? eq(orders.warehouseWorkerId, userId)
                    : eq(orders.driverId, userId),
                ),
              );

            for (const row of assignedOrderRows) {
              orderById.set(row.id, {
                warehouseWorkerId: row.warehouseWorkerId ?? null,
                driverId: row.driverId ?? null,
              });
            }

            const orderIdsFromLogs = [
              ...new Set(
                logs
                  .filter((log) => log.entityType === "order")
                  .map((log) => log.entityId),
              ),
            ].filter((id) => !orderById.has(id));

            if (orderIdsFromLogs.length > 0) {
              const orderRows = await db
                .select({
                  id: orders.id,
                  warehouseWorkerId: orders.warehouseWorkerId,
                  driverId: orders.driverId,
                })
                .from(orders)
                .where(and(eq(orders.vendorId, effectiveVendorId), inArray(orders.id, orderIdsFromLogs)));

              for (const row of orderRows) {
                orderById.set(row.id, {
                  warehouseWorkerId: row.warehouseWorkerId ?? null,
                  driverId: row.driverId ?? null,
                });
              }
            }

            logs = filterVendorEmployeeNotifications(logs, role, userId, orderById);
          }

          total = logs.length;
        }
      }

      const viewerKey = buildNotificationViewerKey(role, userId);
      let clearedAt: Date | null = null;
      try {
        const [clearance] = await db
          .select()
          .from(notificationClearances)
          .where(eq(notificationClearances.viewerKey, viewerKey))
          .limit(1);
        clearedAt = clearance?.clearedAt ?? null;
      } catch (clearanceError) {
        console.warn("[notifications] clearance lookup failed", clearanceError);
      }
      const unreadCount = countUnreadNotifications(logs, clearedAt);

      res.json({
        notifications: enrichNotificationsForViewer(logs, { userId, role }),
        total,
        unreadCount,
        clearedAt,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.post("/api/notifications/clear", requireAuth, async (req: any, res: any) => {
    const { userId } = req.session;
    const role = normalizeNotificationRole(req.session.role);
    try {
      const viewerKey = buildNotificationViewerKey(role, userId);
      const clearedAt = new Date();
      await db
        .insert(notificationClearances)
        .values({ viewerKey, clearedAt })
        .onConflictDoUpdate({
          target: notificationClearances.viewerKey,
          set: { clearedAt },
        });

      res.json({
        status: "success",
        message: "Notifications cleared.",
        clearedAt,
        unreadCount: 0,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Failed to clear notifications" });
    }
  });

  app.get("/api/activity-logs/all", requireAuth, async (req: any, res: any) => {
    if (req.session.role !== "super_admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const logs = await db.select().from(activityLogs).orderBy(desc(activityLogs.createdAt)).limit(200);
      res.json(logs);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Failed to fetch logs" });
    }
  });
}
