/**
 * Seeds portal login accounts only (no full DB reset).
 * Run: pnpm run db:seed:login
 */
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db.js";
import { users, vendors, restaurantOrganizations } from "../src/shared/schema.js";
import { hashPassword } from "../src/lib/password";

const LOGIN = {
  admin: { email: "admin@gmail.com", password: "password", name: "Super Admin" },
  restaurant: { email: "resturent@gmail.com", password: "password", name: "Demo Restaurant" },
  vendor: { email: "vendor@gmail.com", password: "password", name: "Demo Vendor" },
} as const;

const IDS = {
  admin: "11111111-1111-1111-1111-111111111101",
  vendor: "22222222-2222-2222-2222-222222222201",
  restaurant: "33333333-3333-3333-3333-333333333301",
};

async function seedAdmin() {
  const hashed = hashPassword(LOGIN.admin.password);
  const [byEmail] = await db.select().from(users).where(eq(users.username, LOGIN.admin.email)).limit(1);
  const [byId] = await db.select().from(users).where(eq(users.id, IDS.admin)).limit(1);
  const target = byEmail ?? byId;

  if (target) {
    await db
      .update(users)
      .set({ username: LOGIN.admin.email, password: hashed })
      .where(eq(users.id, target.id));
    console.log(`  Super Admin: ${LOGIN.admin.email} (updated)`);
    return target.id;
  }

  await db.insert(users).values({
    id: IDS.admin,
    username: LOGIN.admin.email,
    password: hashed,
  });
  console.log(`  Super Admin: ${LOGIN.admin.email} (created)`);
  return IDS.admin;
}

async function seedVendor() {
  const hashed = hashPassword(LOGIN.vendor.password);
  const [byEmail] = await db.select().from(vendors).where(eq(vendors.email, LOGIN.vendor.email)).limit(1);
  const [byId] = await db.select().from(vendors).where(eq(vendors.id, IDS.vendor)).limit(1);
  const target = byEmail ?? byId;

  if (target) {
    await db
      .update(vendors)
      .set({
        email: LOGIN.vendor.email,
        name: LOGIN.vendor.name,
        loginPassword: hashed,
        status: "active",
      })
      .where(eq(vendors.id, target.id));
    console.log(`  Vendor:      ${LOGIN.vendor.email} (updated, id: ${target.id})`);
    return target.id;
  }

  await db.insert(vendors).values({
    id: IDS.vendor,
    name: LOGIN.vendor.name,
    contactName: "Vendor Admin",
    email: LOGIN.vendor.email,
    phone: "2125550199",
    loginPassword: hashed,
    status: "active",
  });
  console.log(`  Vendor:      ${LOGIN.vendor.email} (created)`);
  return IDS.vendor;
}

async function seedRestaurant() {
  const hashed = hashPassword(LOGIN.restaurant.password);
  const [byEmail] = await db
    .select()
    .from(restaurantOrganizations)
    .where(eq(restaurantOrganizations.email, LOGIN.restaurant.email))
    .limit(1);
  const [byId] = await db
    .select()
    .from(restaurantOrganizations)
    .where(eq(restaurantOrganizations.id, IDS.restaurant))
    .limit(1);
  const target = byEmail ?? byId;

  if (target) {
    await db
      .update(restaurantOrganizations)
      .set({
        email: LOGIN.restaurant.email,
        name: LOGIN.restaurant.name,
        loginPassword: hashed,
        status: "active",
      })
      .where(eq(restaurantOrganizations.id, target.id));
    console.log(`  Restaurant:  ${LOGIN.restaurant.email} (updated, id: ${target.id})`);
    return target.id;
  }

  await db.insert(restaurantOrganizations).values({
    id: IDS.restaurant,
    name: LOGIN.restaurant.name,
    contactName: "Restaurant Admin",
    email: LOGIN.restaurant.email,
    phone: "3125550199",
    loginPassword: hashed,
    status: "active",
  });
  console.log(`  Restaurant:  ${LOGIN.restaurant.email} (created)`);
  return IDS.restaurant;
}

async function main() {
  console.log("Seeding portal login accounts...\n");
  console.log("Credentials (all use password: \"password\"):");
  await seedAdmin();
  await seedVendor();
  await seedRestaurant();
  console.log("\nDone. Use these on the React login pages:");
  console.log("  /super-admin/login  → admin@gmail.com");
  console.log("  /restaurant/login   → restaurant@gmail.com");
  console.log("  /vendor/login       → vendor@gmail.com");
  process.exit(0);
}

main().catch((err) => {
  console.error("Login seed failed:", err);
  process.exit(1);
});
