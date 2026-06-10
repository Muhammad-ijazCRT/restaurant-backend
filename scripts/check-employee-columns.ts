import mysql from "mysql2/promise";
import { getDatabaseConfig } from "../src/db/config";

async function main() {
  const config = getDatabaseConfig();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });

  try {
    const [columns] = await connection.query("SHOW COLUMNS FROM vendor_employees");
    console.log("vendor_employees columns:");
    for (const column of columns as Array<{ Field: string; Type: string }>) {
      console.log(`- ${column.Field} (${column.Type})`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
