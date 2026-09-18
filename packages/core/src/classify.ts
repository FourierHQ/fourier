/**
 * Classifying a visit: is it a bot, and which marketing channel brought it.
 *
 * Both answers are derived at read time from columns that were already stored — the
 * user agent, the campaign parameters, the referrer — and never stamped at ingest.
 * That is the whole point: a bot list is out of date the day it ships, and a channel
 * taxonomy is an opinion that changes. Deriving them at read time means correcting
 * either one re-reports every visit ever recorded, including the ones from before
 * the correction. Stamping at ingest would only ever fix the future.
 *
 * The cost is that the rules have to exist as SQL, because that is where the grouping
 * happens. They are written once here, as data, and emitted two ways: a ClickHouse
 * expression baked into the `sessions_resolved` view, and a TypeScript predicate for
 * anything holding rows in memory. `classify.integration.mts` runs the same fixtures
 * through both and fails if they ever disagree.
 */

// ---------- bots ----------

/**
 * Substrings that mark a user agent as automated, lowercased. Deliberately blunt:
 * the cost of missing a crawler on a marketing site is an inflated visitor count,
 * and the cost of a false positive is one lost visit. Kept as fragments rather than
 * a single regex so the SQL and TS forms can be generated from the same list.
 */
export const BOT_PATTERNS = [
  "bot", // googlebot, bingbot, adsbot, semrushbot, ahrefsbot, discordbot, telegrambot …
  "crawl", // crawler, crawling
  "spider",
  "slurp", // yahoo
  "scrape",
  "curl/",
  "wget",
  "python-requests",
  "python-urllib",
  "http-client",
  "httpclient",
  "okhttp",
  "axios/",
  "node-fetch",
  "got (",
  "guzzle",
  "java/",
  "libwww-perl",
  "phantomjs",
  "headlesschrome",
  "electron/",
  "puppeteer",
  "playwright",
  "selenium",
  "lighthouse",
  "chrome-lighthouse",
  "pagespeed",
  "gtmetrix",
  "pingdom",
  "uptimerobot",
  "statuscake",
  "site24x7",
  "datadog",
  "newrelic",
  "prerender",
  "preview",
  "monitoring",
  "validator",
  "feedfetcher",
  "facebookexternalhit",
  "whatsapp",
  "slackbot",
  "linkedinbot",
  "twitterbot",
  "embedly",
  "quora link preview",
  "showyoubot",
  "outbrain",
  "vkshare",
  "w3c_validator",
  "redditbot",
  "applebot",
  "yandex",
  "baiduspider",
  "duckduckgo-favicons",
  "ia_archiver",
  "archive.org",
] as const;

/** An empty user agent is not evidence of a bot: server-side SDK calls have none. */
export function isBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return false;
  return BOT_PATTERNS.some((p) => ua.includes(p));
}

/**
 * ClickHouse expression: 1 when `col` looks automated, 0 when it is empty or human.
 * `multiSearchAnyCaseInsensitive` is a single pass over the string against the whole
 * pattern set, which matters because this runs over every session row in the view.
 */
export function botSql(col: string): string {
  return `if(${col} = '', 0, toUInt8(multiSearchAnyCaseInsensitive(${col}, ${sqlArray(BOT_PATTERNS)})))`;
}

// ---------- channels ----------

/**
 * Where a visit came from, as a person would describe it. The set is closed and
 * deliberately small: these are the rows of the acquisition table, and a taxonomy
 * nobody can hold in their head is a taxonomy nobody reads.
 *
 * "Direct" and "Unattributed" are different answers and must not be merged.
 * Direct means the entry page view was recorded and carried neither a referrer nor
 * a campaign — someone typed the address, or followed a link we cannot see. It is a
 * real, if blunt, observation. Unattributed means the session never recorded a page
 * view at all, so there was nothing to read an origin from. Folding the second into
 * the first would report an instrumentation gap as a marketing result.
 */
export const CHANNELS = [
  "Paid Search",
  "Paid Social",
  "Display",
  "Paid Other",
  "Organic Search",
  "Organic Social",
  "Email",
  "Affiliate",
  "Referral",
  "Other Campaign",
  "Direct",
  "Unattributed",
] as const;

export type Channel = (typeof CHANNELS)[number];

/** Domain labels that mean a search engine, matched against a host or a utm_source. */
export const SEARCH_DOMAINS = [
  "google",
  "bing",
  "yahoo",
  "duckduckgo",
  "ecosia",
  "baidu",
  "yandex",
  "startpage",
  "qwant",
  "naver",
  "seznam",
  "ask",
  "aol",
  "brave",
  "perplexity",
  "chatgpt",
  "openai",
  "claude",
  "copilot",
  "gemini",
] as const;

