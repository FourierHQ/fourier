/**
 * Upgrading an install that already has traffic.
 *
 * A materialised view only ever sees rows inserted after it exists, so `sessions_mv`
 * alone would leave every visit recorded before the upgrade out of Web Analytics — the
 * reports would open empty on an install with months of data and look broken rather
 * than new. The schema therefore carries a one-time backfill, and a backfill over
 * summed columns is precisely the kind of statement that is either missing or applied
 * twice, and looks plausible both ways.
 *
 * This walks a database back to v7, puts traffic in it, and upgrades.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_upgradetest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  getAdminClient,
  getDataClient,
  ingest,
  migrate,
  migrateAll,
  configFor,
  controlStatements,
  dataStatements,
  migrationsStatement,
  scope,
  resolveRange,
  headline,
  type Project,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
let project: Project;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** A visit, as the browser SDK would have sent it. */
function visit(id: string, at: Date, paths: string[]) {
  return paths.map((path, i) => ({
    type: "page" as const,
    anonymousId: `anon-${id}`,
    timestamp: new Date(at.getTime() + i * 10_000).toISOString(),
    properties: { path, url: `https://example.com${path}` },
    context: {
      page: { url: `https://example.com${path}`, path, referrer: i === 0 ? "https://www.google.com/" : "" },
      userAgent: UA,
      session: { id, isNew: i === 0 },
    },
  }));
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

test("upgrading an install with traffic backfills its sessions exactly once", async () => {
  const client = getDataClient("production");
  const now = new Date();

  // Walk this database back to the state a v7 install is in: the rollup does not exist,
  // and the recorded schema version predates it.
  await client.command({ query: `DROP VIEW IF EXISTS sessions_mv` });
  await client.command({ query: `TRUNCATE TABLE sessions` });
  await client.command({ query: `TRUNCATE TABLE _migrations` });
  await client.insert({ table: "_migrations", values: [{ version: 7 }], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });

  // Traffic that arrives while there is no view to notice it.
  await ingest(
    project,
    [
      ...visit("old-1", new Date(now.getTime() - 3 * 86_400_000), ["/", "/pricing"]),
      ...visit("old-2", new Date(now.getTime() - 2 * 86_400_000), ["/blog/a"]),
      ...visit("old-3", new Date(now.getTime() - 86_400_000), ["/", "/demo", "/pricing"]),
    ] as never,
    { receivedAt: now },
    "production",
  );

  const count = async () => {
    const res = await client.query({ query: `SELECT count() AS n FROM (SELECT session_id FROM sessions GROUP BY project_id, session_id)`, format: "JSONEachRow" });
    return Number(((await res.json()) as { n: string }[])[0]?.n ?? 0);
  };
  const pageviews = async () => {
    const res = await client.query({ query: `SELECT sum(pageviews) AS n FROM sessions`, format: "JSONEachRow" });
    return Number(((await res.json()) as { n: string }[])[0]?.n ?? 0);
  };

  assert.equal(await count(), 0, "with no view, nothing was rolled up");

  // The upgrade.
  await migrate(configFor("production", cfg()), [...controlStatements, ...dataStatements, migrationsStatement]);
  await client.command({ query: `OPTIMIZE TABLE sessions FINAL` });

  assert.equal(await count(), 3, "every visit recorded before the upgrade is now there");
  assert.equal(await pageviews(), 6, "and carries its page views");

  // Running migrate again must not re-apply the backfill. These are summed columns, so
  // a second pass would double every page view and every measured second — numbers that
  // stay entirely plausible while being twice the truth.
  await migrate(configFor("production", cfg()), [...controlStatements, ...dataStatements, migrationsStatement]);
  await client.command({ query: `OPTIMIZE TABLE sessions FINAL` });
  assert.equal(await count(), 3, "still three visits");
  assert.equal(await pageviews(), 6, "and still six page views, not twelve");
});

test("after the upgrade the rollup keeps working for new traffic", async () => {
  const client = getDataClient("production");
  const now = new Date();
  await ingest(project, visit("after-1", new Date(now.getTime() - 3_600_000), ["/", "/pricing", "/demo"]) as never, { receivedAt: now }, "production");
  await client.command({ query: `OPTIMIZE TABLE sessions FINAL` });

  const w = {
    scope: scope(project.id, "production"),
    range: resolveRange({ preset: "7d", now }),
    filters: {},
    goal: null,
    goals: [],
    pageGroups: [],
  };
  const h = await headline(w);
  // The three backfilled visits plus the one the view caught, counted together with no
  // seam between them.
  assert.equal(h.sessions.current, 4);
  assert.equal(h.visitors.current, 4);
});
