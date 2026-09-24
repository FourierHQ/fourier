/**
 * Web Analytics, against a real ClickHouse.
 *
 * These are the acceptance criteria written as assertions: conversion deduplication,
 * shared metric consistency, session attribution, landing-page eligibility, funnel
 * ordering, page-group aggregation, and the difference between "nobody converted" and
 * "nothing is configured". Every one of them is a mistake that produces a plausible
 * number rather than an error, which is exactly the kind a type system cannot catch.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database name,
 * and drops everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_webtest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  classifyBrowser,
  classifyChannel,
  classifyDevice,
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  getAdminClient,
  getDataClient,
  ingest,
  migrateAll,
  resolveRange,
  scope,
  upsertDefinition,
  deleteDefinition,
  listGoals,
  listPageGroups,
  headline,
  trend,
  breakdown,
  landingPages,
  allPages,
  visitorMix,
  funnel,
  conversionCredit,
  pagesInConvertingSessions,
  conversionPages,
  goalSummary,
  supportingActions,
  availability,
  conversionTrend,
  pageDetail,
  wentOnBaseline,
  type Goal,
  type PathRule,
  type Project,
  type WebScope,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });

let project: Project;
const prod = () => scope(project.id, "production");

const UA_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const HOST = "example.com";
const DAY = 86_400_000;

/** Fixed clock so the periods under test never straddle a real midnight. */
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

interface Visit {
  anonymousId: string;
  sessionId: string;
  at: Date;
  pages: { path: string; afterMs?: number; engagedMs?: number; title?: string }[];
  tracks?: { event: string; properties?: Record<string, unknown>; afterMs?: number; path?: string }[];
  referrer?: string;
  utm?: Record<string, string>;
  userAgent?: string;
  userId?: string;
}

/** Turn a described visit into the messages a browser would actually have sent. */
function messagesFor(v: Visit) {
  const msgs: Record<string, unknown>[] = [];
  const ua = v.userAgent ?? UA_DESKTOP;
  let first = true;
  const ctx = (path: string, at: Date, title?: string) => ({
    page: { url: `https://${HOST}${path}`, path, search: "", title: title ?? path, referrer: first ? (v.referrer ?? "") : `https://${HOST}/` },
    userAgent: ua,
    session: { id: v.sessionId, isNew: first },
    ...(v.utm && first ? { campaign: v.utm } : {}),
  });
  for (const p of v.pages) {
    const at = new Date(v.at.getTime() + (p.afterMs ?? 0));
    msgs.push({ type: "page", anonymousId: v.anonymousId, userId: v.userId, timestamp: at.toISOString(), properties: { path: p.path, url: `https://${HOST}${p.path}` }, context: ctx(p.path, at, p.title) });
    first = false;
    if (p.engagedMs) {
      const leaveAt = new Date(at.getTime() + p.engagedMs);
      msgs.push({
        type: "track",
        event: "$page_leave",
        anonymousId: v.anonymousId,
        userId: v.userId,
        timestamp: leaveAt.toISOString(),
        properties: { engaged_ms: p.engagedMs, path: p.path },
        context: { ...ctx(p.path, leaveAt), session: { id: v.sessionId, isNew: false } },
      });
    }
  }
  for (const t of v.tracks ?? []) {
    const at = new Date(v.at.getTime() + (t.afterMs ?? 0));
    const path = t.path ?? v.pages[v.pages.length - 1]?.path ?? "/";
    msgs.push({
      type: "track",
      event: t.event,
      anonymousId: v.anonymousId,
      userId: v.userId,
      timestamp: at.toISOString(),
      properties: { ...(t.properties ?? {}), path },
      context: { ...ctx(path, at), session: { id: v.sessionId, isNew: false } },
    });
  }
  return msgs;
}

async function send(visits: Visit[]) {
  const msgs = visits.flatMap(messagesFor);
  // Sent in one batch with an explicit receivedAt so the clock-skew correction in
  // normalize() does not shift the timestamps these assertions depend on.
  await ingest(project, msgs as never, { receivedAt: NOW, userAgent: UA_DESKTOP }, "production");
  await getDataClient("production").command({ query: `OPTIMIZE TABLE sessions FINAL` });
}

let SIGNUP: Goal;
let DEMO: Goal;
let CTA: Goal;