/** Domain labels that mean a social network, matched against a host or a utm_source. */
export const SOCIAL_DOMAINS = [
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "x",
  "t", // t.co
  "reddit",
  "youtube",
  "tiktok",
  "pinterest",
  "snapchat",
  "threads",
  "bsky",
  "bluesky",
  "mastodon",
  "discord",
  "slack",
  "whatsapp",
  "telegram",
  "quora",
  "medium",
  "substack",
  "news.ycombinator",
  "lnkd",
  "fb",
] as const;

const PAID_MEDIA = ["cpc", "ppc", "paid", "paidsearch", "paid_search", "paid-search", "paidsocial", "paid_social", "paid-social", "cpv", "cpa", "cpp", "ppe", "retargeting", "remarketing"] as const;
const DISPLAY_MEDIA = ["display", "banner", "cpm", "expandable", "interstitial"] as const;
const EMAIL_MEDIA = ["email", "e-mail", "e_mail", "e mail", "newsletter"] as const;
const AFFILIATE_MEDIA = ["affiliate", "affiliates", "partner"] as const;
const ORGANIC_MEDIA = ["organic", "search"] as const;
const SOCIAL_MEDIA = ["social", "social-network", "social_network", "sm", "social media"] as const;
const REFERRAL_MEDIA = ["referral", "link"] as const;

/** What a session's entry page view said about where it came from. */
export interface Entry {
  /** 0 means nothing was recorded to classify — the session never had a page view. */
  pageviews: number;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  referrer_host?: string | null;
  /** The host the visit landed on, so a self-referral is not counted as a referral. */
  entry_host?: string | null;
}

const lc = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** "www.google.co.uk" -> ["www","google","co","uk"], so a label can be matched whatever the TLD. */
function labels(host: string): string[] {
  return lc(host).split(".").filter(Boolean);
}

function matchesDomain(list: readonly string[], ...values: (string | null | undefined)[]): boolean {
  for (const v of values) {
    const s = lc(v);
    if (!s) continue;
    if (list.includes(s)) return true;
    for (const label of labels(s)) if (list.includes(label)) return true;
  }
  return false;
}

/**
 * The channel a session arrived on. Order is the whole algorithm: an explicitly paid
 * medium beats the network it ran on, and an explicit campaign beats a bare referrer,
 * because the more specific claim is the one the marketer actually made.
 */
export function classifyChannel(e: Entry): Channel {
  if (!e.pageviews) return "Unattributed";

  const source = lc(e.utm_source);
  const medium = lc(e.utm_medium);
  const campaign = lc(e.utm_campaign);
  const refHost = lc(e.referrer_host);
  const entryHost = lc(e.entry_host);
  const externalReferrer = refHost !== "" && refHost !== entryHost;

  const search = matchesDomain(SEARCH_DOMAINS, refHost, source);
  const social = matchesDomain(SOCIAL_DOMAINS, refHost, source) || SOCIAL_MEDIA.includes(medium as never);
  const paid = PAID_MEDIA.includes(medium as never) || medium.startsWith("paid");

  if (EMAIL_MEDIA.includes(medium as never) || source === "email" || source === "newsletter") return "Email";
  if (AFFILIATE_MEDIA.includes(medium as never)) return "Affiliate";
  if (paid && social) return "Paid Social";
  if (paid && search) return "Paid Search";
  if (DISPLAY_MEDIA.includes(medium as never)) return "Display";
  if (paid) return "Paid Other";
  if (social) return "Organic Social";
  if (search || ORGANIC_MEDIA.includes(medium as never)) return "Organic Search";
  if (source !== "" || campaign !== "") return "Other Campaign";
  if (externalReferrer || REFERRAL_MEDIA.includes(medium as never)) return "Referral";
  return "Direct";
}

// ---------- SQL ----------

function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function sqlArray(items: readonly string[]): string {
  return `[${items.map(quote).join(", ")}]`;
}

/**
 * Whether any of `values` names one of `list`, matching either the whole string or one
 * dot-separated label of it — so "google", "google.com" and "www.google.co.uk" all hit
 * the "google" entry, whatever the country suffix.
 */
function domainSql(list: readonly string[], values: string[]): string {
  const any = values
    .map((v) => `arrayExists(x -> has(${sqlArray(list)}, x), arrayPushBack(splitByChar('.', lower(${v})), lower(${v})))`)
    .join(" OR ");
  return `(${any})`;
}

function inSql(col: string, list: readonly string[]): string {
  return `lower(${col}) IN ${sqlArray(list)}`;
}

/**
 * ClickHouse expression returning one of CHANNELS. `c` names the columns on the row
 * being classified, so the same expression works over the sessions view and over any
 * ad-hoc query that can supply the five inputs.
 */
