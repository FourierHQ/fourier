// `ajs_uid` in a URL is an assertion about who the visitor is, and anyone can put
// one in a link. These cover the gate on accepting it: ids are taken only when
// cross-domain identity is configured AND the visitor arrived from a listed host.
//
// Needs a DOM, and `isBrowser` is decided when the module first loads, so the
// stub goes in before the import and the SDK is re-imported per scenario.
import { test } from "node:test";
import assert from "node:assert/strict";

function stubBrowser({ search = "", referrer = "" } = {}) {
  globalThis.window = { addEventListener() {}, screen: { width: 1280, height: 800 }, devicePixelRatio: 1 };
  globalThis.document = { cookie: "", title: "", referrer, addEventListener() {} };
  globalThis.location = {
    href: `https://app.example.com/landing${search}`,
    origin: "https://app.example.com",
    host: "app.example.com",
    protocol: "https:",
    pathname: "/landing",
    search,
  };
  globalThis.history = {
    state: null,
    replaceState(_state, _title, url) {
      globalThis.location.href = url;
      globalThis.location.search = new URL(url).search;
    },
  };
}

/** Fresh module instance so the module-level `isBrowser` sees the stub. */
async function load() {
  return import(`../dist/index.js?${Math.random()}`);
}

async function arrive({ search, referrer, crossDomain }) {
  stubBrowser({ search, referrer });
  const { Fourier } = await load();
  const f = new Fourier({
    writeKey: "fk_test",
    host: "http://analytics.test",
    storage: "memory",
    disabled: true,
    ...(crossDomain ? { crossDomain } : {}),
  });
  return { f, href: globalThis.location.href };
}

const LINK = "?ajs_aid=handed-over-anon&ajs_uid=handed-over-user&utm_source=partner";

// Positive control. Without this the four refusals below would also pass if
// adoptCrossDomainIds were deleted outright, and prove nothing.
test("cross-domain: ids ARE adopted from a listed domain when configured", async () => {
  const { f } = await arrive({ search: LINK, referrer: "https://www.example.io/pricing", crossDomain: ["example.io"] });
  assert.equal(f.anonymousId(), "handed-over-anon");
  assert.equal(f.userId(), "handed-over-user");
});

test("cross-domain: ids are ignored when crossDomain is not configured", async () => {
  const { f } = await arrive({ search: LINK, referrer: "https://www.example.io/pricing" });
  assert.notEqual(f.anonymousId(), "handed-over-anon");
  assert.equal(f.userId(), null);
});

test("cross-domain: ids are ignored when the referrer is not a listed domain", async () => {
  const { f } = await arrive({ search: LINK, referrer: "https://attacker.test/post", crossDomain: ["example.io"] });
  assert.notEqual(f.anonymousId(), "handed-over-anon");
  assert.equal(f.userId(), null);
});

test("cross-domain: ids are ignored when there is no referrer to attribute them to", async () => {
  const { f } = await arrive({ search: LINK, referrer: "", crossDomain: ["example.io"] });
  assert.notEqual(f.anonymousId(), "handed-over-anon");
  assert.equal(f.userId(), null);
});

test("cross-domain: a lookalike domain does not pass the referrer check", async () => {
  const { f } = await arrive({ search: LINK, referrer: "https://notexample.io/", crossDomain: ["example.io"] });
  assert.equal(f.userId(), null);
});

test("cross-domain: the identity parameters are stripped either way, other params survive", async () => {
  const adopted = await arrive({ search: LINK, referrer: "https://www.example.io/", crossDomain: ["example.io"] });
  assert.equal(new URL(adopted.href).searchParams.get("ajs_uid"), null);
  assert.equal(new URL(adopted.href).searchParams.get("utm_source"), "partner");

  const rejected = await arrive({ search: LINK, referrer: "https://attacker.test/", crossDomain: ["example.io"] });
  assert.equal(new URL(rejected.href).searchParams.get("ajs_aid"), null);
  assert.equal(new URL(rejected.href).searchParams.get("utm_source"), "partner");
});