async function web(overrides: Partial<WebScope> = {}): Promise<WebScope> {
  const goals = await listGoals(project.id);
  const pageGroups = await listPageGroups(project.id);
  return {
    scope: prod(),
    range: resolveRange({ preset: "7d", now: NOW }),
    filters: {},
    goal: goals.find((g) => g.id === SIGNUP?.id) ?? null,
    goals,
    pageGroups,
    ...overrides,
  };
}

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();

  SIGNUP = (await upsertDefinition(project.id, "goal", {
    name: "Signup completed",
    is_default: true,
    config: { type: "primary", match: "event", event: "Signup Completed" },
  })) as Goal;
  DEMO = (await upsertDefinition(project.id, "goal", {
    name: "Demo booked",
    config: {
      type: "primary",
      match: "event",
      event: "Demo Booked",
      funnel: [
        { name: "Demo page viewed", match: { match: "pageview", path: { op: "exact", value: "/demo" } } },
        { name: "Form started", match: { match: "event", event: "Form Started" } },
        { name: "Booking confirmed", match: { match: "event", event: "Demo Booked" } },
      ],
    },
  })) as Goal;
  CTA = (await upsertDefinition(project.id, "goal", {
    name: "CTA clicked",
    config: { type: "supporting", match: "event", event: "CTA Clicked" },
  })) as Goal;

  await upsertDefinition(project.id, "page_group", { name: "Blog", position: 0, config: { rules: [{ op: "prefix", value: "/blog" }] } });
  await upsertDefinition(project.id, "page_group", { name: "Product", position: 1, config: { rules: [{ op: "prefix", value: "/product" }, { op: "exact", value: "/pricing" }] } });

  await send([
    // A visit that completes the signup goal THREE times. One converting session.
    {
      anonymousId: "a1",
      sessionId: "s1",
      at: ago(2 * DAY),
      referrer: "https://www.google.com/",
      pages: [{ path: "/", engagedMs: 15_000 }, { path: "/pricing", afterMs: 20_000 }],
      tracks: [
        { event: "Signup Completed", afterMs: 30_000 },
        { event: "Signup Completed", afterMs: 40_000 },
        { event: "Signup Completed", afterMs: 50_000 },
      ],
    },
    // Paid social, lands on /blog/post-a, does not convert, single page, 3s — not engaged.
    {
      anonymousId: "a2",
      sessionId: "s2",
      at: ago(2 * DAY),
      referrer: "https://www.linkedin.com/feed/",
      utm: { source: "linkedin", medium: "paid_social", name: "september-launch" },
      pages: [{ path: "/blog/post-a", engagedMs: 3_000 }],
    },
    // Direct, two pages -> engaged by pageview count, no goal.
    { anonymousId: "a3", sessionId: "s3", at: ago(DAY), pages: [{ path: "/" }, { path: "/product/api", afterMs: 5_000 }] },
    // The full demo funnel, in order.
    {
      anonymousId: "a4",
      sessionId: "s4",
      at: ago(DAY),
      pages: [{ path: "/demo" }],
      tracks: [
        { event: "CTA Clicked", afterMs: 1_000 },
        { event: "Form Started", afterMs: 2_000 },
        { event: "Demo Booked", afterMs: 3_000 },
      ],
    },
    // Reaches the demo goal WITHOUT the funnel path — booked from a different page.
    { anonymousId: "a5", sessionId: "s5", at: ago(DAY), pages: [{ path: "/pricing" }], tracks: [{ event: "Demo Booked", afterMs: 1_000 }] },
    // Out-of-order: form started BEFORE the demo page was seen. Must not reach step 2.
    {
      anonymousId: "a6",
      sessionId: "s6",
      at: ago(DAY),
      pages: [{ path: "/demo", afterMs: 5_000 }],
      tracks: [{ event: "Form Started", afterMs: 1_000, path: "/" }],
    },
    // A bot. Must be absent from every count.
    { anonymousId: "bot1", sessionId: "sbot", at: ago(DAY), userAgent: UA_BOT, pages: [{ path: "/" }, { path: "/pricing", afterMs: 1_000 }] },
    // Mobile, trailing-slash variant of a page seen elsewhere without one.
    { anonymousId: "a7", sessionId: "s7", at: ago(DAY), userAgent: UA_MOBILE, pages: [{ path: "/pricing/" }] },
    // A returning visitor: first seen well before the 7-day window, active inside it.
    { anonymousId: "old1", sessionId: "s-old", at: ago(40 * DAY), pages: [{ path: "/" }] },
    { anonymousId: "old1", sessionId: "s-new", at: ago(DAY), pages: [{ path: "/" }] },
  ]);
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const e of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, e)}\`` });
  await admin.close();
});

test("a session that completes the goal three times converts once", async () => {
  const w = await web();
  const h = await headline(w);
  assert.equal(h.converting_sessions.current, 1, "three Signup Completed events in one visit is one converting session");
  assert.equal(h.goal_name, "Signup completed");
  // The rate's numerator and denominator must be the same numbers shown elsewhere.
  assert.equal(h.conversion_rate.numerator, 1);
  assert.equal(h.conversion_rate.denominator, h.sessions.current);
});

test("bots are excluded everywhere, and included only when asked", async () => {
  const clean = await headline(await web());
  const dirty = await headline(await web({ filters: { includeBots: true } }));
  assert.equal(dirty.sessions.current - clean.sessions.current, 1, "exactly the one bot visit");
  const paths = (await allPages(await web())).map((p) => p.path);
  assert.ok(paths.length > 0);
});