export function channelSql(c: {
  pageviews: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referrer_host: string;
  entry_host: string;
}): string {
  const search = domainSql(SEARCH_DOMAINS, [c.referrer_host, c.utm_source]);
  const social = `(${domainSql(SOCIAL_DOMAINS, [c.referrer_host, c.utm_source])} OR ${inSql(c.utm_medium, SOCIAL_MEDIA)})`;
  const paid = `(${inSql(c.utm_medium, PAID_MEDIA)} OR startsWith(lower(${c.utm_medium}), 'paid'))`;
  const externalReferrer = `(${c.referrer_host} != '' AND lower(${c.referrer_host}) != lower(${c.entry_host}))`;

  return `multiIf(
    ${c.pageviews} = 0, 'Unattributed',
    ${inSql(c.utm_medium, EMAIL_MEDIA)} OR lower(${c.utm_source}) IN ('email', 'newsletter'), 'Email',
    ${inSql(c.utm_medium, AFFILIATE_MEDIA)}, 'Affiliate',
    ${paid} AND ${social}, 'Paid Social',
    ${paid} AND ${search}, 'Paid Search',
    ${inSql(c.utm_medium, DISPLAY_MEDIA)}, 'Display',
    ${paid}, 'Paid Other',
    ${social}, 'Organic Social',
    ${search} OR ${inSql(c.utm_medium, ORGANIC_MEDIA)}, 'Organic Search',
    ${c.utm_source} != '' OR ${c.utm_campaign} != '', 'Other Campaign',
    ${externalReferrer} OR ${inSql(c.utm_medium, REFERRAL_MEDIA)}, 'Referral',
    'Direct')`;
}

// ---------- device and browser ----------
//
// Filter dimensions only. Fourier deliberately has no device or browser report — that
// is section 11 of the brief, and a standalone browser breakdown is a table nobody has
// ever acted on. But "was the drop mobile-only?" is a real question about a real
// regression, so both exist as something to slice by.
//
// Read from the user agent at query time like everything else here, which means a
// browser released next year starts being named correctly the moment this list learns
// it, for every visit already recorded.

export const DEVICES = ["Desktop", "Mobile", "Tablet"] as const;
export type Device = (typeof DEVICES)[number];

/** Order matters: an Android tablet says "Android" but not "Mobile". */
export function classifyDevice(userAgent: string | null | undefined): Device {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "Desktop";
  if (/ipad|tablet|playbook|silk|kindle/.test(ua)) return "Tablet";
  if (ua.includes("android") && !ua.includes("mobile")) return "Tablet";
  if (/mobile|iphone|ipod|blackberry|opera mini|iemobile|windows phone/.test(ua)) return "Mobile";
  if (ua.includes("android")) return "Mobile";
  return "Desktop";
}

export function deviceSql(col: string): string {
  const has = (s: string) => `position(lower(${col}), ${quote(s)}) > 0`;
  const anyOf = (...s: string[]) => `(${s.map(has).join(" OR ")})`;
  return `multiIf(
    ${col} = '', 'Desktop',
    ${anyOf("ipad", "tablet", "playbook", "silk", "kindle")}, 'Tablet',
    ${has("android")} AND NOT ${has("mobile")}, 'Tablet',
    ${anyOf("mobile", "iphone", "ipod", "blackberry", "opera mini", "iemobile", "windows phone", "android")}, 'Mobile',
    'Desktop')`;
}

export const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge", "Opera", "Samsung Internet", "Other"] as const;
export type Browser = (typeof BROWSERS)[number];

/**
 * Every Chromium browser claims to be Chrome and Safari, and Safari claims to be
 * neither Chrome nor Chromium. The only thing that works is checking for the specific
 * names first and falling through, which is why the order below is the algorithm.
 */
const BROWSER_RULES: { name: Browser; needles: string[]; not?: string[] }[] = [
  { name: "Edge", needles: ["edg/", "edge/", "edga/", "edgios/"] },
  { name: "Opera", needles: ["opr/", "opera", "opios/"] },
  { name: "Samsung Internet", needles: ["samsungbrowser"] },
  { name: "Firefox", needles: ["firefox/", "fxios/"] },
  { name: "Chrome", needles: ["chrome/", "crios/", "chromium/"] },
  { name: "Safari", needles: ["safari/"] },
];

export function classifyBrowser(userAgent: string | null | undefined): Browser {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "Other";
  for (const r of BROWSER_RULES) if (r.needles.some((n) => ua.includes(n))) return r.name;
  return "Other";
}

export function browserSql(col: string): string {
  const branches = BROWSER_RULES.map((r) => `multiSearchAnyCaseInsensitive(${col}, ${sqlArray(r.needles)}), ${quote(r.name)}`);
  return `multiIf(${col} = '', 'Other', ${branches.join(", ")}, 'Other')`;
}
