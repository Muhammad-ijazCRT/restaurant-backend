import { randomUUID } from "crypto";
import { eq, type SQL } from "drizzle-orm";
import { db } from "./db.js";
import { requestContext } from "./async-context.js";
import { activityLogs } from "../shared/schema.js";

async function logActivity(executor: DbExecutor, action: string, table: any, id: string | null, metadata?: string) {
  if (table === activityLogs) return;
  
  const ctx = requestContext.getStore();
  const actor = ctx ? `${ctx.userName} (${ctx.userRole})` : "System";
  const tableName = table && table[Symbol.for("drizzle:Name")] ? table[Symbol.for("drizzle:Name")] : "database_record";
  
  try {
    await executor.insert(activityLogs).values({
      id: newId(),
      action: action,
      entityType: tableName,
      entityId: id || "unknown",
      entityName: `${action} ${tableName} by ${actor}`,
      metadata: metadata || null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("Failed to log activity:", e);
  }
}

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function newId(): string {
  return randomUUID();
}

/** Coerce MySQL/XAMPP timestamp values (incl. zero-dates) for Drizzle inserts. */
export function toValidDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value && !value.startsWith("0000-00-00")) {
    const d = new Date(value.includes("T") ? value : value.replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function insertOne<T extends { id: string }>(
  executor: DbExecutor,
  table: any,
  values: Record<string, unknown>,
): Promise<T> {
  const id = (values.id as string | undefined) ?? newId();
  await executor.insert(table).values({ ...values, id });
  const [row] = await executor.select().from(table).where(eq(table.id, id));
  if (!row) throw new Error("Insert failed");
  await logActivity(executor, "INSERT", table, id, JSON.stringify({ inserted: true }));
  return row as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function insertMany<T extends { id: string }>(
  executor: DbExecutor,
  table: any,
  rows: Record<string, unknown>[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const withIds = rows.map((row) => ({ ...row, id: (row.id as string | undefined) ?? newId() }));
  await executor.insert(table).values(withIds);
  const ids = withIds.map((row) => row.id as string);
  const { inArray } = await import("drizzle-orm");
  const results = await executor.select().from(table).where(inArray(table.id, ids)) as T[];
  for (const id of ids) {
    await logActivity(executor, "INSERT", table, id, JSON.stringify({ bulk_inserted: true }));
  }
  return results;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updateOneById<T>(
  executor: DbExecutor,
  table: any,
  id: string,
  values: Record<string, unknown>,
): Promise<T | undefined> {
  await executor.update(table).set(values).where(eq(table.id, id));
  const [row] = await executor.select().from(table).where(eq(table.id, id));
  await logActivity(executor, "UPDATE", table, id, JSON.stringify({ updated_fields: Object.keys(values) }));
  return row as T | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updateOneWhere<T>(
  executor: DbExecutor,
  table: any,
  values: Record<string, unknown>,
  where: SQL,
): Promise<T | undefined> {
  const [existing] = await executor.select({ id: table.id }).from(table).where(where).limit(1);
  if (!existing) return undefined;
  await executor.update(table).set(values).where(where);
  const [row] = await executor.select().from(table).where(eq(table.id, existing.id));
  await logActivity(executor, "UPDATE", table, existing.id as string, JSON.stringify({ updated_fields: Object.keys(values) }));
  return row as T | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deleteOneById(
  executor: DbExecutor,
  table: any,
  id: string,
): Promise<boolean> {
  const [existing] = await executor.select().from(table).where(eq(table.id, id));
  if (!existing) return false;
  await executor.delete(table).where(eq(table.id, id));
  await logActivity(executor, "DELETE", table, id, JSON.stringify({ deleted: true }));
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deleteManyWhere(
  executor: DbExecutor,
  table: any,
  where: SQL,
): Promise<number> {
  const rows = await executor.select({ id: table.id }).from(table).where(where);
  if (rows.length === 0) return 0;
  await executor.delete(table).where(where);
  for (const r of rows) {
    await logActivity(executor, "DELETE", table, r.id as string, JSON.stringify({ bulk_deleted: true }));
  }
  return rows.length;
}
