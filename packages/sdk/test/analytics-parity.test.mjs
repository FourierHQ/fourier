// Checks the analytics.js argument conventions against the built SDK (run `pnpm build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Fourier, readCrossDomainIds, hostMatches } from "../dist/index.js";

function client(extra = {}) {
  const sent = [];
  const f = new Fourier({
    writeKey: "fk_test",
    host: "http://analytics.test",
    storage: "memory",
    flushAt: 1000,
    flushInterval: 100000,
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
    ...extra,
  });
  return { f, sent };
}

test("identify(userId, traits) sets user and merges traits", async () => {
  const { f } = client();
  const m1 = await f.identify("u1", { email: "a@b.c" });
  const m2 = await f.identify({ plan: "pro" }); // traits only, keeps userId
  assert.equal(m1.type, "identify");
  assert.equal(m1.userId, "u1");
  assert.equal(m2.userId, "u1");
  assert.deepEqual(m2.traits, { email: "a@b.c", plan: "pro" });
  assert.deepEqual(f.user().traits(), { email: "a@b.c", plan: "pro" });
  assert.equal(f.user().id(), "u1");
});

test("identify(userId, traits, options, callback) applies options and fires callback", async () => {
  const { f } = client();
  let cbMsg;
  const m = await f.identify("u2", { a: 1 }, { context: { ip: "1.2.3.4" }, anonymousId: "anon-x", timestamp: "2020-01-01T00:00:00.000Z" }, (msg) => (cbMsg = msg));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(m.context.ip, "1.2.3.4");
  assert.equal(m.anonymousId, "anon-x");
  assert.equal(m.timestamp, "2020-01-01T00:00:00.000Z");
  assert.equal(cbMsg.messageId, m.messageId);
});

