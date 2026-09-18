/**
 * Hiding an event has to hold everywhere at once.
 *
 * The exclusion is applied two different ways — a predicate where a report reads raw
 * events, a subtraction where it reads a rollup that has already summed across event
 * names — and the failure mode of the second is silent: a total that is off by the
 * number of hidden events still looks like a plausible total. So this ingests a known
 * mixture, hides one name, and checks every surface against arithmetic done here.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database, and
 * drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_hiddentest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  PAGE_LEAVE,
  SYSTEM_HIDDEN_EVENTS,
  clearEventHidden,
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  eventTimeseries,
  getAdminClient,
  getDataClient,
  getGroup,
  getOverview,
  getUser,
  hiddenEventsFor,
  ingest,
  listEventNames,
  listEvents,
  listGroups,
  listUsers,
  migrateAll,
  allPages,
  landingPages,
  resolveRange,
  scope,
  setEventHidden,
  type Project,
  type Scope,
  type WebScope,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
let project: Project;

/** Nothing hidden at all, which is the arithmetic everything else is measured against. */
let all: Scope;
/** What the dashboard actually opens on: the system defaults applied. */
let defaults: Scope;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/**
 * One visit: two page views, a $page_leave after each, and one CTA click. The shape
 * matters — a hidden event that never travels alone is exactly the case where an
 * over-subtraction stays invisible, because the totals remain in the right order.
 */
function visit(person: { anonymousId: string; userId?: string; groupId?: string }, sessionId: string, at: Date) {
  const paths = ["/", "/pricing"];
  const ctx = (i: number, path: string) => ({
    library: { name: "fourier", version: "0.1.0" },
    userAgent: UA,
    session: { id: sessionId, isNew: i === 0 },
    page: { url: `https://example.com${path}`, path, title: path, referrer: i === 0 ? "https://www.google.com/" : "" },
    ...(person.groupId ? { groupId: person.groupId } : {}),
  });
  const messages: Record<string, unknown>[] = [];
  paths.forEach((path, i) => {
    const t = at.getTime() + i * 60_000;
    const base = { anonymousId: person.anonymousId, ...(person.userId ? { userId: person.userId } : {}) };
    messages.push({ ...base, type: "page", timestamp: new Date(t).toISOString(), properties: { path, url: `https://example.com${path}` }, context: ctx(i, path) });
    messages.push({ ...base, type: "track", event: PAGE_LEAVE, timestamp: new Date(t + 20_000).toISOString(), properties: { engaged_ms: 20_000, path }, context: ctx(i, path) });
  });
  messages.push({
    anonymousId: person.anonymousId,
    ...(person.userId ? { userId: person.userId } : {}),
    type: "track",
    event: "cta_clicked",
    timestamp: new Date(at.getTime() + 90_000).toISOString(),
    properties: { label: "Start free" },
    context: ctx(1, "/pricing"),
  });
  return messages;
}

/** Page views and CTA clicks per visit — everything that is not the hidden event. */
const VISIBLE_PER_VISIT = 3;
const LEAVES_PER_VISIT = 2;

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
  const now = new Date();

  await ingest(
    project,
    [
      // An identified person in a company, over two visits.
      ...visit({ anonymousId: "anon-a", userId: "user-a", groupId: "acme" }, "s-a1", new Date(now.getTime() - 3 * 3_600_000)),
      ...visit({ anonymousId: "anon-a", userId: "user-a", groupId: "acme" }, "s-a2", new Date(now.getTime() - 2 * 3_600_000)),
      // An anonymous person, one visit, no company.
      ...visit({ anonymousId: "anon-b" }, "s-b1", new Date(now.getTime() - 3_600_000)),
    ] as never,
    { receivedAt: now },
  );

  all = scope(project.id, "production", []);
  defaults = scope(project.id, "production", await hiddenEventsFor(project.id));
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const e of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, e)}\`` });
  await admin.close();
});

test("$page_leave is hidden out of the box, and nothing else is", async () => {
  assert.deepEqual(await hiddenEventsFor(project.id), [...SYSTEM_HIDDEN_EVENTS]);
  assert.deepEqual(defaults.hiddenEvents, [PAGE_LEAVE]);
});

test("the overview total drops by exactly the hidden events, and by nothing else", async () => {
  const before = await getOverview(all);
  const after = await getOverview(defaults);

  // 3 visits x 2 page views + 3 x 2 leaves + 3 clicks, plus the identify each
  // identified message carries. Rather than restate ingest's rules, assert the
  // difference, which is the only thing hiding is allowed to change.
  assert.equal(after.total_events, before.total_events - 3 * LEAVES_PER_VISIT);
  assert.equal(after.total_users, before.total_users);
  assert.equal(after.identified_users, before.identified_users);
  assert.equal(after.total_groups, before.total_groups);
  assert.equal(after.events_24h, before.events_24h - 3 * LEAVES_PER_VISIT);
  assert.equal(after.users_24h, before.users_24h);
  assert.ok(after.total_events > 0);
});

