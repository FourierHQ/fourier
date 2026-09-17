/**
 * Proves an arrival is counted once.
 *
 * Every message carries the page context of whatever loaded it, so a scroll or click
 * fired on a page reached from an external link looks exactly like the page view that
 * started the visit. Production showed a single visit from spearbit.com as five
 * arrivals — one per event on the page — which is what this guards.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database name,
 * and drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_touchtest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  getAdminClient,
  getDataClient,
  ingest,
  listTouches,
  migrateAll,
  scope,
  ENVIRONMENTS,
  type Project,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });

let project: Project;
const prod = () => scope(project.id, "production");

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const env of ENVIRONMENTS) {
    await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, env)}\`` });
  }
  await admin.close();
});

/** The real payload's shape: page context repeated on every message of the page load. */
const page = (url: string, referrer: string) => ({
  url,
  path: new URL(url).pathname,
  search: new URL(url).search,
  title: "Cantina",
  referrer,
});

test("one page load referred from outside is one arrival, however many events it fires", async () => {
  const anonymousId = "anon_one_arrival";
  const session = { id: "sess_1", isNew: true };
  const context = { page: page("https://www.cantina.security/web3", "https://spearbit.com/"), session };

  await ingest(project, [{ type: "page", anonymousId, context }], {}, "production");
  for (const event of ["Section Viewed", "Section Exited", "Section Exited", "Page Exited"]) {
    await ingest(
      project,
      [{ type: "track", anonymousId, event, context: { ...context, session: { ...session, isNew: false } } }],
      {},
      "production",
    );
  }

  const touches = await listTouches(prod(), { personId: anonymousId });
  assert.equal(touches.length, 1, `expected one arrival, got ${touches.length}`);
  assert.equal(touches[0].kind, "referral");
  assert.equal(touches[0].referrer_host, "spearbit.com");
  assert.equal(touches[0].landing_path, "/web3");
});

test("a campaign arriving mid-session is still its own arrival", async () => {
  const anonymousId = "anon_two_arrivals";
  const session = { id: "sess_2", isNew: true };
  const first = { page: page("https://www.cantina.security/", "https://spearbit.com/"), session };
  const second = {
    page: page("https://www.cantina.security/pricing?utm_source=newsletter", "https://mail.example.com/"),
    session: { ...session, isNew: false },
    campaign: { source: "newsletter", medium: "email", name: "launch" },
  };

  await ingest(project, [{ type: "page", anonymousId, context: first }], {}, "production");
  await ingest(project, [{ type: "track", anonymousId, event: "Section Viewed", context: first }], {}, "production");
  await ingest(project, [{ type: "page", anonymousId, context: second }], {}, "production");

  const touches = await listTouches(prod(), { personId: anonymousId });
  assert.equal(touches.length, 2, `expected both arrivals, got ${touches.length}`);
  assert.deepEqual(
    touches.map((t) => t.kind),
    ["campaign", "referral"],
    "newest first: the campaign, then the referral that opened the session",
  );
  assert.equal(touches[0].utm_source, "newsletter");
});

test("arrivals already recorded as one row per event still read as one", async () => {
  // What the materialised view used to write, and what is still in every existing install:
  // five rows for one visit, differing only in message id, time and the event that made them.
  const rows = ["m1", "m2", "m3", "m4", "m5"].map((message_id, i) => ({
    project_id: project.id,
    source_id: "default",
    message_id,
    distinct_id: "anon_legacy",
    anonymous_id: "anon_legacy",
    user_id: "",
    group_id: "",
    session_id: "sess_legacy",
    timestamp: `2026-09-17 13:50:0${i}.000`,
    kind: "referral",
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    utm_content: "",
    utm_term: "",
    referrer: "https://spearbit.com/",
    referrer_host: "spearbit.com",
    landing_url: "https://www.cantina.security/web3",
    landing_path: "/web3",
    country: "GB",
    region: "England",
    city: "Kingston upon Thames",
  }));
  await getDataClient("production").insert({
    table: "touches",
    values: rows,
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });

  const touches = await listTouches(prod(), { personId: "anon_legacy" });
  assert.equal(touches.length, 1, `expected the five rows to read as one arrival, got ${touches.length}`);
  assert.equal(touches[0].message_id, "m1", "the earliest row is the arrival");
});

test("two sessions from the same place are two arrivals", async () => {
  const anonymousId = "anon_returning";
  const context = (id: string) => ({
    page: page("https://www.cantina.security/web3", "https://spearbit.com/"),
    session: { id, isNew: true },
  });
  await ingest(project, [{ type: "page", anonymousId, context: context("sess_a") }], {}, "production");
  await ingest(project, [{ type: "page", anonymousId, context: context("sess_b") }], {}, "production");

  const touches = await listTouches(prod(), { personId: anonymousId });
  assert.equal(touches.length, 2, `expected one arrival per session, got ${touches.length}`);
});

test("the repeated events of one page load are not even written as touches", async () => {
  const anonymousId = "anon_row_count";
  const context = {
    page: page("https://www.cantina.security/web3", "https://spearbit.com/"),
    session: { id: "sess_rows", isNew: true },
  };
  await ingest(project, [{ type: "page", anonymousId, context }], {}, "production");
  for (const event of ["Section Viewed", "Page Exited"]) {
    await ingest(
      project,
      [{ type: "track", anonymousId, event, context: { ...context, session: { id: "sess_rows", isNew: false } } }],
      {},
      "production",
    );
  }

  // Read the table, not listTouches: the dedupe would hide a view that still writes a row per
  // event, and the cost of those rows — storage, and every scan over them — is the point.
  const res = await getDataClient("production").query({
    query: `SELECT count() AS n FROM touches WHERE project_id = {p:String} AND distinct_id = {d:String}`,
    query_params: { p: project.id, d: anonymousId },
    format: "JSONEachRow",
  });
  const n = Number(((await res.json()) as { n: string }[])[0]?.n ?? 0);
  assert.equal(n, 1, `expected the view to write one row for the page load, got ${n}`);
});

test("a server-side track naming its own campaign is still an arrival", async () => {
  const anonymousId = "anon_server_side";
  // No session and no page: what @fourierhq/sdk/server sends from an API route or a cron job.
  await ingest(
    project,
    [{ type: "track", anonymousId, event: "Trial Started", context: { campaign: { source: "webinar", medium: "email", name: "q3" } } }],
    {},
    "production",
  );

  const touches = await listTouches(prod(), { personId: anonymousId });
  assert.equal(touches.length, 1, "a campaign named server-side must still count as an arrival");
  assert.equal(touches[0].kind, "campaign");
  assert.equal(touches[0].utm_source, "webinar");
});

test("sessionless arrivals do not collapse into each other", async () => {
  const anonymousId = "anon_no_session";
  const campaign = { source: "webinar", medium: "email", name: "q3" };
  for (const event of ["Trial Started", "Trial Started"]) {
    await ingest(project, [{ type: "track", anonymousId, event, context: { campaign } }], {}, "production");
  }

  // Same person, same campaign, no session id to tell them apart. Keyed on session alone these
  // would read as one arrival months apart; the message_id fallback is what keeps them two.
  const touches = await listTouches(prod(), { personId: anonymousId });
  assert.equal(touches.length, 2, `expected both sessionless arrivals, got ${touches.length}`);
});
