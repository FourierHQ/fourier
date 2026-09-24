/**
 * The browser's goal matcher and the server's, asked about the same rows.
 *
 * eventMatches (../src/goal-match) is a second implementation of matchSql
 * (../src/definitions), and when the two disagree nothing errors: the Conversions report
 * counts a row the Events list does not mark, or the list marks a row no report counts.
 * That has happened once already — the browser read every non-string property as '',
 * which ClickHouse stopped doing — so this makes the disagreement a test failure.
 *
 * The payloads go in through ingest and come back out through listEvents, which is how
 * both sides really get them: the server reads the text ingest stored, the browser reads
 * that text parsed. There is a hand-written set, one per JSON type, and a seeded random
 * set for the spellings nobody thinks to write down: doubles across the whole exponent
 * range, control characters, U+2028, integer-like keys, half an emoji, deep nesting.
 * The goals are built from what ClickHouse itself reads out of those rows, so every eq
 * has a row to hit, and every goal is asked of every row on both sides.
 *
 * One kind of row is held to a different standard: one carrying an integer beyond 64
 * bits, which ClickHouse 26.4 refuses to parse and 26.8 reads. The browser marks those
 * only where both versions would count them, so it can agree exactly with neither; what
 * is asserted is that it agrees with that rule, and never marks what the server does not.
 *
 * Runs against whatever CLICKHOUSE_URL points at, under a throwaway database, and drops
 * everything it created on the way out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_goalmatch_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  ENVIRONMENTS,
  Params,
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  eventMatches,
  getAdminClient,
  getDataClient,
  ingest,
  listEvents,
  matchSql,
  migrateAll,
  scope,
  type GoalMatch,
  type MatchableEvent,
  type Project,
  type PropertyFilter,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
const EVENT = "fixture";

let project: Project;

// ---------- fixtures ----------

const HALF_EMOJI = "😀".slice(0, 1);

function nest(levels: number, leaf: unknown = "leaf"): unknown {
  let v = leaf;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
}

/** One of each thing, named, so a failure here reads as the case it is. */
const WRITTEN: Record<string, unknown>[] = [
  // The report that started this: a numeric id and a boolean flag.
  { form_id: 42, ok: true },
  { form_id: "42", ok: "true" },
  { v: "pro" },
  { v: "" },
  { v: 42 },
  { v: -7 },
  { v: 0 },
  { v: 1.5 },
  { v: 0.1 },
  { v: 1e3 },
  { v: 1e21 },
  { v: 1.5e-7 },
  { v: 2 ** 60 },
  { v: Number.MAX_VALUE },
  { v: Number.MIN_VALUE },
  { v: true },
  { v: false },
  { v: null },
  { v: { sku: "A1", qty: 2 } },
  { v: ["pro", "beta"] },
  { v: [] },
  { v: {} },
  { v: [1, "x", true, null, { a: 1e21, b: -0.5 }] },
  { v: { b: 1, 2: 2, 1: 3, a: { 10: 1, 9: 2 } } },
  { v: "a\u001bb\u2028c" },
  { v: ["a\u001bb\u2028c\u0000\\u001b/é😀"] },
  { v: "tab\tnew\nline\\back'quote\"" },
  { w: "no v here" },
  {},
  { v: "pro", note: `cut${HALF_EMOJI}` },
  { v: "pro", [`key${HALF_EMOJI}`]: 1 },
  { v: "pro", deep: nest(1022) },
  { v: "pro", deep: nest(1023) },
  { v: nest(3, 1e21) },
  // Integers beyond 64 bits, as JavaScript spells them: plain digits below 1e21.
  { v: 2 ** 64 },
  { v: [2 ** 64] },
  { v: 123456789012345680000 },
  { v: "pro", big: [-(2 ** 63)] },
  // ...and just inside, which is an ordinary number.
  { v: [2 ** 63, -(2 ** 62)] },
];

