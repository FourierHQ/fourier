/**
 * Does one event, as the UI already holds it, complete a goal?
 *
 * The same question `matchSql` in ./definitions asks of a row of `events`, asked here
 * of an event the browser has in hand — so a list of events can mark the rows that are
 * conversions without a round trip per row.
 *
 * It is a deliberate second implementation of one rule, which is a thing worth being
 * nervous about. Two mitigations: this file is pure and dependency-free so it can be
 * read against the SQL side by side, and every quirk of the SQL that a naive JavaScript
 * version would get wrong is called out below. The two must move together.
 *
 * Pure by construction — no database client, no node builtins — so it is importable
 * from a client component, which the package root is not.
 */

import type { GoalMatch, PathRule, PropertyFilter } from "./definitions";

/** The event shape this needs. Anything with these fields will do. */
export interface MatchableEvent {
  type: string;
  event: string;
  path?: string | null;
  properties?: Record<string, unknown> | null;
}

/** Mirrors normalizedPath: empty is the root, and a trailing slash is not significant. */
function normalize(path: string): string {
  if (path === "") return "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function pathMatches(rule: PathRule, path: string): boolean {
  const norm = normalize(path);
  const value = rule.value.trim();
  const trimmed = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  switch (rule.op) {
    case "exact":
      return norm === trimmed;
    case "prefix":
      // Root is the whole site, exactly as pathRuleSql compiles it to `1`.
      if (trimmed === "" || trimmed === "/") return true;
      return norm === trimmed || norm.startsWith(`${trimmed}/`);
    case "contains":
      return norm.includes(trimmed);
  }
}

type Doc = Record<string, unknown> | null;

/**
 * Every way the server could read the properties: normally one, and null when it cannot
 * read them at all.
 *
 * The server never sees this object. It sees the text ingest stored, which is
 * `JSON.stringify(properties)` (see normalize in ./ingest, the only writer of events),
 * parsed by ClickHouse. So this is that text parsed back, which also settles everything
 * JSON.stringify decides on the way: a key whose value is undefined is not there, NaN is
 * null, a -0 is 0.
 *
 * ClickHouse refuses the whole text, not just the offending value, for two things
 * JSON.stringify will write: a lone surrogate (half an emoji, which cutting a string
 * with `slice` produces) in any key or string, and nesting deeper than 1024 levels.
 * When it refuses, JSONHas is false and JSONExtractString is '' for every key, so a
 * `neq` goal fails too.
 *
 * And for one thing the versions Fourier runs disagree, so there are two readings: an
 * integer outside the 64-bit range, which JavaScript writes as plain digits from 2^64 up
 * to 1e21. 26.8 (CI, and `latest` locally) reads it; 26.4 (production) refuses the whole
 * text over it. This cannot know which one is answering, so a goal has to hold under
 * both: never a mark the report does not count, at the price of a missing mark on 26.8.
 * Under that rule how 26.8 spells such an integer never decides anything, so it is not
 * modelled. Once 26.4 is gone, drop the second reading and teach `json` that 26.8 quotes
 * one when nested: `[2 ** 64]` reads `["18446744073709552000"]`.
 *
 * Checked against 26.4 and 26.8 by hand, and against CI's version by
 * goal-match.integration.mts, which runs the same rows through both sides.
 */
function serverReadings(properties: Record<string, unknown> | null | undefined): Doc[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(properties ?? {}));
  } catch {
    return [null]; // circular or a BigInt: ingest could not have stored it either
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [null];
  const found = { wide: false };
  if (!readable(parsed, 1, found)) return [null];
  return found.wide ? [parsed as Doc, null] : [parsed as Doc];
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
/** The deepest level ClickHouse parses, counting the properties object itself as 1. */
const MAX_DEPTH = 1024;

function readable(v: unknown, level: number, found: { wide: boolean }): boolean {
  if (level > MAX_DEPTH) return false;
  if (typeof v === "string") return !LONE_SURROGATE.test(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) && isWide(spellNumber(v))) found.wide = true;
    return true;
  }
  if (v === null || typeof v !== "object") return true;
  if (Array.isArray(v)) return v.every((x) => readable(x, level + 1, found));
  return Object.entries(v).every(([k, x]) => !LONE_SURROGATE.test(k) && readable(x, level + 1, found));
}

