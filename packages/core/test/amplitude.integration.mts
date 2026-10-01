/**
 * The Amplitude import end to end, against real ClickHouse: an Export API archive in,
 * Fourier's people, sessions and rollups out — in Test and nowhere else — and the two
 * promises the design rests on. Importing a day twice changes nothing. Emptying Test
 * leaves it ready to import into again.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database name, and
 * drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_amptest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  configFromEnv,
  databaseFor,
  emptyImportEnvironment,
  ensureDefaultProject,
  ENVIRONMENTS,
  getAdminClient,
  getDataClient,
  importAmplitudeDay,
  importStatus,
  migrateAll,
  type AmplitudeEvent,
  type Environment,
  type Project,
} from "../src/index";
import { ampEvent, ampTime, fakeExport } from "./amplitude-fixtures.mts";

const credentials = { apiKey: "amp-api", secretKey: "amp-secret", region: "us" as const };
let project: Project;

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
});

after(async () => {
  const admin = getAdminClient({ ...configFromEnv(), database: BASE });
  for (const env of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, env)}\`` });
  await admin.close();
});

async function one<T>(environment: Environment, query: string): Promise<T> {
  const res = await getDataClient(environment).query({ query, query_params: { p: project.id }, format: "JSONEachRow" });
  return ((await res.json()) as T[])[0];
}

const count = async (environment: Environment, table: string) =>
  Number((await one<{ n: string }>(environment, `SELECT count() AS n FROM ${table} WHERE project_id = {p:String}`)).n);

/**
 * Two visitors on 2026-09-01. dev-a arrives from a Google ad, reads two pages, clicks a
 * CTA and signs in as user_42. dev-b arrives from a referral a minute later. Amplitude's
 * markers and a replay event come along, as they do in a real export.
 */
function fixture(): AmplitudeEvent[] {
  const aStart = Date.parse("2026-09-01T10:00:00.000Z");
  const bStart = Date.parse("2026-09-01T10:01:00.000Z");
  const page = (path: string, query = "") => ({
    "[Amplitude] Page Location": `https://cantina.example${path}${query}`,
    "[Amplitude] Page URL": `https://cantina.example${path}`,
    "[Amplitude] Page Path": path,
    "[Amplitude] Page Title": path === "/" ? "Home" : "Pricing",
  });
  return [
    ampEvent({ event_type: "session_start", event_time: ampTime("2026-09-01T10:00:00.000Z"), session_id: aStart }),
    ampEvent({
      event_time: ampTime("2026-09-01T10:00:00.000Z"),
      session_id: aStart,
      event_properties: { ...page("/", "?utm_source=google&utm_medium=cpc&utm_campaign=brand"), referrer: "https://www.google.com/" },
    }),
    ampEvent({ event_time: ampTime("2026-09-01T10:00:30.000Z"), session_id: aStart, event_properties: page("/pricing") }),
    ampEvent({ event_type: "CTA Clicked", event_time: ampTime("2026-09-01T10:00:40.000Z"), session_id: aStart, event_properties: { cta: "Book a demo", ...page("/pricing") } }),
    ampEvent({ event_type: "[Amplitude] Replay Captured", event_time: ampTime("2026-09-01T10:00:41.000Z"), session_id: aStart }),
    ampEvent({ event_type: "$identify", event_time: ampTime("2026-09-01T10:00:50.000Z"), session_id: aStart, user_id: "user_42", user_properties: { plan: "pro" } }),
    ampEvent({ event_type: "Signed In", event_time: ampTime("2026-09-01T10:00:51.000Z"), session_id: aStart, user_id: "user_42" }),
    ampEvent({
      device_id: "dev-b",
      event_time: ampTime("2026-09-01T10:01:00.000Z"),
      session_id: bStart,
      country: "Germany",
      city: "Berlin",
      event_properties: { ...page("/"), referrer: "https://news.ycombinator.com/item?id=1" },
    }),
    ampEvent({ device_id: "dev-b", event_type: "session_end", event_time: ampTime("2026-09-01T10:05:00.000Z"), session_id: bStart }),
  ];
}

const events = fixture();
const fetchImpl = fakeExport(events, credentials);

test("a day imports into Test, and the result says what came in and what was left out", async () => {
  const r = await importAmplitudeDay(project, { credentials, day: "2026-09-01", sourceId: "default", fetchImpl });
  assert.equal(r.fetched, 9);
  assert.equal(r.imported, 6);
  assert.equal(r.existing, 0);
  assert.equal(r.rejected, 0);
  assert.deepEqual(r.skipped, { session_start: 1, session_end: 1, "[Amplitude] Replay Captured": 1 });
  assert.match(fetchImpl.calls[0], /^https:\/\/amplitude\.com\/api\/2\/export\?start=20260901T00&end=20260901T23$/);
});

test("production never sees an imported event", async () => {
  assert.equal(await count("production", "events"), 0);
  assert.equal(await count("test", "events"), 6);
});

