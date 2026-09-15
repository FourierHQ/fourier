/**
 * Seeds the default project with 30 days of realistic SaaS data:
 * companies (groups), users, page views and product events.
 *   pnpm seed
 */
import { configFromEnv, ensureDefaultProject, ingest, migrateAll, parseEnvironment, type IncomingMessage } from "@fourierhq/core";

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
      const sessions = new Map<number, string>();
      const session = (t: number) => {
        // one session per calendar hour bucket in the seed; first message in it is the arrival
        const key = Math.floor(t / 3_600_000);
        const isNew = !sessions.has(key);
        if (isNew) sessions.set(key, crypto.randomUUID());
        return { id: sessions.get(key)!, isNew };
      };
      const ctx = (t: number) => ({
        session: session(t),
        library: { name: "fourier", version: "0.1.0" },
        userAgent: ua,
        locale: pick(["en-US", "en-GB", "de-DE", "fr-FR"]),
        timezone: pick(["America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo"]),
        page: { url: `https://app.example.com${pick(PAGES)}`, path: pick(PAGES), title: "Example App", referrer: t === signup ? pick(["https://google.com/", "https://news.ycombinator.com/", "", "https://twitter.com/"]) : "" },
        campaign: t === signup && Math.random() > 0.4 ? { source: pick(["google", "twitter", "newsletter", "producthunt"]), medium: pick(["cpc", "social", "email"]), name: pick(["launch", "spring-promo", "docs"]) } : undefined,
        groupId: c.id,
      });

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
        const sessionStart = now - day * DAY - rand(0, 12) * 3_600_000 - rand(0, 3_600_000);
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

  // a few anonymous visitors who never signed up
  for (let i = 0; i < 25; i++) {
    const anonymousId = crypto.randomUUID();
    const t = now - rand(0, 30) * DAY - rand(0, DAY);
    messages.push({ type: "page", anonymousId, timestamp: new Date(t).toISOString(), properties: { path: "/", url: "https://app.example.com/", title: "Example App" }, context: { library: { name: "fourier", version: "0.1.0" }, userAgent: pick(UAS), page: { referrer: pick(["https://google.com/", "", "https://producthunt.com/"]) } } });
    if (Math.random() > 0.5) messages.push({ type: "page", anonymousId, timestamp: new Date(t + 20_000).toISOString(), properties: { path: "/pricing", url: "https://app.example.com/pricing", title: "Pricing" }, context: { library: { name: "fourier", version: "0.1.0" }, userAgent: pick(UAS) } });
  }

  messages.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const m of messages) m.messageId = `seed-${crypto.randomUUID()}`;

  let accepted = 0;
  for (let i = 0; i < messages.length; i += 500) {
    const r = await ingest(project, messages.slice(i, i + 500), {}, environment);
    accepted += r.accepted;
  }
  console.log(`Seeded ${accepted} events into project "${project.name}" (${project.id})`);
  console.log(`Write key: ${project.write_key}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
