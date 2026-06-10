/** Database connection URL from environment (Neon PostgreSQL). */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required in .env.");
  }
  return url;
}