test("the last event is a visible one, not the instrumentation that followed it", async () => {
  // Every visit ends with a CTA click at +90s and a leave at +80s, so the two scopes
  // must disagree only when the hidden event really is the most recent thing.
  const late = new Date(Date.now() + 3_600_000);
  await ingest(project, [{ type: "track", event: PAGE_LEAVE, anonymousId: "anon-b", timestamp: late.toISOString(), properties: { engaged_ms: 1_000 } }] as never, { receivedAt: new Date() });

  const before = await getOverview(all);
  const after = await getOverview(defaults);
  assert.equal(new Date(before.last_event_at!).getTime(), late.getTime());
  assert.ok(new Date(after.last_event_at!).getTime() < late.getTime());
  assert.ok(after.first_event_at);
});

test("the event list, the name ranking and the chart all leave it out", async () => {
  const names = await listEventNames(defaults);
  assert.ok(!names.some((n) => n.event === PAGE_LEAVE), "hidden event still ranked");
  assert.ok(names.some((n) => n.event === "cta_clicked"), "visible event missing");

  // The settings screen is the one caller that still gets to see it.
  const withHidden = await listEventNames(defaults, { includeHidden: true });
  assert.ok(withHidden.some((n) => n.event === PAGE_LEAVE));

  const feed = await listEvents(defaults, { limit: 500 });
  assert.ok(!feed.some((e) => e.event === PAGE_LEAVE), "hidden event still in the feed");

  // Asking for it by name — a stale deep link — answers nothing rather than answering
  // with rows no total on the page would agree with.
  assert.equal((await listEvents(defaults, { event: PAGE_LEAVE, limit: 10 })).length, 0);
  assert.ok((await listEvents(all, { event: PAGE_LEAVE, limit: 10 })).length > 0);

  const sum = (rows: { count: number }[]) => rows.reduce((a, r) => a + r.count, 0);
  const before = sum(await eventTimeseries(all, { interval: "hour" }));
  const after = sum(await eventTimeseries(defaults, { interval: "hour" }));
  assert.equal(after, before - 3 * LEAVES_PER_VISIT - 1);
});

test("a person's event count comes down, and so does each of their sources", async () => {
  const listed = await listUsers(defaults, { limit: 50 });
  const raw = await listUsers(all, { limit: 50 });
  assert.equal(listed.length, raw.length, "hiding an event must not remove a person");

  const person = listed.find((u) => u.distinct_id === "user-a")!;
  const rawPerson = raw.find((u) => u.distinct_id === "user-a")!;
  assert.equal(person.event_count, rawPerson.event_count - 2 * LEAVES_PER_VISIT);

  const detail = (await getUser(defaults, "user-a"))!;
  assert.equal(detail.event_count, person.event_count);
  assert.equal(
    detail.sources.reduce((a, s) => a + s.event_count, 0),
    detail.event_count,
    "per-source counts must still add up to the total",
  );
  assert.ok(!detail.top_events.some((e) => e.event === PAGE_LEAVE));

  // Reaching a person through the anonymous id they used before signing in has to give
  // the same corrected number, or the subtraction would be attached to half of them.
  assert.equal((await getUser(defaults, "anon-a"))!.event_count, detail.event_count);
});

test("a company's event count comes down, and its members' with it", async () => {
  const [company] = await listGroups(defaults, { limit: 10 });
  const [rawCompany] = await listGroups(all, { limit: 10 });
  assert.equal(company.group_id, "acme");
  assert.equal(company.event_count, rawCompany.event_count - 2 * LEAVES_PER_VISIT);

  const detail = (await getGroup(defaults, "acme"))!;
  assert.equal(detail.event_count, company.event_count);
  assert.ok(!detail.top_events.some((e) => e.event === PAGE_LEAVE));
  const member = detail.members.find((m) => m.distinct_id === "user-a")!;
  assert.equal(member.event_count, (await getUser(defaults, "user-a"))!.event_count);
});

