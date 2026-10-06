/**
 * Proves the thing the design exists for: two environments cannot see each other's
 * people, even when the same user id is identified in both.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database name,
 * and drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

// Set before importing core: every function inside resolves its database through
// configFromEnv(), which is exactly the path the app uses. Passing a config object
// around instead would test a route production never takes.
const BASE = `fourier_envtest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  configFromEnv,
  createSource,
  ensureDefaultProject,
  getAdminClient,
  getClient,
  getDataClient,
  ingest,
  listSourceKeys,
  migrateAll,
  resolveWriteKey,
  scope,
  databaseFor,
  ENVIRONMENTS,
  KEYED_ENVIRONMENTS,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });

before(async () => {
  await migrateAll();
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const env of ENVIRONMENTS) {
    await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, env)}\`` });
  }
  await admin.close();
});

test("each environment gets its own database", async () => {
  const admin = getAdminClient(cfg());
  const res = await admin.query({ query: `SHOW DATABASES`, format: "JSONEachRow" });
  const names = new Set(((await res.json()) as { name: string }[]).map((r) => r.name));
  await admin.close();
  for (const env of ENVIRONMENTS) {
    assert.ok(names.has(databaseFor(BASE, env)), `missing database for ${env}`);
  }
});

test("control tables live only in the base database", async () => {
  const tablesIn = async (db: string) => {
    const c = getClient({ ...cfg(), database: db });
    const res = await c.query({ query: `SHOW TABLES`, format: "JSONEachRow" });
    return new Set(((await res.json()) as { name: string }[]).map((r) => r.name));
  };
  const base = await tablesIn(databaseFor(BASE, "production"));
  const preview = await tablesIn(databaseFor(BASE, "preview"));

  for (const t of ["projects", "sources", "source_keys", "accounts", "api_keys", "settings"]) {
    assert.ok(base.has(t), `base is missing control table ${t}`);
    assert.ok(!preview.has(t), `preview should not hold control table ${t}`);
  }
  for (const t of ["events", "user_traits", "identities", "group_traits", "touches"]) {
    assert.ok(base.has(t), `base is missing data table ${t}`);
    assert.ok(preview.has(t), `preview is missing data table ${t}`);
  }
});

test("a source gets one write key per keyed environment, and each key resolves to its own", async () => {
  const project = await ensureDefaultProject();
  const source = await createSource(project.id, "App");
  const keys = (await listSourceKeys(project.id)).filter((k) => k.source_id === source.id);
  assert.equal(keys.length, KEYED_ENVIRONMENTS.length, "expected a key per keyed environment");
  assert.ok(!keys.some((k) => k.environment === "test"), "test is filled by import and must never get a write key");

  const seen = new Set<string>();
  for (const k of keys) {
    assert.ok(!seen.has(k.write_key), "write keys must be distinct across environments");
    seen.add(k.write_key);
    const resolved = await resolveWriteKey(k.write_key);
    assert.ok(resolved, `key for ${k.environment} did not resolve`);
    assert.equal(resolved.environment, k.environment, "key resolved to the wrong environment");
    assert.equal(resolved.source.id, source.id, "key resolved to the wrong source");
  }
});

test("a key for an environment that issues no keys is refused, never read as production", async () => {
  const project = await ensureDefaultProject();
  const source = await createSource(project.id, "Stray");
  // What a newer build, or a hand-edited row, could leave behind. The old behaviour was
  // to treat an unknown environment as production, which would make this key a way in.
  await getClient(cfg()).insert({
    table: "source_keys",
    values: [{ project_id: project.id, source_id: source.id, environment: "test", write_key: "fk_stray_test_key" }],
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
  assert.equal(await resolveWriteKey("fk_stray_test_key"), null);
});

test("the same user id in two environments stays two different people", async () => {
  const project = await ensureDefaultProject();

  await ingest(project, [{ type: "identify", userId: "user_123", traits: { plan: "enterprise" } }], {}, "production");
  await ingest(project, [{ type: "track", userId: "user_123", event: "Invoice Paid" }], {}, "production");

  await ingest(project, [{ type: "identify", userId: "user_123", traits: { plan: "test-junk" } }], {}, "preview");
  for (let i = 0; i < 5; i++) {
    await ingest(project, [{ type: "track", userId: "user_123", event: "Button Smashed" }], {}, "preview");
  }

  const count = async (env: "production" | "preview") => {
    const rows = await getDataClient(env).query({
      query: `SELECT count() AS n FROM events WHERE project_id = {p:String}`,
      query_params: { p: project.id },
      format: "JSONEachRow",
    });
    return Number(((await rows.json()) as { n: string }[])[0]?.n ?? 0);
  };

  assert.equal(await count("production"), 2, "production should hold only its own two events");
  assert.equal(await count("preview"), 6, "preview should hold only its own six events");

  // The trait written in preview must not have reached the production person.
  const traits = await getDataClient("production").query({
    query: `SELECT traits FROM user_traits FINAL WHERE project_id = {p:String} AND user_id = 'user_123'`,
    query_params: { p: project.id },
    format: "JSONEachRow",
  });
  const rows = (await traits.json()) as { traits: string }[];
  assert.match(rows[0]?.traits ?? "", /enterprise/, "production traits missing");
  assert.doesNotMatch(rows[0]?.traits ?? "", /test-junk/, "preview traits leaked into production");
});

test("a production-scoped read cannot see preview rows", async () => {
  const project = await ensureDefaultProject();
  const { listEvents } = await import("../src/queries");
  const prod = await listEvents(scope(project.id, "production"), { limit: 100 });
  const prev = await listEvents(scope(project.id, "preview"), { limit: 100 });

  assert.ok(
    prod.every((e) => e.event !== "Button Smashed"),
    "a preview-only event appeared in a production read",
  );
  assert.ok(
    prev.some((e) => e.event === "Button Smashed"),
    "preview read did not return its own events",
  );
});
