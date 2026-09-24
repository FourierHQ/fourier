/**
 * Split goals, against a real ClickHouse.
 *
 * One event, a goal per value of a property. What has to hold: every value that counts
 * is counted exactly once whether read as its own row, as the rollup or as "All
 * conversions"; a value nobody has named is counted, not dropped;
 * reclassified and excluded values leave the rollup; names come from the data by shape,
 * never from a property's name; and a deployment that predates splits ignores them
 * instead of counting every value as a primary conversion.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database, and drops
 * everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_splittest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  combinableGoals,
  configFromEnv,
  databaseFor,
  deleteDefinition,
  detectSiteName,
  ensureDefaultProject,
  getAdminClient,
  getDataClient,
  goalConfigSchema,
  goalScanWindow,
  inheritsDefault,
  goalSummary,
  headline,
  humanize,
  ingest,
  listGoalDefinitions,
  listGoals,
  listPageGroups,
  looksLikeId,
  migrateAll,
  nameSplitValue,
  pickLabelKey,
  resolveGoals,
  resolveRange,
  scope,
  splitCatalog,
  splitEventMatch,
  splitKeyCandidates,
  suggestLabelKey,
  supportingActions,
  titleWithoutSite,
  upsertDefinition,
  type Goal,
  type Project,
  type SplitGoalConfig,
  type WebScope,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
let project: Project;
const prod = () => scope(project.id, "production");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const FORM = {
  demo: "11111111-1111-4111-8111-111111111111",
  scan: "22222222-2222-4222-8222-222222222222",
  guide: "33333333-3333-4333-8333-333333333333",
  spam: "44444444-4444-4444-8444-444444444444",
  fresh: "55555555-5555-4555-8555-555555555555",
  quiet: "66666666-6666-4666-8666-666666666666",
  late: "77777777-7777-4777-8777-777777777777",
};

const TITLES: Record<string, string> = {
  "/": "Acme | The platform for things",
  "/get-a-demo": "Get a demo | Acme",
  "/scan": "Free vulnerability scan | Acme",
  "/guide": "The field guide | Acme",
  "/new": "Brand new offer | Acme",
  "/late": "Last-minute offer | Acme",
  "/pricing": "Pricing | Acme",
};

let n = 0;
/** One visit: a page view, then a submission on that page. Each visit its own session. */
function submission(path: string, properties: Record<string, unknown>, at: Date, event = "Form Submitted", after = 5_000) {
  const id = `v${n++}`;
  const page = { url: `https://acme.test${path}`, path, title: TITLES[path] ?? path, referrer: "" };
  const ctx = (isNew: boolean) => ({ library: { name: "fourier", version: "0.1.0" }, userAgent: UA, session: { id: `s-${id}`, isNew }, page });
  return [
    { type: "page", anonymousId: id, timestamp: at.toISOString(), properties: { path }, context: ctx(true) },
    { type: "track", event, anonymousId: id, timestamp: new Date(at.getTime() + after).toISOString(), properties: { ...properties, email: `${id}@example.com` }, context: ctx(false) },
  ];
}

let DEMO: Goal;
let GUIDE: Goal;
let SPLIT_ID: string;

const range = () => resolveRange({ preset: "7d", now: NOW });
const windowOf = () => goalScanWindow(range());

