import { db } from "../src/db/client.js";
import { vendors } from "../src/db/schema.js";
import { storage } from "../src/services/storage.js";

async function run() {
  try {
    console.log("Attempting to insert a product manually...");
    const [vendor] = await db.select().from(vendors).limit(1);
    if (!vendor) {
      console.error("No vendor found in the DB. Please run seed-login or seed first.");
      process.exit(1);
    }
    console.log("Using vendor ID:", vendor.id);

    const product = await storage.createProduct({
      vendorId: vendor.id,
      name: "Test pizaa",
      sku: "1221",
      unitType: "each",
      unitSize: "12ct",
      price: "12.00",
      status: "active",
    });
    console.log("Product inserted successfully:", product);
  } catch (error) {
    console.error("Error inserting product:", error);
  }
  process.exit(0);
}

run();
