import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function generatePortalPassword(length = 12): string {
  return randomBytes(Math.ceil(length * 0.75))
    .toString("base64url")
    .slice(0, length);
}

export function resolvePortalPassword(plain?: string | null): { plain: string; hashed: string } {
  const password = plain?.trim() || generatePortalPassword();
  return { plain: password, hashed: hashPassword(password) };
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, "hex");
  const testHash = scryptSync(password, salt, 64);
  if (hashBuffer.length !== testHash.length) return false;
  return timingSafeEqual(hashBuffer, testHash);
}