async function web(overrides: Partial<WebScope> = {}): Promise<WebScope> {
  const defs = await listGoalDefinitions(project.id);
  return {
    scope: prod(),
    range: range(),
    filters: {},
    goal: null,
    goals: await resolveGoals(prod(), defs, windowOf()),
    pageGroups: await listPageGroups(project.id),
    ...overrides,
  };
}

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();

  const msgs = [
    // The demo form, named on its later submissions only, on its own page and on the homepage.
    ...submission("/get-a-demo", { form_id: FORM.demo, form_variant: "default", form_section: "hero" }, ago(40 * DAY)),
    ...submission("/get-a-demo", { form_id: FORM.demo, form_variant: "default", form_section: "hero", form_name: "demo-request" }, ago(2 * DAY)),
    ...submission("/get-a-demo", { form_id: FORM.demo, form_variant: "default", form_section: "hero", form_name: "demo-request" }, ago(1 * DAY)),
    ...submission("/", { form_id: FORM.demo, form_variant: "default", form_section: "cta", form_name: "demo-request" }, ago(1 * DAY)),
    // The scan form never sends a name. Its page is its only name.
    ...submission("/scan", { form_id: FORM.scan, form_variant: "scan" }, ago(3 * DAY)),
    ...submission("/scan", { form_id: FORM.scan, form_variant: "scan" }, ago(2 * DAY)),
    // A gated guide: the same event, but not a lead.
    ...submission("/guide", { form_id: FORM.guide, form_variant: "default", form_name: "guide-download" }, ago(2 * DAY)),
    // Spam, which the operator will exclude.
    ...submission("/pricing", { form_id: FORM.spam, form_name: "spam-trap" }, ago(1 * DAY)),
    // A form added yesterday. Nobody has made a goal for it: the whole point.
    ...submission("/new", { form_id: FORM.fresh }, ago(1 * DAY)),
    // A submission from a form whose instrumentation forgot the id.
    ...submission("/pricing", { form_name: "mystery" }, ago(1 * DAY)),
    // A visit that began before the period ended and submitted after it: the report reads
    // it through its 12-hour tail, so the split has to list this value too.
    ...submission("/late", { form_id: FORM.late }, new Date(NOW.getTime() - 30 * 60_000), "Form Submitted", 60 * 60_000),
    // Two forms that the data names identically.
    ...submission("/pricing", { list_id: "aaaa1111bbbb2222", list_name: "newsletter" }, ago(DAY), "Subscribed"),
    ...submission("/pricing", { list_id: "cccc3333dddd4444", list_name: "newsletter" }, ago(DAY), "Subscribed"),
    ...submission("/pricing", { list_id: "eeee5555ffff6666", list_name: "product-updates" }, ago(DAY), "Subscribed"),
    // A different event with far more values than fit on screen.
    ...Array.from({ length: 30 }, (_, i) => submission("/pricing", { plan: `plan-${String(i).padStart(2, "0")}` }, ago((i % 5) * DAY + DAY), "Plan Chosen")).flat(),
  ];
  await ingest(project, msgs as never, { receivedAt: NOW, userAgent: UA }, "production");
  await getDataClient("production").command({ query: `OPTIMIZE TABLE sessions FINAL` });

  // Two goals written out by hand, the way a site ends up with nine of them.
  DEMO = (await upsertDefinition(project.id, "goal", {
    name: "Demo Requested",
    is_default: true,
    config: { type: "primary", match: "event", event: "Form Submitted", properties: [{ key: "form_id", op: "eq", value: FORM.demo }] },
  })) as Goal;
  GUIDE = (await upsertDefinition(project.id, "goal", {
    name: "Guide Downloaded",
    config: { type: "supporting", match: "event", event: "Form Submitted", properties: [{ key: "form_id", op: "eq", value: FORM.guide }] },
  })) as Goal;
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const e of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, e)}\`` });
  await admin.close();
});

// ---------- naming, by shape ----------

test("identifiers are told apart from names by how they look, not what they are called", () => {
  for (const id of [FORM.demo, "c033b7f0", "42", "form_8shd83hs", "prod_Nx9Kd82Jd", "a8f3k29x"]) assert.equal(looksLikeId(id), true, id);
  for (const name of ["demo-request", "web3-scoping", "Book a call", "pro", "v2", "iPhone", "q3-2026-promo", "Free FHIR Vulnerability Scan"]) {
    assert.equal(looksLikeId(name), false, name);
  }
  assert.equal(humanize("demo-request"), "Demo request");
  assert.equal(humanize("contact_inquiry"), "Contact inquiry");
  assert.equal(humanize("Book a call"), "Book a call");
  assert.equal(humanize("iPhone"), "iPhone");
});

test("the site's name is found in its titles and taken off, wherever it sits", () => {
  const site = detectSiteName(Object.values(TITLES));
  assert.equal(site, "acme");
  assert.equal(titleWithoutSite("Free vulnerability scan | Acme", site), "Free vulnerability scan");
  assert.equal(titleWithoutSite("Acme — Pricing", "acme"), "Pricing");
  assert.equal(titleWithoutSite("Acme", site), null, "a title that is only the brand names nothing");
  assert.equal(detectSiteName(["One", "Two | Three"]), null, "too few titles to call anything a brand");
});

