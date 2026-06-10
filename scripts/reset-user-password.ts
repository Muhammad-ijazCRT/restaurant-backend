/**
 * Reset a portal user's login password with the app's scrypt hash format.
 * Run: pnpm exec tsx --env-file=.env scripts/reset-user-password.ts <email> [password]
 */
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db.js";
import { users } from "../src/shared/schema.js";
import { hashPassword, verifyPassword } from "../src/lib/password";

const email = process.argv[2]?.trim().toLowerCase();
const password = process.argv[3] ?? "password";

if (!email) {
  console.error("Usage: tsx --env-file=.env scripts/reset-user-password.ts <email> [password]");
  process.exit(1);
}

const allUsers = await db.select().from(users);
const user = allUsers.find((row) => row.username.trim().toLowerCase() === email);
if (!user) {
  console.error(`No user found with username/email: ${email}`);
  process.exit(1);
}

const hashed = hashPassword(password);
await db.update(users).set({
  password: hashed,
  username: email,
}).where(eq(users.id, user.id));

const [updated] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
const ok = updated ? verifyPassword(password, updated.password) : false;

console.log(`Password reset for: ${email}`);
console.log(`Login with password: ${password}`);
console.log(`Verify check: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
