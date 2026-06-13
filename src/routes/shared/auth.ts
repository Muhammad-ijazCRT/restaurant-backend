import { eq, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { db } from "../../db/client.js";
import {
  users,
  vendors,
  vendorEmployees,
  restaurantEmployees,
  restaurantOrganizations,
  insertVendorSchema,
  insertRestaurantOrgSchema,
} from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../../lib/auth/password.js";
import { buildLoginMetadata } from "../../lib/activity/session-messages.js";
import {
  createAuthToken,
  getAuthSession,
  signUpdatedSession,
  updateAuthSession,
} from "../../lib/auth/tokens.js";
import { storage } from "../../services/storage.js";
import {
  getRestaurantEmployeeLoginRole,
  normalizeEmployeeRoleList as normalizeRestaurantEmployeeRoles,
} from "../../lib/permissions/restaurant-employee.js";
import { requestPasswordReset, resetPasswordWithToken } from "../../lib/auth/password-reset.js";
import type { CompatExpressApp, CompatRequest, CompatResponse } from "../../lib/express-compat.js";

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

function parseForgotPasswordBody(req: CompatRequest, res: CompatResponse) {
  try {
    const body = forgotPasswordSchema.parse(req.body);
    return { email: normalizeLoginEmail(body.email) };
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(422).json({
        status: "error",
        message: "Validation failed.",
        errors: fromZodError(error).message,
      });
      return null;
    }
    res.status(400).json({ status: "error", message: "Invalid request body." });
    return null;
  }
}

function parseResetPasswordBody(req: CompatRequest, res: CompatResponse) {
  try {
    return resetPasswordSchema.parse(req.body);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(422).json({
        status: "error",
        message: "Validation failed.",
        errors: fromZodError(error).message,
      });
      return null;
    }
    res.status(400).json({ status: "error", message: "Invalid request body." });
    return null;
  }
}

const forgotPasswordSuccessMessage =
  "If an account exists with that email, password reset instructions have been sent.";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseLoginBody(req: CompatRequest, res: CompatResponse) {
  try {
    const body = loginSchema.parse(req.body);
    return { ...body, email: normalizeLoginEmail(body.email) };
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(422).json({
        status: "error",
        message: "Validation failed.",
        errors: fromZodError(error).message,
      });
      return null;
    }
    res.status(400).json({ status: "error", message: "Invalid request body." });
    return null;
  }
}

function invalidCredentials(res: CompatResponse) {
  return res.status(401).json({
    status: "error",
    message: "Invalid email or password. Please try again.",
  });
}

function normalizeEmployeeRoles(roles: unknown): string[] {
  const normalize = (items: unknown[]) =>
    items.map((role) => String(role).trim().toLowerCase()).filter(Boolean);

  if (Array.isArray(roles)) return normalize(roles);
  if (typeof roles !== "string") return [];
  const rawRoles = roles;
  try {
    const parsed = JSON.parse(rawRoles);
    return Array.isArray(parsed) ? normalize(parsed) : normalize([parsed]);
  } catch {
    return rawRoles.split(",").map((role: string) => role.trim().toLowerCase()).filter(Boolean);
  }
}

function getEmployeeLoginRole(
  roles: string[],
): "manager" | "warehouse_worker" | "driver" | "sales_representative" {
  if (roles.includes("manager")) return "manager";
  if (roles.includes("sales_representative")) return "sales_representative";
  if (roles.includes("driver")) return "driver";
  if (roles.includes("warehouse") || roles.includes("warehouse_worker")) return "warehouse_worker";
  return "manager";
}

function getEmployeeLoginRedirect(
  role: "manager" | "warehouse_worker" | "driver" | "sales_representative",
): string {
  if (role === "driver") {
    return "/shipping-company/dashboard";
  }
  if (role === "warehouse_worker") {
    return "/vendor/portal";
  }
  return "/vendor/portal";
}

const vendorRegisterSchema = insertVendorSchema
  .omit({ status: true, loginPassword: true })
  .extend({
    password: z.string().min(8, "Password must be at least 8 characters"),
  });

const restaurantRegisterSchema = insertRestaurantOrgSchema
  .omit({ status: true, loginPassword: true })
  .extend({
    password: z.string().min(8, "Password must be at least 8 characters"),
  });

function parseRegisterBody<T extends z.ZodTypeAny>(
  schema: T,
  req: CompatRequest,
  res: CompatResponse,
): z.infer<T> | null {
  try {
    return schema.parse(req.body);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(422).json({
        status: "error",
        message: "Validation failed.",
        errors: fromZodError(error).message,
      });
      return null;
    }
    res.status(400).json({ status: "error", message: "Invalid request body." });
    return null;
  }
}

