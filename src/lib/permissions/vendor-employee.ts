export type VendorEmployeeRole =
  | "manager"
  | "sales_representative"
  | "driver"
  | "warehouse";

export type VendorPermissionKey = string;

export interface VendorPermissionDefinition {
  key: VendorPermissionKey;
  label: string;
}

export interface VendorPermissionGroup {
  id: string;
  label: string;
  permissions: VendorPermissionDefinition[];
}

export const VENDOR_PERMISSION_GROUPS: VendorPermissionGroup[] = [
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
      { key: "view_contact_details", label: "View Contact Details" },
    ],
  },
  {
    id: "orders",
    label: "Orders",
    permissions: [
      { key: "view_all_orders", label: "View All Orders" },
      { key: "view_submitted_orders", label: "View Submitted Orders" },
      { key: "view_assigned_deliveries", label: "View Assigned Deliveries" },
      { key: "adjust_submitted_orders", label: "Adjust Submitted Orders" },
      { key: "mark_orders_delivered", label: "Mark Orders Delivered" },
      { key: "view_orders_needing_approval", label: "View Orders Needing Approval" },
      { key: "approve_restaurant_review", label: "Approve Restaurant Review" },
      { key: "reject_restaurant_review", label: "Reject Restaurant Review" },
      { key: "update_delivery_review", label: "Update Delivery Review" },
      { key: "view_invoiced_orders", label: "View Invoiced Orders" },
      { key: "view_order_history", label: "View Order History" },
    ],
  },
  {
    id: "products",
    label: "Product Catalog",
    permissions: [
      { key: "view_product_catalog", label: "View Product Catalog" },
      { key: "add_products", label: "Add Products" },
      { key: "edit_products", label: "Edit Products" },
      { key: "archive_products", label: "Archive Products" },
      { key: "import_csv", label: "Import CSV" },
      { key: "export_csv", label: "Export CSV" },
      { key: "update_stock_status", label: "Update Stock Status" },
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

export const ALL_VENDOR_PERMISSION_KEYS = VENDOR_PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

export const ROLE_DEFAULT_PERMISSIONS: Record<VendorEmployeeRole, VendorPermissionKey[]> = {
  manager: [
    "view_dashboard",
    "view_relationships",
    "view_contact_details",
    "view_all_orders",
    "view_submitted_orders",
    "view_orders_needing_approval",
    "approve_restaurant_review",
    "reject_restaurant_review",
    "view_invoiced_orders",
    "view_order_history",
    "view_product_catalog",
    "add_products",
    "edit_products",
    "archive_products",
    "import_csv",
    "export_csv",
    "update_stock_status",
    "view_employees",
    "add_employees",
    "edit_employees",
    "manage_employee_permissions",
    "view_settings",
    "edit_settings",
  ],
  sales_representative: [
    "view_dashboard",
    "view_relationships",
    "view_contact_details",
    "view_all_orders",
    "view_submitted_orders",
    "view_invoiced_orders",
    "view_order_history",
    "view_product_catalog",
  ],
  driver: [
    "view_dashboard",
    "view_assigned_deliveries",
    "mark_orders_delivered",
    "update_delivery_review",
  ],
  warehouse: [
    "view_dashboard",
    "view_submitted_orders",
    "adjust_submitted_orders",
    "mark_orders_delivered",
    "view_product_catalog",
    "update_stock_status",
  ],
};

const ASSIGNMENT_ROLES = new Set<VendorEmployeeRole>(["manager", "sales_representative"]);

export function normalizeEmployeeRoleList(roles: unknown): VendorEmployeeRole[] {
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
    .filter((role): role is VendorEmployeeRole => valid.has(role as VendorEmployeeRole));
}

export function getRoleDefaultPermissions(roles: unknown): Set<VendorPermissionKey> {
  const normalizedRoles = normalizeEmployeeRoleList(roles);
  const permissions = new Set<VendorPermissionKey>();

  for (const role of normalizedRoles) {
    for (const permission of ROLE_DEFAULT_PERMISSIONS[role] ?? []) {
      permissions.add(permission);
    }
  }

  return permissions;
}

export function normalizeExtraPermissions(value: unknown): VendorPermissionKey[] {
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

  const allowed = new Set(ALL_VENDOR_PERMISSION_KEYS);
  return raw
    .map((permission) => String(permission).trim())
    .filter((permission) => allowed.has(permission));
}

export function normalizeRelationshipAssignments(value: unknown): string[] {
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

  return raw.map((id) => String(id).trim()).filter(Boolean);
}

export function getEffectivePermissions(
  roles: unknown,
  extraPermissions: unknown,
): Set<VendorPermissionKey> {
  const effective = getRoleDefaultPermissions(roles);
  for (const permission of normalizeExtraPermissions(extraPermissions)) {
    effective.add(permission);
  }
  return effective;
}

export function employeeCanManageAssignments(roles: unknown): boolean {
  return normalizeEmployeeRoleList(roles).some((role) => ASSIGNMENT_ROLES.has(role));
}

export function getPrimaryRoleLabel(roles: unknown): string {
  const normalized = normalizeEmployeeRoleList(roles);
  if (normalized.includes("manager")) return "Manager";
  if (normalized.includes("sales_representative")) return "Sales Representative";
  if (normalized.includes("warehouse")) return "Warehouse";
  if (normalized.includes("driver")) return "Driver";
  return normalized[0] ?? "Employee";
}
