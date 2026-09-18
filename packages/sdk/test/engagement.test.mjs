// Engagement is the one metric in Web Analytics that cannot be derived after the fact:
// if the SDK does not measure attention while the page is open, no query will recover
// it later. These cover the measurement itself — that the clock runs only while the
// page is visible and someone is still there, that the total reaches the server
// attached to the page it describes, and that nothing is reported when nothing was
// measured. A page that silently reported zero would be worse than one that reported
// nothing, because zero is a claim.
//
// Needs a DOM, and `isBrowser` is decided when the module first loads, so the stub goes
// in before the import and the SDK is re-imported per scenario.
import { test } from "node:test";
import assert from "node:assert/strict";

const LEAVE = "$page_leave";

function stubBrowser({ path = "/pricing" } = {}) {
  const listeners = { window: new Map(), document: new Map() };
  const add = (bag) => (type, fn) => {
    if (!bag.has(type)) bag.set(type, new Set());
    bag.get(type).add(fn);
  };
  globalThis.window = {
    addEventListener: add(listeners.window),
    removeEventListener() {},
    screen: { width: 1280, height: 800 },
    devicePixelRatio: 1,
  };
  globalThis.document = {
    cookie: "",
    title: "Pricing",
    referrer: "",
    visibilityState: "visible",
    addEventListener: add(listeners.document),
    removeEventListener() {},
  };
  globalThis.location = {
    href: `https://example.com${path}`,
    origin: "https://example.com",
    host: "example.com",
    protocol: "https:",
    pathname: path,
    search: "",
  };
  globalThis.history = { state: null, replaceState() {} };
  const fire = (target, type) => {
    for (const fn of listeners[target].get(type) ?? []) fn({});
  };
  return { fire, listeners };
}

/** Fresh module instance so the module-level `isBrowser` sees the stub. */
async function load() {
  return import(`../dist/index.js?${Math.random()}`);
}

async function setup(options = {}) {
  const dom = stubBrowser();
  const { Fourier } = await load();
  const sent = [];
  const f = new Fourier({
    writeKey: "fk_test",
    host: "http://analytics.test",
    storage: "memory",
    flushAt: 1000,
    // Short, so the queue's own timer is not still armed when the assertions finish —
    // a 100-second flush interval keeps Node's event loop alive for 100 seconds.
    flushInterval: 50,
    fetch: async (_url, init) => {
      for (const m of JSON.parse(init.body).batch) sent.push(m);
      return { ok: true, status: 200 };
    },
    ...options,
  });
  return { f, sent, ...dom };
}

const leaves = (sent) => sent.filter((m) => m.event === LEAVE);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("engagement: a page reports the foreground time it actually measured", async () => {
  const { f, sent, fire } = await setup();
  await f.page();
  await wait(2200);
  fire("window", "pagehide");
  await wait(20);

  const [leave] = leaves(sent);
  assert.ok(leave, "leaving the page reports what was measured");
  const ms = leave.properties.engaged_ms;
  // Two seconds of wall clock, allowing for timer jitter in either direction.
  assert.ok(ms >= 1500 && ms <= 3200, `expected roughly 2s of engagement, got ${ms}ms`);
  assert.equal(leave.properties.path, "/pricing");
});

test("engagement: a hidden tab's time is not counted", async () => {
  const { f, sent, fire } = await setup();
  await f.page();
  await wait(1200);
  // Away from the tab. The clock must stop rather than keep running in the background.
  globalThis.document.visibilityState = "hidden";
  fire("document", "visibilitychange");
  await wait(2500);
  fire("window", "pagehide");
  await wait(20);

  const total = leaves(sent).reduce((n, m) => n + m.properties.engaged_ms, 0);
  assert.ok(total < 2000, `hidden time must not be credited, got ${total}ms across ${leaves(sent).length} beacons`);
  assert.ok(total >= 800, `the visible second before hiding should still count, got ${total}ms`);
});

test("engagement: an idle page stops counting", async () => {
  // Comfortably above the one-second tick, so there is a window to measure before it
  // goes idle; an idle timeout equal to the tick would leave nothing to assert about.
  const { f, sent, fire } = await setup({ engagementIdleTimeout: 2000 });
  await f.page();
  // Never touched. After the idle timeout the clock stops, so five seconds of an
  // abandoned tab does not become five seconds of reading.
  await wait(5000);
  fire("window", "pagehide");
  await wait(20);

  const [leave] = leaves(sent);
  assert.ok(leave, "some time was measured before it went idle");
  assert.ok(leave.properties.engaged_ms <= 3000, `idle time must not accumulate, got ${leave.properties.engaged_ms}ms of 5s elapsed`);
});

test("engagement: a route change closes out the page being left, not the new one", async () => {
  const { f, sent, fire } = await setup();
  await f.page();
  await wait(1500);
  globalThis.location.pathname = "/docs";
  globalThis.location.href = "https://example.com/docs";
  await f.page();
  // Longer than the flush interval: the beacon is enqueued by the route change, and
  // unlike a real navigation there is no unload here to force it out.
  await wait(200);

  const [leave] = leaves(sent);
  assert.ok(leave, "the first page reports before the second begins");
  assert.equal(leave.properties.path, "/pricing", "the time belongs to the page it was spent on");
  assert.equal(leave.context.page.path, "/pricing", "and so does the page context it carries");
  // The new page's own measurement is still open and must not have been reported yet.
  assert.equal(leaves(sent).length, 1);
  // The second page is still being timed, and its interval would keep this process
  // alive after the assertions pass. Leaving is what a real browser does next anyway.
  fire("window", "pagehide");
});

test("engagement: nothing measured reports nothing, rather than a zero", async () => {
  const { f, sent, fire } = await setup();
  await f.page();
  // Left immediately. A beacon here would land as a page that engaged someone for no
  // time at all, which is indistinguishable from one the SDK never measured.
  fire("window", "pagehide");
  await wait(20);
  assert.equal(leaves(sent).length, 0);
});

test("engagement: can be switched off, and then never reports", async () => {
  const { f, sent, fire } = await setup({ engagement: false });
  await f.page();
  await wait(1500);
  fire("window", "pagehide");
  await wait(20);
  assert.equal(leaves(sent).length, 0, "opted out means no measurement at all");
  assert.equal(sent.filter((m) => m.type === "page").length, 1, "ordinary page views are unaffected");
});
