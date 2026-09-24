// Delivery when the server can't be reached. A batch that fails goes back in the queue, and
// these check what happens to it next: that it is sent again without waiting for another
// event to carry it, that it is sent whole, that retries back off instead of riding every
// new event, and that a backlog leaves in requests a browser will actually send. Resending
// a batch the server may already have stored is fine: it keeps each messageId once.
//
// Every client here uses a short flushInterval, and each one is left with an empty queue
// after its test, pass or fail, so no retry timer holds the process open afterwards.
// Leaving the page, which needs a DOM, is in delivery-unload.test.mjs.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Fourier } from "../dist/index.js";

// Captured before any test replaces the global, so waiting here is never itself compressed.
const realSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await wait(5);
  }
  return true;
}

const clients = [];

/** Let the server recover and empty the queue, so no retry timer outlives the test. */
async function settle(f, server) {
  server.script = [];
  server.otherwise = 200;
  await f.flush();
}

afterEach(async () => {
  for (const { f, server } of clients.splice(0)) await settle(f, server);
});

/**
 * A client and the server it talks to. Each request takes the next outcome from
 * `server.script`, then `server.otherwise`: a status code, or "throw" for a network error.
 */
function client(extra = {}) {
  const server = { script: [], otherwise: 200, latency: 0, requests: [], inFlight: 0, mostInFlight: 0 };
  const f = new Fourier({
    writeKey: "fk_test",
    host: "http://analytics.test",
    storage: "memory",
    flushAt: 1000,
    flushInterval: 20,
    fetch: async (_url, init) => {
      const outcome = server.script.length ? server.script.shift() : server.otherwise;
      server.requests.push({
        at: Date.now(),
        outcome,
        body: JSON.parse(init.body),
        bytes: Buffer.byteLength(init.body),
        keepalive: init.keepalive,
      });
      server.mostInFlight = Math.max(server.mostInFlight, ++server.inFlight);
      try {
        if (server.latency) await wait(server.latency);
        if (outcome === "throw") throw new TypeError("Failed to fetch");
        return { ok: outcome >= 200 && outcome < 300, status: outcome };
      } finally {
        server.inFlight--;
      }
    },
    ...extra,
  });
  clients.push({ f, server });
  return { f, server };
}

const ids = (request) => request.body.batch.map((m) => m.messageId);
/** Every messageId the server accepted, in the order it accepted them. */
const delivered = (server) => server.requests.filter((r) => r.outcome === 200).flatMap(ids);

test("a failed flush is retried on its own, with nothing else tracked", async () => {
  const { f, server } = client();
  server.script = ["throw"];
  const m = await f.track("Signed Up");

  // A quiet page: nothing else is tracked, so no new event will come along to carry it.
  assert.ok(await until(() => server.requests.length >= 2), "the failed batch goes out again by itself");
  const [first, second] = server.requests;
  assert.deepEqual(ids(first), [m.messageId]);
  assert.deepEqual(ids(second), [m.messageId], "with the same messageId, so the server can tell it is a resend");
  assert.notEqual(second.body.sentAt, first.body.sentAt, "and a fresh sentAt, so clock correction measures the request that arrived");

  await wait(150);
  assert.equal(server.requests.length, 2, "once delivered it is not sent again");
});

test("server errors and rate limits are retried; any other refusal is dropped", async () => {
  for (const status of [500, 503, 429]) {
    const { f, server } = client();
    server.script = [status];
    const m = await f.track("Retried");
    assert.ok(await until(() => server.requests.length >= 2), `a ${status} is retried`);
    assert.deepEqual(ids(server.requests[1]), [m.messageId]);
  }

  const { f, server } = client();
  server.script = [400];
  await f.track("Refused");
  assert.ok(await until(() => server.requests.length >= 1));
  await wait(200);
  assert.equal(server.requests.length, 1, "a 400 would be refused the same way again, so it is not resent");
  const next = await f.track("Next");
  assert.ok(await until(() => server.requests.length >= 2));
  assert.deepEqual(ids(server.requests[1]), [next.messageId], "and the queue carries on");
});

test("a failed batch is kept whole, not just its first hundred", async () => {
  const { f, server } = client();
  server.script = ["throw"];
  const sent = [];
  for (let i = 0; i < 250; i++) sent.push((await f.track("Item Viewed", { i })).messageId);
  await f.flush();

  assert.ok(await until(() => delivered(server).length >= sent.length), "every message is delivered after the retry");
  assert.deepEqual(delivered(server), sent, "each exactly once, in the order tracked");
});

