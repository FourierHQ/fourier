import { configFromEnv, getAdminClient, getClient, type ClickHouseConfig } from "./client";
import { SCHEMA_VERSION, statements, type Statement } from "./schema";

/**
 * ClickHouse Cloud replicates table metadata between replicas; an ALTER issued while the
 * previous one is still propagating fails with 517 CANNOT_ASSIGN_ALTER ("replica doesn't
 * catch up with latest ALTER query updates ... Please retry this query"). Local single-node
 * ClickHouse never shows this. Retry with a short backoff.
 */
const RETRYABLE_CODES = new Set(["517", "999", "242"]); // CANNOT_ASSIGN_ALTER, KEEPER_EXCEPTION, TABLE_IS_READ_ONLY

async function runWithRetry(exec: () => Promise<unknown>, attempts = 12): Promise<void> {
  let delay = 250;
  for (let i = 1; ; i++) {
    try {
      await exec();
      return;
    } catch (err) {
      const code = String((err as { code?: string | number })?.code ?? "");
      if (!RETRYABLE_CODES.has(code) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 3000);
    }
  }
}

async function storedVersion(client: ReturnType<typeof getClient>): Promise<number> {
  // Fresh install: no _migrations table yet. Checked explicitly so the client library
  // doesn't log an UNKNOWN_TABLE error on every first boot.
  const exists = await client.query({ query: `EXISTS TABLE _migrations`, format: "JSONEachRow" });
  const [row] = (await exists.json()) as { result: number | string }[];
  if (Number(row?.result ?? 0) === 0) return 0;
  const res = await client.query({ query: `SELECT max(version) AS v FROM _migrations`, format: "JSONEachRow" });
  const rows = (await res.json()) as { v: number | string | null }[];
  return Number(rows[0]?.v ?? 0);
}

function shouldRun(stmt: Statement, current: number): boolean {
  if (typeof stmt === "string") return true;
  const fresh = current === 0;
  const behind = current > 0 && current < SCHEMA_VERSION;
  if (stmt.when === "upgrade") return behind;
  return fresh || behind; // "change"
}

export async function migrate(config: ClickHouseConfig = configFromEnv()): Promise<{ version: number; created: boolean; ran: number }> {
  const admin = getAdminClient(config);
  await runWithRetry(() => admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${escapeIdent(config.database)}` }));
  await admin.close();

  const client = getClient(config);
  const current = await storedVersion(client);
  let ran = 0;
  for (const stmt of statements) {
    if (!shouldRun(stmt, current)) continue;
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    await runWithRetry(() => client.command({ query: sql, clickhouse_settings: { wait_end_of_query: 1 } }));
    ran++;
  }
  if (current < SCHEMA_VERSION) {
    await client.insert({ table: "_migrations", values: [{ version: SCHEMA_VERSION }], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  }
  return { version: SCHEMA_VERSION, created: current === 0, ran };
}

export async function ping(config: ClickHouseConfig = configFromEnv()): Promise<{ ok: boolean; error?: string; version?: string }> {
  try {
    const admin = getAdminClient(config);
    const res = await admin.query({ query: "SELECT version() AS v", format: "JSONEachRow" });
    const rows = (await res.json()) as { v: string }[];
    await admin.close();
    return { ok: true, version: rows[0]?.v };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function escapeIdent(s: string) {
  return "`" + s.replace(/`/g, "``") + "`";
}