test("channel comes from the session's entry, and the SQL agrees with the TypeScript", async () => {
  const rows = await breakdown(await web(), "channel", { limit: 20 });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.sessions.current]));
  assert.equal(byKey["Paid Social"], 1, "utm_medium=paid_social from linkedin");
  assert.equal(byKey["Organic Search"], 1, "referrer google.com, no campaign");
  assert.ok((byKey["Direct"] ?? 0) >= 3, "no referrer, no campaign");

  // The same inputs through the TypeScript classifier must give the same answers.
  assert.equal(classifyChannel({ pageviews: 1, utm_source: "linkedin", utm_medium: "paid_social", referrer_host: "www.linkedin.com", entry_host: HOST }), "Paid Social");
  assert.equal(classifyChannel({ pageviews: 1, referrer_host: "www.google.com", entry_host: HOST }), "Organic Search");
  assert.equal(classifyChannel({ pageviews: 1, entry_host: HOST }), "Direct");
  assert.equal(classifyChannel({ pageviews: 0, entry_host: HOST }), "Unattributed", "no page view is unattributed, not direct");
});

test("landing sessions count the page a visit started on, not every page it saw", async () => {
  const rows = await landingPages(await web(), { limit: 50 });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  // /pricing was VIEWED in s1 but that visit landed on "/". It is a landing page only
  // for the visits that actually started there.
  assert.equal(byPath["/pricing"]?.landing_sessions.current, 2, "s5 and s7 (trailing slash) — s1 viewed it but did not land on it");
  assert.equal(byPath["/"]?.landing_sessions.current, 3, "s1, s3 and the returning visitor");
  assert.ok(!("/pricing/" in byPath), "a trailing slash is the same page");

  // Landing conversion is conversion within sessions that STARTED there.
  assert.equal(byPath["/"]?.conversion_rate.numerator, 1, "only s1 signed up");
  assert.equal(byPath["/"]?.conversion_rate.denominator, 3);
});

test("all-pages counts every view of a page and carries no conversion rate", async () => {
  const rows = await allPages(await web(), { limit: 50 });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(byPath["/pricing"]?.pageviews.current, 3, "viewed in s1, s5 and s7 — including the one that did not land there");
  assert.ok(!("conversion_rate" in (byPath["/pricing"] ?? {})), "viewing a page is not evidence it caused anything");
});

test("exit rate counts the visits that ended on a page, not the visits that only saw it", async () => {
  const rows = await allPages(await web(), { limit: 50 });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

  // "/" was viewed three times and ended the visit once: s1 went on to /pricing and
  // s3 to /product/api, so only the returning visitor's single-page visit exits here.
  // Reading this as a bounce rate would say the home page fails two visitors in three.
  assert.equal(byPath["/"]?.exit_rate.numerator, 1, "only s-new stopped on the home page");
  assert.equal(byPath["/"]?.exit_rate.denominator, 3, "denominated in views of the page, not visits that landed on it");
  assert.equal(byPath["/"]?.exit_rate.rate, (1 / 3) * 100, "one view in three, divided the way `rate` divides it");

  // Every visit that saw /pricing ended there — including s1, which landed on "/",
  // read two pages and signed up. A page can be the last one seen and still be the
  // one that worked, which is exactly why this is not bounce rate.
  assert.equal(byPath["/pricing"]?.exit_rate.numerator, 3, "s1, s5 and the trailing-slash s7");
  assert.equal(byPath["/pricing"]?.exit_rate.rate, 100);
});

test("engagement is measured, not inferred, and averages only over measured views", async () => {
  const rows = await allPages(await web(), { limit: 50 });
  const home = rows.find((r) => r.path === "/");
  assert.equal(home?.measured_views, 1, "only s1's home view reported a page-leave");
  assert.equal(home?.avg_engagement_ms, 15_000, "averaged over the view that was measured, not over all three");

  const api = rows.find((r) => r.path === "/product/api");
  assert.equal(api?.measured_views, 0);
  assert.equal(api?.avg_engagement_ms, null, "unmeasured is null, never zero");
});

test("engaged sessions: two pages, or ten measured seconds, or a primary goal", async () => {
  const rows = await breakdown(await web(), "channel", { limit: 20 });
  const paidSocial = rows.find((r) => r.key === "Paid Social");
  // s2 saw one page for three seconds and completed nothing.
  assert.equal(paidSocial?.engagement_rate.numerator, 0);
  assert.equal(paidSocial?.engagement_rate.denominator, 1);

  const organic = rows.find((r) => r.key === "Organic Search");
  assert.equal(organic?.engagement_rate.numerator, 1, "s1: two pages, fifteen seconds and a signup");
});

test("changing the selected goal does not move the engagement rate", async () => {
  const onSignup = await breakdown(await web(), "channel", { limit: 20 });
  const onDemo = await breakdown(await web({ goal: DEMO }), "channel", { limit: 20 });
  const eng = (rows: typeof onSignup) => rows.map((r) => `${r.key}:${r.engagement_rate.numerator}/${r.engagement_rate.denominator}`).sort().join("|");
  assert.equal(eng(onSignup), eng(onDemo), "engagement reads every primary goal, never the selected one");
});

test("the same goal gives the same converting count on every report", async () => {
  const w = await web();
  const [h, summary, ch, fn] = await Promise.all([headline(w), goalSummary(w), breakdown(w, "channel", { limit: 50 }), funnel(w)]);
  const fromSummary = summary.find((g) => g.id === SIGNUP.id)?.converting_sessions.current;
  const fromChannels = ch.reduce((n, r) => n + r.converting_sessions, 0);
  assert.equal(h.converting_sessions.current, fromSummary, "headline and goal table agree");
  assert.equal(h.converting_sessions.current, fromChannels, "channel rows sum to the headline");
  assert.equal(h.converting_sessions.current, fn.steps[1]?.sessions, "the default funnel's last step is the conversion count");
});

