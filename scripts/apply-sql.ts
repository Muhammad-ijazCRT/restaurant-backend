import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import { getDatabaseConfig } from "../src/lib/db-config";

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
  const fileName = process.argv[2];
  if (!fileName) {
    console.error("Usage: pnpm exec tsx --env-file=.env scripts/apply-sql.ts sql/003_vendor_employees.sql");
    process.exit(1);
  }

  const sqlPath = path.resolve(process.cwd(), fileName);
  const sql = fs.readFileSync(sqlPath, "utf8").trim();
  if (!sql) {
    console.log(`No SQL found in ${fileName}.`);
    return;
  }

  const config = getDatabaseConfig();
  await ensureDatabaseExists();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: true,
  });

  try {
    await connection.query(sql);
    console.log(`Applied ${fileName}.`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
