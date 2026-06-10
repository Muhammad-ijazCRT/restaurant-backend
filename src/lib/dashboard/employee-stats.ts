import { db } from "../../db/client.js";
import { activityLogs, orders, type Order } from "../../db/schema.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { storage } from "../../services/storage.js";
import { parseActivityMetadata } from "../notifications/filters.js";

export type DashboardPeriod = "today" | "week" | "month";

function periodStart(period: DashboardPeriod): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === "today") return start;
  if (period === "week") {
    start.setDate(start.getDate() - 7);
    return start;
  }
  start.setDate(start.getDate() - 30);
  return start;
}

function parseDbDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const trimmed = String(value).trim();
  const localValue = trimmed.endsWith("Z") ? trimmed.slice(0, -1) : trimmed;
  const parsed = new Date(localValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOnOrAfter(value: Date | string | null | undefined, start: Date): boolean {
  const parsed = parseDbDate(value);
  if (!parsed) return false;
  return parsed.getTime() >= start.getTime();
}

function normalizeRole(role: string): string {
  if (role === "warehouse") return "warehouse_worker";
  return role;
}

type AssignerCount = { name: string; count: number };

export type DashboardOrderRow = {
  id: string;
  displayId: string | number;
  restaurantName: string;
  status: string;
  label: string;
  updatedAt: Date;
  assignerName?: string;
};

function bumpAssigner(map: Map<string, number>, name: string) {
  const key = name.trim() || "Vendor";
  map.set(key, (map.get(key) ?? 0) + 1);
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function resolveAssignerName(meta: Record<string, unknown>): string {
  if (meta.assignerName != null && String(meta.assignerName).trim()) {
    return String(meta.assignerName).trim();
  }

  const actorRole = String(meta.assignerRole ?? meta.actorRole ?? "").trim().toLowerCase();
  if (["vendor_admin", "manager", "super_admin", "vendor"].includes(actorRole)) {
    return String(meta.actorName ?? meta.vendorName ?? "Vendor").trim() || "Vendor";
  }

  if (["warehouse_worker", "driver", "warehouse"].includes(actorRole)) {
    return String(meta.vendorName ?? "Vendor").trim() || "Vendor";
  }

  return String(meta.actorName ?? meta.vendorName ?? "Vendor").trim() || "Vendor";
}

function resolveAssignerFromLogs(
  row: { action: string; metadata: string | null },
  orderId: string,
  allRows: Array<{ action: string; entityType: string; entityId: string; metadata: string | null }>,
): string {
  const meta = parseActivityMetadata(row.metadata);
  if (meta.assignerName != null && String(meta.assignerName).trim()) {
    return String(meta.assignerName).trim();
  }

  const actorRole = String(meta.actorRole ?? "").trim().toLowerCase();
  if (["warehouse_worker", "driver", "warehouse"].includes(actorRole)) {
    const parentLog = allRows.find(
      (candidate) =>
        candidate.action === "order_assigned" &&
        normalizeId(orderIdFromLog(candidate)) === normalizeId(orderId),
    );
    if (parentLog) {
      return resolveAssignerName(parseActivityMetadata(parentLog.metadata));
    }
  }

  return resolveAssignerName(meta);
}

function isActiveAssignmentOrder(
  order: Order | undefined,
  role: "warehouse_worker" | "driver",
): boolean {
  if (!order) return false;
  if (["invoiced", "delivered"].includes(order.status)) return false;

  if (role === "warehouse_worker") {
    if (order.status === "ready_for_delivery" || order.pickingStatus === "approved") return false;
  }

  return true;
}

function matchesEmployeeAssignment(
  row: { action: string; entityId: string },
  meta: Record<string, unknown>,
  employeeId: string,
  role: "warehouse_worker" | "driver",
): boolean {
  const employeeKey = normalizeId(employeeId);
  const specificAction = role === "warehouse_worker" ? "order_assigned_worker" : "order_assigned_driver";

  if (row.action === specificAction) {
    if (normalizeId(row.entityId) === employeeKey) return true;
    if (normalizeId(meta.employeeId) === employeeKey) return true;
  }

  if (row.action === "order_assigned") {
    if (role === "warehouse_worker" && normalizeId(meta.warehouseWorkerId) === employeeKey) return true;
    if (role === "driver" && normalizeId(meta.driverId) === employeeKey) return true;
  }

  return false;
}

function assignmentActionPriority(action: string, role: "warehouse_worker" | "driver"): number {
  const specificAction = role === "warehouse_worker" ? "order_assigned_worker" : "order_assigned_driver";
  if (action === specificAction) return 0;
  if (action === "order_assigned") return 1;
  return 2;
}

function orderIdFromLog(row: { entityType: string; entityId: string; metadata: string | null }): string {
  const meta = parseActivityMetadata(row.metadata);
  if (meta.orderId != null && String(meta.orderId).trim()) return String(meta.orderId).trim();
  if (row.entityType === "order") return String(row.entityId).trim();
  return "";
}

function isOrderAssignedToEmployee(
  order: Order,
  employeeId: string,
  role: "warehouse_worker" | "driver",
): boolean {
  return role === "warehouse_worker"
    ? normalizeId(order.warehouseWorkerId) === normalizeId(employeeId)
    : normalizeId(order.driverId) === normalizeId(employeeId);
}

function employeeOrdersForRole(vendorOrders: Order[], employeeId: string, role: "warehouse_worker" | "driver"): Order[] {
  return vendorOrders.filter((order) => isOrderAssignedToEmployee(order, employeeId, role));
}

async function assignmentEventsForEmployee(
  vendorId: string,
  employeeId: string,
  role: "warehouse_worker" | "driver",
  period: DashboardPeriod,
  myOrders: Order[] = [],
  vendorName = "Vendor",
) {
  const start = periodStart(period);
  const assignmentActions =
    role === "warehouse_worker"
      ? ["order_assigned_worker", "order_assigned"]
      : ["order_assigned_driver", "order_assigned"];

  const allRows = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.vendorId, vendorId),
        inArray(activityLogs.action, assignmentActions),
      ),
    )
    .orderBy(desc(activityLogs.createdAt));

  const periodRows = allRows.filter((row) => isOnOrAfter(row.createdAt, start));

  const ordersById = new Map(myOrders.map((order) => [order.id, order]));
  const activeAssignerMap = new Map<string, number>();
  const completedAssignerMap = new Map<string, number>();
  type AssignmentEvent = {
    orderId: string;
    displayId: string | number;
    assignerName: string;
    at: Date;
    status?: string;
  };
  const activeEvents: AssignmentEvent[] = [];
  const completedEvents: AssignmentEvent[] = [];
  const seenOrderIds = new Set<string>();

  const addEvent = (
    orderId: string,
    displayId: string | number,
    assignerName: string,
    at: Date,
    sourceRow?: { action: string; metadata: string | null },
  ) => {
    const order = findOrderById(ordersById, orderId);
    if (!order) return;

    const key = normalizeId(orderId);
    if (!key || seenOrderIds.has(key)) return;
    if (!isOnOrAfter(at, start)) return;

    seenOrderIds.add(key);

    const resolvedAssigner = sourceRow
      ? resolveAssignerFromLogs(sourceRow, orderId, allRows)
      : assignerName;

    const event: AssignmentEvent = {
      orderId,
      displayId,
      assignerName: resolvedAssigner,
      at,
      status: order.status,
    };

    if (isActiveAssignmentOrder(order, role)) {
      bumpAssigner(activeAssignerMap, resolvedAssigner);
      activeEvents.push(event);
      return;
    }

    bumpAssigner(completedAssignerMap, resolvedAssigner);
    completedEvents.push(event);
  };

  const sortedRows = [...periodRows].sort((a, b) => {
    const priorityDiff =
      assignmentActionPriority(a.action, role) - assignmentActionPriority(b.action, role);
    if (priorityDiff !== 0) return priorityDiff;
    const aTime = parseDbDate(a.createdAt)?.getTime() ?? 0;
    const bTime = parseDbDate(b.createdAt)?.getTime() ?? 0;
    return bTime - aTime;
  });

  for (const row of sortedRows) {
    const meta = parseActivityMetadata(row.metadata);
    if (!matchesEmployeeAssignment(row, meta, employeeId, role)) continue;

    const orderId = orderIdFromLog(row) || String(meta.orderId ?? "");
    if (!orderId) continue;
    addEvent(
      orderId,
      meta.displayId ?? meta.displayOrderId ?? "—",
      resolveAssignerName(meta),
      parseDbDate(row.createdAt) ?? new Date(),
      row,
    );
  }

  for (const order of myOrders) {
    if (!isOrderAssignedToEmployee(order, employeeId, role)) continue;
    if (seenOrderIds.has(normalizeId(order.id))) continue;

    const orderLogs = allRows.filter(
      (row) => normalizeId(orderIdFromLog(row)) === normalizeId(order.id),
    );

    const employeeLog = orderLogs.find((row) => {
      const meta = parseActivityMetadata(row.metadata);
      return matchesEmployeeAssignment(row, meta, employeeId, role);
    });

    const bestLog = employeeLog ?? orderLogs.find((row) => row.action === "order_assigned");
    if (bestLog) {
      const at = parseDbDate(bestLog.createdAt);
      if (at && at.getTime() >= start.getTime()) {
        const meta = parseActivityMetadata(bestLog.metadata);
        addEvent(
          order.id,
          order.displayId ?? meta.displayId ?? meta.displayOrderId ?? "—",
          resolveAssignerName(meta),
          at,
          bestLog,
        );
        continue;
      }
    }

    if (isOnOrAfter(order.createdAt, start)) {
      const parentLog = allRows.find(
        (candidate) =>
          candidate.action === "order_assigned" &&
          normalizeId(orderIdFromLog(candidate)) === normalizeId(order.id),
      );
      addEvent(
        order.id,
        order.displayId ?? "—",
        parentLog
          ? resolveAssignerFromLogs(parentLog, order.id, allRows)
          : vendorName,
        parseDbDate(order.createdAt) ?? new Date(),
        parentLog,
      );
    }
  }

  activeEvents.sort((a, b) => b.at.getTime() - a.at.getTime());
  completedEvents.sort((a, b) => b.at.getTime() - a.at.getTime());

  const toAssignerCounts = (map: Map<string, number>): AssignerCount[] =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    assignedCount: activeEvents.length,
    assignedBy: toAssignerCounts(activeAssignerMap),
    events: activeEvents,
    completedCount: completedEvents.length,
    completedBy: toAssignerCounts(completedAssignerMap),
    completedEvents,
  };
}

