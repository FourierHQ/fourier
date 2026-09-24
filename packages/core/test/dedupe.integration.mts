/**
 * Proves a message is stored once however many times it is delivered.
 *
 * Production held 186 message ids twice. Two shapes, both reproduced here as they arrived:
 *
 * - The SDK's own resend. A batch's request reached the server, the browser reported it
 *   failed, and the SDK put the batch back in its queue. It left again in the next flush,
 *   usually the page-leave beacon, with a new sentAt. About 85% of the pairs.
 * - The same request body delivered twice, seconds to minutes apart, both answered 200.
 *   The SDK never sends one body twice, so this is a replay below it.
 *
 * In both, the clock-skew correction gives the second copy its own timestamp, so `events`
 * sees a new sort key and every rollup counts it again. The check under test runs before
 * the insert, so the assertions below read the rollups as well as `events`.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database name,
 * and drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";

const BASE = `fourier_dedupetest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  configFromEnv,
  createProject,
  databaseFor,
  ensureDefaultProject,
  getAdminClient,
  getDataClient,
  ingest,
  migrateAll,
  ENVIRONMENTS,
  type Environment,
  type IncomingMessage,
  type Project,
} from "../src/index";
import { dedupe, forgetClaims } from "../src/dedupe";

const cfg = () => ({ ...configFromEnv(), database: BASE });
let project: Project;

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
});

// Each delivery below stands for a separate request, usually on another instance. Only the
// test that is about concurrency keeps this process's claims between deliveries.
beforeEach(() => forgetClaims());

after(async () => {
  const admin = getAdminClient(cfg());
  for (const env of ENVIRONMENTS) {
    await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, env)}\`` });
  }
  await admin.close();
});

async function one<T>(sql: string, params: Record<string, unknown>, environment: Environment = "production"): Promise<T> {
  const res = await getDataClient(environment).query({ query: sql, query_params: params, format: "JSONEachRow" });
  return ((await res.json()) as T[])[0];
}

/** What the reports read for one visitor: raw rows and every rollup a page view moves. */
async function counts(anonymousId: string, sessionId: string, environment: Environment = "production") {
  const p = { p: project.id, a: anonymousId, s: sessionId };
  const events = await one<{ n: string; ids: string }>(
    `SELECT count() AS n, uniqExact(message_id) AS ids FROM events WHERE project_id = {p:String} AND anonymous_id = {a:String}`,
    p,
    environment,
  );
  const user = await one<{ n: string }>(
    `SELECT sum(event_count) AS n FROM user_stats WHERE project_id = {p:String} AND distinct_id = {a:String}`,
    p,
    environment,
  );
  const session = await one<{ pageviews: string; engaged_ms: string }>(
    `SELECT sum(pageviews) AS pageviews, sum(engaged_ms) AS engaged_ms FROM sessions WHERE project_id = {p:String} AND session_id = {s:String}`,
    p,
    environment,
  );
  const actor = await one<{ n: string }>(
    `SELECT sum(count) AS n FROM actor_event_stats WHERE project_id = {p:String} AND distinct_id = {a:String}`,
    p,
    environment,
  );
  return {
    rows: Number(events.n),
    ids: Number(events.ids),
    userEvents: Number(user.n),
    actorEvents: Number(actor.n),
    pageviews: Number(session.pageviews),
    engagedMs: Number(session.engaged_ms),
  };
}

/** A landing page view, as the browser SDK sends it. */
function landing(anonymousId: string, sessionId: string, at: number): IncomingMessage {
  return {
    type: "page",
    messageId: `ajs-next-${at}-${anonymousId}-page`,
    anonymousId,
    timestamp: new Date(at).toISOString(),
    properties: { path: "/", url: "https://example.com/" },
    context: { page: { path: "/", url: "https://example.com/" }, session: { id: sessionId, isNew: true } },
  };
}

/** What the page-leave flush adds: the site's own exit event and the SDK's engagement beacon. */
function leaving(anonymousId: string, sessionId: string, at: number): IncomingMessage[] {
  const context = { page: { path: "/", url: "https://example.com/" }, session: { id: sessionId, isNew: false } };
  return [
    { type: "track", event: "Page Exited", messageId: `ajs-next-${at}-${anonymousId}-exit`, anonymousId, timestamp: new Date(at).toISOString(), context },
    {
      type: "track",
      event: "$page_leave",
      messageId: `ajs-next-${at}-${anonymousId}-leave`,
      anonymousId,
      timestamp: new Date(at).toISOString(),
      properties: { engaged_ms: 1500, path: "/" },
      context,
    },
  ];
}

const sent = (messages: IncomingMessage[], at: number) => messages.map((m) => ({ ...m, sentAt: new Date(at).toISOString() }));

