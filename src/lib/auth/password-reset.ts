import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  restaurantEmployees,
  restaurantOrganizations,
  vendorEmployees,
  vendors,
} from "../../db/schema.js";
import { hashPassword } from "./password.js";
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  type PasswordResetTokenPayload,
} from "./tokens.js";
import { sendPasswordResetEmail } from "../email/password-reset.js";

export type PasswordResetPortal = "restaurant" | "vendor";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findRestaurantAccount(email: string) {
  const normalized = normalizeEmail(email);

  const [org] = await db
    .select()
    .from(restaurantOrganizations)
    .where(sql`LOWER(TRIM(${restaurantOrganizations.email})) = ${normalized}`)
    .limit(1);

  if (org) {
    return {
      accountType: "restaurant_org" as const,
      userId: org.id,
      email: org.email,
      name: org.name,
    };
  }

  const [employee] = await db
    .select()
    .from(restaurantEmployees)
    .where(sql`LOWER(TRIM(${restaurantEmployees.email})) = ${normalized}`)
    .limit(1);

  if (employee) {
    return {
      accountType: "restaurant_employee" as const,
      userId: employee.id,
      email: employee.email,
      name: employee.name,
    };
  }

  return null;
}

async function findVendorAccount(email: string) {
  const normalized = normalizeEmail(email);

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(sql`LOWER(TRIM(${vendors.email})) = ${normalized}`)
    .limit(1);

  if (vendor) {
    return {
      accountType: "vendor" as const,
      userId: vendor.id,
      email: vendor.email,
      name: vendor.name,
    };
  }

  const [employee] = await db
    .select()
    .from(vendorEmployees)
    .where(sql`LOWER(TRIM(${vendorEmployees.email})) = ${normalized}`)
    .limit(1);

  if (employee) {
    return {
      accountType: "vendor_employee" as const,
      userId: employee.id,
      email: employee.email,
      name: employee.name,
    };
  }

  return null;
}

async function updateAccountPassword(payload: PasswordResetTokenPayload, hashedPassword: string) {
  switch (payload.accountType) {
    case "restaurant_org":
      await db
        .update(restaurantOrganizations)
        .set({ loginPassword: hashedPassword })
        .where(eq(restaurantOrganizations.id, payload.userId));
      return;
    case "restaurant_employee":
      await db
        .update(restaurantEmployees)
        .set({ loginPassword: hashedPassword })
        .where(eq(restaurantEmployees.id, payload.userId));
      return;
    case "vendor":
      await db.update(vendors).set({ loginPassword: hashedPassword }).where(eq(vendors.id, payload.userId));
      return;
    case "vendor_employee":
      await db
        .update(vendorEmployees)
        .set({ loginPassword: hashedPassword })
        .where(eq(vendorEmployees.id, payload.userId));
      return;
    default:
      throw new Error("Unsupported account type.");
  }
}

export async function requestPasswordReset(portal: PasswordResetPortal, email: string): Promise<void> {
  const account =
    portal === "restaurant"
      ? await findRestaurantAccount(email)
      : await findVendorAccount(email);

  if (!account) return;

  const token = createPasswordResetToken({
    portal,
    accountType: account.accountType,
    userId: account.userId,
    email: account.email,
  });

  await sendPasswordResetEmail({
    to: account.email,
    name: account.name,
    portal,
    resetToken: token,
  });
}

export async function resetPasswordWithToken(
  portal: PasswordResetPortal,
  token: string,
  newPassword: string,
): Promise<boolean> {
  const payload = verifyPasswordResetToken(token);
  if (!payload || payload.portal !== portal) return false;

  await updateAccountPassword(payload, hashPassword(newPassword));
  return true;
}
