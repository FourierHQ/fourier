/**
 * Seeds the default project with 30 days of realistic SaaS data:
 * companies (groups), users, page views and product events.
 *   pnpm seed
 */
import { configFromEnv, ensureDefaultProject, ingest, migrateAll, parseEnvironment, upsertDefinition, type IncomingMessage } from "@fourierhq/core";
import { seedForms } from "./seed-forms";

const COMPANIES = [
  { id: "acme", name: "Acme Inc", plan: "enterprise", industry: "Manufacturing", seats: 120 },
  { id: "globex", name: "Globex", plan: "pro", industry: "Energy", seats: 40 },
  { id: "initech", name: "Initech", plan: "pro", industry: "Software", seats: 25 },
  { id: "umbrella", name: "Umbrella Corp", plan: "free", industry: "Biotech", seats: 5 },
  { id: "hooli", name: "Hooli", plan: "enterprise", industry: "Software", seats: 800 },
  { id: "vandelay", name: "Vandelay Industries", plan: "free", industry: "Import/Export", seats: 3 },
];
const FIRST = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara", "Dennis", "Ken", "Radia", "Tim", "Hedy", "Guido"];
const LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Turing", "Liskov", "Ritchie", "Thompson", "Perlman", "Berners-Lee", "Lamarr", "van Rossum"];
const PAGES = ["/", "/pricing", "/docs", "/dashboard", "/dashboard/reports", "/settings", "/settings/billing", "/integrations"];
// The marketing site, which is what Web Analytics reports on. Kept separate from the
// app's own pages so landing pages, page groups and exits look like a real website.
const MARKETING_PAGES = ["/", "/pricing", "/product/analytics", "/product/api", "/blog/launching-fourier", "/blog/why-clickhouse", "/docs", "/docs/quickstart", "/about", "/demo"];
/** Where marketing traffic arrives. Weighted so the ranked tables have a shape to them. */
const LANDINGS: [string, number][] = [["/", 10], ["/pricing", 5], ["/blog/launching-fourier", 4], ["/product/analytics", 3], ["/blog/why-clickhouse", 3], ["/docs/quickstart", 2], ["/demo", 2]];
/** How visits arrive, as the SDK would have recorded them. */
const ARRIVALS: [{ referrer?: string; campaign?: Record<string, string> }, number][] = [
  [{ referrer: "https://www.google.com/" }, 10],
  [{}, 8],
  [{ referrer: "https://news.ycombinator.com/" }, 3],
  [{ referrer: "https://www.linkedin.com/feed/" }, 2],
  [{ campaign: { source: "google", medium: "cpc", name: "brand-search" }, referrer: "https://www.google.com/" }, 4],
  [{ campaign: { source: "linkedin", medium: "paid_social", name: "september-launch" }, referrer: "https://www.linkedin.com/" }, 3],
  [{ campaign: { source: "newsletter", medium: "email", name: "monthly-digest" } }, 2],
  [{ referrer: "https://www.producthunt.com/" }, 2],
  [{ referrer: "https://twitter.com/" }, 2],
];
const EVENTS: [string, number, () => Record<string, unknown>][] = [
  ["Report Created", 5, () => ({ type: pick(["funnel", "retention", "trend"]), rows: rand(10, 5000) })],
  ["Report Exported", 2, () => ({ format: pick(["csv", "pdf", "xlsx"]) })],
  ["Integration Connected", 1, () => ({ provider: pick(["slack", "github", "salesforce", "hubspot"]) })],
  ["Invite Sent", 2, () => ({ role: pick(["admin", "member", "viewer"]) })],
  ["Search Performed", 6, () => ({ query_length: rand(3, 40), results: rand(0, 50) })],
  ["Feature Flag Toggled", 1, () => ({ flag: pick(["new-nav", "ai-summaries", "dark-mode"]), enabled: Math.random() > 0.5 })],
  ["Upgrade Clicked", 1, () => ({ from_plan: "free", to_plan: pick(["pro", "enterprise"]) })],
  ["Checkout Completed", 0.4, () => ({ plan: pick(["pro", "enterprise"]), amount: pick([4900, 9900, 49900]), currency: "USD" })],
];
// Somewhere to be, with a matching locale and timezone so a seeded person is coherent.
// Seeds set context.geo explicitly: there is no CDN in front of a `pnpm seed`, and geo
// is normally resolved from the connection, which a local script does not have.
const LOCATIONS = [
  { country: "US", region: "NY", city: "New York", latitude: 40.7128, longitude: -74.006, locale: "en-US", timezone: "America/New_York" },
  { country: "US", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, locale: "en-US", timezone: "America/Los_Angeles" },
  { country: "GB", region: "ENG", city: "London", latitude: 51.5072, longitude: -0.1276, locale: "en-GB", timezone: "Europe/London" },
  { country: "DE", region: "BE", city: "Berlin", latitude: 52.52, longitude: 13.405, locale: "de-DE", timezone: "Europe/Berlin" },
  { country: "FR", region: "IDF", city: "Paris", latitude: 48.8566, longitude: 2.3522, locale: "fr-FR", timezone: "Europe/Paris" },
  { country: "JP", region: "13", city: "Tokyo", latitude: 35.6762, longitude: 139.6503, locale: "ja-JP", timezone: "Asia/Tokyo" },
  { country: "BR", region: "SP", city: "Sao Paulo", latitude: -23.5505, longitude: -46.6333, locale: "pt-BR", timezone: "America/Sao_Paulo" },
  { country: "IN", region: "KA", city: "Bengaluru", latitude: 12.9716, longitude: 77.5946, locale: "en-IN", timezone: "Asia/Kolkata" },
];

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
];

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickWeighted<T>(arr: [T, number][]): T {
  const total = arr.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of arr) {
    r -= w;
    if (r <= 0) return v;
  }
  return arr[0][0];
}
function weighted() {
  const total = EVENTS.reduce((s, e) => s + e[1], 0);
  let r = Math.random() * total;
  for (const e of EVENTS) {
    r -= e[1];
    if (r <= 0) return e;
  }
  return EVENTS[0];
}