// Strings rather than literals: the web app compiles this file for ES2017, which has no
// BigInt literal syntax.
const UINT64_MAX = BigInt("18446744073709551615");
const INT64_MIN = BigInt("-9223372036854775808");

/** A number spelled as an integer that fits neither Int64 nor UInt64. */
function isWide(spelled: string): boolean {
  if (!/^-?\d+$/.test(spelled)) return false;
  const n = BigInt(spelled);
  return n > UINT64_MAX || n < INT64_MIN;
}

/**
 * Mirrors JSONExtractString, which on the versions Fourier runs returns every value in
 * its own spelling rather than '' for anything that is not a string:
 *
 * - a string is itself, unescaped;
 * - a number is spelled as JavaScript spells it, except that an exponent is `1e21`
 *   where JavaScript writes `1e+21`. That holds for every double: ClickHouse formats
 *   floats as the shortest string that round-trips, as JavaScript does, and echoes
 *   integers digit for digit;
 * - true and false are "true" and "false";
 * - null is '', though JSONHas still counts the key as present;
 * - an object or array is compact JSON, with the differences `json` below handles.
 *
 * So `form_id eq "42"` matches a numeric 42, and `plan eq "5"` matches a numeric 5.
 */
function extract(doc: Doc, key: string): string {
  if (!doc || !Object.hasOwn(doc, key)) return "";
  return spell(doc[key]);
}

function has(doc: Doc, key: string): boolean {
  return doc != null && Object.hasOwn(doc, key);
}

function spell(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "";
  if (typeof v === "number") return spellNumber(v);
  if (typeof v === "boolean") return String(v);
  return json(v);
}

function spellNumber(n: number): string {
  return String(n).replace("e+", "e");
}

/**
 * An object or array as ClickHouse writes it back out: compact, keys in the order they
 * were stored (which is JavaScript's order, since JSON.stringify stored them), numbers
 * spelled as above, and strings escaped as JSON.stringify escapes them except in two
 * places — a control character's hex is upper case (\u001B, not \u001b), and U+2028 and
 * U+2029 are escaped rather than written raw.
 */
function json(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return quote(v);
  if (typeof v === "number") return spellNumber(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(json).join(",")}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${quote(k)}:${json(x)}`)
    .join(",")}}`;
}

function quote(s: string): string {
  // Escapes are matched whole, so the `\\` of an escaped backslash is never mistaken for
  // the start of a \u escape that happens to follow it.
  return JSON.stringify(s).replace(/\\(?:u[0-9a-f]{4}|.)|[\u2028\u2029]/g, (m) =>
    m.length === 1 ? `\\u${m.charCodeAt(0).toString(16)}` : m.length === 6 ? `\\u${m.slice(2).toUpperCase()}` : m,
  );
}

function propertyMatches(f: PropertyFilter, doc: Doc): boolean {
  switch (f.op) {
    case "exists":
      return has(doc, f.key);
    case "eq":
      return extract(doc, f.key) === (f.value ?? "");
    case "neq":
      // The key must be present. Without this, "plan is not free" would be true of every
      // event carrying no plan at all — see the note on the SQL side. A null counts as
      // present here, as it does to JSONHas, even though it reads as ''.
      return has(doc, f.key) && extract(doc, f.key) !== (f.value ?? "");
    case "contains":
      // position(x, '') is 1 whatever x is, so an empty needle matches even a missing key.
      return f.value ? extract(doc, f.key).includes(f.value) : true;
  }
}

export function eventMatches(match: GoalMatch, e: MatchableEvent): boolean {
  if (match.match === "pageview") return e.type === "page" && pathMatches(match.path, e.path ?? "");
  if (e.event !== match.event) return false;
  const filters = match.properties ?? [];
  if (!filters.length) return true;
  return serverReadings(e.properties).every((doc) => filters.every((f) => propertyMatches(f, doc)));
}
