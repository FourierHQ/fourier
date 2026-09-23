/**
 * eventMatches, the browser's copy of matchSql, case by case.
 *
 * Every expectation here is what ClickHouse answers for the same row, checked by hand
 * against 26.4 and 26.8; goal-match.integration.mts asks ClickHouse itself. The cases
 * that matter most are the ones a JavaScript author would guess wrong: non-string
 * values are compared in their own spelling rather than as '', a missing key reads as
 * '', and `neq` still requires the key to be there.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventMatches, type MatchableEvent } from "../src/goal-match";
import type { GoalMatch, PropertyFilter } from "../src/definitions";

const EVENT = "form_submitted";

function ev(properties: Record<string, unknown> | null | undefined): MatchableEvent {
  return { type: "track", event: EVENT, properties };
}

function goal(...properties: PropertyFilter[]): GoalMatch {
  return { match: "event", event: EVENT, properties };
}

const eq = (key: string, value: string): PropertyFilter => ({ key, op: "eq", value });
const neq = (key: string, value: string): PropertyFilter => ({ key, op: "neq", value });
const contains = (key: string, value: string): PropertyFilter => ({ key, op: "contains", value });
const exists = (key: string): PropertyFilter => ({ key, op: "exists" });

const matches = (props: Record<string, unknown> | null | undefined, ...filters: PropertyFilter[]) => eventMatches(goal(...filters), ev(props));

test("a string compares as itself", () => {
  assert.equal(matches({ plan: "pro" }, eq("plan", "pro")), true);
  assert.equal(matches({ plan: "pro" }, eq("plan", "Pro")), false, "case-sensitive, as = is");
  assert.equal(matches({ plan: "pro" }, neq("plan", "free")), true);
  assert.equal(matches({ plan: "pro" }, neq("plan", "pro")), false);
  assert.equal(matches({ plan: "enterprise" }, contains("plan", "terp")), true);
  assert.equal(matches({ plan: "enterprise" }, contains("plan", "TERP")), false);
  assert.equal(matches({ plan: "" }, eq("plan", "")), true);
});

test("a number compares in its own spelling, not as ''", () => {
  // The reported bug: the server counts this, the browser did not mark it.
  assert.equal(matches({ form_id: 42 }, eq("form_id", "42")), true);
  assert.equal(matches({ form_id: 42 }, eq("form_id", "")), false);
  assert.equal(matches({ form_id: 42 }, neq("form_id", "42")), false);
  assert.equal(matches({ form_id: 42 }, neq("form_id", "43")), true);
  assert.equal(matches({ form_id: 42 }, contains("form_id", "4")), true);
  assert.equal(matches({ delta: -7 }, eq("delta", "-7")), true);
  assert.equal(matches({ n: 0 }, eq("n", "0")), true);
});

test("a float is spelled as ClickHouse spells it", () => {
  assert.equal(matches({ price: 1.5 }, eq("price", "1.5")), true);
  assert.equal(matches({ price: 0.1 }, eq("price", "0.1")), true);
  assert.equal(matches({ price: 1 / 3 }, eq("price", "0.3333333333333333")), true);
  // A float with no fraction is an integer by the time JSON.stringify stores it.
  assert.equal(matches({ total: 1e3 }, eq("total", "1000")), true);
  assert.equal(matches({ total: 100.0 }, eq("total", "100")), true);
  assert.equal(matches({ tiny: 1e-7 }, eq("tiny", "1e-7")), true);
  // The one place JavaScript and ClickHouse spell a double differently.
  assert.equal(matches({ huge: 1e21 }, eq("huge", "1e21")), true);
  assert.equal(matches({ huge: 1e21 }, eq("huge", "1e+21")), false);
  assert.equal(matches({ huge: 1.5e300 }, eq("huge", "1.5e300")), true);
  // An integer past 2^53 is stored in JavaScript's spelling, which pads with zeros past
  // the digits that round-trip, and ClickHouse reads an integer back digit for digit.
  assert.equal(matches({ id: 2 ** 60 }, eq("id", "1152921504606847000")), true);
  assert.equal(matches({ id: 2 ** 60 }, eq("id", "1152921504606846976")), false);
  // JSON.stringify writes -0 as 0, and NaN as null.
  assert.equal(matches({ z: -0 }, eq("z", "0")), true);
  assert.equal(matches({ z: NaN }, eq("z", "")), true);
  assert.equal(matches({ z: NaN }, exists("z")), true);
});

test("a boolean compares as true or false", () => {
  assert.equal(matches({ ok: true }, eq("ok", "true")), true);
  assert.equal(matches({ ok: false }, eq("ok", "false")), true);
  assert.equal(matches({ ok: true }, eq("ok", "")), false);
  assert.equal(matches({ ok: true }, neq("ok", "false")), true);
  assert.equal(matches({ ok: true }, contains("ok", "ru")), true);
});

test("null reads as '' but is present", () => {
  assert.equal(matches({ coupon: null }, eq("coupon", "")), true);
  assert.equal(matches({ coupon: null }, eq("coupon", "null")), false);
  assert.equal(matches({ coupon: null }, exists("coupon")), true);
  assert.equal(matches({ coupon: null }, neq("coupon", "SAVE10")), true);
  assert.equal(matches({ coupon: null }, neq("coupon", "")), false);
  assert.equal(matches({ coupon: null }, contains("coupon", "null")), false);
});

test("an object or array compares as compact JSON", () => {
  assert.equal(matches({ tags: ["pro", "beta"] }, eq("tags", '["pro","beta"]')), true);
  assert.equal(matches({ tags: ["pro", "beta"] }, contains("tags", '"pro"')), true);
  assert.equal(matches({ tags: [] }, eq("tags", "[]")), true);
  assert.equal(matches({ cart: { sku: "A1", qty: 2 } }, eq("cart", '{"sku":"A1","qty":2}')), true);
  assert.equal(matches({ cart: {} }, eq("cart", "{}")), true);
  assert.equal(matches({ mixed: [1, "x", true, null, { a: 1e21 }] }, eq("mixed", '[1,"x",true,null,{"a":1e21}]')), true);
  // Keys in the order JSON.stringify stored them, which puts integer-like keys first.
  assert.equal(matches({ m: { b: 1, 2: 2, a: 3 } }, eq("m", '{"2":2,"b":1,"a":3}')), true);
  // ClickHouse's escaping: upper-case hex for control characters, and U+2028 escaped.
  assert.equal(matches({ s: ["a\u001bb"] }, eq("s", '["a\\u001Bb"]')), true);
  assert.equal(matches({ s: ["a\u2028b"] }, eq("s", '["a\\u2028b"]')), true);
  assert.equal(matches({ s: ["a\nb\t\"c\\"] }, eq("s", '["a\\nb\\t\\"c\\\\"]')), true);
  // A backslash followed by text that looks like an escape is still just a backslash.
  assert.equal(matches({ s: ["\\u001b"] }, eq("s", '["\\\\u001b"]')), true);
  // Not escaped: "/", non-ASCII, astral characters.
  assert.equal(matches({ s: ["a/é/中/😀"] }, eq("s", '["a/é/中/😀"]')), true);
  // Big integers that still fit 64 bits are numbers like any other.
  assert.equal(matches({ ids: [2 ** 63] }, eq("ids", "[9223372036854776000]")), true, "a UInt64");
  assert.equal(matches({ ids: [1e21] }, eq("ids", "[1e21]")), true, "an exponent is a double, whatever its size");
  // Undefined inside an array is null, inside an object it is gone — as JSON.stringify stored it.
  assert.equal(matches({ a: [undefined, 1], o: { x: undefined, y: 1 } }, eq("a", "[null,1]"), eq("o", '{"y":1}')), true);
});

test("a missing key reads as '' and does not exist", () => {
  assert.equal(matches({ other: "x" }, exists("plan")), false);
  assert.equal(matches({ other: "x" }, eq("plan", "")), true, "'' = '' on the server too");
  assert.equal(matches({ other: "x" }, eq("plan", "free")), false);
  assert.equal(matches({ other: "x" }, contains("plan", "f")), false);
  assert.equal(matches({ other: "x" }, contains("plan", "")), true, "position(x, '') is 1 for any x");
  assert.equal(matches({}, eq("plan", "")), true);
  assert.equal(matches(null, eq("plan", "")), true);
  assert.equal(matches(undefined, exists("plan")), false);
  // A key whose value is undefined was never stored.
  assert.equal(matches({ plan: undefined }, exists("plan")), false);
  // Own keys only: nothing inherited from Object.prototype.
  assert.equal(matches({}, exists("toString")), false);
  assert.equal(matches({}, exists("__proto__")), false);
  assert.equal(matches(JSON.parse('{"__proto__":"x"}'), eq("__proto__", "x")), true);
  // A key is one level, never a path.
  assert.equal(matches({ a: { b: "x" } }, exists("a.b")), false);
  assert.equal(matches({ "a.b": "x" }, eq("a.b", "x")), true);
});

test("neq requires the key to be present", () => {
  // Otherwise "plan is not free" would be true of every event that carries no plan at all.
  assert.equal(matches({}, neq("plan", "free")), false);
  assert.equal(matches({ other: 1 }, neq("plan", "free")), false);
  assert.equal(matches({ plan: undefined }, neq("plan", "free")), false);
  assert.equal(matches({ plan: "pro" }, neq("plan", "free")), true);
  assert.equal(matches({ plan: "free" }, neq("plan", "free")), false);
  assert.equal(matches({ plan: "" }, neq("plan", "free")), true);
  assert.equal(matches({ plan: 5 }, neq("plan", "free")), true);
});

test("properties ClickHouse cannot parse have no keys at all", () => {
  // Half an emoji anywhere in the blob, even under another key, and even in a key.
  const halfEmoji = "😀".slice(0, 1);
  assert.equal(matches({ plan: "pro", note: `cut${halfEmoji}` }, eq("plan", "pro")), false);
  assert.equal(matches({ plan: "pro", note: `cut${halfEmoji}` }, exists("plan")), false);
  assert.equal(matches({ plan: "pro", note: `cut${halfEmoji}` }, neq("plan", "free")), false);
  assert.equal(matches({ plan: "pro", note: `cut${halfEmoji}` }, eq("plan", "")), true);
  assert.equal(matches({ plan: "pro", [`k${halfEmoji}`]: 1 }, exists("plan")), false);
  assert.equal(matches({ plan: "pro", n: ["😀".slice(1)] }, exists("plan")), false);
  // A whole emoji is fine.
  assert.equal(matches({ plan: "pro", note: "😀" }, eq("plan", "pro")), true);

  // Nesting: the properties object is level 1 and 1024 is the deepest value it reads.
  const nest = (levels: number): unknown => {
    let v: unknown = "leaf";
    for (let i = 0; i < levels; i++) v = [v];
    return v;
  };
  assert.equal(matches({ plan: "pro", deep: nest(1022) }, exists("plan")), true, "leaf at level 1024");
  assert.equal(matches({ plan: "pro", deep: nest(1023) }, exists("plan")), false, "leaf at level 1025");
});

test("an integer beyond 64 bits is marked only where every ClickHouse version agrees", () => {
  // 26.8 reads 2^64 (spelled 18446744073709552000) as its digits, or as a quoted string
  // when nested; 26.4 refuses the whole properties object over it. So a goal that needs
  // the properties read is never marked, on any key...
  assert.equal(matches({ id: 2 ** 64 }, eq("id", "18446744073709552000")), false);
  assert.equal(matches({ id: 2 ** 64 }, exists("id")), false);
  assert.equal(matches({ ids: [2 ** 64] }, eq("ids", '["18446744073709552000"]')), false);
  assert.equal(matches({ plan: "pro", ids: [-(2 ** 63)] }, eq("plan", "pro")), false, "-2^63 is spelled past Int64's minimum");
  assert.equal(matches({ plan: "pro", ids: [2 ** 64] }, neq("plan", "free")), false);
  assert.equal(matches({ plan: "pro", ids: [2 ** 64] }, eq("plan", "")), false, "26.4 reads '', 26.8 reads pro");
  // ...while one that both versions answer the same way still is.
  assert.equal(matches({ plan: "pro", ids: [2 ** 64] }, eq("missing", "")), true);
  assert.equal(matches({ plan: "pro", ids: [2 ** 64] }, contains("plan", "")), true);
});

test("every filter must hold, and the event name must match", () => {
  const props = { plan: "pro", seats: 5 };
  assert.equal(matches(props, eq("plan", "pro"), eq("seats", "5")), true);
  assert.equal(matches(props, eq("plan", "pro"), eq("seats", "6")), false);
  assert.equal(matches(props), true);
  assert.equal(eventMatches({ match: "event", event: "other" }, ev(props)), false);
  assert.equal(eventMatches({ match: "event", event: EVENT }, { type: "track", event: EVENT }), true);
});

test("page views match on the normalised path", () => {
  const page = (path: string): MatchableEvent => ({ type: "page", event: "", path });
  assert.equal(eventMatches({ match: "pageview", path: { op: "exact", value: "/pricing/" } }, page("/pricing")), true);
  assert.equal(eventMatches({ match: "pageview", path: { op: "prefix", value: "/blog" } }, page("/blog/x")), true);
  assert.equal(eventMatches({ match: "pageview", path: { op: "prefix", value: "/blog" } }, page("/blogroll")), false);
  assert.equal(eventMatches({ match: "pageview", path: { op: "prefix", value: "/" } }, page("")), true);
  assert.equal(eventMatches({ match: "pageview", path: { op: "exact", value: "/" } }, { type: "track", event: "x", path: "/" }), false);
});
