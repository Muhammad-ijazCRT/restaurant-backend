/** True for hosted databases (Neon, Railway, etc.) — not local Postgres. */
export function requiresDatabaseSsl(url: string): boolean {
  return !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
}

/** Ensure remote Postgres URLs request SSL (required by Neon). */
export function ensureSslDatabaseUrl(url: string): string {
  if (!requiresDatabaseSsl(url)) return url;
  if (/sslmode=/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sslmode=require`;
}

/** Database connection URL from environment (Neon PostgreSQL). */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required in .env.");
  }
  return ensureSslDatabaseUrl(url);
}
