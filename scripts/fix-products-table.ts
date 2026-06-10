import { db } from "../src/lib/db.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    console.log("Fixing products table columns to match Drizzle schema...\n");
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

    // id was already fixed to VARCHAR(36), but let's ensure it
    console.log("1. Ensuring id is VARCHAR(36)...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN id VARCHAR(36) NOT NULL`);

    console.log("2. Fixing vendor_id to VARCHAR(36)...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN vendor_id VARCHAR(36) NOT NULL`);

    console.log("3. Fixing name to TEXT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN name TEXT NOT NULL`);

    console.log("4. Fixing sku to TEXT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN sku TEXT`);

    console.log("5. Fixing stock_type to TEXT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN stock_type TEXT`);

    console.log("6. Fixing unit_type to TEXT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN unit_type TEXT NOT NULL`);

    console.log("7. Fixing unit_size to TEXT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN unit_size TEXT NOT NULL`);

    console.log("8. Fixing price to DECIMAL(10,2)...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN price DECIMAL(10,2) NOT NULL`);

    console.log("9. Fixing status to TEXT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN status TEXT NOT NULL DEFAULT 'active'`);

    console.log("10. Fixing sort_order to INT...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN sort_order INT NOT NULL DEFAULT 0`);

    console.log("11. Fixing created_at to TIMESTAMP...");
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);

    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    // Verify
    console.log("\n--- Verifying updated table structure ---");
    const [rows] = await db.execute(sql`DESCRIBE products`);
    if (Array.isArray(rows)) {
      console.log("Column | Type | Null | Key | Default | Extra");
      console.log("-----------------------------------------------");
      for (const row of rows as any[]) {
        console.log(`${row.Field} | ${row.Type} | ${row.Null} | ${row.Key} | ${row.Default} | ${row.Extra}`);
      }
    }

    console.log("\n✅ Products table fixed successfully!");
  } catch (error) {
    console.error("Error fixing products table:", error);
  }
  process.exit(0);
}

run();