function mapOrderRow(
  order: Order,
  restaurantMap: Map<string, string>,
  label: string,
  updatedAt?: Date | string | null,
): DashboardOrderRow {
  return {
    id: order.id,
    displayId: order.displayId ?? "—",
    restaurantName: restaurantMap.get(order.restaurantOrgId) ?? "Restaurant",
    status: order.status,
    label,
    updatedAt: parseDbDate(updatedAt ?? order.createdAt) ?? new Date(),
  };
}

function findOrderById(ordersById: Map<string, Order>, orderId: string): Order | undefined {
  const direct = ordersById.get(orderId);
  if (direct) return direct;
  const key = normalizeId(orderId);
  for (const [id, order] of ordersById) {
    if (normalizeId(id) === key) return order;
  }
  return undefined;
}

function buildAssignedRows(
  events: Array<{ orderId: string; displayId: string | number; assignerName: string; at: Date }>,
  ordersById: Map<string, Order>,
  restaurantMap: Map<string, string>,
): DashboardOrderRow[] {
  return events.map((event) => {
    const order = findOrderById(ordersById, event.orderId);
    return {
      id: event.orderId,
      displayId: event.displayId,
      restaurantName: order ? (restaurantMap.get(order.restaurantOrgId) ?? "Restaurant") : "Restaurant",
      status: order?.status ?? "assigned",
      label: "Assigned",
      updatedAt: event.at,
      assignerName: event.assignerName,
    };
  });
}