test("the naming ladder: rename, readable value, label, page, then the value shortened", () => {
  const key = "form_id";
  assert.equal(nameSplitValue({ value: FORM.demo, key, renamed: "Demo" }).source, "renamed");
  assert.deepEqual(nameSplitValue({ value: "pro", key: "plan" }), { name: "Pro", source: "value" });
  assert.equal(nameSplitValue({ value: FORM.demo, key, label: "demo-request", labelKey: "form_name" }).name, "Demo request");
  assert.equal(nameSplitValue({ value: FORM.demo, key, label: "c033b7f0" }).source, "raw", "an id is not a label");
  assert.equal(nameSplitValue({ value: FORM.scan, key, page: { path: "/scan", title: "Free scan" } }).name, "Free scan");
  assert.equal(nameSplitValue({ value: FORM.scan, key }).name, "22222222…");
  assert.equal(nameSplitValue({ value: "", key }).name, "No form_id");
});

test("the label property is the one that lines up one-to-one, not the one with the most coverage", () => {
  const values = ["a", "b", "c", "d"];
  const cand = (key: string, pairs: [string, number, string][]) => ({ key, splitValues: values.length, perValue: pairs.map(([value, labels, latest]) => ({ value, labels, latest })) });
  const picked = pickLabelKey([
    // Covers three of four, one label each, all different: a name.
    cand("form_name", [["a", 1, "demo-request"], ["b", 1, "contact"], ["c", 1, "guide"]]),
    // Covers all four but two share a value: describes, does not name.
    cand("form_variant", [["a", 1, "default"], ["b", 1, "default"], ["c", 1, "scan"], ["d", 1, "web3"]]),
    // Covers all four, all different, but one form sits in two sections: placement.
    cand("form_section", [["a", 2, "hero"], ["b", 1, "get-in-touch"], ["c", 1, "gate"], ["d", 1, "scope"]]),
    // One-to-one and readable, but a path: the page title does that job better.
    cand("page_path", [["a", 1, "/demo"], ["b", 1, "/contact"], ["c", 1, "/guide"], ["d", 1, "/web3"]]),
  ]);
  assert.equal(picked, "form_name");
});

// ---------- combining ----------

test("goals that are one split written out by hand are offered for combining", async () => {
  const proposals = combinableGoals(await listGoalDefinitions(project.id));
  assert.equal(proposals.length, 1);
  const p = proposals[0];
  assert.equal(p.key, "form_id");
  assert.deepEqual(new Set(p.goal_ids), new Set([DEMO.id, GUIDE.id]));
  assert.equal(p.config.type, "primary", "any primary member makes the combined goal primary");
  assert.deepEqual(p.config.split.values?.[FORM.demo], { name: "Demo Requested" });
  assert.deepEqual(p.config.split.values?.[FORM.guide], { name: "Guide Downloaded", type: "supporting" });
});

test("a deployment that predates split goals drops them rather than counting every value", () => {
  const cfg: SplitGoalConfig = { type: "primary", match: "event_split", event: "Form Submitted", split: { key: "form_id" } };
  // The schema main parses stored goals with. Failing it is what makes an old dashboard
  // skip the row, where parsing it as a plain event goal would count spam and guides as leads.
  assert.equal(goalConfigSchema.safeParse(cfg).success, false);
});

test("combining keeps the originals, hidden, and deleting the split brings them back", async () => {
  const [p] = combinableGoals(await listGoalDefinitions(project.id));
  const split = await upsertDefinition(project.id, "goal", {
    name: "Form submissions",
    config: {
      ...p.config,
      split: {
        ...p.config.split,
        label_key: "form_name",
        values: { ...p.config.split.values, [FORM.spam]: { type: "excluded" }, [FORM.scan]: {}, [FORM.quiet]: { name: "Quiet form" } },
      },
    },
  });
  SPLIT_ID = split.id;
  assert.deepEqual((await listGoals(project.id)).map((g) => g.id), [], "absorbed goals are not in force");
  const defs = await listGoalDefinitions(project.id);
  assert.equal(defs.find((d) => d.id === DEMO.id)?.absorbed_by, SPLIT_ID);
  assert.equal(defs.length, 3, "nothing was deleted");

  await deleteDefinition(project.id, "goal", SPLIT_ID);
  assert.deepEqual(new Set((await listGoals(project.id)).map((g) => g.id)), new Set([DEMO.id, GUIDE.id]));
  // Put it back for the rest of the file.
  await upsertDefinition(project.id, "goal", { id: SPLIT_ID, name: "Form submissions", config: split.config });
});