test("funnel steps are ordered, deduplicated, and honest about other routes", async () => {
  const f = await funnel(await web({ goal: DEMO }));
  assert.equal(f.is_path_specific, true);
  assert.deepEqual(f.steps.map((s) => s.sessions), [2, 1, 1], "s4 and s6 saw /demo; only s4 started the form after seeing it");
  assert.equal(f.total_conversions, 2, "s4 and s5 both booked");
  assert.ok(f.total_conversions > f.steps[2].sessions, "one booking arrived by another route, and the funnel says so");
  assert.equal(f.steps[1].dropped, 1);
});

test("credit splits one total rather than comparing two", async () => {
  const w = await web({ goal: null });
  const credit = await conversionCredit(w);
  const h = await headline(w);

  // Every conversion is credited to exactly one channel, and within that channel falls
  // into exactly one of the two segments. This used to be two parallel columns and was
  // read twice as though one were a subset of the other; it is now a total and its
  // parts, and that relationship has to actually hold or the bar lies about itself.
  assert.equal(
    credit.rows.reduce((n, r) => n + r.conversions, 0),
    h.converting_sessions.current,
    "every conversion is credited to one channel",
  );
  for (const r of credit.rows) {
    assert.equal(r.first_visit + r.returned, r.conversions, `${r.channel}: the segments are the total`);
  }
  assert.equal(credit.total, h.converting_sessions.current);
  assert.equal(credit.rows.reduce((n, r) => n + r.returned, 0), credit.returned);

  // Nobody in the fixtures has a touch before the visit they converted in, so all of it
  // is first-visit. The returning half is exercised by the seeded demo data, which has
  // people arriving weeks before they convert.
  assert.equal(credit.returned, 0, "these fixtures convert on first contact");

  assert.deepEqual(await conversionCredit(await web({ goal: null, goals: [] })), { rows: [], total: 0, returned: 0 });
});

test("a page is credited for conversions on it and for conversions it led to, separately", async () => {
  const w = await web({ goal: null });
  const { rows, total, on_arrival } = await conversionPages(w, { limit: 100 });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

  // s1 read "/" and then signed up on /pricing. /pricing is where it happened; "/" is
  // what led to it. s5 arrived on /pricing and converted there without going anywhere,
  // so /pricing is credited again under converted_on and nothing is led_to.
  assert.equal(byPath["/pricing"].converted_on, 2, "a page keeps credit for conversions that happen on it");
  assert.equal(byPath["/pricing"].led_to, 0);
  assert.equal(byPath["/"].led_to, 1, "and the page before gets its own, separate credit");
  assert.equal(byPath["/"].converted_on, 0);

  // The case that made one column wrong: /pricing both hosts conversions and is read on
  // the way to others. Excluding the conversion page would have thrown the first away.
  assert.ok(byPath["/pricing"].converted_on > 0 && byPath["/demo"].converted_on > 0, "both conversion pages are present");

  // Neither column may count a conversion twice, and between them they must lose none.
  assert.equal(rows.reduce((n, r) => n + r.converted_on, 0), total, "every conversion happened on exactly one page");
  assert.equal(
    rows.reduce((n, r) => n + r.led_to, 0),
    total - on_arrival,
    "and every one that had an earlier page is credited to exactly one",
  );
  assert.equal(on_arrival, 2, "s4 and s5 converted on the page they arrived on");
  assert.equal(total, (await headline(w)).converting_sessions.current);

  assert.deepEqual(await conversionPages(await web({ goal: null, goals: [] })), { rows: [], total: 0, on_arrival: 0 });
});

test("pages in converting visits are shown against how often every visit sees them", async () => {
  const w = await web({ goal: null });
  const rows = await pagesInConvertingSessions(w, { limit: 20 });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

  // /demo is on the path of both demo bookings and is otherwise rarely visited, so it
  // should be over-represented. The home page is seen by nearly everyone and should not
  // look impressive just because it is everywhere.
  assert.ok(byPath["/demo"], "a page the converting visits went through");
  assert.ok(byPath["/demo"].lift !== null && byPath["/demo"].lift > 1, "over-represented in converting visits");

  for (const r of rows) {
    // A page cannot appear in more converting visits than visits.
    assert.ok(r.converting_sessions <= r.sessions, `${r.path}: converting ${r.converting_sessions} <= sessions ${r.sessions}`);
    assert.ok(r.converting_sessions > 0, "rows with no conversions are not worth a line");
  }

  assert.deepEqual(await pagesInConvertingSessions(await web({ goal: null, goals: [] })), [], "no goal means nothing to rank");
});

test("supporting actions are reported separately and never added to conversions", async () => {
  const w = await web();
  const actions = await supportingActions(w);
  const cta = actions.find((a) => a.id === CTA.id);
  assert.equal(cta?.sessions.current, 1);
  const summary = await goalSummary(w);
  assert.ok(!summary.some((g) => g.id === CTA.id), "a supporting action is not a goal in the summary table");
});

