import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl, requiresDatabaseSsl } from "./db-config.js";
import * as schema from "../shared/schema.js";

const databaseUrl = getDatabaseUrl();

const client = postgres(databaseUrl, {
  max: 10,
  ssl: requiresDatabaseSsl(databaseUrl) ? "require" : undefined,
});

export const db = drizzle(client, { schema });
