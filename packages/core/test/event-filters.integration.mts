/**
 * Filtering the events feed by property, and counting what the filter leaves.
 *
 * The question this exists to answer is the one a form campaign raises: "the form says
 * 127 submissions, the analytics says 80 — is it the same people submitting twice?" So
 * the fixture is that shape: one visitor who submits three times in one visit, others
 * who submit once, a second form sharing the event name, and a hidden event carrying
 * the same property. The feed, its totals and its chart have to agree on every filter,
 * and the totals have to keep submissions, visits and people apart.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database, and
 * drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_filtertest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  eventTimeseries,
  eventTotals,
  getAdminClient,
  ingest,
  listEvents,
  migrateAll,
  propertyKeys,
  propertyValues,
  scope,
  type Project,
  type PropertyFilter,
  type Scope,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
let project: Project;
let visible: Scope;

const HIDDEN = "Form Instrumented";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function submit(anonymousId: string, sessionId: string, at: number, properties: Record<string, unknown>, event = "Form Submitted") {
  return {
    type: "track",
    event,
    anonymousId,
    timestamp: new Date(at).toISOString(),
    properties,
    context: { userAgent: UA, session: { id: sessionId, isNew: false }, page: { path: "/free-scan", url: "https://example.com/free-scan" } },
  };
}

const hero = { form_name: "free-scan-hero", form_id: "free-scan", attempt: 1, consented: true };
const footer = { form_name: "free-scan-footer", form_id: "free-scan" };

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
  const t = Date.now() - 3_600_000;
  await ingest(
    project,
    [
      // One visitor, one visit, three submissions of the hero form: reload, submit again.
      submit("anon-a", "s-a", t, hero),
      submit("anon-a", "s-a", t + 20_000, { ...hero, attempt: 2 }),
      submit("anon-a", "s-a", t + 40_000, { ...hero, attempt: 3 }),
      // Two more visitors, once each.
      submit("anon-b", "s-b", t + 60_000, hero),
      submit("anon-c", "s-c", t + 80_000, hero),
      // The same visitor as above, on another visit, through the footer form.
      submit("anon-c", "s-c2", t + 100_000, footer),
      // A form that sends no name at all.
      submit("anon-d", "s-d", t + 120_000, { form_id: "contact" }),
      // Instrumentation that carries the same property, and is hidden.
      submit("anon-e", "s-e", t + 140_000, hero, HIDDEN),
      // A server-side message: a person, but no visit.
      { type: "track", event: "Form Submitted", userId: "server-user", timestamp: new Date(t + 160_000).toISOString(), properties: hero },
    ] as never,
    { receivedAt: new Date() },
  );
  visible = scope(project.id, "production", [HIDDEN]);
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const e of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, e)}\`` });
  await admin.close();
});

const heroOnly: PropertyFilter[] = [{ key: "form_name", op: "eq", value: "free-scan-hero" }];

/** The feed, its totals and its chart for one filter, so every test can hold them to each other. */
async function read(properties: PropertyFilter[] | undefined, event = "Form Submitted") {
  const feed = await listEvents(visible, { event, properties, limit: 1000 });
  const totals = await eventTotals(visible, { event, properties });
  const chart = (await eventTimeseries(visible, { event, properties, interval: "hour" })).reduce((a, p) => a + p.count, 0);
  return { feed, totals, chart };
}

test("repeat submissions are events, not people: 3 + 1 + 1 + server = 6 events, 3 visits, 4 people", async () => {
  const { feed, totals, chart } = await read(heroOnly);
  assert.equal(feed.length, 6);
  assert.ok(feed.every((e) => e.properties.form_name === "free-scan-hero"));
  assert.deepEqual(totals, { events: 6, sessions: 3, people: 4 });
  assert.equal(chart, totals.events, "the chart counts what the feed lists");
});

test("the hidden event carrying the same property adds nothing anywhere", async () => {
  // And asking for it by name is a stale link, not a way back in.
  const { feed, totals, chart } = await read(heroOnly, HIDDEN);
  assert.equal(feed.length, 0);
  assert.deepEqual(totals, { events: 0, sessions: 0, people: 0 });
  assert.equal(chart, 0);
});

test("without an event name the filter spans every visible event", async () => {
  const totals = await eventTotals(visible, { properties: heroOnly });
  assert.deepEqual(totals, { events: 6, sessions: 3, people: 4 });
});

test("is not needs the property to be there; a form that sent no name is not 'not the hero'", async () => {
  const { feed, totals } = await read([{ key: "form_name", op: "neq", value: "free-scan-hero" }]);
  assert.deepEqual(
    feed.map((e) => e.properties.form_name),
    ["free-scan-footer"],
  );
  assert.deepEqual(totals, { events: 1, sessions: 1, people: 1 });
});

test("is set, contains, and several filters at once", async () => {
  assert.equal((await read([{ key: "form_name", op: "exists" }])).totals.events, 7);
  assert.equal((await read([{ key: "form_name", op: "contains", value: "free-scan" }])).totals.events, 7);
  const both = await read([
    { key: "form_id", op: "eq", value: "free-scan" },
    { key: "form_name", op: "eq", value: "free-scan-footer" },
  ]);
  assert.deepEqual(both.totals, { events: 1, sessions: 1, people: 1 });
});

test("numbers and booleans match as the text the filter picker offers", async () => {
  // propertyValues offers 2 as "2" and true as "true"; a filter built from those has to match.
  const attempts = await propertyValues(visible, "Form Submitted", "attempt");
  assert.ok(attempts.some((v) => v.value === "2"));
  assert.equal((await read([{ key: "attempt", op: "eq", value: "2" }])).feed.length, 1);
  assert.equal((await read([{ key: "consented", op: "eq", value: "true" }])).totals.events, 6);
});

test("a server-side message is a person without a visit", async () => {
  const totals = await eventTotals(visible, { properties: heroOnly, search: "server-user" });
  assert.deepEqual(totals, { events: 1, sessions: 0, people: 1 });
});

test("with no event, the property picker offers every visible event's keys and values", async () => {
  const keys = (await propertyKeys(visible)).map((k) => k.key);
  for (const k of ["form_name", "form_id", "attempt", "consented"]) assert.ok(keys.includes(k), `missing ${k}`);

  const values = await propertyValues(visible, undefined, "form_name");
  assert.deepEqual(
    values.map((v) => [v.value, v.count]),
    [
      ["free-scan-hero", 6],
      ["free-scan-footer", 1],
    ],
    "the hidden event's copy of the hero form is not counted",
  );

  // Named, a hidden event still has nothing to offer.
  assert.deepEqual(await propertyKeys(visible, HIDDEN), []);
  assert.deepEqual(await propertyValues(visible, HIDDEN, "form_name"), []);
});