function buildManagerAssignmentRows(
  assignLogs: Array<{ id: string; metadata: string | null; createdAt: Date | string }>,
  ordersById: Map<string, Order>,
  restaurantMap: Map<string, string>,
): DashboardOrderRow[] {
  return assignLogs.map((row) => {
    const meta = parseActivityMetadata(row.metadata);
    const orderId = String(meta.orderId ?? "");
    const order = orderId ? ordersById.get(orderId) : undefined;
    return {
      id: orderId || row.id,
      displayId: meta.displayId ?? meta.displayOrderId ?? order?.displayId ?? "—",
      restaurantName: order ? (restaurantMap.get(order.restaurantOrgId) ?? "Restaurant") : "Restaurant",
      status: order?.status ?? "assigned",
      label: "Assigned to team",
      updatedAt: parseDbDate(row.createdAt) ?? new Date(),
      assignerName: String(meta.actorName ?? meta.vendorName ?? "Vendor"),
    };
  });
}

function workerOrderFilters(employeeOrders: Order[]) {
  return {
    newTasks: employeeOrders.filter(
      (o) => o.status === "submitted" && (!o.pickingStatus || o.pickingStatus === "assigned"),
    ),
    inProgress: employeeOrders.filter(
      (o) => o.status === "submitted" && o.pickingStatus === "in_progress",
    ),
    submittedForReview: employeeOrders.filter(
      (o) => o.pickingStatus === "review" || o.status === "picking_review",
    ),
    readyForDelivery: employeeOrders.filter(
      (o) => o.pickingStatus === "approved" || o.status === "ready_for_delivery",
    ),
    completed: employeeOrders.filter((o) =>
      ["ready_for_delivery", "delivered", "invoiced"].includes(o.status),
    ),
  };
}