export function registerAuthRoutes(app: CompatExpressApp): void {
  // Super Admin Login
  app.post("/api/super-admin/login", async (req, res) => {
    const body = parseLoginBody(req, res);
    if (!body) return;

    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(TRIM(${users.username})) = ${body.email}`)
      .limit(1);

    if (!user || !verifyPassword(body.password, user.password)) {
      return invalidCredentials(res);
    }

    const token = createAuthToken({
      role: "super_admin",
      userId: user.id,
      email: body.email,
      name: user.name || user.username,
    });

    const adminMeta = buildLoginMetadata(
      { id: user.id, name: user.name || user.username, role: "super_admin" },
      "Super Admin",
    );
    storage.createActivityLog({
      action: "super_admin_logged_in",
      entityType: "user",
      entityId: user.id,
      entityName: adminMeta.othersMessage as string,
      metadata: JSON.stringify(adminMeta),
    }).catch(console.error);

    return res.json({
      status: "success",
      message: "Login successful. Welcome back, Admin!",
      token,
      redirect: "/super-admin/dashboard",
      user: {
        id: user.id,
        email: body.email,
        name: user.name || user.username,
        role: "super_admin",
        image: user.image || null,
      },
    });
  });

  // Restaurant Login
  app.post("/api/restaurant/login", async (req, res) => {
    const body = parseLoginBody(req, res);
    if (!body) return;

    const [restaurant] = await db
      .select()
      .from(restaurantOrganizations)
      .where(eq(restaurantOrganizations.email, body.email))
      .limit(1);

    if (
      restaurant?.loginPassword &&
      verifyPassword(body.password, restaurant.loginPassword)
    ) {
      const token = createAuthToken({
        role: "restaurant",
        userId: restaurant.id,
        email: restaurant.email,
        name: restaurant.name,
      });

      const restaurantMeta = buildLoginMetadata(
        { id: restaurant.id, name: restaurant.name, role: "restaurant" },
        "Restaurant",
      );
      storage.createActivityLog({
        action: "restaurant_logged_in",
        entityType: "restaurant_org",
        entityId: restaurant.id,
        entityName: restaurantMeta.othersMessage as string,
        restaurantId: restaurant.id,
        metadata: JSON.stringify(restaurantMeta),
      }).catch(console.error);

      return res.json({
        status: "success",
        message: "Login successful. Welcome back!",
        token,
        user: {
          id: restaurant.id,
          email: restaurant.email,
          name: restaurant.name,
          role: "restaurant",
          restaurant_id: restaurant.id,
          image: restaurant.image || null,
        },
        redirect: "/restaurant/portal",
      });
    }

    const [employee] = await db
      .select()
      .from(restaurantEmployees)
      .where(eq(restaurantEmployees.email, body.email))
      .limit(1);

    if (!employee || !verifyPassword(body.password, employee.loginPassword)) {
      return invalidCredentials(res);
    }

    const employeeRoles = normalizeRestaurantEmployeeRoles(employee.roles);
    const role = getRestaurantEmployeeLoginRole(employeeRoles);
    const restaurantOrg = await storage.getRestaurantOrg(employee.restaurantOrgId);

    const token = createAuthToken({
      role,
      userId: employee.id,
      email: employee.email,
      name: employee.name,
    });

    const employeeMeta = buildLoginMetadata(
      { id: employee.id, name: employee.name, role },
      "Employee",
      { employeeId: employee.id, role },
    );
    storage.createActivityLog({
      action: "employee_logged_in",
      entityType: "restaurant_employee",
      entityId: employee.id,
      entityName: employeeMeta.othersMessage as string,
      restaurantId: employee.restaurantOrgId,
      metadata: JSON.stringify(employeeMeta),
    }).catch(console.error);

    return res.json({
      status: "success",
      message: "Login successful. Welcome back!",
      token,
      user: {
        id: employee.id,
        email: employee.email,
        name: employee.name,
        role,
        roles: employeeRoles,
        restaurant_id: employee.restaurantOrgId,
        restaurant_name: restaurantOrg?.name ?? null,
        image: employee.image || null,
      },
      redirect: "/restaurant/portal",
    });
  });

  // Vendor / Employee Login
  app.post("/api/vendor/login", async (req, res) => {
    const body = parseLoginBody(req, res);
    if (!body) return;

    const [vendor] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.email, body.email))
      .limit(1);

    if (
      vendor?.loginPassword &&
      verifyPassword(body.password, vendor.loginPassword)
    ) {
      const token = createAuthToken({
        role: "vendor_admin",
        userId: vendor.id,
        email: vendor.email,
        name: vendor.name,
        vendorId: vendor.id,
      });

      const vendorMeta = buildLoginMetadata(
        { id: vendor.id, name: vendor.name, role: "vendor_admin" },
        "Vendor",
      );
      storage.createActivityLog({
        action: "vendor_logged_in",
        entityType: "vendor",
        entityId: vendor.id,
        entityName: vendorMeta.othersMessage as string,
        vendorId: vendor.id,
        metadata: JSON.stringify(vendorMeta),
      }).catch(console.error);

      return res.json({
        status: "success",
        message: "Login successful. Welcome back!",
        token,
        user: {
          id: vendor.id,
          email: vendor.email,
          name: vendor.name,
          role: "vendor_admin",
          vendor_id: vendor.id,
          image: vendor.image || null,
        },
        redirect: "/vendor/dashboard",
      });
    }

    const [employee] = await db
      .select()
      .from(vendorEmployees)
      .where(eq(vendorEmployees.email, body.email))
      .limit(1);

    if (!employee || !verifyPassword(body.password, employee.loginPassword)) {
      return invalidCredentials(res);
    }

    const employeeRoles = normalizeEmployeeRoles(employee.roles);
    const role = getEmployeeLoginRole(employeeRoles);
    const employeeVendor = await storage.getVendor(employee.vendorId);

    const token = createAuthToken({
      role,
      userId: employee.id,
      email: employee.email,
      name: employee.name,
      vendorId: employee.vendorId,
    });

    const employeeMeta = buildLoginMetadata(
      { id: employee.id, name: employee.name, role },
      "Employee",
      { employeeId: employee.id, role },
    );
    storage.createActivityLog({
      action: "employee_logged_in",
      entityType: "vendor_employee",
      entityId: employee.id,
      entityName: employeeMeta.othersMessage as string,
      vendorId: employee.vendorId,
      metadata: JSON.stringify(employeeMeta),
    }).catch(console.error);

    return res.json({
      status: "success",
      message: "Login successful. Welcome back!",
      token,
      user: {
        id: employee.id,
        email: employee.email,
        name: employee.name,
        role,
        roles: employeeRoles,
        vendor_id: employee.vendorId,
        vendor_name: employeeVendor?.name ?? null,
        image: employee.image || null,
      },
      redirect: getEmployeeLoginRedirect(role),
    });
  });

  app.post("/api/vendor/switch-role", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const token = (typeof authHeader === "string" ? authHeader : authHeader?.[0])?.split(" ")[1];
      const session = getAuthSession(token);
      if (!session) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
      }

      const { role } = z.object({ role: z.string().min(1) }).parse(req.body);
      const targetRole =
        role === "warehouse" ? "warehouse_worker" : role.trim().toLowerCase();

      const employee = await storage.getVendorEmployee(session.userId);
      if (!employee) {
        return res.status(403).json({
          status: "error",
          message: "Only vendor employees with multiple roles can switch portals.",
        });
      }

      const employeeRoles = normalizeEmployeeRoles(employee.roles);
      const assignedRoles = new Set(
        employeeRoles.map((item) => (item === "warehouse" ? "warehouse_worker" : item)),
      );

      if (!assignedRoles.has(targetRole)) {
        return res.status(403).json({
          status: "error",
          message: "You are not assigned to that role.",
        });
      }

      const updatedSession = updateAuthSession(token, { role: targetRole });
      const newToken = updatedSession ? signUpdatedSession(updatedSession) : token;

      const employeeVendor = await storage.getVendor(employee.vendorId);
      return res.json({
        status: "success",
        token: newToken,
        user: {
          id: employee.id,
          email: employee.email,
          name: employee.name,
          role: targetRole,
          roles: employeeRoles,
          vendor_id: employee.vendorId,
          vendor_name: employeeVendor?.name ?? null,
          image: employee.image || null,
        },
        redirect: getEmployeeLoginRedirect(
          targetRole as "manager" | "warehouse_worker" | "driver" | "sales_representative",
        ),
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ status: "error", message: fromZodError(error).message });
      }
      console.error(error);
      return res.status(500).json({ status: "error", message: "Failed to switch role" });
    }
  });

  // Restaurant Register
  app.post("/api/restaurant/register", async (req, res) => {
    try {
      const body = parseRegisterBody(restaurantRegisterSchema, req, res);
      if (!body) return;

      const [existing] = await db
        .select({ id: restaurantOrganizations.id })
        .from(restaurantOrganizations)
        .where(eq(restaurantOrganizations.email, body.email))
        .limit(1);

      if (existing) {
        return res.status(409).json({
          status: "error",
          message: "An account with this email already exists. Please sign in instead.",
        });
      }

      if (await storage.isPhoneInUse(body.phone)) {
        return res.status(409).json({
          status: "error",
          message:
            "This phone number is already in use by another vendor or restaurant organization.",
        });
      }

      const { password, ...orgFields } = body;
      const org = await storage.createRestaurantOrg({
        ...orgFields,
        status: "active",
        loginPassword: hashPassword(password),
      });

      storage
        .createActivityLog({
          action: "restaurant_created",
          entityType: "restaurant_org",
          entityId: org.id,
          entityName: org.name,
          restaurantId: org.id,
        })
        .catch(console.error);

      const token = createAuthToken({
        role: "restaurant",
        userId: org.id,
        email: org.email,
        name: org.name,
      });

      return res.status(201).json({
        status: "success",
        message: "Registration successful. Welcome!",
        token,
        user: {
          id: org.id,
          email: org.email,
          name: org.name,
          role: "restaurant",
        },
      });
    } catch (error) {
      console.error("Restaurant registration failed:", error);
      return res.status(500).json({
        status: "error",
        message: "Registration failed. Please try again.",
      });
    }
  });

  // Vendor Register
  app.post("/api/vendor/register", async (req, res) => {
    try {
      const body = parseRegisterBody(vendorRegisterSchema, req, res);
      if (!body) return;

      const [existing] = await db
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.email, body.email))
        .limit(1);

      if (existing) {
        return res.status(409).json({
          status: "error",
          message: "An account with this email already exists. Please sign in instead.",
        });
      }

      if (await storage.isPhoneInUse(body.phone)) {
        return res.status(409).json({
          status: "error",
          message:
            "This phone number is already in use by another vendor or restaurant organization.",
        });
      }

      const { password, ...vendorFields } = body;
      const vendor = await storage.createVendor({
        ...vendorFields,
        status: "active",
        loginPassword: hashPassword(password),
      });

      storage
        .createActivityLog({
          action: "vendor_created",
          entityType: "vendor",
          entityId: vendor.id,
          entityName: vendor.name,
          vendorId: vendor.id,
        })
        .catch(console.error);

      const token = createAuthToken({
        role: "vendor_admin",
        userId: vendor.id,
        email: vendor.email,
        name: vendor.name,
        vendorId: vendor.id,
      });

      return res.status(201).json({
        status: "success",
        message: "Registration successful. Welcome!",
        token,
        user: {
          id: vendor.id,
          email: vendor.email,
          name: vendor.name,
          role: "vendor_admin",
          vendor_id: vendor.id,
        },
        redirect: "/vendor/dashboard",
      });
    } catch (error) {
      console.error("Vendor registration failed:", error);
      return res.status(500).json({
        status: "error",
        message: "Registration failed. Please try again.",
      });
    }
  });

  app.post("/api/restaurant/forgot-password", async (req, res) => {
    const body = parseForgotPasswordBody(req, res);
    if (!body) return;

    try {
      await requestPasswordReset("restaurant", body.email);
      return res.json({ status: "success", message: forgotPasswordSuccessMessage });
    } catch (error) {
      console.error("[restaurant/forgot-password]", error);
      return res.status(500).json({
        status: "error",
        message: "Could not process your request. Please try again.",
      });
    }
  });

  app.post("/api/restaurant/reset-password", async (req, res) => {
    const body = parseResetPasswordBody(req, res);
    if (!body) return;

    try {
      const updated = await resetPasswordWithToken("restaurant", body.token, body.password);
      if (!updated) {
        return res.status(400).json({
          status: "error",
          message: "This reset link is invalid or has expired.",
        });
      }

      return res.json({
        status: "success",
        message: "Your password has been updated. You can now sign in.",
      });
    } catch (error) {
      console.error("[restaurant/reset-password]", error);
      return res.status(500).json({
        status: "error",
        message: "Could not reset your password. Please try again.",
      });
    }
  });

  app.post("/api/vendor/forgot-password", async (req, res) => {
    const body = parseForgotPasswordBody(req, res);
    if (!body) return;

    try {
      await requestPasswordReset("vendor", body.email);
      return res.json({ status: "success", message: forgotPasswordSuccessMessage });
    } catch (error) {
      console.error("[vendor/forgot-password]", error);
      return res.status(500).json({
        status: "error",
        message: "Could not process your request. Please try again.",
      });
    }
  });

  app.post("/api/vendor/reset-password", async (req, res) => {
    const body = parseResetPasswordBody(req, res);
    if (!body) return;

    try {
      const updated = await resetPasswordWithToken("vendor", body.token, body.password);
      if (!updated) {
        return res.status(400).json({
          status: "error",
          message: "This reset link is invalid or has expired.",
        });
      }

      return res.json({
        status: "success",
        message: "Your password has been updated. You can now sign in.",
      });
    } catch (error) {
      console.error("[vendor/reset-password]", error);
      return res.status(500).json({
        status: "error",
        message: "Could not reset your password. Please try again.",
      });
    }
  });
}