test("identify(userId, callback) shifts arguments", async () => {
  const { f } = client();
  let called = false;
  await f.identify("u3", () => (called = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(called);
});

test("track(event, properties) and track(event, callback)", async () => {
  const { f } = client();
  const m = await f.track("Signed Up", { plan: "pro" });
  assert.equal(m.type, "track");
  assert.equal(m.event, "Signed Up");
  assert.deepEqual(m.properties, { plan: "pro" });
  let cb = false;
  const m2 = await f.track("Clicked", () => (cb = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(cb);
  assert.deepEqual(m2.properties, {});
});

test("page() argument variants", async () => {
  const { f } = client();
  const a = await f.page();
  assert.equal(a.type, "page");
  assert.equal(a.name, undefined);
  const b = await f.page("Home");
  assert.equal(b.name, "Home");
  const c = await f.page("Docs", "Getting Started");
  assert.equal(c.category, "Docs");
  assert.equal(c.name, "Getting Started");
  const d = await f.page("Pricing", { plan: "pro" });
  assert.equal(d.name, "Pricing");
  assert.equal(d.properties.plan, "pro");
  const e = await f.page({ foo: "bar" });
  assert.equal(e.name, undefined);
  assert.equal(e.properties.foo, "bar");
  const g = await f.page("Docs", "Intro", { x: 1 }, { context: { ip: "9.9.9.9" } });
  assert.equal(g.context.ip, "9.9.9.9");
  assert.equal(g.properties.x, 1);
});

test("group(groupId, traits) attaches groupId to following events; group() returns handle", async () => {
  const { f } = client();
  await f.identify("u1");
  const g = await f.group("acme", { name: "Acme" });
  assert.equal(g.type, "group");
  assert.equal(g.groupId, "acme");
  assert.equal(g.context.groupId, "acme");
  const t = await f.track("Did Thing");
  assert.equal(t.context.groupId, "acme");
  assert.equal(f.group().id(), "acme");
  assert.deepEqual(f.group().traits(), { name: "Acme" });
});

test("alias(userId, previousId) and alias(userId) default previousId", async () => {
  const { f } = client();
  const anon = f.anonymousId();
  const a = await f.alias("new-id");
  assert.equal(a.type, "alias");
  assert.equal(a.userId, "new-id");
  assert.equal(a.previousId, anon);
  const b = await f.alias("newer", "older");
  assert.equal(b.previousId, "older");
  assert.equal(f.user().id(), "newer");
});

test("reset() clears user, group, traits and rotates anonymousId", async () => {
  const { f } = client();
  const anon = f.anonymousId();
  await f.identify("u1", { a: 1 });
  await f.group("g1", { b: 2 });
  f.reset();
  assert.equal(f.user().id(), null);
  assert.deepEqual(f.user().traits(), {});
  assert.equal(f.group().id(), null);
  assert.notEqual(f.anonymousId(), anon);
});

test("flush posts a Segment-shaped batch to /v1/batch", async () => {
  const { f, sent } = client();
  await f.identify("u1", { email: "x@y.z" });
  await f.track("Signed Up", { plan: "pro" });
  await f.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://analytics.test/v1/batch");
  const { writeKey, batch, sentAt } = sent[0].body;
  assert.equal(writeKey, "fk_test");
  assert.ok(sentAt);
  assert.equal(batch.length, 2);
  for (const m of batch) {
    assert.ok(m.messageId && m.timestamp && m.anonymousId && m.context.library.name === "fourier");
    assert.equal(m.userId, "u1");
  }
  assert.equal(batch[0].type, "identify");
  assert.equal(batch[1].type, "track");
});

test("flushAt triggers an automatic flush", async () => {
  const { f, sent } = client({ flushAt: 2 });
  await f.track("a");
  await f.track("b");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.batch.length, 2);
});

test("on/once/off emitter and ready()", async () => {
  const { f } = client();
  const seen = [];
  f.on("track", (event, props) => seen.push([event, props]));
  f.once("identify", () => seen.push("identify-once"));
  await f.track("A", { n: 1 });
  await f.identify("u");
  await f.identify("u");
  f.off("track");
  await f.track("B");
  assert.deepEqual(seen, [["A", { n: 1 }], "identify-once"]);
  let readyCalled = false;
  await f.ready(() => (readyCalled = true));
  await new Promise((r) => setTimeout(r, 1));
  assert.ok(readyCalled);
});

test("source middleware can mutate and drop", async () => {
  const { f } = client();
  f.addSourceMiddleware(({ payload, next }) => {
    if (payload.event === "drop me") return next(null);
    payload.properties = { ...payload.properties, injected: true };
    next(payload);
  });
  const kept = await f.track("keep", { a: 1 });
  assert.deepEqual(kept.properties, { a: 1, injected: true });
  const dropped = await f.track("drop me");
  assert.equal(dropped, null);
});

test("disabled client never sends", async () => {
  const { f, sent } = client({ disabled: true });
  await f.track("x");
  await f.flush();
  assert.equal(sent.length, 0);
});

test("static load() and singleton helpers", async () => {
  const f = Fourier.load("fk_x", { host: "http://h", storage: "memory", disabled: true });
  assert.ok(f instanceof Fourier);
  assert.equal(f.options.writeKey, "fk_x");
});

test("sessions: first message starts a session, later ones reuse it, timeout starts a new one", async () => {
  const { f } = client({ sessionTimeout: 50 });
  const a = await f.track("a");
  const b = await f.track("b");
  assert.equal(a.context.session.isNew, true);
  assert.equal(b.context.session.isNew, false);
  assert.equal(a.context.session.id, b.context.session.id);
  await new Promise((r) => setTimeout(r, 80));
  const c = await f.track("c");
  assert.equal(c.context.session.isNew, true);
  assert.notEqual(c.context.session.id, a.context.session.id);
  f.reset();
  assert.equal(f.sessionId(), null);
  await f.track("d");
  const before = f.sessionId();
  f.newSession();
  const e = await f.track("e");
  assert.equal(e.context.session.isNew, true);
  assert.notEqual(e.context.session.id, before);
});

test("sessions can be disabled", async () => {
  const { f } = client({ sessionTimeout: 0 });
  const m = await f.track("a");
  assert.equal(m.context.session, undefined);
});

test("cross-domain: decorateUrl adds ajs_aid/ajs_uid only for listed domains", async () => {
  const { f } = client({ crossDomain: ["cantina.xyz", "example.io"] });
  const anon = f.anonymousId();
  assert.equal(f.decorateUrl("https://google.com/x"), "https://google.com/x");
  const a = new URL(f.decorateUrl("https://clarion.cantina.xyz/login?next=/home"));
  assert.equal(a.searchParams.get("ajs_aid"), anon);
  assert.equal(a.searchParams.get("ajs_uid"), null);
  assert.equal(a.searchParams.get("next"), "/home");
  await f.identify("u42");
  const b = new URL(f.decorateUrl("https://example.io/"));
  assert.equal(b.searchParams.get("ajs_uid"), "u42");
  assert.equal(b.searchParams.get("ajs_aid"), anon);
  // no crossDomain configured: untouched
  const { f: plain } = client();
  assert.equal(plain.decorateUrl("https://cantina.xyz/"), "https://cantina.xyz/");
});

test("cross-domain: readCrossDomainIds and hostMatches", () => {
  assert.deepEqual(readCrossDomainIds("?ajs_aid=abc&ajs_uid=u1&x=1"), { anonymousId: "abc", userId: "u1" });
  assert.deepEqual(readCrossDomainIds("?x=1"), {});
  assert.ok(hostMatches("ai.cantina.xyz", ["cantina.xyz"]));
  assert.ok(hostMatches("cantina.xyz:3000", [".cantina.xyz"]));
  assert.ok(!hostMatches("notcantina.xyz", ["cantina.xyz"]));
  assert.ok(!hostMatches("cantina.security", ["cantina.xyz"]));
});