/** Mulberry32: a few lines, and the same fixtures every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20260923);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const PIECES = ["a", "Z", "0", "9", "42", " ", '"', "\\", "/", "'", "\n", "\t", "\r", "\u0000", "\u0001", "\u001b", "\u001f", "\u007f", "\u2028", "\u2029", "é", "中", "😀", "e+", "e-", "-", ".", "{", "[", ",", ":", "null", "true"];
const KEYS = ["a", "b", "0", "1", "2", "10", "k.x", "", " ", "é", "\n"];

function randomDouble(): number {
  if (rand() < 0.5) {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, Math.floor(rand() * 2 ** 32));
    view.setUint32(4, Math.floor(rand() * 2 ** 32));
    const d = view.getFloat64(0);
    return Number.isFinite(d) ? d : 0.5;
  }
  return (rand() - 0.5) * 10 ** Math.floor(rand() * 60 - 30);
}

function randomString(): string {
  let s = "";
  const n = Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) s += pick(PIECES);
  return s;
}

function randomValue(depth: number): unknown {
  const r = rand();
  if (r < 0.2) return randomString();
  if (r < 0.3) return Math.floor((rand() - 0.5) * 2000);
  if (r < 0.35) return Math.floor(2 ** (rand() * 70)) * (rand() < 0.5 ? -1 : 1);
  if (r < 0.55) return randomDouble();
  if (r < 0.62) return rand() < 0.5;
  if (r < 0.67) return null;
  if (depth >= 3) return randomString();
  if (r < 0.82) return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(rand() * 4); i > 0; i--) o[rand() < 0.8 ? pick(KEYS) : randomString()] = randomValue(depth + 1);
  return o;
}

function randomProperties(): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (rand() < 0.9) p.v = randomValue(0);
  if (rand() < 0.5) p.w = randomValue(0);
  if (rand() < 0.04) p.note = `cut${HALF_EMOJI}`;
  if (rand() < 0.02) p.deep = nest(1030);
  return p;
}

const FIXTURES: Record<string, unknown>[] = [...WRITTEN, ...Array.from({ length: 160 }, randomProperties)];

const UINT64_MAX = 18446744073709551615n;
const INT64_MIN = -9223372036854775808n;

/** Whether a payload holds an integer beyond 64 bits anywhere: the rows versions disagree on. */
function hasWideInteger(v: unknown): boolean {
  if (typeof v === "number") {
    const s = String(v);
    return /^-?\d+$/.test(s) && (BigInt(s) > UINT64_MAX || BigInt(s) < INT64_MIN);
  }
  if (Array.isArray(v)) return v.some(hasWideInteger);
  if (v && typeof v === "object") return Object.values(v).some(hasWideInteger);
  return false;
}

const WIDE = new Set(FIXTURES.flatMap((p, i) => (hasWideInteger(p) ? [`gm-${i}`] : [])));
/** A row with no properties at all, which is how 26.4 reads a row it cannot parse. */
const EMPTY = `gm-${FIXTURES.findIndex((p) => Object.keys(p).length === 0)}`;

/** The keys every goal asks about, including one no row carries. */
const ASKED = ["v", "w", "form_id", "ok", "note", "missing"];

// ---------- the two sides ----------

/** Each row as the browser holds it: through listEvents, then through a JSON response. */
let rows: (MatchableEvent & { message_id: string })[] = [];
/** Whether the server under test reads an integer beyond 64 bits (26.8) or refuses it (26.4). */
let readsWideIntegers: boolean;

async function sqlHits(goals: GoalMatch[]): Promise<Set<string>[]> {
  const hits: Set<string>[] = [];
  // Chunked, because every goal's values travel as URL parameters.
  for (let i = 0; i < goals.length; i += 40) {
    const chunk = goals.slice(i, i + 40);
    const p = new Params();
    const preds = chunk.map((g) => matchSql(g, p));
    const res = await getDataClient("production").query({
      query: `SELECT message_id, [${preds.join(", ")}] AS hits FROM events WHERE project_id = {project:String} AND event = {event:String}`,
      query_params: { ...p.values, project: project.id, event: EVENT },
      format: "JSONEachRow",
    });
    const out = chunk.map(() => new Set<string>());
    for (const r of (await res.json()) as { message_id: string; hits: number[] }[]) {
      r.hits.forEach((h, j) => {
        if (Number(h)) out[j].add(r.message_id);
      });
    }
    hits.push(...out);
  }
  return hits;
}

function jsHits(goals: GoalMatch[]): Set<string>[] {
  return goals.map((g) => new Set(rows.filter((r) => eventMatches(g, r)).map((r) => r.message_id)));
}

/** What ClickHouse reads for a key in every row, which is where the goals' values come from. */
async function readings(key: string): Promise<string[]> {
  const res = await getDataClient("production").query({
    query: `SELECT DISTINCT JSONExtractString(properties, {k:String}) AS v FROM events WHERE project_id = {project:String} AND event = {event:String}`,
    query_params: { k: key, project: project.id, event: EVENT },
    format: "JSONEachRow",
  });
  return ((await res.json()) as { v: string }[]).map((r) => r.v);
}

function goal(f: PropertyFilter): GoalMatch {
  return { match: "event", event: EVENT, properties: [f] };
}

function describe(g: GoalMatch): string {
  return JSON.stringify(g.match === "event" ? g.properties : g);
}