// ---------- expansion ----------

test("a split expands into a rollup, a goal per value, and names from the data", async () => {
  const goals = await resolveGoals(prod(), await listGoalDefinitions(project.id), windowOf());
  const forms = goals.filter((g) => g.split?.definition_id === SPLIT_ID);
  const byValue = new Map(forms.filter((g) => g.split?.role === "value").map((g) => [g.split!.value, g]));

  assert.equal(forms[0].split?.role, "all");
  assert.equal(forms[0].is_default, true, "the default carried over from the absorbed goal");
  assert.equal(byValue.get(FORM.demo)?.name, "Demo Requested", "renamed");
  assert.equal(byValue.get(FORM.scan)?.name, "Free vulnerability scan", "from the page, without the site's name");
  assert.equal(byValue.get(FORM.scan)?.split?.name_source, "page");
  assert.equal(byValue.get(FORM.fresh)?.name, "Brand new offer");
  assert.equal(byValue.get(FORM.fresh)?.split?.first_seen, new Date(ago(DAY).getTime() + 5_000).toISOString(), "its first completion, to date it by");
  assert.equal(byValue.get(FORM.guide)?.config.type, "supporting");
  assert.equal(byValue.has(FORM.spam), false, "excluded values are no goal at all");
  assert.equal(byValue.get("")?.name, "No form_id");
  assert.equal(byValue.get(FORM.quiet)?.name, "Quiet form", "a named value with no data is still listed, at zero");
});

test("every value that counts is counted once: as its row, in the rollup and in All conversions", async () => {
  const w = await web();
  const rows = await goalSummary(w);
  const rollup = rows.find((r) => r.id === SPLIT_ID)!;
  // In the window: demo x3 (two named, one on the homepage), scan x2, fresh x1, no-id x1,
  // and the late one submitted in the tail. Not the guide (supporting), not spam
  // (excluded), not the 40-day-old demo (outside).
  assert.equal(rollup.converting_sessions.current, 8);
  const leaves = rows.filter((r) => r.split?.definition_id === SPLIT_ID && r.split.role === "value");
  assert.equal(leaves.reduce((s, r) => s + r.converting_sessions.current, 0), 8, "one submission per visit, so the values partition the rollup");
  assert.ok(leaves.some((r) => r.split?.value === FORM.late), "a value seen only in the tail still gets its row");
  const head = await headline(w);
  assert.equal(head.converting_sessions.current, 8, "All conversions is the rollup, not the rollup plus its rows — and misses nothing it counts");

  const supporting = await supportingActions(w);
  assert.deepEqual(supporting.map((s) => [s.name, s.sessions.current]), [["Guide Downloaded", 1]]);
});

test("too many values are pooled into Other, which still adds up", async () => {
  const plans = await upsertDefinition(project.id, "goal", {
    name: "Plan chosen",
    config: { type: "primary", match: "event_split", event: "Plan Chosen", split: { key: "plan" } },
  });
  const w = await web();
  const rows = (await goalSummary(w)).filter((r) => r.split?.definition_id === plans.id);
  const values = rows.filter((r) => r.split?.role === "value");
  const other = rows.find((r) => r.split?.role === "other");
  assert.equal(values.length, 25);
  assert.ok(other, "the rest are pooled rather than dropped");
  assert.equal(rows[0].converting_sessions.current, 30);
  assert.equal(values.reduce((s, r) => s + r.converting_sessions.current, 0) + other!.converting_sessions.current, 30);
  assert.equal(values[0].name, "Plan 00", "readable values name themselves");
  await deleteDefinition(project.id, "goal", plans.id);
});