function workerOrderBuckets(employeeOrders: Order[]) {
  const filters = workerOrderFilters(employeeOrders);
  return {
    newTasks: filters.newTasks.length,
    inProgress: filters.inProgress.length,
    submittedForReview: filters.submittedForReview.length,
    readyForDelivery: filters.readyForDelivery.length,
    completed: filters.completed.length,
  };
}

function driverOrderFilters(employeeOrders: Order[]) {
  return {
    readyForDelivery: employeeOrders.filter((o) => o.status === "ready_for_delivery"),
    delivered: employeeOrders.filter((o) => ["delivered", "invoiced"].includes(o.status)),
    issuePending: employeeOrders.filter((o) => o.restaurantIssueStatus === "pending_driver"),
    issueResolved: employeeOrders.filter(
      (o) => o.restaurantIssueStatus === "resolved_by_driver" || !!o.driverResolvedAt,
    ),
  };
}

function driverOrderBuckets(employeeOrders: Order[]) {
  const filters = driverOrderFilters(employeeOrders);
  return {
    readyForDelivery: filters.readyForDelivery.length,
    delivered: filters.delivered.length,
    issuePending: filters.issuePending.length,
    issueResolved: filters.issueResolved.length,
  };
}

function workerOrderLabel(order: Order): string {
  if (order.pickingStatus === "review" || order.status === "picking_review") return "Picking submitted";
  if (order.pickingStatus === "in_progress") return "Picking in progress";
  if (!order.pickingStatus || order.pickingStatus === "assigned") return "New assignment";
  if (order.pickingStatus === "approved") return "Ready for delivery";
  return order.status.replace(/_/g, " ");
}

function driverOrderLabel(order: Order): string {
  if (order.restaurantIssueStatus === "pending_driver") return "Issue needs review";
  if (order.restaurantIssueStatus === "resolved_by_driver") return "Issue resolved";
  if (order.status === "ready_for_delivery") return "Ready to deliver";
  if (["delivered", "invoiced"].includes(order.status)) return "Delivered";
  return order.status.replace(/_/g, " ");
}

function periodDeliveredCount(employeeOrders: Order[], start: Date): number {
  return employeeOrders.filter(
    (o) =>
      ["delivered", "invoiced"].includes(o.status) &&
      isOnOrAfter(o.vendorConfirmedAt ?? o.createdAt, start),
  ).length;
}

