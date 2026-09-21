/**
 * Upgrading an install that already has traffic to the per-event rollup.
 *
 * `actor_event_stats` is what lets a hidden event be taken back out of a person's or a
 * company's total, and a materialised view only ever sees rows inserted after it
 * exists. Without a backfill, an install with months of history would subtract only
 * the hidden events that arrived after the upgrade — every count would be wrong, in a
 * direction that looks entirely reasonable. Applied twice it would over-subtract
 * instead, which is worse: totals would sink below zero and be clamped there.
 *
 * This walks a database back to v8, puts traffic in it, and upgrades.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_hiddenupgrade_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  PAGE_LEAVE,
  configFor,
  configFromEnv,
  controlStatements,
  dataStatements,
  databaseFor,
  ensureDefaultProject,
  getAdminClient,
  getDataClient,
  getOverview,
  ingest,
  migrate,
  migrateAll,
  migrationsStatement,
  scope,
  type Project,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
let project: Project;

function leave(anonymousId: string, at: Date) {
  return { type: "track", event: PAGE_LEAVE, anonymousId, timestamp: at.toISOString(), properties: { engaged_ms: 5_000, path: "/" } };
}
function view(anonymousId: string, at: Date) {
  return { type: "page", anonymousId, timestamp: at.toISOString(), properties: { path: "/", url: "https://example.com/" } };
}

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const e of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, e)}\`` });
  await admin.close();
});

const upgrade = () => migrate(configFor("production", cfg()), [...controlStatements, ...dataStatements, migrationsStatement]);

test("history recorded before the rollup existed is still subtracted, exactly once", async () => {
  const client = getDataClient("production");
  const now = new Date();

  // The state a v8 install is in: no per-event rollup, and a recorded version to match.
  await client.command({ query: `DROP VIEW IF EXISTS actor_event_stats_mv` });
  await client.command({ query: `TRUNCATE TABLE actor_event_stats` });
  await client.command({ query: `TRUNCATE TABLE _migrations` });
  await client.insert({ table: "_migrations", values: [{ version: 8 }], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });

  // Traffic that arrives while there is no view to notice it: 4 views, 4 leaves.
  const old = Array.from({ length: 4 }, (_, i) => {
    const at = new Date(now.getTime() - (i + 1) * 3_600_000);
    return [view(`anon-${i % 2}`, at), leave(`anon-${i % 2}`, new Date(at.getTime() + 10_000))];
  }).flat();
  await ingest(project, old as never, { receivedAt: now }, "production");

  const rollup = async () => {
    const res = await client.query({ query: `SELECT sum(count) AS n FROM actor_event_stats WHERE event = {e:String}`, query_params: { e: PAGE_LEAVE }, format: "JSONEachRow" });
    return Number(((await res.json()) as { n: string }[])[0]?.n ?? 0);
  };
  assert.equal(await rollup(), 0, "with no view, nothing was rolled up");

  await upgrade();
  assert.equal(await rollup(), 4, "every hidden event recorded before the upgrade is now accounted for");

  // A second migrate must not re-apply the backfill. These are summed counts, and
  // subtracting them twice would take real activity off the totals as well.
  await upgrade();
  assert.equal(await rollup(), 4, "still four, not eight");

  const hidden = await getOverview(scope(project.id, "production", [PAGE_LEAVE]));
  const raw = await getOverview(scope(project.id, "production", []));
  assert.equal(raw.total_events, 8);
  assert.equal(hidden.total_events, 4, "the four page views, and nothing taken off twice");
});

test("after the upgrade the rollup keeps working for new traffic", async () => {
  const now = new Date();
  await ingest(project, [view("anon-9", now), leave("anon-9", new Date(now.getTime() + 10_000))] as never, { receivedAt: now }, "production");

  const hidden = await getOverview(scope(project.id, "production", [PAGE_LEAVE]));
  const raw = await getOverview(scope(project.id, "production", []));
  // The four backfilled events plus the one the view caught, with no seam between them.
  assert.equal(raw.total_events, 10);
  assert.equal(hidden.total_events, 5);
});
