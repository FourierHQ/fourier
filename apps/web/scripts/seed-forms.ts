/**
 * Seeds a marketing site with several forms behind one event, the way a form provider's
 * embed reports them: `Form Submitted` with a `form_id`, and a readable `form_name` only
 * on some of them. Then one goal per form, written out by hand, which is where a site
 * ends up after a year of adding forms — minus the newest form, which nobody made a goal
 * for. That is the situation split goals exist for, and the Conversions page offers to
 * combine these the first time it is opened.
 *
 *   pnpm seed:forms          (also run by `pnpm seed`)
 */
import { ensureDefaultProject, ingest, migrateAll, parseEnvironment, upsertDefinition, type Environment, type IncomingMessage, type Project } from "@fourierhq/core";

const DAY = 86_400_000;

interface Form {
  id: string;
  /** Sent on submissions from `namedSince` days ago onwards, the way a name gets added to tracking late. */
  name?: string;
  namedSince?: number;
  pages: { path: string; title: string; weight: number; section: string }[];
  perDay: number;
  /** First submission this many days ago. */
  since: number;
  goal?: { name: string; type: "primary" | "supporting" };
}

const FORMS: Form[] = [
  {
    id: "7c1e2a9b-4f3d-4b8e-9a61-0d2c5e7f1a01",
    name: "contact-us",
    namedSince: 9,
    pages: [{ path: "/contact", title: "Contact us | Example", weight: 1, section: "get-in-touch" }],
    perDay: 0.9,
    since: 45,
    goal: { name: "Contact inquiry", type: "primary" },
  },
  {
    id: "2b8d4c6e-1a3f-4e5b-8c7d-9f0e1a2b3c02",
    name: "demo-request",
    namedSince: 9,
    pages: [
      { path: "/demo", title: "Book a demo | Example", weight: 3, section: "book-a-demo" },
      { path: "/", title: "Example | Product analytics on ClickHouse", weight: 1, section: "cta-demo" },
    ],
    perDay: 1.4,
    since: 45,
    goal: { name: "Demo form", type: "primary" },
  },
  {
    id: "9e3f5a7b-2c4d-4f6e-8a9b-1c2d3e4f5a03",
    pages: [{ path: "/assessment", title: "Free security assessment | Example", weight: 1, section: "request-assessment" }],
    perDay: 0.5,
    since: 40,
    goal: { name: "Security assessment", type: "primary" },
  },
  {
    id: "4a6b8c0d-3e5f-4a7b-9c1d-2e3f4a5b6c04",
    name: "partner-application",
    namedSince: 9,
    pages: [{ path: "/partners", title: "Become a partner | Example", weight: 1, section: "apply" }],
    perDay: 0.25,
    since: 38,
    goal: { name: "Partner application", type: "primary" },
  },
  {
    id: "6c8d0e2f-5a7b-4c9d-8e1f-3a4b5c6d7e05",
    name: "whitepaper-download",
    namedSince: 9,
    pages: [{ path: "/benchmark-report", title: "The 2026 benchmark report | Example", weight: 1, section: "download" }],
    perDay: 1.1,
    since: 35,
    goal: { name: "Report downloaded", type: "supporting" },
  },
  // Launched two days ago. Nobody has made a goal for it.
  {
    id: "1f3a5b7c-8d9e-4f0a-9b2c-4d5e6f7a8b06",
    pages: [{ path: "/webinar", title: "Live webinar: analytics without the SaaS bill | Example", weight: 1, section: "register" }],
    perDay: 2.5,
    since: 2,
  },
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const LOCATIONS = [
  { country: "US", region: "NY", city: "New York", latitude: 40.7128, longitude: -74.006, locale: "en-US", timezone: "America/New_York" },
  { country: "GB", region: "ENG", city: "London", latitude: 51.5072, longitude: -0.1276, locale: "en-GB", timezone: "Europe/London" },
  { country: "DE", region: "BE", city: "Berlin", latitude: 52.52, longitude: 13.405, locale: "de-DE", timezone: "Europe/Berlin" },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickPage(form: Form) {
  const total = form.pages.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of form.pages) if ((r -= p.weight) <= 0) return p;
  return form.pages[0];
}

export async function seedForms(project: Project, environment: Environment): Promise<number> {
  const now = Date.now();
  const messages: IncomingMessage[] = [];
  for (const form of FORMS) {
    for (let day = form.since; day >= 0; day--) {
      // Poisson-ish: a whole number of submissions most days, some days none.
      const count = Math.floor(form.perDay + Math.random());
      for (let i = 0; i < count; i++) {
        const at = now - day * DAY - Math.floor(Math.random() * DAY * 0.9);
        if (at > now - 60_000) continue;
        const page = pickPage(form);
        const loc = pick(LOCATIONS);
        const anonymousId = `form-${crypto.randomUUID()}`;
        const session = crypto.randomUUID();
        const ctx = (isNew: boolean) => ({
          library: { name: "fourier", version: "0.1.0" },
          userAgent: UA,
          locale: loc.locale,
          timezone: loc.timezone,
          geo: { country: loc.country, region: loc.region, city: loc.city, latitude: loc.latitude, longitude: loc.longitude },
          session: { id: session, isNew },
          page: { url: `https://example.com${page.path}`, path: page.path, title: page.title, referrer: isNew ? "https://www.google.com/" : "" },
        });
        const named = form.name && day <= (form.namedSince ?? Infinity);
        messages.push({ type: "page", anonymousId, timestamp: new Date(at).toISOString(), properties: { path: page.path, title: page.title }, context: ctx(true) } as IncomingMessage);
        messages.push({
          type: "track",
          event: "Form Submitted",
          anonymousId,
          timestamp: new Date(at + 45_000 + Math.floor(Math.random() * 90_000)).toISOString(),
          properties: {
            form_id: form.id,
            ...(named ? { form_name: form.name } : {}),
            form_section: page.section,
            form_variant: page.path === "/" ? "inline" : "default",
            form_provider: "hubspot",
            page_path: page.path,
          },
          context: ctx(false),
        } as IncomingMessage);
      }
    }
  }
  for (const m of messages) (m as Record<string, unknown>).messageId = `seed-form-${crypto.randomUUID()}`;
  let accepted = 0;
  for (let i = 0; i < messages.length; i += 500) accepted += (await ingest(project, messages.slice(i, i + 500), {}, environment)).accepted;

  // One goal per form, each narrowed by form_id: how these accumulate by hand. Fixed ids,
  // so seeding twice updates them in place.
  for (const [i, form] of FORMS.entries()) {
    if (!form.goal) continue;
    await upsertDefinition(project.id, "goal", {
      id: `seed-form-${i}`,
      name: form.goal.name,
      config: { type: form.goal.type, match: "event", event: "Form Submitted", properties: [{ key: "form_id", op: "eq", value: form.id }] },
    });
  }
  return accepted;
}

async function main() {
  const environment = parseEnvironment(process.env.FOURIER_SEED_ENVIRONMENT);
  await migrateAll();
  const project = await ensureDefaultProject();
  const accepted = await seedForms(project, environment);
  console.log(`Seeded ${accepted} form events into project "${project.name}" (${environment})`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
