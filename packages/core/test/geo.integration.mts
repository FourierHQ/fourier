/**
 * Location is an event property, not a trait — one person can arrive from several
 * countries and every arrival keeps its own. What that costs is a rollup with a trick
 * in it (a location-less event must not blank out where someone was last seen), so the
 * round trip through ClickHouse is worth proving rather than assuming.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

const BASE = `fourier_geotest_${Math.random().toString(36).slice(2, 8)}`;
process.env.CLICKHOUSE_DATABASE = BASE;
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  configFromEnv,
  databaseFor,
  ensureDefaultProject,
  ensureGeoDb,
  geoFromContext,
  geoFromHeaders,
  geoFromIp,
  getAdminClient,
  getDataClient,
  ingest,
  listEvents,
  listUsers,
  migrateAll,
  scope,
  ENVIRONMENTS,
} from "../src/index";

const cfg = () => ({ ...configFromEnv(), database: BASE });
const headers = (h: Record<string, string>) => new Headers(h);
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

before(async () => {
  await migrateAll();
});

after(async () => {
  const admin = getAdminClient(cfg());
  for (const env of ENVIRONMENTS) {
    await admin.command({ query: `DROP DATABASE IF EXISTS \`${databaseFor(BASE, env)}\`` });
  }
  await admin.close();
});

test("edge headers are read, and a city is decoded the way Vercel encodes it", () => {
  const geo = geoFromHeaders(
    headers({
      "x-vercel-ip-country": "br",
      "x-vercel-ip-country-region": "sp",
      "x-vercel-ip-city": "S%C3%A3o%20Paulo",
      "x-vercel-ip-latitude": "-23.5505",
      "x-vercel-ip-longitude": "-46.6333",
    }),
  );
  assert.deepEqual(geo, { country: "BR", region: "SP", city: "São Paulo", latitude: -23.5505, longitude: -46.6333 });
});

test("other CDNs are understood, and 'we don't know' is not a country", () => {
  assert.equal(geoFromHeaders(headers({ "cf-ipcountry": "JP" }))?.country, "JP");
  assert.equal(geoFromHeaders(headers({ "cloudfront-viewer-country": "DE" }))?.country, "DE");
  assert.equal(geoFromHeaders(headers({ "x-geo-country": "NL" }))?.country, "NL");
  // Cloudflare's unresolvable and Tor placeholders, and anything that is not a code.
  assert.equal(geoFromHeaders(headers({ "cf-ipcountry": "XX" })), null);
  assert.equal(geoFromHeaders(headers({ "cf-ipcountry": "T1" })), null);
  assert.equal(geoFromHeaders(headers({ "x-vercel-ip-country": "United Kingdom" })), null);
  assert.equal(geoFromHeaders(headers({})), null);
});

test("a city that cannot be decoded is kept, not thrown over", () => {
  // A throw here reaches handleIngest, which turns it into a 500 for the whole batch:
  // one malformed header would cost up to 1000 events, not one field.
  for (const bad of ["%", "%E0%A4%A", "100%25 %ZZ"]) {
    const geo = geoFromHeaders(headers({ "x-vercel-ip-country": "GB", "x-vercel-ip-city": bad }));
    assert.equal(geo?.city, bad, `${bad} should survive as itself`);
  }
});

test("an oversized city is truncated and control characters are dropped", () => {
  const long = geoFromHeaders(headers({ "x-geo-country": "GB", "x-geo-city": "A".repeat(5000) }));
  assert.equal(long?.city.length, 120, "city must be capped before it reaches the column");
  // Positive control: a normal city is not truncated at all.
  assert.equal(geoFromHeaders(headers({ "x-geo-country": "GB", "x-geo-city": "London" }))?.city, "London");

  const ctrl = geoFromContext({ geo: { country: "GB", city: `Lon${String.fromCharCode(0)}d${String.fromCharCode(0x7f)}on` } });
  assert.equal(ctrl?.city, "London", "control characters must not reach a column the dashboard renders");
});

test("region takes ISO 3166-2 subdivision codes and nothing else", () => {
  const r = (v: string) => geoFromHeaders(headers({ "x-geo-country": "GB", "x-geo-region": v }))?.region;
  assert.equal(r("eng"), "ENG", "a real subdivision code is kept, upper-cased");
  assert.equal(r("13"), "13", "numeric subdivisions are real too");
  // region is LowCardinality, and every one of these is client-supplied.
  assert.equal(r("'; DROP--"), "", "junk must not reach the column");
  assert.equal(r("AAAAAAAAAA"), "", "an over-long value is not a subdivision code");
  assert.equal(r("A-B"), "", "punctuation is not a subdivision code");
});

test("a nonsense latitude is dropped rather than stored", () => {
  const geo = geoFromHeaders(headers({ "x-vercel-ip-country": "GB", "x-vercel-ip-latitude": "not-a-number", "x-vercel-ip-longitude": "999" }));
  assert.equal(geo?.latitude, 0);
  assert.equal(geo?.longitude, 0);
});

test("every event keeps the location it arrived from, and the person keeps the latest", async () => {
  const project = await ensureDefaultProject();
  const s = scope(project.id, "production");
  const userId = "traveller";

  const london = geoFromHeaders(headers({ "x-vercel-ip-country": "GB", "x-vercel-ip-city": "London" }));
  const tokyo = geoFromHeaders(headers({ "x-vercel-ip-country": "JP", "x-vercel-ip-city": "Tokyo" }));

  await ingest(project, [{ type: "track", userId, event: "Booked Flight", timestamp: at(60) }], { geo: london }, "production");
  await ingest(project, [{ type: "track", userId, event: "Landed", timestamp: at(30) }], { geo: tokyo }, "production");

  const events = await listEvents(s, { userId, limit: 10 });
  const byName = new Map(events.map((e) => [e.event, e]));
  assert.equal(byName.get("Booked Flight")?.country, "GB", "the earlier event should still say GB");
  assert.equal(byName.get("Booked Flight")?.city, "London");
  assert.equal(byName.get("Landed")?.country, "JP", "the later event should say JP");

  const [user] = await listUsers(s, { search: userId, limit: 5 });
  assert.equal(user?.country, "JP", "the person is last seen where they most recently were");
  assert.equal(user?.city, "Tokyo");
});

test("an event with no location does not erase where someone was last seen", async () => {
  const project = await ensureDefaultProject();
  const s = scope(project.id, "production");
  const userId = "commuter"; // its own person: this must not depend on a previous test's ingests

  await ingest(
    project,
    [{ type: "track", userId, event: "Commuted", timestamp: at(30) }],
    { geo: geoFromHeaders(headers({ "x-vercel-ip-country": "GB", "x-vercel-ip-city": "London" })) },
    "production",
  );
  // Then a server-side call with nothing in front of it: no CDN headers, no database, no
  // geo — and, crucially, more recent than the located one.
  await ingest(project, [{ type: "track", userId, event: "Invoice Paid", timestamp: at(1) }], {}, "production");

  const [user] = await listUsers(s, { search: userId, limit: 5 });
  assert.equal(user?.country, "GB", "a location-less event should not blank out the last known country");
  assert.equal(user?.city, "London");
});

test("a relayed message is not stamped with the relay's own location", async () => {
  const project = await ensureDefaultProject();
  const s = scope(project.id, "production");
  const frankfurt = geoFromHeaders(headers({ "x-vercel-ip-country": "DE", "x-vercel-ip-city": "Frankfurt" }));

  // A server-side SDK naming its end user's address: the edge resolved the datacenter,
  // which is the one thing this event is definitely not about.
  await ingest(
    project,
    [{ type: "track", userId: "relayed", event: "Server Side", timestamp: at(5), context: { ip: "203.0.113.7" } }],
    { geo: frankfurt, ip: "198.51.100.1" },
    "production",
  );

  const [event] = await listEvents(s, { userId: "relayed", limit: 1 });
  assert.equal(event.country, "", "the datacenter's country must not be attributed to the end user");

  // listEvents does not hand raw addresses to the dashboard, so read the column itself:
  // storing the address the message named is what makes ignoring the edge the right call.
  const res = await getDataClient("production").query({
    query: `SELECT ip FROM events WHERE project_id = {p:String} AND user_id = 'relayed' LIMIT 1`,
    query_params: { p: project.id },
    format: "JSONEachRow",
  });
  assert.equal(((await res.json()) as { ip: string }[])[0]?.ip, "203.0.113.7", "the named address is what gets stored");
});

test("an explicit context.geo outranks the edge, which is how imports and server SDKs report location", async () => {
  const project = await ensureDefaultProject();
  const s = scope(project.id, "production");
  const berlin = geoFromHeaders(headers({ "x-vercel-ip-country": "DE", "x-vercel-ip-city": "Berlin" }));
  const paris = { country: "fr", region: "idf", city: "Paris", latitude: 48.8566, longitude: 2.3522 };

  // No context.ip, so the edge's answer is genuinely in the running: this is what makes
  // the assertion about precedence rather than about an empty field.
  await ingest(project, [{ type: "track", userId: "explicit", event: "Imported", timestamp: at(5), context: { geo: paris } }], { geo: berlin }, "production");
  const [event] = await listEvents(s, { userId: "explicit", limit: 1 });
  assert.equal(event.country, "FR", "context.geo must beat the edge header, not merely fill a gap");
  assert.equal(event.city, "Paris");
  assert.equal(event.region, "IDF");
  assert.equal(Math.round(event.latitude * 100) / 100, 48.86);

  // Positive control: the same call without context.geo takes the edge's answer.
  await ingest(project, [{ type: "track", userId: "edge_only", event: "Imported", timestamp: at(5) }], { geo: berlin }, "production");
  const [fallback] = await listEvents(s, { userId: "edge_only", limit: 1 });
  assert.equal(fallback.country, "DE", "without context.geo the edge header is what lands");
  assert.equal(fallback.city, "Berlin");
});

/**
 * The local-database path cannot run in CI: an .mmdb is a 4-70MB third-party file that
 * does not belong in the repo. Point FOURIER_GEOIP_DB at one (DB-IP Lite needs no
 * account) and this covers it. Otherwise it says so out loud — a silent skip reads
 * exactly like a pass, which is the only way this file could lie about its coverage.
 */
const GEOIP_DB = process.env.FOURIER_GEOIP_DB;
const skipDb = GEOIP_DB ? false : "FOURIER_GEOIP_DB is not set, so the local .mmdb path is NOT covered by this run";

test("a local database resolves an address when nothing in front of us did", { skip: skipDb }, async () => {
  await ensureGeoDb();
  assert.equal(geoFromIp("212.58.244.20")?.country, "GB");
  assert.equal(geoFromIp("8.8.8.8")?.country, "US");
  // A malformed address and a private range must return nothing rather than throw:
  // both reach this straight from a request, on every event.
  assert.equal(geoFromIp("192.168.1.1"), null);
  assert.equal(geoFromIp("not-an-ip"), null);
  assert.equal(geoFromIp(""), null);

  const project = await ensureDefaultProject();
  await ingest(project, [{ type: "track", userId: "no_cdn", event: "Pinged", timestamp: at(5) }], { ip: "212.58.244.20" }, "production");
  const [event] = await listEvents(scope(project.id, "production"), { userId: "no_cdn", limit: 1 });
  assert.equal(event.country, "GB", "a bare socket address should resolve through the local database");
});
