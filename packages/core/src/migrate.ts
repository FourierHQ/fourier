import { configFromEnv, getAdminClient, getClient, type ClickHouseConfig } from "./client";
import { SCHEMA_VERSION, statements } from "./schema";

export async function migrate(config: ClickHouseConfig = configFromEnv()): Promise<{ version: number; created: boolean }> {
  const admin = getAdminClient(config);
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${escapeIdent(config.database)}` });
  await admin.close();

  const client = getClient(config);
  for (const stmt of statements) {
    await client.command({ query: stmt, clickhouse_settings: { wait_end_of_query: 1 } });
  }
  const existing = await client.query({ query: `SELECT max(version) AS v FROM _migrations`, format: "JSONEachRow" });
  const rows = (await existing.json()) as { v: number | string | null }[];
  const current = Number(rows[0]?.v ?? 0);
  if (current < SCHEMA_VERSION) {
    await client.insert({ table: "_migrations", values: [{ version: SCHEMA_VERSION }], format: "JSONEachRow" });
  }
  return { version: SCHEMA_VERSION, created: current === 0 };
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
