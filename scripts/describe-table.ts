import { db } from "../src/lib/db.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    const [res] = await db.execute(sql`DESCRIBE products`);
    if (Array.isArray(res)) {
      console.log("Column | Type | Null | Key | Default | Extra");
      console.log("-----------------------------------------------");
      for (const row of res as any[]) {
        console.log(`${row.Field} | ${row.Type} | ${row.Null} | ${row.Key} | ${row.Default} | ${row.Extra}`);
      }
    }
  } catch (error) {
    console.error("Error describing products table:", error);
  }
  process.exit(0);
}

run();
