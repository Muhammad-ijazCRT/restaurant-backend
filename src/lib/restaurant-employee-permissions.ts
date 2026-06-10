export type RestaurantEmployeeRole = "manager" | "employee";

export type RestaurantPermissionKey = string;

export interface RestaurantPermissionDefinition {
  key: RestaurantPermissionKey;
  label: string;
}

export interface RestaurantPermissionGroup {
  id: string;
  label: string;
  permissions: RestaurantPermissionDefinition[];
}

export const RESTAURANT_PERMISSION_GROUPS: RestaurantPermissionGroup[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    permissions: [{ key: "view_dashboard", label: "View Dashboard" }],
  },
  {
    id: "relationships",
    label: "Relationships",
    permissions: [
      { key: "view_relationships", label: "View Relationships" },
      { key: "view_relationship_contacts", label: "View Relationship Contacts" },
    ],
  },
  {
    id: "ordering",
    label: "Ordering",
    permissions: [
      { key: "place_orders", label: "Place Orders" },
      { key: "create_draft_orders", label: "Create Draft Orders" },
      { key: "submit_orders", label: "Submit Orders" },
    ],
  },
  {
    id: "orders",
    label: "Orders",
    permissions: [
      { key: "view_submitted_orders", label: "View Submitted Orders" },
      { key: "review_delivered_orders", label: "Review Delivered Orders" },
      { key: "submit_delivery_review", label: "Submit Delivery Review" },
      { key: "view_waiting_for_approval", label: "View Waiting for Approval" },
      { key: "view_invoiced_orders", label: "View Invoiced Orders" },
      { key: "mark_invoices_paid", label: "Mark Invoices Paid" },
      { key: "view_order_history", label: "View Order History" },
    ],
  },
  {
    id: "employees",
    label: "Employees",
    permissions: [
      { key: "view_employees", label: "View Employees" },
      { key: "add_employees", label: "Add Employees" },
      { key: "edit_employees", label: "Edit Employees" },
      { key: "delete_employees", label: "Delete Employees" },
      { key: "manage_employee_permissions", label: "Manage Employee Permissions" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    permissions: [
      { key: "view_settings", label: "View Settings" },
      { key: "edit_settings", label: "Edit Settings" },
    ],
  },
];

export const ALL_RESTAURANT_PERMISSION_KEYS = RESTAURANT_PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

export const ROLE_DEFAULT_PERMISSIONS: Record<RestaurantEmployeeRole, RestaurantPermissionKey[]> = {
  manager: [
    "view_dashboard",
    "view_relationships",
    "view_relationship_contacts",
    "place_orders",
    "create_draft_orders",
    "submit_orders",
    "view_submitted_orders",
    "review_delivered_orders",
    "submit_delivery_review",
    "view_waiting_for_approval",
    "view_invoiced_orders",
    "view_order_history",
    "view_employees",
  ],
  employee: [
    "view_dashboard",
    "view_relationships",
    "place_orders",
    "create_draft_orders",
    "submit_orders",
    "view_submitted_orders",
  ],
};

export function normalizeEmployeeRoleList(roles: unknown): RestaurantEmployeeRole[] {
  const valid = new Set(Object.keys(ROLE_DEFAULT_PERMISSIONS));
  let raw: unknown[] = [];

  if (Array.isArray(roles)) {
    raw = roles;
  } else if (typeof roles === "string") {
    try {
      const parsed = JSON.parse(roles);
      raw = Array.isArray(parsed) ? parsed : roles.split(",");
    } catch {
      raw = roles.split(",");
    }
  }

  return raw
    .map((role) => String(role).trim().toLowerCase())
    .filter((role): role is RestaurantEmployeeRole => valid.has(role as RestaurantEmployeeRole));
}

export function getRoleDefaultPermissions(roles: unknown): Set<RestaurantPermissionKey> {
  const normalizedRoles = normalizeEmployeeRoleList(roles);
  const permissions = new Set<RestaurantPermissionKey>();

  for (const role of normalizedRoles) {
    for (const permission of ROLE_DEFAULT_PERMISSIONS[role] ?? []) {
      permissions.add(permission);
    }
  }

  return permissions;
}

export function normalizeExtraPermissions(value: unknown): RestaurantPermissionKey[] {
  let raw: unknown[] = [];

  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      raw = Array.isArray(parsed) ? parsed : [];
    } catch {
      raw = [];
    }
  }

  const allowed = new Set(ALL_RESTAURANT_PERMISSION_KEYS);
  return raw
    .map((permission) => String(permission).trim())
    .filter((permission) => allowed.has(permission));
}

export function getEffectivePermissions(
  roles: unknown,
  extraPermissions: unknown,
): Set<RestaurantPermissionKey> {
  const effective = getRoleDefaultPermissions(roles);
  for (const permission of normalizeExtraPermissions(extraPermissions)) {
    effective.add(permission);
  }
  return effective;
}

export function getPrimaryRoleLabel(roles: unknown): string {
  const normalized = normalizeEmployeeRoleList(roles);
  if (normalized.includes("manager")) return "Manager";
  if (normalized.includes("employee")) return "Employee";
  return "Employee";
}

export function getRestaurantEmployeeLoginRole(roles: unknown): "restaurant_manager" | "restaurant_employee" {
  const normalized = normalizeEmployeeRoleList(roles);
  return normalized.includes("manager") ? "restaurant_manager" : "restaurant_employee";
}