test("the SDK's resend, riding in the page-leave beacon under a new sentAt, is stored once", async () => {
  // Timings from a production pair: flushed a second after the page view, the visitor left
  // 1.6s later, and each delivery took about 1.3s to reach normalize().
  const t = Date.now() - 60_000;
  const [anon, sess] = ["anon_resend", "sess_resend"];
  const first = await ingest(project, sent([landing(anon, sess, t)], t + 1017), { receivedAt: new Date(t + 2390) }, "production");
  const beacon = sent([landing(anon, sess, t), ...leaving(anon, sess, t + 1597)], t + 1601);
  const second = await ingest(project, beacon, { receivedAt: new Date(t + 2796) }, "production");

  assert.deepEqual([first.accepted, first.duplicates], [1, 0]);
  assert.deepEqual([second.accepted, second.duplicates], [2, 1], "the beacon's own events are new, its page view is not");
  const c = await counts(anon, sess);
  assert.equal(c.rows, 3, "one page view, one exit, one engagement beacon");
  assert.equal(c.ids, 3);
  assert.equal(c.userEvents, 3, "user_stats counted the page view once");
  assert.equal(c.actorEvents, 3, "actor_event_stats counted the page view once");
  assert.equal(c.pageviews, 1, "the visit saw one page, not two");
});

test("the same request replayed later is stored once, beacon and all", async () => {
  // Same body twice, ten seconds apart, both answered 200: the production shape for
  // leave-time events. Engagement is summed per visit, so a copy here doubles it.
  const t = Date.now() - 60_000;
  const [anon, sess] = ["anon_replay", "sess_replay"];
  await ingest(project, sent([landing(anon, sess, t)], t + 1000), { receivedAt: new Date(t + 1200) }, "production");
  const body = sent(leaving(anon, sess, t + 30_000), t + 30_005);
  const first = await ingest(project, body, { receivedAt: new Date(t + 30_300) }, "production");
  forgetClaims();
  const replay = await ingest(project, body, { receivedAt: new Date(t + 40_400) }, "production");

  assert.deepEqual([first.accepted, replay.accepted, replay.duplicates], [2, 0, 2]);
  const c = await counts(anon, sess);
  assert.equal(c.rows, 3);
  assert.equal(c.engagedMs, 1500, "engaged time counted once");
});

test("two copies in flight at once are stored once", async () => {
  // The resend usually lands while the first request is still being written, before a
  // lookup could see it. Both go to this process, so its claims have to settle it.
  const t = Date.now() - 60_000;
  const [anon, sess] = ["anon_race", "sess_race"];
  const results = await Promise.all([
    ingest(project, sent([landing(anon, sess, t)], t + 1000), { receivedAt: new Date(t + 2300) }, "production"),
    ingest(project, sent([landing(anon, sess, t)], t + 1600), { receivedAt: new Date(t + 2800) }, "production"),
  ]);

  assert.equal(results.reduce((n, r) => n + r.accepted, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.duplicates, 0), 1);
  const c = await counts(anon, sess);
  assert.equal(c.rows, 1);
  assert.equal(c.pageviews, 1);
});

test("a copy inside one batch is stored once", async () => {
  const t = Date.now() - 60_000;
  const [anon, sess] = ["anon_twice", "sess_twice"];
  const page = landing(anon, sess, t);
  const r = await ingest(project, sent([page, page], t + 1000), {}, "production");
  assert.deepEqual([r.accepted, r.duplicates], [1, 1]);
  assert.equal((await counts(anon, sess)).rows, 1);
});

test("an attempt that failed holds nothing: the copy waiting on it goes ahead", async () => {
  const t = Date.now() - 60_000;
  const page = landing("anon_failed", "sess_failed", t);
  const attempt = await dedupe("production", project.id, [page]);
  assert.equal(attempt.fresh.length, 1);

  let waited = false;
  const retry = dedupe("production", project.id, [page]).then((d) => ((waited = true), d));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(waited, false, "the retry waits while the first attempt is still storing");

  attempt.settle(false);
  const d = await retry;
  assert.equal(d.fresh.length, 1, "the retry is not dropped for a copy that never landed");
  assert.equal(d.duplicates, 0);
  d.settle(false);
});

test("messages with no id are never copies, and an id is only a copy within its own project and environment", async () => {
  const t = Date.now() - 60_000;
  const [anon, sess] = ["anon_scope", "sess_scope"];
  const { messageId: _, ...noId } = landing(anon, sess, t);
  const r = await ingest(project, sent([noId, noId], t + 1000), {}, "production");
  assert.deepEqual([r.accepted, r.duplicates], [2, 0], "normalize() gives each its own id");

  const page = sent([landing("anon_scope_2", "sess_scope_2", t)], t + 1000);
  const other = await createProject("Another site");
  const results = [
    await ingest(project, page, {}, "production"),
    await ingest(other, page, {}, "production"),
    await ingest(project, page, {}, "preview"),
  ];
  assert.deepEqual(results.map((x) => x.accepted), [1, 1, 1]);
  assert.equal((await counts("anon_scope_2", "sess_scope_2", "preview")).rows, 1);
});

test("the dedupe index holds each stored id with its arrival, inside the window the lookup reads", async () => {
  // The lookup filters on received_at, so a view that wrote epoch here would quietly catch nothing.
  const row = await one<{ n: string; oldest: string }>(
    `SELECT count() AS n, min(received_at) AS oldest FROM message_ids WHERE project_id = {p:String}`,
    { p: project.id },
  );
  assert.ok(Number(row.n) > 0, "message_ids_mv filled the index");
  assert.ok(Date.now() - new Date(row.oldest + "Z").getTime() < 10 * 60_000, `received_at looks wrong: ${row.oldest}`);
});