async function main() {
  await migrateAll(configFromEnv());
  // Seed wherever you point it: FOURIER_SEED_ENVIRONMENT=preview fills the preview database.
  const environment = parseEnvironment(process.env.FOURIER_SEED_ENVIRONMENT);
  const project = await ensureDefaultProject();
  const now = Date.now();
  const DAY = 86_400_000;
  const messages: IncomingMessage[] = [];

  let userIdx = 0;
  for (const c of COMPANIES) {
    const userCount = Math.min(rand(2, 8), FIRST.length);
    for (let u = 0; u < userCount; u++) {
      userIdx++;
      const first = FIRST[(userIdx * 7) % FIRST.length];
      const last = LAST[(userIdx * 5) % LAST.length];
      const userId = `user_${userIdx.toString().padStart(3, "0")}`;
      const anonymousId = crypto.randomUUID();
      const email = `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@${c.id}.com`;
      const signup = now - rand(3, 30) * DAY;
      const ua = pick(UAS);
      const home = pick(LOCATIONS);
      const sessions = new Map<number, string>();
      const session = (t: number) => {
        // one session per calendar hour bucket in the seed; first message in it is the arrival
        const key = Math.floor(t / 3_600_000);
        const isNew = !sessions.has(key);
        if (isNew) sessions.set(key, crypto.randomUUID());
        return { id: sessions.get(key)!, isNew };
      };
      const ctx = (t: number) => {
        // A few events from somewhere else, because people travel and use VPNs. This is
        // the case location-as-a-trait gets wrong, so the seed had better contain it.
        const where = Math.random() < 0.06 ? pick(LOCATIONS) : home;
        return {
          session: session(t),
          library: { name: "fourier", version: "0.1.0" },
          userAgent: ua,
          locale: where.locale,
          timezone: where.timezone,
          geo: { country: where.country, region: where.region, city: where.city, latitude: where.latitude, longitude: where.longitude },
          page: { url: `https://app.example.com${pick(PAGES)}`, path: pick(PAGES), title: "Example App", referrer: t === signup ? pick(["https://google.com/", "https://news.ycombinator.com/", "", "https://twitter.com/"]) : "" },
          campaign: t === signup && Math.random() > 0.4 ? { source: pick(["google", "twitter", "newsletter", "producthunt"]), medium: pick(["cpc", "social", "email"]), name: pick(["launch", "spring-promo", "docs"]) } : undefined,
          groupId: c.id,
        };
      };

      // anonymous landing, then signup -> identify + group
      messages.push({ type: "page", anonymousId, timestamp: new Date(signup - 60_000).toISOString(), properties: { path: "/", url: "https://app.example.com/", title: "Example App" }, context: { ...ctx(signup), groupId: undefined } });
      messages.push({ type: "page", anonymousId, timestamp: new Date(signup - 30_000).toISOString(), properties: { path: "/pricing", url: "https://app.example.com/pricing", title: "Pricing" }, context: { ...ctx(signup), groupId: undefined } });
      messages.push({ type: "track", anonymousId, event: "Signed Up", timestamp: new Date(signup).toISOString(), properties: { method: pick(["google", "email", "github"]) }, context: { ...ctx(signup), groupId: undefined } });
      messages.push({ type: "identify", anonymousId, userId, timestamp: new Date(signup + 1000).toISOString(), traits: { email, name: `${first} ${last}`, first_name: first, last_name: last, role: u === 0 ? "owner" : pick(["admin", "member"]), created_at: new Date(signup).toISOString() }, context: ctx(signup) });
      messages.push({ type: "group", anonymousId, userId, groupId: c.id, timestamp: new Date(signup + 2000).toISOString(), traits: { name: c.name, plan: c.plan, industry: c.industry, employees: c.seats, website: `https://${c.id}.com` }, context: ctx(signup) });

      // sessions after signup, more for bigger plans
      const activity = c.plan === "enterprise" ? 0.8 : c.plan === "pro" ? 0.5 : 0.25;
      for (let day = Math.floor((now - signup) / DAY); day >= 0; day--) {
        if (Math.random() > activity) continue;
        // Clamped to after the signup. The oldest day in this loop lands exactly on the
        // signup moment, and the random hours then push it up to thirteen hours earlier
        // — giving the account activity before it existed, and, worse, making that
        // stray session the person's first recorded touch. Every seeded customer then
        // looked like it arrived Direct, which is the one thing the attribution report
        // is there to disprove.
        const sessionStart = Math.max(signup + 60_000, now - day * DAY - rand(0, 12) * 3_600_000 - rand(0, 3_600_000));
        const n = rand(2, 9);
        let t = sessionStart;
        for (let i = 0; i < n; i++) {
          t += rand(5_000, 240_000);
          if (t > now) break;
          if (Math.random() < 0.45) {
            const path = pick(PAGES);
            messages.push({ type: "page", anonymousId, userId, timestamp: new Date(t).toISOString(), properties: { path, url: `https://app.example.com${path}`, title: `Example App ${path}` }, context: ctx(t) });
          } else {
            const [event, , props] = weighted();
            messages.push({ type: "track", anonymousId, userId, event, timestamp: new Date(t).toISOString(), properties: props(), context: ctx(t) });
          }
        }
      }
    }
  }

  // Marketing traffic: people who came to the website and mostly left again. This is what
  // the Web Analytics section reports on, so these visits carry everything it reads —
  // a session, an arrival, a landing page, and measured time on each page.
  // Sixty days, not thirty: the default report compares the last thirty against the
  // thirty before them, and a seed that stops at the boundary makes every change column
  // read "+21050%" against the two visits that happened to fall the other side of it.
  // Mildly growing — roughly 40% more traffic in the recent half than the earlier one,
  // which is what a site that is going well actually looks like. A steeper curve makes
  // every change column read in the thousands and teaches nobody anything.
  const visitTimes = Array.from({ length: 800 }, () => now - Math.floor(59 * Math.pow(Math.random(), 1.3)) * DAY - rand(0, DAY)).sort((a, b) => a - b);
  // About a third of visits are somebody coming back. Emitted oldest-first and reusing
  // an id only from a visit already generated, so a returning visitor's first sighting
  // genuinely precedes their return — otherwise the new/returning split would depend on
  // the order the seed happened to write rows in.
  const seenVisitors: string[] = [];
  for (const start of visitTimes) {
    const returning = seenVisitors.length > 20 && Math.random() < 0.32;
    const anonymousId = returning ? pick(seenVisitors) : crypto.randomUUID();
    if (!returning) seenVisitors.push(anonymousId);
    const w = pick(LOCATIONS);
    const ua = pick(UAS);
    const geo = { country: w.country, region: w.region, city: w.city, latitude: w.latitude, longitude: w.longitude };
    const sessionId = crypto.randomUUID();
    const arrival = pickWeighted(ARRIVALS);
    const landing = pickWeighted(LANDINGS);

    // Most visits are one page; a few go deeper. Roughly the shape of a real site.
    const depth = Math.random() < 0.55 ? 1 : Math.random() < 0.8 ? rand(2, 3) : rand(4, 7);
    const path = [landing, ...Array.from({ length: depth - 1 }, () => pick(MARKETING_PAGES))];

    let t = start;
    path.forEach((p, idx) => {
      const first = idx === 0;
      const base = {
        library: { name: "fourier", version: "0.1.0" },
        userAgent: ua,
        locale: w.locale,
        timezone: w.timezone,
        geo,
        session: { id: sessionId, isNew: first },
        page: { url: `https://example.com${p}`, path: p, title: p, referrer: first ? (arrival.referrer ?? "") : `https://example.com${path[idx - 1]}` },
        ...(first && arrival.campaign ? { campaign: arrival.campaign } : {}),
      };
      messages.push({ type: "page", anonymousId, timestamp: new Date(t).toISOString(), properties: { path: p, url: `https://example.com${p}`, title: p }, context: base });

      // What the SDK's engagement timer would have measured on this page. Not every
      // view reports one — a visit closed abruptly never sends its beacon — so the
      // reports have both measured and unmeasured pages to tell apart.
      const engaged = Math.random() < 0.8 ? rand(2_000, 180_000) : 0;
      if (engaged) {
        messages.push({
          type: "track",
          event: "$page_leave",
          anonymousId,
          timestamp: new Date(t + engaged).toISOString(),
          properties: { engaged_ms: engaged, path: p },
          context: { ...base, session: { id: sessionId, isNew: false } },
        });
      }

      // A CTA on the pages that have one.
      if ((p === "/pricing" || p === "/" || p === "/demo") && Math.random() < 0.18) {
        messages.push({
          type: "track",
          event: "CTA Clicked",
          anonymousId,
          timestamp: new Date(t + Math.max(engaged - 500, 1000)).toISOString(),
          properties: { path: p, label: p === "/demo" ? "Book a demo" : "Start free" },
          context: { ...base, session: { id: sessionId, isNew: false } },
        });
      }
      t += engaged + rand(1_000, 20_000);
    });

    // A few of these visits go on to request a demo, which is the marketing site's goal.
    if (path.includes("/demo") && Math.random() < 0.28) {
      messages.push({ type: "track", event: "Form Started", anonymousId, timestamp: new Date(t).toISOString(), properties: { path: "/demo", form: "demo-request" }, context: { library: { name: "fourier", version: "0.1.0" }, userAgent: ua, locale: w.locale, timezone: w.timezone, geo, session: { id: sessionId, isNew: false }, page: { url: "https://example.com/demo", path: "/demo" } } });
      if (Math.random() < 0.6) {
        messages.push({ type: "track", event: "Demo Requested", anonymousId, timestamp: new Date(t + rand(20_000, 90_000)).toISOString(), properties: { path: "/demo", form: "demo-request" }, context: { library: { name: "fourier", version: "0.1.0" }, userAgent: ua, locale: w.locale, timezone: w.timezone, geo, session: { id: sessionId, isNew: false }, page: { url: "https://example.com/demo", path: "/demo" } } });
      }
    }
  }

  // Some crawler traffic, because a real site has it and the reports have to exclude it.
  for (let i = 0; i < 80; i++) {
    const t = now - rand(0, 59) * DAY - rand(0, DAY);
    messages.push({
      type: "page",
      anonymousId: `bot-${i}`,
      timestamp: new Date(t).toISOString(),
      properties: { path: pick(MARKETING_PAGES), url: "https://example.com/", title: "Example" },
      context: {
        library: { name: "fourier", version: "0.1.0" },
        userAgent: pick(["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; AhrefsBot/7.0)", "Mozilla/5.0 (compatible; bingbot/2.0)"]),
        session: { id: crypto.randomUUID(), isNew: true },
        page: { url: "https://example.com/", path: "/", referrer: "" },
      },
    });
  }

  messages.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const m of messages) m.messageId = `seed-${crypto.randomUUID()}`;

  let accepted = 0;
  for (let i = 0; i < messages.length; i += 500) {
    const r = await ingest(project, messages.slice(i, i + 500), {}, environment);
    accepted += r.accepted;
  }
  // Goals and page groups, so Web Analytics has something to measure against on the
  // first load rather than four setup prompts. These are ordinary definitions — nothing
  // about them is special to the seed except that they match the events above.
  //
  // Each carries a fixed id so running the seed twice updates them rather than filling
  // the Conversions page with three copies of every goal.
  await upsertDefinition(project.id, "goal", { id: "seed-demo-requested", name: "Demo requested", is_default: true, config: { type: "primary", match: "event", event: "Demo Requested", funnel: [{ name: "Demo page viewed", match: { match: "pageview", path: { op: "exact", value: "/demo" } } }, { name: "Form started", match: { match: "event", event: "Form Started" } }, { name: "Request confirmed", match: { match: "event", event: "Demo Requested" } }] } });
  await upsertDefinition(project.id, "goal", { id: "seed-signed-up", name: "Signed up", config: { type: "primary", match: "event", event: "Signed Up" } });
  await upsertDefinition(project.id, "goal", { id: "seed-cta-clicked", name: "CTA clicked", config: { type: "supporting", match: "event", event: "CTA Clicked" } });
  await upsertDefinition(project.id, "goal", { id: "seed-form-started", name: "Form started", config: { type: "supporting", match: "event", event: "Form Started" } });
  await upsertDefinition(project.id, "page_group", { id: "seed-group-blog", name: "Blog", position: 0, config: { rules: [{ op: "prefix", value: "/blog" }] } });
  await upsertDefinition(project.id, "page_group", { id: "seed-group-product", name: "Product", position: 1, config: { rules: [{ op: "prefix", value: "/product" }, { op: "exact", value: "/pricing" }] } });
  await upsertDefinition(project.id, "page_group", { id: "seed-group-docs", name: "Docs", position: 2, config: { rules: [{ op: "prefix", value: "/docs" }] } });

  // Several forms behind one event, with a goal per form written out by hand — what
  // split goals are for, and what the Conversions page offers to combine.
  accepted += await seedForms(project, environment);

  console.log(`Seeded ${accepted} events into project "${project.name}" (${project.id})`);
  console.log(`Write key: ${project.write_key}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