test("hiding is a decision you can take back", async () => {
  await setEventHidden(project.id, "cta_clicked", true);
  let hidden = await hiddenEventsFor(project.id);
  assert.deepEqual(hidden, [PAGE_LEAVE, "cta_clicked"].sort());

  const narrowed = scope(project.id, "production", hidden);
  const both = await getOverview(narrowed);
  assert.equal(both.total_events, (await getOverview(all)).total_events - 3 * LEAVES_PER_VISIT - 1 - 3);

  // Showing the system event again is stored, because the default would otherwise
  // reinstate it on the next read.
  await setEventHidden(project.id, PAGE_LEAVE, false);
  assert.deepEqual(await hiddenEventsFor(project.id), ["cta_clicked"]);

  await clearEventHidden(project.id, "cta_clicked");
  await clearEventHidden(project.id, PAGE_LEAVE);
  assert.deepEqual(await hiddenEventsFor(project.id), [...SYSTEM_HIDDEN_EVENTS]);

  // And the history is all still there, because nothing was ever deleted.
  assert.deepEqual((await getOverview(all)).total_events, (await getOverview(scope(project.id, "production", []))).total_events);
});

test("ordering by event count sorts on the corrected number", async () => {
  // Someone who does almost nothing but fire the hidden event. By raw counts they are
  // the busiest person here; by the counts anyone is shown, they are the quietest. If
  // the subtraction happened after the sort rather than inside it, page one of Users
  // would be a ranking of whoever emitted the most instrumentation.
  const now = new Date();
  const noisy = Array.from({ length: 40 }, (_, i) => ({
    type: "track",
    event: PAGE_LEAVE,
    anonymousId: "anon-noisy",
    timestamp: new Date(now.getTime() - i * 1_000).toISOString(),
    properties: { engaged_ms: 1_000 },
  }));
  await ingest(project, [...noisy, { type: "track", event: "cta_clicked", anonymousId: "anon-noisy", timestamp: now.toISOString() }] as never, { receivedAt: now });

  const rawByCount = await listUsers(all, { limit: 50, orderBy: "event_count" });
  assert.equal(rawByCount[0].distinct_id, "anon-noisy", "fixture no longer inverts the order");

  const byCount = await listUsers(defaults, { limit: 50, orderBy: "event_count" });
  assert.equal(byCount[0].distinct_id, "user-a");
  assert.equal(byCount.at(-1)!.distinct_id, "anon-noisy");
  assert.equal(byCount.find((u) => u.distinct_id === "anon-noisy")!.event_count, 1);
});

test("hiding a system event changes what is shown, never what is measured", async () => {
  // The whole point of $page_leave is the foreground time it carries, and that is read
  // two ways the hidden set deliberately does not reach: summed into engaged_ms by the
  // sessions rollup at write time, and read off the raw rows by the per-page report.
  //
  // So engagement has to come out identical whether or not the event is shown. It is
  // one `excludeHidden` away from silently becoming zero — added by someone tidying up
  // web-analytics.ts to match queries.ts — and the failure would look like a product
  // nobody engages with rather than like a bug.
  const web = (hiddenEvents: readonly string[]): WebScope => ({
    scope: scope(project.id, "production", hiddenEvents),
    range: resolveRange({ preset: "30d", now: new Date() }),
    filters: {},
    goal: null,
    goals: [],
    pageGroups: [],
  });

  const [shownPages, hiddenPages] = await Promise.all([allPages(web([])), allPages(web([PAGE_LEAVE]))]);
  const measured = shownPages.filter((p) => p.measured_views > 0);
  assert.ok(measured.length > 0, "fixture measured no engagement at all");
  assert.deepEqual(
    hiddenPages.map((p) => [p.path, p.avg_engagement_ms, p.measured_views]),
    shownPages.map((p) => [p.path, p.avg_engagement_ms, p.measured_views]),
    "hiding $page_leave changed measured engagement time",
  );

  // And the session-level judgement built on it — engaged_ms feeds engaged_base, which
  // is what an engagement rate counts.
  const [shownLanding, hiddenLanding] = await Promise.all([landingPages(web([])), landingPages(web([PAGE_LEAVE]))]);
  assert.deepEqual(
    hiddenLanding.map((p) => [p.path, p.engagement_rate.rate, p.engagement_rate.numerator]),
    shownLanding.map((p) => [p.path, p.engagement_rate.rate, p.engagement_rate.numerator]),
    "hiding $page_leave changed the engagement rate",
  );
  assert.ok(shownLanding.some((p) => (p.engagement_rate.numerator ?? 0) > 0), "fixture had no engaged sessions");
});

test("the per-event rollup agrees with the events it was built from", async () => {
  // The subtraction is only ever as right as this table. If the materialised view and
  // the raw rows disagree, every corrected count above is wrong by the same amount and
  // still looks reasonable.
  const client = getDataClient("production");
  const res = await client.query({
    query: `SELECT
              (SELECT sum(count) FROM actor_event_stats WHERE project_id = {p:String}) AS rollup,
              (SELECT count() FROM events WHERE project_id = {p:String}) AS raw`,
    query_params: { p: project.id },
    format: "JSONEachRow",
  });
  const [row] = (await res.json()) as { rollup: string; raw: string }[];
  assert.equal(Number(row.rollup), Number(row.raw));
});
