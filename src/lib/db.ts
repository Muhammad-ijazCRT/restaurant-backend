import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { getDatabaseConfig } from "./db-config.js";
import * as schema from "../shared/schema.js";

const config = getDatabaseConfig();

const pool = mysql.createPool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  waitForConnections: true,
  connectionLimit: 10,
});

export const db = drizzle(pool, { schema, mode: "default" });