test("a value asked for by id exists even when the window would not produce it", async () => {
  const defs = await listGoalDefinitions(project.id);
  const narrow = { from: ago(0.5 * DAY), to: NOW };
  const id = `${SPLIT_ID}:${FORM.demo}`;
  assert.equal((await resolveGoals(prod(), defs, narrow)).some((g) => g.id === id), true, "named, so listed at zero anyway");
  const freshId = `${SPLIT_ID}:${FORM.fresh}`;
  const none = { from: ago(0.1 * DAY), to: NOW };
  assert.equal((await resolveGoals(prod(), defs, none)).some((g) => g.id === freshId), false, "unnamed and absent: not listed");
  assert.equal((await resolveGoals(prod(), defs, none, { include: [freshId] })).some((g) => g.id === freshId), true);
});

// ---------- choosing a split ----------

test("split candidates rank by how values behave, and a value-per-event property is unsuitable", async () => {
  const candidates = await splitKeyCandidates(prod(), { event: "Form Submitted" });
  assert.equal(candidates[0].key, "form_id");
  const email = candidates.find((c) => c.key === "email");
  assert.equal(email?.suitable, false);
  assert.match(email!.reason, /different value/);
});

test("the label property is suggested from the data", async () => {
  assert.equal(await suggestLabelKey(prod(), { event: "Form Submitted", split: { key: "form_id" } }), "form_name");
});

test("the catalog names every value and previews the suggested label", async () => {
  const catalog = await splitCatalog(prod(), { type: "primary", event: "Form Submitted", split: { key: "form_id" } });
  assert.equal(catalog.suggested_label_key, "form_name");
  const demo = catalog.values.find((v) => v.value === FORM.demo)!;
  assert.equal(demo.name, "Demo request");
  assert.equal(demo.total, 4, "all history, including the submission before the window");
  assert.equal(catalog.values.find((v) => v.value === FORM.fresh)?.override, null, "nothing decided about it");
});

test("the browser names and types an event the way the reports do", async () => {
  const def = (await listGoalDefinitions(project.id)).find((d) => d.id === SPLIT_ID)!;
  const cfg = def.config as SplitGoalConfig;
  const e = (props: Record<string, unknown>) => ({ type: "track", event: "Form Submitted", properties: props });
  assert.deepEqual(splitEventMatch(cfg, e({ form_id: FORM.demo })), { value: FORM.demo, name: "Demo Requested", type: "primary" });
  assert.equal(splitEventMatch(cfg, e({ form_id: FORM.guide }))?.type, "supporting");
  assert.equal(splitEventMatch(cfg, e({ form_id: FORM.spam })), null, "excluded");
  assert.equal(splitEventMatch(cfg, e({ form_id: FORM.fresh, form_name: "fresh-offer" }))?.name, "Fresh offer", "its own label property names it");
  assert.equal(splitEventMatch(cfg, { type: "track", event: "Other", properties: { form_id: FORM.demo } }), null);
});

test("values the data names identically are told apart", async () => {
  const subs = await upsertDefinition(project.id, "goal", {
    name: "Subscribed",
    config: { type: "supporting", match: "event_split", event: "Subscribed", split: { key: "list_id", label_key: "list_name" } },
  });
  const goals = (await resolveGoals(prod(), await listGoalDefinitions(project.id), windowOf())).filter((g) => g.split?.definition_id === subs.id && g.split.role === "value");
  const names = goals.map((g) => g.name).sort();
  assert.deepEqual(names, ["Newsletter (aaaa1111bbbb2222)", "Newsletter (cccc3333dddd4444)", "Product updates"]);
  await deleteDefinition(project.id, "goal", subs.id);
});

test("a split inherits the default from a goal it absorbed, until another goal is made default", async () => {
  const defs = await listGoalDefinitions(project.id);
  const split = defs.find((d) => d.id === SPLIT_ID)!;
  assert.equal(inheritsDefault(defs, split), true);
  const other = await upsertDefinition(project.id, "goal", { name: "Other default", is_default: true, config: { type: "primary", match: "event", event: "Nope" } });
  const after = await listGoalDefinitions(project.id);
  assert.equal(inheritsDefault(after, after.find((d) => d.id === SPLIT_ID)!), false, "a default chosen since wins");
  await deleteDefinition(project.id, "goal", other.id);
});
