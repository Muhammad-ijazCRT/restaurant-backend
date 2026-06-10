import { db } from "../src/lib/db.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    const tables = ["vendors", "restaurant_organizations", "vendor_restaurant_relationships", "orders", "order_line_items", "internal_notes", "attachments", "activity_logs", "users"];
    
    for (const table of tables) {
      console.log(`\n=== ${table} ===`);
      try {
        const [rows] = await db.execute(sql.raw(`DESCRIBE ${table}`));
        if (Array.isArray(rows)) {
          console.log("Column | Type | Null | Key | Default");
          console.log("-----------------------------------------------");
          for (const row of rows as any[]) {
            console.log(`${row.Field} | ${row.Type} | ${row.Null} | ${row.Key} | ${row.Default}`);
          }
        }
      } catch (e: any) {
        console.log(`Table does not exist or error: ${e.message}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
  process.exit(0);
}

run();
