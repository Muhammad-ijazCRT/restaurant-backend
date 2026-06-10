import { execSync } from "child_process";
import mysql from "mysql2/promise";
import { getDatabaseConfig } from "../src/db/config";

async function ensureDatabaseExists() {
  const config = getDatabaseConfig();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: true,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }
}

async function main() {
  if (!process.env.DB_NAME) {
    console.error("DB_NAME is required in .env.");
    process.exit(1);
  }

  await ensureDatabaseExists();

  console.log("Pushing schema to MySQL...");
  try {
    execSync("pnpm exec drizzle-kit push", {
      stdio: "inherit",
      env: process.env,
    });
    console.log("Migration complete.");
  } catch {
    process.exit(1);
  }
}

main();