before(async () => {
  await migrateAll();
  project = await ensureDefaultProject();
  const now = Date.now();
  const result = await ingest(
    project,
    FIXTURES.map((properties, i) => ({
      type: "track",
      event: EVENT,
      messageId: `gm-${i}`,
      anonymousId: `anon-${i}`,
      timestamp: new Date(now - i * 1000).toISOString(),
      properties,
    })) as never,
  );
  assert.equal(result.accepted, FIXTURES.length, "every fixture ingested");

  const listed = await listEvents(scope(project.id), { event: EVENT, limit: 1000 });
  rows = JSON.parse(JSON.stringify(listed));
  assert.equal(rows.length, FIXTURES.length, "every fixture read back");

  const probe = await getDataClient("production").query({ query: `SELECT JSONHas('{"a":1,"b":18446744073709551616}', 'a') AS ok`, format: "JSONEachRow" });
  readsWideIntegers = Number(((await probe.json()) as { ok: number }[])[0].ok) === 1;
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const e of ENVIRONMENTS) await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, e)}\`` });
  await admin.close();
});

test("the reported case: a numeric id and a boolean match as their spelling", async () => {
  const goals = [goal({ key: "form_id", op: "eq", value: "42" }), goal({ key: "ok", op: "eq", value: "true" })];
  const [sql, js] = [await sqlHits(goals), jsHits(goals)];
  for (let i = 0; i < goals.length; i++) {
    // Both the numeric row and the string row, on both sides.
    assert.deepEqual([...sql[i]].sort(), ["gm-0", "gm-1"], `server, ${describe(goals[i])}`);
    assert.deepEqual([...js[i]].sort(), ["gm-0", "gm-1"], `browser, ${describe(goals[i])}`);
  }
});

test("every goal matches the same rows on both sides", async (t) => {
  t.diagnostic(`${WIDE.size} of ${rows.length} rows carry an integer beyond 64 bits; this server ${readsWideIntegers ? "reads" : "refuses"} them`);
  const goals: GoalMatch[] = [];
  const seen = new Set<string>();
  const add = (f: PropertyFilter) => {
    const id = JSON.stringify(f);
    if (seen.has(id)) return;
    seen.add(id);
    goals.push(goal(f));
  };
  const fromReadings: GoalMatch[] = [];

  for (const key of ASKED) {
    add({ key, op: "exists" });
    const values = new Set([...(await readings(key)), "", "42", "true", "false", "null", "1e21", "1e+21", "[]", "{}"]);
    for (const value of values) {
      add({ key, op: "eq", value });
      add({ key, op: "neq", value });
      add({ key, op: "contains", value });
      // A piece of the value, cut on code points so the needle is never half an emoji.
      const chars = Array.from(value);
      if (chars.length > 1) {
        const start = Math.floor(rand() * chars.length);
        add({ key, op: "contains", value: chars.slice(start, start + 1 + Math.floor(rand() * 3)).join("") });
      }
    }
    for (const value of await readings(key)) fromReadings.push(goal({ key, op: "eq", value }));
    // not_in is what a split goal's rollup and Other bucket compile to. It is the one
    // operator with no presence check, so a missing key must read as '' and match.
    const listed = [...values];
    add({ key, op: "not_in", values: listed.slice(0, 3) });
    add({ key, op: "not_in", values: listed.filter((v) => v !== "") });
  }

  const [sql, js] = [await sqlHits(goals), jsHits(goals)];
  const disagreements: string[] = [];
  goals.forEach((g, i) => {
    for (const r of rows) {
      const server = sql[i].has(r.message_id);
      const browser = js[i].has(r.message_id);
      let ok: boolean;
      if (!WIDE.has(r.message_id)) ok = browser === server;
      // On 26.8, what 26.4 would say is what it says of a row it cannot read — the empty one.
      else if (readsWideIntegers) ok = browser === (server && sql[i].has(EMPTY));
      else ok = !browser || server;
      if (!ok) disagreements.push(`${describe(g)} on ${r.message_id} ${JSON.stringify(r.properties).slice(0, 120)}: server ${server}, browser ${browser}`);
    }
  });
  assert.equal(disagreements.length, 0, `${disagreements.length} disagreements, first ones:\n${disagreements.slice(0, 15).join("\n")}`);

  // Not vacuous: an eq built from what the server read out of a row hits that row.
  const fromSql = await sqlHits(fromReadings);
  fromSql.forEach((hits, i) => assert.ok(hits.size > 0, `server matched nothing for ${describe(fromReadings[i])}`));
  assert.ok(goals.length > 500, `asked ${goals.length} goals`);
});
