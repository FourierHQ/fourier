/**
 * The SQL and the TypeScript must agree.
 *
 * ./classify.ts emits every rule twice — once as a ClickHouse expression, because that
 * is where grouping happens, and once as a function, because some callers hold rows in
 * memory. Two implementations of one rule is a standing invitation to drift, and the
 * drift would be invisible: both sides would keep returning a plausible channel, just
 * not the same one, and the acquisition table would quietly stop matching everything
 * else. So every fixture below goes through both, and any disagreement fails here.
 *
 * Runs against whatever CLICKHOUSE_URL points at. No schema and no tables: the fixtures
 * are a literal VALUES list, so this is fast and independent of the rest.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";

import {
  botSql,
  browserSql,
  channelSql,
  classifyBrowser,
  classifyChannel,
  classifyReferrer,
  classifyDevice,
  configFromEnv,
  deviceSql,
  getAdminClient,
  isBot,
  referrerSql,
  type Entry,
} from "../src/index";

const client = getAdminClient({ ...configFromEnv(), database: "default" });
after(() => client.close());

async function evaluate<T>(expr: string, rows: Record<string, string | number>[], cols: string[]): Promise<T[]> {
  // A literal VALUES list, so nothing has to be created or cleaned up.
  const values = rows
    .map((r) => `(${cols.map((c) => (typeof r[c] === "number" ? String(r[c]) : `'${String(r[c] ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)).join(", ")})`)
    .join(", ");
  const schema = cols.map((c) => `${c} ${typeof rows[0]?.[c] === "number" ? "UInt64" : "String"}`).join(", ");
  const res = await client.query({
    query: `SELECT ${expr} AS v FROM values('${schema}', ${values})`,
    format: "JSONEachRow",
  });
  return ((await res.json()) as { v: T }[]).map((r) => r.v);
}

// ---------- channels ----------

const CHANNEL_CASES: Entry[] = [
  { pageviews: 1, referrer_host: "www.google.com", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "google.co.uk", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "duckduckgo.com", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "chatgpt.com", entry_host: "example.com" },
  { pageviews: 1, utm_source: "google", utm_medium: "cpc", entry_host: "example.com" },
  { pageviews: 1, utm_source: "google", utm_medium: "cpc", referrer_host: "www.google.com", entry_host: "example.com" },
  { pageviews: 1, utm_source: "linkedin", utm_medium: "paid_social", entry_host: "example.com" },
  { pageviews: 1, utm_source: "linkedin", utm_medium: "cpc", referrer_host: "www.linkedin.com", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "www.linkedin.com", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "t.co", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "news.ycombinator.com", entry_host: "example.com" },
  { pageviews: 1, utm_medium: "email", utm_source: "mailchimp", entry_host: "example.com" },
  { pageviews: 1, utm_source: "newsletter", entry_host: "example.com" },
  { pageviews: 1, utm_medium: "affiliate", utm_source: "somepartner", entry_host: "example.com" },
  { pageviews: 1, utm_medium: "display", utm_source: "adroll", entry_host: "example.com" },
  { pageviews: 1, utm_medium: "banner", entry_host: "example.com" },
  { pageviews: 1, utm_medium: "paid-whatever", utm_source: "mystery", entry_host: "example.com" },
  { pageviews: 1, utm_medium: "organic", utm_source: "somewhere", entry_host: "example.com" },
  { pageviews: 1, utm_source: "partnersite", entry_host: "example.com" },
  { pageviews: 1, utm_campaign: "spring", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "someblog.dev", entry_host: "example.com" },
  { pageviews: 1, referrer_host: "example.com", entry_host: "example.com" },
  { pageviews: 1, entry_host: "example.com" },
  { pageviews: 0, entry_host: "example.com" },
  { pageviews: 0, referrer_host: "www.google.com", entry_host: "example.com" },
];

test("channel classification: SQL and TypeScript return the same answer", async () => {
  const cols = ["pageviews", "utm_source", "utm_medium", "utm_campaign", "referrer_host", "entry_host"];
  const rows = CHANNEL_CASES.map((c) => ({
    pageviews: c.pageviews,
    utm_source: c.utm_source ?? "",
    utm_medium: c.utm_medium ?? "",
    utm_campaign: c.utm_campaign ?? "",
    referrer_host: c.referrer_host ?? "",
    entry_host: c.entry_host ?? "",
  }));
  const expr = channelSql({
    pageviews: "pageviews",
    utm_source: "utm_source",
    utm_medium: "utm_medium",
    utm_campaign: "utm_campaign",
    referrer_host: "referrer_host",
    entry_host: "entry_host",
  });
  const fromSql = await evaluate<string>(expr, rows, cols);
  CHANNEL_CASES.forEach((c, i) => {
    assert.equal(fromSql[i], classifyChannel(c), `case ${i}: ${JSON.stringify(c)}`);
  });
});

test("channel classification: the answers are the ones intended", async () => {
  // Pinning a few by hand, so a change that keeps both sides in agreement but moves
  // them together still has to be a deliberate one.
  const expect: [Entry, string][] = [
    [{ pageviews: 1, referrer_host: "www.google.com", entry_host: "example.com" }, "Organic Search"],
    [{ pageviews: 1, utm_source: "google", utm_medium: "cpc", entry_host: "example.com" }, "Paid Search"],
    [{ pageviews: 1, utm_source: "linkedin", utm_medium: "paid_social", entry_host: "example.com" }, "Paid Social"],
    [{ pageviews: 1, referrer_host: "www.linkedin.com", entry_host: "example.com" }, "Organic Social"],
    [{ pageviews: 1, utm_medium: "email", utm_source: "mailchimp", entry_host: "example.com" }, "Email"],
    [{ pageviews: 1, utm_medium: "affiliate", entry_host: "example.com" }, "Affiliate"],
    [{ pageviews: 1, referrer_host: "someblog.dev", entry_host: "example.com" }, "Referral"],
    [{ pageviews: 1, referrer_host: "example.com", entry_host: "example.com" }, "Direct"],
    [{ pageviews: 1, entry_host: "example.com" }, "Direct"],
    [{ pageviews: 0, entry_host: "example.com" }, "Unattributed"],
  ];
  for (const [entry, want] of expect) assert.equal(classifyChannel(entry), want, JSON.stringify(entry));
});

// ---------- referrers ----------

// The shapes a single network actually arrives in, taken from production traffic.
const REFERRER_CASES: [Entry, string][] = [
  [{ pageviews: 1, referrer_host: "t.co", entry_host: "example.com" }, "X"],
  [{ pageviews: 1, utm_source: "x", utm_medium: "social", referrer_host: "t.co", entry_host: "example.com" }, "X"],
  [{ pageviews: 1, utm_source: "x", utm_medium: "social", entry_host: "example.com" }, "X"],
  [{ pageviews: 1, referrer_host: "com.twitter.android", entry_host: "example.com" }, "X"],
  [{ pageviews: 1, utm_source: "Twitter", entry_host: "example.com" }, "X"],
  [{ pageviews: 1, referrer_host: "www.linkedin.com", entry_host: "example.com" }, "LinkedIn"],
  [{ pageviews: 1, referrer_host: "com.linkedin.android", entry_host: "example.com" }, "LinkedIn"],
  [{ pageviews: 1, referrer_host: "lnkd.in", entry_host: "example.com" }, "LinkedIn"],
  [{ pageviews: 1, utm_source: "linkedin", referrer_host: "lnkd.in", entry_host: "example.com" }, "LinkedIn"],
  // t.me is Telegram, not X: the shortener is matched as a whole host, never as "t".
  [{ pageviews: 1, referrer_host: "t.me", entry_host: "example.com" }, "Telegram"],
  [{ pageviews: 1, referrer_host: "org.telegram.messenger", entry_host: "example.com" }, "Telegram"],
  [{ pageviews: 1, referrer_host: "news.ycombinator.com", entry_host: "example.com" }, "Hacker News"],
  [{ pageviews: 1, referrer_host: "www.producthunt.com", entry_host: "example.com" }, "Product Hunt"],
  [{ pageviews: 1, utm_source: "producthunt", utm_medium: "social", entry_host: "example.com" }, "Product Hunt"],
  [{ pageviews: 1, referrer_host: "www.google.co.uk", entry_host: "example.com" }, "Google"],
  [{ pageviews: 1, referrer_host: "com.google.android.googlequicksearchbox", entry_host: "example.com" }, "Google"],
  [{ pageviews: 1, referrer_host: "gemini.google.com", entry_host: "example.com" }, "Gemini"],
  [{ pageviews: 1, referrer_host: "com.google.android.gm", entry_host: "example.com" }, "Gmail"],
  [{ pageviews: 1, utm_source: "chatgpt.com", referrer_host: "chatgpt.com", entry_host: "example.com" }, "ChatGPT"],
  [{ pageviews: 1, utm_source: "google", utm_medium: "cpc", referrer_host: "www.google.com", entry_host: "example.com" }, "Google"],
  // The tag is the claim the marketer made, so it wins over where the click happened.
  [{ pageviews: 1, utm_source: "newsletter", referrer_host: "t.co", entry_host: "example.com" }, "newsletter"],
  // Unknown values arrive as they were: the tag as typed, the host without its www.
  [{ pageviews: 1, utm_source: "hs_email", utm_medium: "email", entry_host: "example.com" }, "hs_email"],
  [{ pageviews: 1, utm_source: " Partner Site ", entry_host: "example.com" }, "Partner Site"],
  [{ pageviews: 1, referrer_host: "www.someblog.dev", entry_host: "example.com" }, "someblog.dev"],
  // No tag and no other site: nothing to name. The site's own pages are not a referrer.
  [{ pageviews: 1, referrer_host: "example.com", entry_host: "example.com" }, ""],
  [{ pageviews: 1, entry_host: "example.com" }, ""],
  [{ pageviews: 0, entry_host: "example.com" }, ""],
];

test("referrers: SQL and TypeScript return the same answer, and it is the intended one", async () => {
  const cols = ["utm_source", "referrer_host", "entry_host"];
  const rows = REFERRER_CASES.map(([c]) => ({ utm_source: c.utm_source ?? "", referrer_host: c.referrer_host ?? "", entry_host: c.entry_host ?? "" }));
  const fromSql = await evaluate<string>(referrerSql({ utm_source: "utm_source", referrer_host: "referrer_host", entry_host: "entry_host" }), rows, cols);
  REFERRER_CASES.forEach(([c, want], i) => {
    assert.equal(classifyReferrer(c), want, `TypeScript, case ${i}: ${JSON.stringify(c)}`);
    assert.equal(fromSql[i], want, `SQL, case ${i}: ${JSON.stringify(c)}`);
  });
});

// ---------- bots ----------

const UA_CASES = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  "curl/8.7.1",
  "python-requests/2.32.3",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (compatible; Yandex.Bot/3.0)",
  "",
];

test("bot detection: SQL and TypeScript return the same answer", async () => {
  const rows = UA_CASES.map((ua) => ({ ua }));
  const fromSql = await evaluate<number>(botSql("ua"), rows, ["ua"]);
  UA_CASES.forEach((ua, i) => {
    assert.equal(Boolean(fromSql[i]), isBot(ua), `ua ${i}: ${ua || "(empty)"}`);
  });
});

test("bot detection: real browsers pass, crawlers and tools do not", () => {
  assert.equal(isBot(UA_CASES[0]), false, "desktop Chrome");
  assert.equal(isBot(UA_CASES[1]), false, "mobile Safari");
  assert.equal(isBot(UA_CASES[7]), false, "Firefox");
  assert.equal(isBot(UA_CASES[9]), true, "Googlebot");
  assert.equal(isBot(UA_CASES[12]), true, "curl");
  assert.equal(isBot(UA_CASES[14]), true, "HeadlessChrome");
  // Server-side SDK calls arrive with no user agent at all, and are not bots.
  assert.equal(isBot(""), false);
  assert.equal(isBot(undefined), false);
});

test("device and browser: SQL and TypeScript return the same answer", async () => {
  const rows = UA_CASES.map((ua) => ({ ua }));
  const devices = await evaluate<string>(deviceSql("ua"), rows, ["ua"]);
  const browsers = await evaluate<string>(browserSql("ua"), rows, ["ua"]);
  UA_CASES.forEach((ua, i) => {
    assert.equal(devices[i], classifyDevice(ua), `device ${i}: ${ua || "(empty)"}`);
    assert.equal(browsers[i], classifyBrowser(ua), `browser ${i}: ${ua || "(empty)"}`);
  });
});

test("device and browser: the tricky ones", () => {
  assert.equal(classifyDevice(UA_CASES[2]), "Tablet", "iPad");
  assert.equal(classifyDevice(UA_CASES[4]), "Tablet", "Android without 'Mobile' is a tablet");
  assert.equal(classifyDevice(UA_CASES[3]), "Mobile", "Android with 'Mobile'");
  // Every Chromium browser claims to be Chrome and Safari; the specific name wins.
  assert.equal(classifyBrowser(UA_CASES[5]), "Edge");
  assert.equal(classifyBrowser(UA_CASES[6]), "Opera");
  assert.equal(classifyBrowser(UA_CASES[8]), "Samsung Internet");
  assert.equal(classifyBrowser(UA_CASES[0]), "Chrome");
  assert.equal(classifyBrowser(UA_CASES[1]), "Safari");
});