test("page groups aggregate from sessions, not by summing page rows", async () => {
  const w = await web();
  const grouped = await landingPages(w, { groupBy: "group", limit: 50 });
  const byKey = Object.fromEntries(grouped.map((r) => [r.path, r]));
  assert.equal(byKey["Blog"]?.landing_sessions.current, 1, "/blog/post-a");
  assert.equal(byKey["Product"]?.landing_sessions.current, 2, "the two /pricing arrivals; nothing landed under /product");
  assert.ok(byKey["Ungrouped"], "pages matching no rule are named, not dropped");

  // A visitor who saw two pages in the same group is one visitor for the group, not two.
  const pages = await allPages(w, { groupBy: "group", limit: 50 });
  const product = pages.find((p) => p.path === "Product");
  assert.equal(product?.unique_viewers.current, 4, "a1 and a5 and a7 on /pricing, a3 on /product/api — counted once each");

  // Exits are grouped by where the visit stopped, through the same rules as the pages
  // themselves: s1, s3, s5 and s7 all ended somewhere inside Product.
  assert.equal(product?.exit_rate.numerator, 4);
  assert.equal(product?.exit_rate.denominator, 4, "the three /pricing views and the one /product/api view");
});

test("with no goal named, conversions are every primary goal, counted once", async () => {
  // A third primary goal that fires in a session another goal already claims: s4 both
  // clicked the CTA and booked the demo. Without it the fixtures could not tell a
  // distinct-session count from a sum, because no visit completes two goals.
  await upsertDefinition(project.id, "goal", {
    id: "also-primary",
    name: "CTA clicked (primary)",
    config: { type: "primary", match: "event", event: "CTA Clicked" },
  });

  const all = await web({ goal: null });
  const h = await headline(all);
  assert.equal(h.goal_name, "All conversions", "the cards say what they are counting");

  // s1 signed up, s4 booked and clicked, s5 booked. Three visits did something.
  assert.equal(h.converting_sessions.current, 3);

  // Summing the goals would say four, because s4 would be counted by two of them. That
  // is the number a naive total produces and it exceeds the visits it came from.
  const summed = (await goalSummary(all)).reduce((n, g) => n + g.converting_sessions.current, 0);
  assert.equal(summed, 4, "the per-goal rows do add to more than the distinct total");
  assert.ok(h.converting_sessions.current < summed, "so the headline must not be their sum");

  // The rate is against the same sessions as every other rate on the page.
  assert.equal(h.conversion_rate.numerator, 3);
  assert.equal(h.conversion_rate.denominator, h.sessions.current);

  // Narrowing to one goal counts only that goal, against the same denominator.
  const narrowed = await headline(await web({ goal: DEMO }));
  assert.equal(narrowed.goal_name, "Demo booked");
  assert.equal(narrowed.converting_sessions.current, 2);
  assert.equal(narrowed.sessions.current, h.sessions.current, "narrowing the goal must not narrow the visits");

  // A funnel cannot be drawn to whichever of three things happened, so with no goal
  // named it falls back to the honest two steps rather than a configured path.
  const f = await funnel(all);
  assert.equal(f.is_path_specific, false);
  assert.deepEqual(f.steps.map((x) => x.name), ["Website session", "Any conversion"]);
  assert.equal(f.steps[1].sessions, 3);

  await deleteDefinition(project.id, "goal", "also-primary");
});

test("page groups overlap deterministically: the first matching rule wins", async () => {
  // Two groups that both claim /demo, and which no other configured group touches. The
  // one that gets it must be decided by the operator's stated order and nothing else —
  // not by insertion order, not by however the rows happen to arrive.
  const rules = { narrow: { op: "contains" as const, value: "demo" }, broad: { op: "prefix" as const, value: "/demo" } };
  const put = (id: string, name: string, position: number, rule: PathRule) =>
    upsertDefinition(project.id, "page_group", { id, name, position, config: { rules: [rule] } });

  await put("overlap-a", "Demo by name", 100, rules.narrow);
  await put("overlap-b", "Demo section", 101, rules.broad);

  const grouped = async () => {
    const rows = await landingPages(await web(), { groupBy: "group", limit: 50 });
    return Object.fromEntries(rows.map((r) => [r.path, r.landing_sessions.current]));
  };

  let byKey = await grouped();
  assert.equal(byKey["Demo by name"], 2, "the earlier group claims the overlapping page");
  assert.ok(!byKey["Demo section"], "and the later one does not also count it");

  // Swap the order and the same visits move, with nothing else changed.
  await put("overlap-a", "Demo by name", 101, rules.narrow);
  await put("overlap-b", "Demo section", 100, rules.broad);
  byKey = await grouped();
  assert.equal(byKey["Demo section"], 2, "order decides the answer, and it is the only thing that does");
  assert.ok(!byKey["Demo by name"], "a page belongs to one group, never to both");

  // Which is what makes the totals safe to read: every visit is counted once.
  const total = Object.values(byKey).reduce((n, v) => n + v, 0);
  const h = await headline(await web());
  assert.equal(total, h.sessions.current, "the groups partition the visits rather than overlapping them");

  await deleteDefinition(project.id, "page_group", "overlap-a");
  await deleteDefinition(project.id, "page_group", "overlap-b");
});