function periodIssueResolvedCount(employeeOrders: Order[], start: Date): number {
  return employeeOrders.filter(
    (o) => !!o.driverResolvedAt && isOnOrAfter(o.driverResolvedAt, start),
  ).length;
}

function periodPickingSubmittedCount(employeeOrders: Order[], start: Date): number {
  return employeeOrders.filter(
    (o) =>
      (o.pickingStatus === "review" || o.status === "picking_review" || o.pickingStatus === "approved") &&
      isOnOrAfter(o.readyForDeliveryAt ?? o.createdAt, start),
  ).length;
}

export async function buildEmployeeDashboardStats(options: {
  vendorId: string;
  employeeId: string;
  role: string;
  period: DashboardPeriod;
}) {
  const role = normalizeRole(options.role);
  const period = options.period;
  const start = periodStart(period);

  const [employee, vendor, vendorOrders, allRestaurants] = await Promise.all([
    storage.getVendorEmployee(options.employeeId),
    storage.getVendor(options.vendorId),
    storage.getOrdersByVendor(options.vendorId),
    storage.getRestaurantOrgs(),
  ]);

  const restaurantMap = new Map(allRestaurants.map((r) => [r.id, r.name]));

  if (role === "vendor_admin" || role === "manager") {
    const displayEmployee = employee && employee.vendorId === options.vendorId
      ? { id: employee.id, name: employee.name, email: employee.email }
      : {
          id: options.employeeId,
          name: vendor?.name ?? "Manager",
          email: vendor?.email ?? "",
        };

    const activeOrders = vendorOrders.filter((o) => o.status !== "draft");
    const ordersById = new Map(activeOrders.map((o) => [o.id, o]));
    const inPeriod = activeOrders.filter((o) => isOnOrAfter(o.createdAt, start));
    const assignLogs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.vendorId, options.vendorId),
          inArray(activityLogs.action, ["order_assigned", "order_assigned_worker", "order_assigned_driver"]),
          gte(activityLogs.createdAt, start),
        ),
      )
      .orderBy(desc(activityLogs.createdAt));

    const assignerMap = new Map<string, number>();
    for (const row of assignLogs) {
      const meta = parseActivityMetadata(row.metadata);
      bumpAssigner(assignerMap, String(meta.actorName ?? meta.vendorName ?? "Vendor"));
    }

    return {
      period,
      role,
      employee: displayEmployee,
      vendor: { id: options.vendorId, name: vendor?.name ?? "Vendor" },
      stats: {
        ordersInPeriod: inPeriod.length,
        submitted: inPeriod.filter((o) => o.status === "submitted").length,
        readyForDelivery: activeOrders.filter((o) => o.status === "ready_for_delivery").length,
        delivered: activeOrders.filter((o) => ["delivered", "invoiced"].includes(o.status)).length,
        issuePending: activeOrders.filter((o) => o.restaurantIssueStatus === "pending_driver").length,
        issueResolved: activeOrders.filter((o) => o.restaurantIssueStatus === "resolved_by_driver").length,
        assignmentsInPeriod: assignLogs.length,
        assignedBy: [...assignerMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      },
      details: {
        ordersInPeriod: inPeriod.map((o) =>
          mapOrderRow(o, restaurantMap, o.status.replace(/_/g, " "), o.createdAt),
        ),
        submitted: inPeriod
          .filter((o) => o.status === "submitted")
          .map((o) => mapOrderRow(o, restaurantMap, "Awaiting assign", o.createdAt)),
        assignmentsInPeriod: buildManagerAssignmentRows(assignLogs, ordersById, restaurantMap),
        readyForDelivery: activeOrders
          .filter((o) => o.status === "ready_for_delivery")
          .map((o) => mapOrderRow(o, restaurantMap, "Ready for driver", o.readyForDeliveryAt ?? o.createdAt)),
        delivered: activeOrders
          .filter((o) => ["delivered", "invoiced"].includes(o.status))
          .map((o) => mapOrderRow(o, restaurantMap, "Delivered", o.vendorConfirmedAt ?? o.createdAt)),
        issuePending: activeOrders
          .filter((o) => o.restaurantIssueStatus === "pending_driver")
          .map((o) => mapOrderRow(o, restaurantMap, "Issue open", o.createdAt)),
      },
      recentOrders: activeOrders
        .sort((a, b) => (parseDbDate(b.createdAt)?.getTime() ?? 0) - (parseDbDate(a.createdAt)?.getTime() ?? 0))
        .slice(0, 6)
        .map((o) => ({
          id: o.id,
          displayId: o.displayId ?? "—",
          restaurantName: restaurantMap.get(o.restaurantOrgId) ?? "Restaurant",
          status: o.status,
          label: o.status.replace(/_/g, " "),
          updatedAt: o.createdAt,
        })),
    };
  }

  if (!employee || employee.vendorId !== options.vendorId) {
    throw new Error("EMPLOYEE_NOT_FOUND");
  }

  if (role === "warehouse_worker") {
    const myOrders = employeeOrdersForRole(vendorOrders, options.employeeId, "warehouse_worker");
    const ordersById = new Map(myOrders.map((o) => [o.id, o]));
    const filters = workerOrderFilters(myOrders);
    const buckets = workerOrderBuckets(myOrders);
    const assignment = await assignmentEventsForEmployee(
      options.vendorId,
      options.employeeId,
      "warehouse_worker",
      period,
      myOrders,
      vendor?.name ?? "Vendor",
    );

    const recentOrders = myOrders
      .filter((o) => o.status !== "draft")
      .sort((a, b) => (parseDbDate(b.createdAt)?.getTime() ?? 0) - (parseDbDate(a.createdAt)?.getTime() ?? 0))
      .slice(0, 6)
      .map((o) => ({
        id: o.id,
        displayId: o.displayId ?? "—",
        restaurantName: restaurantMap.get(o.restaurantOrgId) ?? "Restaurant",
        status: o.status,
        pickingStatus: o.pickingStatus,
        label:
          o.pickingStatus === "review" || o.status === "picking_review"
            ? "Picking submitted"
            : o.pickingStatus === "in_progress"
              ? "Picking in progress"
              : !o.pickingStatus || o.pickingStatus === "assigned"
                ? "New assignment"
                : o.pickingStatus === "approved"
                  ? "Ready for delivery"
                  : o.status,
        updatedAt: o.readyForDeliveryAt ?? o.createdAt,
      }));

    return {
      period,
      role,
      employee: { id: employee.id, name: employee.name, email: employee.email },
      vendor: { id: options.vendorId, name: vendor?.name ?? "Vendor" },
      stats: {
        assigned: assignment.assignedCount,
        assignedBy: assignment.assignedBy,
        assignedCompleted: assignment.completedCount,
        assignedCompletedBy: assignment.completedBy,
        newTasks: buckets.newTasks,
        inProgress: buckets.inProgress,
        submittedForReview: buckets.submittedForReview,
        readyForDelivery: buckets.readyForDelivery,
        completed: buckets.completed,
        pickingSubmittedInPeriod: periodPickingSubmittedCount(myOrders, start),
      },
      details: {
        assigned: buildAssignedRows(assignment.events, ordersById, restaurantMap),
        assignedCompleted: buildAssignedRows(assignment.completedEvents, ordersById, restaurantMap),
        newTasks: filters.newTasks.map((o) =>
          mapOrderRow(o, restaurantMap, workerOrderLabel(o), o.createdAt),
        ),
        inProgress: filters.inProgress.map((o) =>
          mapOrderRow(o, restaurantMap, workerOrderLabel(o), o.createdAt),
        ),
        submittedForReview: filters.submittedForReview.map((o) =>
          mapOrderRow(o, restaurantMap, workerOrderLabel(o), o.readyForDeliveryAt ?? o.createdAt),
        ),
        readyForDelivery: filters.readyForDelivery.map((o) =>
          mapOrderRow(o, restaurantMap, workerOrderLabel(o), o.readyForDeliveryAt ?? o.createdAt),
        ),
        completed: filters.completed.map((o) =>
          mapOrderRow(o, restaurantMap, workerOrderLabel(o), o.readyForDeliveryAt ?? o.createdAt),
        ),
      },
      recentAssignments: assignment.events.slice(0, 5),
      completedAssignments: assignment.completedEvents.slice(0, 5),
      recentOrders,
    };
  }

  if (role === "driver") {
    const myOrders = employeeOrdersForRole(vendorOrders, options.employeeId, "driver");
    const ordersById = new Map(myOrders.map((o) => [o.id, o]));
    const filters = driverOrderFilters(myOrders);
    const buckets = driverOrderBuckets(myOrders);
    const assignment = await assignmentEventsForEmployee(
      options.vendorId,
      options.employeeId,
      "driver",
      period,
      myOrders,
      vendor?.name ?? "Vendor",
    );

    const recentOrders = myOrders
      .filter((o) => o.status !== "draft")
      .sort((a, b) => {
        const aTime = parseDbDate(a.vendorConfirmedAt ?? a.driverResolvedAt ?? a.createdAt)?.getTime() ?? 0;
        const bTime = parseDbDate(b.vendorConfirmedAt ?? b.driverResolvedAt ?? b.createdAt)?.getTime() ?? 0;
        return bTime - aTime;
      })
      .slice(0, 6)
      .map((o) => ({
        id: o.id,
        displayId: o.displayId ?? "—",
        restaurantName: restaurantMap.get(o.restaurantOrgId) ?? "Restaurant",
        status: o.status,
        issueStatus: o.restaurantIssueStatus,
        label:
          o.restaurantIssueStatus === "pending_driver"
            ? "Issue needs review"
            : o.restaurantIssueStatus === "resolved_by_driver"
              ? "Issue resolved"
              : o.status === "ready_for_delivery"
                ? "Ready to deliver"
                : ["delivered", "invoiced"].includes(o.status)
                  ? "Delivered"
                  : o.status,
        updatedAt: o.driverResolvedAt ?? o.vendorConfirmedAt ?? o.createdAt,
      }));

    return {
      period,
      role,
      employee: { id: employee.id, name: employee.name, email: employee.email },
      vendor: { id: options.vendorId, name: vendor?.name ?? "Vendor" },
      stats: {
        assigned: assignment.assignedCount,
        assignedBy: assignment.assignedBy,
        assignedCompleted: assignment.completedCount,
        assignedCompletedBy: assignment.completedBy,
        readyForDelivery: buckets.readyForDelivery,
        delivered: buckets.delivered,
        deliveredInPeriod: periodDeliveredCount(myOrders, start),
        issuePending: buckets.issuePending,
        issueResolved: buckets.issueResolved,
        issueResolvedInPeriod: periodIssueResolvedCount(myOrders, start),
      },
      details: {
        assigned: buildAssignedRows(assignment.events, ordersById, restaurantMap),
        assignedCompleted: buildAssignedRows(assignment.completedEvents, ordersById, restaurantMap),
        readyForDelivery: filters.readyForDelivery.map((o) =>
          mapOrderRow(o, restaurantMap, driverOrderLabel(o), o.readyForDeliveryAt ?? o.createdAt),
        ),
        delivered: filters.delivered.map((o) =>
          mapOrderRow(o, restaurantMap, driverOrderLabel(o), o.vendorConfirmedAt ?? o.createdAt),
        ),
        deliveredInPeriod: myOrders
          .filter(
            (o) =>
              ["delivered", "invoiced"].includes(o.status) &&
              isOnOrAfter(o.vendorConfirmedAt ?? o.createdAt, start),
          )
          .map((o) => mapOrderRow(o, restaurantMap, driverOrderLabel(o), o.vendorConfirmedAt ?? o.createdAt)),
        issuePending: filters.issuePending.map((o) =>
          mapOrderRow(o, restaurantMap, driverOrderLabel(o), o.createdAt),
        ),
        issueResolved: filters.issueResolved.map((o) =>
          mapOrderRow(o, restaurantMap, driverOrderLabel(o), o.driverResolvedAt ?? o.createdAt),
        ),
      },
      recentAssignments: assignment.events.slice(0, 5),
      completedAssignments: assignment.completedEvents.slice(0, 5),
      recentOrders,
    };
  }

  throw new Error("UNSUPPORTED_ROLE");
}
