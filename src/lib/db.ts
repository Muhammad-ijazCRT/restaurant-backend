import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "./db-config.js";
import * as schema from "../shared/schema.js";

const client = postgres(getDatabaseUrl(), {
  max: 10,
  ssl: process.env.NODE_ENV === "production" ? "require" : undefined,
});

export const db = drizzle(client, { schema });