test("new and returning are exclusive, sum to the total, and come from full history", async () => {
  const mix = await visitorMix(await web());
  assert.equal(mix.new_visitors + mix.returning_visitors, mix.total, "the two groups partition the visitors");
  assert.equal(mix.returning_visitors, 1, "old1 was first seen 40 days ago, outside the 7-day window");
  assert.ok(mix.returning_share !== null);
  assert.equal(Math.round(mix.returning_share!), Math.round((1 / mix.total) * 100));
});

test("the new/returning filter uses the same classification as the mix", async () => {
  const mix = await visitorMix(await web());
  const returning = await headline(await web({ filters: { visitor: "returning" } }));
  const fresh = await headline(await web({ filters: { visitor: "new" } }));
  assert.equal(returning.visitors.current, mix.returning_visitors);
  assert.equal(fresh.visitors.current, mix.new_visitors);
});

test("filters narrow the report without changing what a visitor is", async () => {
  const mobile = await headline(await web({ filters: { device: "Mobile" } }));
  assert.equal(mobile.sessions.current, 1, "only s7");
  assert.equal(classifyDevice(UA_MOBILE), "Mobile");
  assert.equal(classifyDevice(UA_DESKTOP), "Desktop");
  assert.equal(classifyBrowser(UA_MOBILE), "Safari");
  assert.equal(classifyBrowser(UA_DESKTOP), "Chrome");

  const campaign = await headline(await web({ filters: { utmCampaign: "september-launch" } }));
  assert.equal(campaign.sessions.current, 1);
});

test("rates are unavailable rather than zero when nothing could have converted", async () => {
  // A window with no traffic at all.
  const empty = await web({ range: resolveRange({ preset: "custom", from: "2020-01-01", to: "2020-01-07", now: NOW }) });
  const h = await headline(empty);
  assert.equal(h.sessions.current, 0);
  assert.equal(h.conversion_rate.rate, null, "0/0 is not 0%");
  assert.equal(h.conversion_rate.denominator, 0);

  const state = await availability(empty);
  assert.equal(state.has_traffic, false);
  assert.equal(state.has_primary_goal, true, "a goal is configured — this is 'no traffic', not 'no goal'");
});

test("no goal configured is distinguishable from nobody converting", async () => {
  const w = await web({ goal: null, goals: [] });
  const state = await availability(w);
  assert.equal(state.has_traffic, true);
  assert.equal(state.has_primary_goal, false);
  assert.deepEqual(await conversionTrend(w), [], "no goal means no conversion series to draw");
  assert.deepEqual(await goalSummary(w), []);

  const configured = await availability(await web());
  assert.equal(configured.has_primary_goal, true);
  assert.equal(configured.engagement_tracked, true);
});

test("no filter matches is distinguishable from no traffic", async () => {
  // The two halves of the distinction come from different places on purpose:
  // availability answers "did this site have visits at all", ignoring the reader's
  // filters, and the report itself answers "did any of them match". Asking the second
  // question twice would mean a second full scan for something already in hand.
  const filtered = await web({ filters: { country: "ZZ" } });
  const state = await availability(filtered);
  const h = await headline(filtered);
  assert.equal(state.has_traffic, true, "the site has traffic");
  assert.equal(h.sessions.current, 0, "and this filter matches none of it");

  const empty = await web({ range: resolveRange({ preset: "custom", from: "2020-01-01", to: "2020-01-07", now: NOW }) });
  assert.equal((await availability(empty)).has_traffic, false, "an empty period is a different answer");
});

test("comparison is against the same elapsed distance, and absent when switched off", async () => {
  const off = await headline(await web({ range: resolveRange({ preset: "7d", now: NOW, compare: false }) }));
  assert.equal(off.sessions.previous, null);
  assert.equal(off.sessions.change, null);

  const on = await headline(await web());
  assert.notEqual(on.sessions.previous, null);
  // Nothing was seeded in the preceding week except the 40-day-old visit, which is
  // further back still — so the previous period is empty, and there is no percentage.
  assert.equal(on.sessions.previous, 0);
  assert.equal(on.sessions.change, null, "dividing by zero is not +∞%");
});

test("the trend keeps the two periods apart and inside the selected range", async () => {
  const w = await web();
  const series = await trend(w);
  const points = series.sessions;
  assert.ok(points.length > 0);
  // Both metrics come from one scan and must share a bucket set, or the toggle would
  // shift the chart sideways.
  assert.deepEqual(series.visitors.map((p) => p.bucket), points.map((p) => p.bucket));

  // Every bucket must fall inside the selected range. The comparison period is shifted
  // forward to line up with it, so nothing may land beyond either end — a previous-period
  // point drawn a month into the future is the signature of a WHERE that matched every
  // row instead of one period's, which is a wrong chart rather than an error.
  const from = w.range.current.from.getTime();
  const to = w.range.current.to.getTime();
  for (const p of points) {
    const t = new Date(`${p.bucket.replace(" ", "T")}Z`).getTime();
    assert.ok(t >= from - 86_400_000 && t < to, `bucket ${p.bucket} is outside ${w.range.current.from.toISOString()}..${w.range.current.to.toISOString()}`);
  }

  // The seeded visits are all inside the current period, so the two series must not
  // agree: if the period filter were ineffective both would carry the same totals.
  const current = points.reduce((n, p) => n + p.value, 0);
  const previous = points.reduce((n, p) => n + (p.previous ?? 0), 0);
  const h = await headline(w);
  assert.equal(current, h.sessions.current, "the series sums to the headline");
  assert.equal(previous, 0, "nothing was seeded in the preceding week");
});