test("imported rows carry the columns the reports read", async () => {
  const landing = await one<Record<string, string>>(
    "test",
    `SELECT type, event, url, host, path, title, referrer_host, utm_source, utm_medium, utm_campaign, country, city, library_name, session_start, anonymous_id
     FROM events WHERE project_id = {p:String} AND type = 'page' ORDER BY timestamp LIMIT 1`,
  );
  assert.deepEqual(
    { ...landing, session_start: Number(landing.session_start) },
    {
      type: "page",
      event: "$page",
      url: "https://cantina.example/?utm_source=google&utm_medium=cpc&utm_campaign=brand",
      host: "cantina.example",
      path: "/",
      title: "Home",
      referrer_host: "www.google.com",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "brand",
      country: "US",
      city: "San Francisco",
      library_name: "amplitude-import",
      session_start: 1,
      anonymous_id: "amp:dev-a",
    },
  );
});

test("the device's anonymous history belongs to the user it signed in as", async () => {
  const rows = await getDataClient("test").query({
    query: `SELECT DISTINCT person_id FROM events_resolved WHERE project_id = {p:String} AND anonymous_id = 'amp:dev-a'`,
    query_params: { p: project.id },
    format: "JSONEachRow",
  });
  assert.deepEqual(((await rows.json()) as { person_id: string }[]).map((r) => r.person_id), ["user_42"]);
  const traits = await one<{ traits: string }>("test", `SELECT traits FROM user_traits FINAL WHERE project_id = {p:String} AND user_id = 'user_42'`);
  assert.deepEqual(JSON.parse(traits.traits), { plan: "pro" });
});

test("sessions are rebuilt from the imported events, with where each visit came from", async () => {
  const rows = await getDataClient("test").query({
    query: `SELECT session_id, pageviews, entry_path, utm_source, referrer_host, person_id
            FROM sessions_resolved WHERE project_id = {p:String} ORDER BY started_at`,
    query_params: { p: project.id },
    format: "JSONEachRow",
  });
  const sessions = (await rows.json()) as Record<string, string | number>[];
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((s) => ({ ...s, pageviews: Number(s.pageviews) })),
    [
      { session_id: `amp:dev-a:${Date.parse("2026-09-01T10:00:00.000Z")}`, pageviews: 2, entry_path: "/", utm_source: "google", referrer_host: "www.google.com", person_id: "user_42" },
      { session_id: `amp:dev-b:${Date.parse("2026-09-01T10:01:00.000Z")}`, pageviews: 1, entry_path: "/", utm_source: "", referrer_host: "news.ycombinator.com", person_id: "amp:dev-b" },
    ],
  );
});

test("importing the same day again writes nothing, so no rollup counts anything twice", async () => {
  const snapshot = async () => ({
    events: await count("test", "events"),
    userEvents: Number((await one<{ n: string }>("test", `SELECT sum(event_count) AS n FROM user_stats WHERE project_id = {p:String}`)).n),
    pageviews: Number((await one<{ n: string }>("test", `SELECT sum(pageviews) AS n FROM sessions WHERE project_id = {p:String}`)).n),
    daily: Number((await one<{ n: string }>("test", `SELECT sum(count) AS n FROM event_stats_daily WHERE project_id = {p:String}`)).n),
    touches: await count("test", "touches"),
  });
  const before = await snapshot();
  const r = await importAmplitudeDay(project, { credentials, day: "2026-09-01", sourceId: "default", fetchImpl });
  assert.equal(r.imported, 0);
  assert.equal(r.existing, 6);
  assert.deepEqual(await snapshot(), before);
});

test("a day Amplitude has nothing for imports nothing, and bad keys say so", async () => {
  const empty = await importAmplitudeDay(project, { credentials, day: "2026-09-02", sourceId: "default", fetchImpl });
  assert.deepEqual(empty, { day: "2026-09-02", fetched: 0, imported: 0, existing: 0, skipped: {}, rejected: 0 });
  await assert.rejects(
    importAmplitudeDay(project, { credentials: { ...credentials, secretKey: "wrong" }, day: "2026-09-01", sourceId: "default", fetchImpl }),
    /rejected the API key and secret key/,
  );
});

test("the importer refuses to write anywhere but Test", async () => {
  await assert.rejects(
    importAmplitudeDay(project, { credentials, day: "2026-09-01", sourceId: "default", fetchImpl, environment: "production" }),
    /only write to the test environment/,
  );
  assert.equal(await count("production", "events"), 0);
});

test("status reports what Test holds", async () => {
  const s = await importStatus(project.id);
  assert.equal(s.events, 6);
  assert.equal(s.imported, 6);
  assert.match(s.first ?? "", /^2026-09-01 10:00:00/);
});

test("emptying Test clears every table and leaves it ready for the next import", async () => {
  await assert.rejects(emptyImportEnvironment("production"), /Only the test environment/);

  const { tables } = await emptyImportEnvironment();
  assert.ok(tables.includes("events") && tables.includes("sessions") && tables.includes("user_stats"));
  assert.ok(!tables.includes("_migrations"));
  for (const t of ["events", "sessions", "user_stats", "event_stats_daily", "identities", "user_traits", "touches"]) {
    assert.equal(await count("test", t), 0, `${t} should be empty`);
  }
  assert.equal((await importStatus(project.id)).events, 0);

  // The materialised views survived the truncate, so a fresh import rebuilds the rollups.
  const r = await importAmplitudeDay(project, { credentials, day: "2026-09-01", sourceId: "default", fetchImpl });
  assert.equal(r.imported, 6);
  assert.equal(Number((await one<{ n: string }>("test", `SELECT sum(pageviews) AS n FROM sessions WHERE project_id = {p:String}`)).n), 3);
});