test("a backlog leaves as requests small enough for keepalive", async () => {
  const { f, server } = client();
  server.script = ["throw"];
  const filler = "x".repeat(400);
  const sent = [];
  for (let i = 0; i < 600; i++) sent.push((await f.track("Item Viewed", { i, filler })).messageId);
  // One message too big for keepalive on its own: it must still go, not block the queue.
  sent.push((await f.track("Huge", { blob: "y".repeat(70 * 1024) })).messageId);
  await f.flush();

  assert.ok(await until(() => delivered(server).length >= sent.length));
  assert.deepEqual(delivered(server), sent);
  const ok = server.requests.filter((r) => r.outcome === 200);
  assert.ok(ok.length > 1, "the backlog is split rather than sent as one request");
  for (const r of ok) {
    const huge = r.body.batch.some((m) => m.event === "Huge");
    if (huge) {
      assert.equal(r.body.batch.length, 1, "the oversized message goes alone");
      assert.equal(r.keepalive, false, "and without keepalive, which the browser would refuse");
    } else {
      assert.ok(r.bytes <= 64 * 1024, `request of ${r.bytes} bytes is over the 64KB keepalive allowance`);
      assert.equal(r.keepalive, true);
    }
  }
});

test("the queue is bounded while delivery fails, dropping the oldest with a debug log", async () => {
  const logs = [];
  const log = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    const { f, server } = client({ debug: true });
    server.otherwise = 503;
    const sent = [];
    for (let i = 0; i < 995; i++) sent.push((await f.track("Item Viewed", { i })).messageId);
    assert.ok(await until(() => server.requests.length >= 1), "a first attempt fails, and the batch goes back in the queue");
    // The page keeps tracking while the server is down, past the queue's limit of 1000.
    for (let i = 0; i < 10; i++) sent.push((await f.track("Item Viewed", { i: 995 + i })).messageId);
    await settle(f, server);

    assert.deepEqual(delivered(server), sent.slice(5), "the five oldest are dropped, and everything newer is delivered");
    // Past the limit each new event pushes out one old one, and each drop is logged.
    const dropped = logs.map((l) => /queue full: dropped the (\d+) oldest/.exec(l)?.[1]).filter(Boolean);
    assert.equal(dropped.reduce((n, d) => n + Number(d), 0), 5, `the drops are logged: ${JSON.stringify(dropped)}`);
  } finally {
    console.log = log;
  }
});

test("while delivery fails, new events wait for the retry, and the retries space out", async () => {
  // flushAt 1: with nothing holding it back, every event would be its own request.
  const { f, server } = client({ flushAt: 1 });
  server.otherwise = "throw";
  await f.track("First");
  const start = Date.now();
  while (Date.now() - start < 700) {
    await f.track("Busy");
    await wait(10);
  }
  const times = server.requests.map((r) => r.at);
  await settle(f, server);

  assert.ok(times.length <= 6, `${times.length} requests in 700ms of an event every 10ms; they should wait for the retry`);
  // First retry after 50-100ms (the 100ms floor, jittered down to half), then doubling.
  times.slice(1).forEach((t, k) => {
    const gap = t - times[k];
    assert.ok(gap >= 50 * 2 ** k - 5, `retry ${k + 1} came ${gap}ms after the attempt before it`);
  });
  assert.ok(server.requests.at(-1).body.batch.length > 1, "the retry carries everything that waited for it");
});

test("the wait between retries doubles up to 30 seconds", async () => {
  // Record each timer's requested delay but run it at once, so twelve failures take
  // milliseconds rather than minutes.
  const delays = [];
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    if (ms > 0) delays.push(ms);
    return realSetTimeout(fn, Math.min(ms, 1), ...args);
  };
  try {
    const { f, server } = client({ flushInterval: 1000 });
    server.otherwise = "throw";
    await f.track("Retried");
    assert.ok(await until(() => server.requests.length >= 12));
    await settle(f, server);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  const [interval, ...retries] = delays;
  assert.equal(interval, 1000, "the first attempt waits for the ordinary flush interval");
  assert.ok(retries.length >= 11);
  retries.slice(0, 11).forEach((d, k) => {
    const ceiling = Math.min(30_000, 1000 * 2 ** k);
    assert.ok(d >= ceiling / 2 && d <= ceiling, `retry ${k + 1} waited ${d}ms, expected ${ceiling / 2}-${ceiling}ms`);
  });
});

test("one flush at a time: flush() during another waits for it and covers what was queued", async () => {
  const { f, server } = client();
  server.latency = 40;
  const a = await f.track("A");
  const first = f.flush();
  const b = await f.track("B");
  await f.flush();

  assert.deepEqual(server.requests.map(ids), [[a.messageId], [b.messageId]], "B goes after A's request, not beside it");
  assert.equal(server.mostInFlight, 1, "never two requests in flight at once");
  assert.deepEqual(delivered(server), [a.messageId, b.messageId], "and both are delivered by the time the second flush resolves");
  await first;
});

test("a message that can't be serialised is dropped on its own", async () => {
  const { f, server } = client();
  const errors = [];
  f.on("error", (e) => errors.push(e));
  const before = await f.track("Before");
  await f.track("Bad", { amount: 10n });
  const after = await f.track("After");
  await f.flush();

  assert.deepEqual(delivered(server), [before.messageId, after.messageId], "the rest of the batch still goes");
  assert.equal(errors.length, 1, "the dropped message is reported");
  await wait(100);
  assert.equal(server.requests.length, 1, "and nothing is left to retry");
});