test("page detail describes observed navigation and does not invent exits", async () => {
  const detail = await pageDetail(await web(), "/");
  assert.equal(detail.landing_sessions.current, 3);
  assert.ok(detail.sources.length > 0, "where the sessions that landed here came from");
  const next = Object.fromEntries(detail.next_pages.map((n) => [n.is_exit ? "(exit)" : n.path, n.sessions]));
  assert.equal(next["/pricing"], 1, "s1 went home -> pricing");
  assert.equal(next["/product/api"], 1, "s3 went home -> product");
  assert.equal(detail.click_rate_basis, "page_viewers", "CTA exposure is not tracked and must not be implied");
});

// ---------- went on to convert, and finding a page by name ----------
//
// Seeded in January, a window no other test reads, so these visits cannot move any
// number asserted above. Signup is the goal throughout.

const JAN = (day: number, hour = 10) => new Date(Date.UTC(2026, 0, day, hour));
const january = () => web({ range: resolveRange({ preset: "custom", from: "2026-01-10", to: "2026-01-16", now: NOW }) });

let januarySeeded = false;
async function seedJanuary() {
  if (januarySeeded) return;
  januarySeeded = true;
  await send([
    // Reads the guide, leaves, and signs up on a visit AFTER the range ends. The return
    // falls outside the report, and it is still "went on to convert".
    { anonymousId: "wo1", sessionId: "wo1-a", at: JAN(11), pages: [{ path: "/guide", title: "Getting started guide" }, { path: "/features", afterMs: 5_000 }] },
    { anonymousId: "wo1", sessionId: "wo1-b", at: JAN(20), pages: [{ path: "/" }], tracks: [{ event: "Signup Completed", afterMs: 2_000 }] },
    // Features, then signs up on /signup in the same visit.
    {
      anonymousId: "wo2",
      sessionId: "wo2-a",
      at: JAN(12),
      pages: [{ path: "/features" }, { path: "/signup", afterMs: 5_000 }],
      tracks: [{ event: "Signup Completed", afterMs: 8_000, path: "/signup" }],
    },
    // Signs up FIRST, then reads the guide. The guide did not lead anywhere: they had
    // already converted by the time they saw it.
    {
      anonymousId: "wo3",
      sessionId: "wo3-a",
      at: JAN(12),
      pages: [{ path: "/" }, { path: "/guide", afterMs: 10_000, title: "Getting started guide" }],
      tracks: [{ event: "Signup Completed", afterMs: 1_000, path: "/" }],
    },
    // Reads the guide, comes back two days later — inside the range — lands elsewhere
    // and signs up there without seeing the guide again.
    { anonymousId: "wo4", sessionId: "wo4-a", at: JAN(11), pages: [{ path: "/guide", title: "Getting started guide" }] },
    { anonymousId: "wo4", sessionId: "wo4-b", at: JAN(14), pages: [{ path: "/offer" }], tracks: [{ event: "Signup Completed", afterMs: 3_000 }] },
  ]);
}

test("went on to convert: the same visit, a later one, and never before the page was seen", async () => {
  await seedJanuary();
  const w = await january();
  const pages = Object.fromEntries((await allPages(w, { limit: 50 })).map((r) => [r.path, r]));

  const guide = pages["/guide"]?.went_on;
  assert.ok(guide, "a goal is configured, so the page carries the measure");
  assert.equal(guide.people, 3, "wo1, wo3 and wo4 viewed it");
  assert.equal(guide.same_visit, 0, "wo3 converted in that visit, but BEFORE seeing the page");
  assert.equal(guide.later_visit, 2, "wo1 came back after the range ended, wo4 inside it");
  assert.equal(guide.rate.numerator, 2);
  assert.equal(guide.rate.denominator, pages["/guide"].unique_viewers.current, "the denominator is the viewers column");

  const features = pages["/features"]?.went_on;
  assert.deepEqual([features?.people, features?.same_visit, features?.later_visit], [2, 1, 1], "wo2 then and there, wo1 later");

  // A person falls into one half at most: wo3 converted and viewed "/" in one visit,
  // and that is a same-visit conversion, not also a later one.
  const home = pages["/"]?.went_on;
  assert.deepEqual([home?.people, home?.same_visit, home?.later_visit], [1, 1, 0]);

  // Landing rows ask it of the people who landed, and a later visit counts there too —
  // which the per-visit conversion rate beside it, by design, cannot see.
  const landings = Object.fromEntries((await landingPages(w, { limit: 50 })).map((r) => [r.path, r]));
  assert.equal(landings["/guide"]?.conversion_rate.numerator, 0, "neither visit that landed on the guide converted");
  assert.deepEqual([landings["/guide"]?.went_on?.people, landings["/guide"]?.went_on?.later_visit], [2, 2], "but both people did, later");

  // Another goal nobody completed is a zero, and no goal at all is not a zero.
  const onDemo = Object.fromEntries((await allPages({ ...w, goal: DEMO }, { limit: 50 })).map((r) => [r.path, r]));
  assert.deepEqual([onDemo["/guide"]?.went_on?.people, onDemo["/guide"]?.went_on?.rate.numerator], [3, 0]);
  const noGoals = await allPages({ ...w, goal: null, goals: [] }, { limit: 50 });
  assert.ok(noGoals.every((r) => r.went_on === null), "nothing configured is unavailable, not 0%");

  // The baseline asks every visitor in the period the same question.
  const baseline = await wentOnBaseline(w);
  assert.equal(baseline?.people, 4);
  assert.equal(baseline?.rate.numerator, 4, "all four converted at some point after their visit began");
  assert.equal(await wentOnBaseline({ ...w, goal: null, goals: [] }), null);
});

