// Leaving the page with a backlog. The rest of delivery is in delivery.test.mjs; this one
// needs a DOM, and `isBrowser` is decided when the SDK's shared chunk first loads, so the
// stub goes in before the SDK is imported at all.
import { test } from "node:test";
import assert from "node:assert/strict";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stubBrowser() {
  const listeners = new Map();
  const beacons = [];
  globalThis.window = { addEventListener() {}, removeEventListener() {}, screen: { width: 1280, height: 800 }, devicePixelRatio: 1 };
  globalThis.document = {
    cookie: "",
    title: "Pricing",
    referrer: "",
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener() {},
  };
  globalThis.location = { href: "https://example.com/", origin: "https://example.com", host: "example.com", protocol: "https:", pathname: "/", search: "" };
  globalThis.history = { state: null, replaceState() {} };
  // Node has a navigator of its own, as a getter, so it is replaced rather than assigned.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "test",
      language: "en",
      sendBeacon: (_url, blob) => {
        beacons.push(blob);
        // Browsers refuse a beacon over 64KB.
        return blob.size <= 64 * 1024;
      },
    },
  });
  const fire = (type) => {
    for (const fn of listeners.get(type) ?? []) fn({});
  };
  return { beacons, fire };
}

test("leaving the page sends a backlog as beacons that each fit", async () => {
  const { beacons, fire } = stubBrowser();
  const { Fourier } = await import("../dist/index.js");
  const server = { up: false, requests: 0 };
  const f = new Fourier({
    writeKey: "fk_test",
    host: "http://analytics.test",
    storage: "memory",
    flushAt: 1000,
    flushInterval: 20,
    engagement: false,
    fetch: async () => {
      server.requests++;
      if (!server.up) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200 };
    },
  });
  try {
    const sent = [];
    const filler = "x".repeat(400);
    for (let i = 0; i < 300; i++) sent.push((await f.track("Item Viewed", { i, filler })).messageId);
    await f.flush();
    assert.equal(server.requests, 1, "the backlog has failed once and is waiting to retry");

    globalThis.document.visibilityState = "hidden";
    fire("visibilitychange");
    await wait(20);

    assert.ok(beacons.length > 1, "split across beacons rather than one the browser would refuse");
    for (const b of beacons) assert.ok(b.size <= 64 * 1024, `a ${b.size} byte beacon is over the limit`);
    const bodies = await Promise.all(beacons.map(async (b) => JSON.parse(await b.text())));
    assert.deepEqual(bodies.flatMap((p) => p.batch.map((m) => m.messageId)), sent, "and together they carry the whole backlog");
    assert.equal(server.requests, 1, "with no fetch needed once every beacon was accepted");
  } finally {
    // Whatever failed above, leave nothing queued for a retry timer to keep the process up.
    server.up = true;
    await f.flush();
  }
});
