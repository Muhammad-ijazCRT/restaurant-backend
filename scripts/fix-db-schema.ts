import { db } from "../src/lib/db.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    console.log("Altering products.id column to VARCHAR(36) to match Drizzle schema...");
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    
    // Modify id to VARCHAR(36)
    await db.execute(sql`ALTER TABLE products MODIFY COLUMN id VARCHAR(36) NOT NULL`);
    
    // Also check other columns if needed
    console.log("Database altered successfully.");
    
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  } catch (error) {
    console.error("Error altering database:", error);
  }
  process.exit(0);
}

run();