test("the page drawer switches between landings and every visit, and matches its row on both", async () => {
  await seedJanuary();
  const w = await january();
  const pageRow = (await allPages(w, { limit: 50 })).find((r) => r.path === "/guide")!;
  const landingRow = (await landingPages(w, { limit: 50 })).find((r) => r.path === "/guide")!;

  const asLanding = await pageDetail(w, "/guide", { basis: "landing" });
  assert.equal(asLanding.basis, "landing");
  assert.equal(asLanding.landing_sessions.current, 2, "wo1-a and wo4-a started here");
  assert.deepEqual(asLanding.went_on, landingRow.went_on, "the drawer is the landing row, not a near relation of it");
  assert.equal(asLanding.landing_conversion_rate?.numerator, landingRow.conversion_rate.numerator);
  assert.equal(
    asLanding.sources.reduce((n, s) => n + s.sessions.current, 0),
    asLanding.landing_sessions.current,
    "acquisition of the visits that landed here, every one of them",
  );
  // After a landing, each visit is counted once: wo1 went on to /features, wo4 left.
  const nextLanding = Object.fromEntries(asLanding.next_pages.map((n) => [n.is_exit ? "(exit)" : n.path, n.sessions]));
  assert.deepEqual(nextLanding, { "/features": 1, "(exit)": 1 });

  const asViewers = await pageDetail(w, "/guide", { basis: "viewers" });
  assert.equal(asViewers.basis, "viewers");
  assert.equal(asViewers.unique_viewers.current, pageRow.unique_viewers.current);
  assert.equal(asViewers.pageviews.current, pageRow.pageviews.current);
  assert.equal(asViewers.sessions.current, 3, "three visits included it; only two started there");
  assert.deepEqual(asViewers.went_on, pageRow.went_on, "and on this basis it is the All pages row");
  assert.equal(
    asViewers.sources.reduce((n, s) => n + s.sessions.current, 0),
    asViewers.sessions.current,
    "the sources follow the switch rather than staying on landings",
  );
  // After any view: wo3 read the guide last and left, which the landing basis never saw.
  const nextAll = Object.fromEntries(asViewers.next_pages.map((n) => [n.is_exit ? "(exit)" : n.path, n.sessions]));
  assert.deepEqual(nextAll, { "/features": 1, "(exit)": 2 });

  assert.deepEqual(asViewers.went_on_baseline, await wentOnBaseline(w));
});

test("searching the page tables chooses rows and never changes what is on them", async () => {
  await seedJanuary();
  const w = await january();
  const everything = Object.fromEntries((await allPages(w, { limit: 50 })).map((r) => [r.path, r]));

  const byPath = await allPages(w, { limit: 50, search: "GUI" });
  assert.deepEqual(byPath.map((r) => r.path), ["/guide"], "case-insensitive, anywhere in the path");
  assert.deepEqual(byPath[0], everything["/guide"], "the row found is the row that was there");

  assert.deepEqual((await allPages(w, { limit: 50, search: "getting started" })).map((r) => r.path), ["/guide"], "by title too");
  assert.deepEqual((await allPages(w, { limit: 50, search: "https://example.com/features?utm_source=x" })).map((r) => r.path), ["/features"], "a pasted URL means its path");
  assert.deepEqual(await allPages(w, { limit: 50, search: "no-such-page" }), []);
  assert.equal((await allPages(w, { limit: 50, search: "   " })).length, Object.keys(everything).length, "blank is no search");

  const landings = Object.fromEntries((await landingPages(w, { limit: 50 })).map((r) => [r.path, r]));
  const found = await landingPages(w, { limit: 50, search: "feat" });
  assert.deepEqual(found.map((r) => r.path), ["/features"]);
  assert.deepEqual(found[0], landings["/features"]);
  assert.deepEqual((await landingPages(w, { limit: 50, search: "getting" })).map((r) => r.path), ["/guide"], "landings match on title as well");
});
