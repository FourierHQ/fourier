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
  geoFromHeaders,
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
  const userId = "traveller";

  // A server-side call with nothing in front of it: no CDN headers, no database, no geo.
  await ingest(project, [{ type: "track", userId, event: "Invoice Paid", timestamp: at(1) }], {}, "production");

  const [user] = await listUsers(s, { search: userId, limit: 5 });
  assert.equal(user?.country, "JP", "a location-less event should not blank out the last known country");
  assert.equal(user?.city, "Tokyo");
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

test("an explicit context.geo wins, which is how imports and server SDKs report location", async () => {
  const project = await ensureDefaultProject();
  const s = scope(project.id, "production");
  await ingest(
    project,
    [
      {
        type: "track",
        userId: "explicit",
        event: "Imported",
        timestamp: at(5),
        context: { ip: "203.0.113.9", geo: { country: "fr", region: "idf", city: "Paris", latitude: 48.8566, longitude: 2.3522 } },
      },
    ],
    { geo: geoFromHeaders(headers({ "x-vercel-ip-country": "DE" })) },
    "production",
  );

  const [event] = await listEvents(s, { userId: "explicit", limit: 1 });
  assert.equal(event.country, "FR");
  assert.equal(event.city, "Paris");
  assert.equal(Math.round(event.latitude * 100) / 100, 48.86);
});
