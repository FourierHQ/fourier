<p align="center">
  <img src="brand/lockup-on-onyx.png#gh-dark-mode-only" alt="Fourier" width="233" />
  <img src="brand/lockup-on-paper.png#gh-light-mode-only" alt="Fourier" width="233" />
</p>

<p align="center">
  Open source product analytics on ClickHouse. The analytics.js API you already use, companies as a first-class entity, and an API + MCP server so agents can query everything.
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FFourierHQ%2Ffourier&root-directory=apps%2Fweb&project-name=fourier&repository-name=fourier&env=CLICKHOUSE_URL,CLICKHOUSE_USER,CLICKHOUSE_PASSWORD,CLICKHOUSE_DATABASE,FOURIER_SECRET,FOURIER_SETUP_TOKEN&envDescription=ClickHouse%20connection%20%28ClickHouse%20Cloud%20works%20out%20of%20the%20box%29.%20FOURIER_SECRET%20signs%20sessions%20-%20paste%20any%20long%20random%20string.%20FOURIER_SETUP_TOKEN%20is%20optional%20and%20gates%20the%20create-first-account%20screen.&envLink=https%3A%2F%2Fgithub.com%2FFourierHQ%2Ffourier%23clickhouse-cloud"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

---

Fourier replaces the Segment + Amplitude (or Mixpanel) pair with one thing you run yourself: a Next.js app and a ClickHouse database.

- **Drop-in SDK.** `identify`, `track`, `page`, `group`, `alias`, `reset` with the exact analytics.js argument conventions, callbacks, middleware, and cookies. Migrating from Segment is a find-and-replace. First-class Next.js provider with automatic page views.
- **Companies built in.** `group()` makes a company a real entity: members, activity, attribution, all roll up. Query anything per company.
- **Identity that works.** Anonymous activity is attributed to the person once they identify, retroactively, including funnels and attribution.
- **Attribution.** Every arrival is a touch: UTMs, referrers, direct sessions. First touch, last touch, and any multi-touch model from the same rows.
- **Agent-native.** Everything in the dashboard is available through a REST API and an MCP server, including read-only SQL against the raw data.
- **One deployable.** Ingest, dashboard, API, and MCP in a single Next.js app. Deploy to Vercel against ClickHouse Cloud with zero infrastructure of your own, or run it anywhere Node runs.

## Quick start

Requirements: Node 22+ (see `.nvmrc`), pnpm, and ClickHouse (a local binary, Docker, or ClickHouse Cloud).

```bash
git clone https://github.com/FourierHQ/fourier.git && cd fourier
pnpm install
cp .env.example .env            # defaults point at a local ClickHouse on :8123

# ClickHouse, pick one:
brew install clickhouse                                           # local binary; `pnpm dev` starts it for you
docker compose -f infra/clickhouse/docker-compose.yml up -d       # or Docker
# or edit .env to point at ClickHouse Cloud (see below)

pnpm dev                        # dashboard on http://localhost:5050
```

The dashboard creates the database, tables, and a default project on first request. Open it, go to **Install**, and copy the snippet with your write key already filled in. It shows the moment the first event lands.

Optional: `pnpm seed` loads 30 days of demo companies, users, and events. `pnpm dev:demo` runs an instrumented example app on http://localhost:5051 (copy `examples/nextjs-demo/.env.local.example` to `.env.local` and paste your write key first).

### ClickHouse Cloud

Create a service at [clickhouse.cloud](https://clickhouse.cloud) (the free tier is plenty to start), then set:

```
CLICKHOUSE_URL=https://<your-service>.clickhouse.cloud:8443
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=<password>
CLICKHOUSE_DATABASE=fourier
```

Fourier does the rest: database, tables, materialised views, migrations on boot.

### Deploy to Vercel

Click the button above, or import the repo manually with **Root Directory** set to `apps/web` and the four `CLICKHOUSE_*` variables from your ClickHouse Cloud service. Your deployment URL is both the dashboard and the ingest host; put it in `NEXT_PUBLIC_FOURIER_HOST` in the apps you instrument.

Two more worth setting on Vercel specifically:

```bash
openssl rand -base64 32   # FOURIER_SECRET
```

`FOURIER_SECRET` signs session cookies. Fourier generates one on first boot if you leave it unset, but Vercel runs many instances and two of them starting at once briefly disagree about which generated secret won — which shows up as being signed out at random for the first minute. Setting it removes that window and gives you a way to end every session at once (change it).

`FOURIER_SETUP_TOKEN` is optional and closes the gap between "deployment is live" and "you created your account" — in that window, whoever opens the URL first becomes the admin. Set it and the setup screen asks for it too.

**Opening it for the first time** takes you to a create-your-account screen; the first account is the admin, and after that the same URL is a sign-in page. Ingest needs none of this — write keys work from the moment the deployment is live. If the first load says it can't reach the server, that is usually a ClickHouse Cloud service still waking up: wait a moment and press Try again.

## Instrument a Next.js app

```bash
pnpm add @fourierhq/sdk
```

```tsx
// app/layout.tsx
import { FourierProvider } from "@fourierhq/sdk/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <FourierProvider writeKey={process.env.NEXT_PUBLIC_FOURIER_WRITE_KEY!} host={process.env.NEXT_PUBLIC_FOURIER_HOST!}>
          {children}
        </FourierProvider>
      </body>
    </html>
  );
}
```

```tsx
"use client";
import { useFourier } from "@fourierhq/sdk/next";

const fourier = useFourier();
fourier.identify("user_123", { email: "jane@acme.com", plan: "pro" });
fourier.group("acme", { name: "Acme Inc", plan: "enterprise" });   // the user's company
fourier.track("Report Exported", { format: "csv" });
```

Page views are sent automatically on every route change. The plain browser client (`fourier`) and the server client (`fourier/server`) are documented in [packages/sdk/README.md](packages/sdk/README.md). A complete working app is in [examples/nextjs-demo](examples/nextjs-demo).

### Coming from Segment

The SDK implements the analytics.js surface: `identify`, `track`, `page`, `screen`, `group`, `alias`, `reset`, `ready`, `user()`, `group()`, `on/once/off`, `trackLink`, `trackForm`, `addSourceMiddleware`, `setAnonymousId`, the same argument shifting and callbacks, and the same `ajs_*` cookies, so anonymous ids survive the switch.

```diff
- import { AnalyticsBrowser } from "@segment/analytics-next";
+ import { AnalyticsBrowser } from "@fourierhq/sdk";
- const analytics = AnalyticsBrowser.load({ writeKey });
+ const analytics = AnalyticsBrowser.load(writeKey, { host: "https://analytics.example.com" });
```

The server also speaks Segment's HTTP tracking API (`POST /v1/batch`, `/v1/track`, `/v1/identify`, `/v1/page`, `/v1/group`, `/v1/alias`, Basic auth with the write key) and serves the settings document at `/v1/projects/:writeKey/settings`. An unmodified `@segment/analytics-next` or `@segment/analytics-node` can be pointed at Fourier with only its `cdnURL` / `apiHost` / `host` changed, and RudderStack or Jitsu can forward to it as a destination. Fourier itself has no dependency on Segment.

## Concepts

### Sources: several sites and products, one set of users

A project is one identity space. Inside it, create a **source** for each website, app, or product; each gets its own write key. Events record which source they came from, while users and companies are shared across all of them. So a visitor on your marketing site who later signs up in your app is one person, and a company's page shows which of your products its people use. Filter any view, endpoint, or MCP tool by `source`.

Keeping the visitor one person across sites:

- Subdomains of one domain share the anonymous id through the cookie: `cookieDomain: ".example.com"`.
- Different domains can't share cookies, so list them in `crossDomain: ["app.example.io"]`. Links to those hosts are decorated with the anonymous id (`ajs_aid`, and `ajs_uid` once identified, the same parameters analytics.js uses) and read on arrival. `fourier.decorateUrl(url)` does the same for URLs you build yourself.
- Signing in on any site with `identify(userId)` links everything the person did on every site, including before sign-up.

Use separate projects only for genuinely separate user bases, such as different client businesses.

### Environments: production, preview and development

Sources deliberately **share** a person graph, so they are the wrong tool for keeping test data out of real numbers — `identify("user_123")` from a preview deploy would merge into the same person as the real `user_123`. Environments exist for that, and they share nothing.

Each environment is a **separate ClickHouse database** — `fourier`, `fourier_preview`, `fourier_development` — created and migrated automatically on boot. Production keeps the base name, so an install that predates this is already the production environment with nothing to migrate. There is no environment column to filter on: a production query cannot see preview rows because they are not in the database it is connected to.

What is shared is the definitions: projects, sources and write keys live once in the base database. "Marketing site" is one source with the same id everywhere, so a source filter means the same thing in every environment — you just get a different write key per environment.

**Which environment an event lands in is decided by the write key**, never by the client. A preview deployment holds only the preview key, so it cannot write to production however its code is configured.

Wiring it up on Vercel takes no code, because Vercel already scopes environment variables per environment:

1. In the dashboard's setup guide, switch the environment picker and copy that environment's write key.
2. In Vercel → Settings → Environment Variables, set `NEXT_PUBLIC_FOURIER_WRITE_KEY` three times — same name, one value per environment checkbox.
3. Put the development key in your local `.env.local`.

Your app never reads `VERCEL_ENV`. Vercel hands each deployment the right key, and the key decides the rest.

The dashboard's environment switcher is in the sidebar and opens on Production; non-production is tinted amber so preview numbers are never mistaken for real ones. Every API endpoint and MCP tool takes an `environment` argument and defaults to production. To reset an environment, drop its database — it is rebuilt on the next boot.

### People and identity

`identify(userId, traits)` names the current visitor. Everything they did anonymously before that is attributed to them: the Users list, counts, funnels, and the person's timeline all resolve anonymous ids to the person they became. Resolution lives in the database, in the `identity_map`, `events_resolved`, and `person_stats` views, so agents writing SQL get the same answer as the dashboard. `alias(newId, previousId)` links two ids the same way. Conflicts, such as a shared device without `reset()`, resolve to the earliest link.

### Companies

`group(groupId, traits)` registers a company and links the current user to it. Every later event carries `group_id`. The **Companies** view shows members, top events, activity, and attribution per company, and every API endpoint and MCP tool accepts a `group_id` filter.

### System and hidden events

Not everything that arrives is something a person did. **Settings → Events** has two lists.

**System events** are messages the SDK sends to make the product work. `$page_leave` is one: it fires once per page view carrying the foreground time that page held, so left in the activity views it would roughly double the event count of a site that only has page views. It is kept out of them by default — and **kept out is not ignored**. That measurement is read from the stored row either way: the `sessions` rollup sums it into `engaged_ms` when the event arrives, and the per-page engagement report reads the raw rows when you open it. Engagement time, engaged sessions and the engagement rate are computed from these events whether or not they are shown. Showing one changes what you see, never what is measured — which is what makes it a safe thing to switch on while debugging instrumentation.

**Hidden events** are your own events that you have decided are not activity.

Either way the exclusion is the same, and it reaches **every** count, chart, ranking and feed: the overview totals and activity chart, the events list and its filter, top events, and each person's and each company's event count. Nothing is deleted and nothing is dropped at ingest — the rows are still stored, still counted by raw SQL, and showing an event again brings back its entire history, including the part recorded while it was hidden. Like goals and page groups, the setting is stored once for the whole install rather than per environment.

Raw SQL is the one exception, because it is your SQL: `describe_schema` names the excluded events so an agent can leave them out and get the same numbers the dashboard shows.

### Location

Every event carries the country, region, city and coordinates it arrived from. It is a property of the arrival, not of the person — someone who travels has events in several countries, and each keeps its own — so the Users list and profile show where that person was **last** seen, ignoring events that carry no location.

It is derived on the server from the connecting address rather than asked of the page, so ordinary traffic gets an answer nobody had to be trusted for. It is **not an authenticated signal** — don't use it for access control, billing or compliance. Behind Vercel, Cloudflare or CloudFront the header is written by the edge and a client cannot set it; with nothing trusted in front, these headers arrive from the client like any other and are believed, as is `context.geo`. That is no new hole: a write key is public by design, so whoever can forge a country can equally forge the event name and the user id.

- **On Vercel, Cloudflare or CloudFront, it already works.** They resolve the address at the edge and pass it in request headers; Fourier reads them. Nothing to install, nothing to configure, no lookup cost.
- **Behind your own proxy**, set `X-Geo-Country`, `X-Geo-Region`, `X-Geo-City`, `X-Geo-Latitude` and `X-Geo-Longitude` from your nginx/Caddy GeoIP module.
- **With nothing in front of it**, point `FOURIER_GEOIP_DB` at a MaxMind-format `.mmdb` file. [DB-IP Lite](https://db-ip.com/db/lite.php) is the one to reach for: same format as GeoLite2, downloadable without an account or licence key, refreshed monthly. Leave the variable unset and events simply have no location.
- **Server-side SDKs** report on behalf of someone else, so the edge sees your datacenter rather than your user. Send `context.ip` with the end user's address and the edge's view is discarded — but resolving that address needs `FOURIER_GEOIP_DB`, which a Vercel deployment has no reason to have, so on Vercel those events get no location at all. Send `context.geo` instead and they get the right one.

### Attribution

Every arrival is a **touch**: the first message of a session, and any page view carrying UTM parameters or an external referrer. Touches are classified `campaign`, `referral`, or `direct`, keep the landing page and all `utm_*` fields, and belong to the person, including arrivals from before they signed up. Nothing is overwritten, so first-touch, last-touch, and multi-touch models are aggregations over the same rows.

- User and company pages show first touch, last touch, and the arrival timeline. Company attribution is the union of its members' touches, with how each member arrived.
- The overview shows where identified sign-ups come from, by source, referrer, campaign, or type.
- Last-touch ignores direct arrivals when the person has any campaign or referral touch.

Sessions come from the SDK: 30 minutes of inactivity starts a new one, configurable with `sessionTimeout`. Server-side events have no session and only create touches when they carry UTMs.

### Web Analytics

An opinionated report on how a marketing website is doing, in four pages and no dashboard to build: **Overview**, **Acquisition**, **Pages**, **Conversions**. Campaigns, referrers, devices, browsers, geography and page groups live inside those four as groupings, drilldowns and filters, because a sidebar of fourteen reports is one nobody finishes reading.

One control bar runs the section — source, date range, comparison, conversion goal, filters — and it lives entirely in the URL, so a view can be bookmarked or sent to someone and moving between reports keeps what you were looking at.

"Source" means what it means everywhere else in Fourier: a website or app with its own write key. The campaign parameter that wants the same word is reported as **campaign source**, which is what it is — it exists only where a link was tagged, so most traffic has none.

Everything is counted in **sessions**, off one rollup that the `sessions` materialised view maintains. A few consequences are worth knowing, because they are what make the numbers hold up:

- **A conversion rate shows its working.** "2.5% — 12 of 480 sessions", never a bare percentage. A rate with nothing to divide by is unavailable, not 0%. A previous period of zero reads "New", not +∞%.
- **A session converts once**, however many times the goal fires inside it.
- **Landing-page conversion means conversion in visits that started there** — not conversion among everyone who happened to see the page. The All pages tab carries no conversion column at all, because viewing a page is not evidence it caused anything.
- **Bots and channels are decided when you read, not when the event arrives.** Both are derived in the `sessions_resolved` view from the stored user agent and campaign, so correcting either re-reports every visit already recorded rather than only the ones that arrive next.
- **Engagement is measured, not inferred.** The SDK times foreground attention, stops for a hidden or idle tab, and reports it on leaving the page. Where it was never measured the reports say so rather than showing zero seconds. Turn it off with `engagement: false`.
- **Nothing is invented.** No traffic, no goal configured, a goal nobody has completed, a measurement the SDK never sent, and a filter that matches nothing are five different states with five different messages.
- **"Which page drives conversions" is two counts, not one.** A page is credited both for conversions that happened *on* it and, separately, for conversions on the page a visitor went to *next*. Neither is enough alone: a dedicated `/book-a-demo` tops the first by construction and tells you nothing, while the same form embedded on a product page makes that page the one doing the work. Both columns are observations, they are never added together, and a page showing both is a content page with a form in it.
- **Conversions are also credited to what first brought the person**, split by whether they converted then or came back later. Everywhere else credits the visit a conversion happened in, which under-credits whatever introduced someone who returned weeks later to convert. The two segments add to the row's total rather than sitting beside each other as a comparison — a channel with a tail of returns is seeding demand some other visit gets the credit for. "First" means the first arrival Fourier recorded, so on a young install nearly everything is a first visit.

Goals, supporting actions and page groups are defined in the dashboard and stored once for the whole install, not per environment — so a goal can be checked in preview before the tracking that fires it ships. They are compiled into SQL when a report runs, which means naming a goal a week after installing tracking reports the week you already have.

A **primary goal** is something the site exists to produce and is the only thing a conversion rate counts. A **supporting action** — a CTA click, a form start, a download — is reported on its own and never added to a conversion total.

Reports count **all conversions** by default: a site with three goals answers "how is it doing" with the visits that completed any of them, counted once each — a visit that signs up and books a demo is one converting session, not two. Narrowing to a single goal is a refinement, and it is a separate control from the filters on purpose: a filter changes which visits are counted, while the goal changes only what counts as a conversion. The session total stays exactly where it was, which is visible in every rate's denominator.

## Accounts and access

Two kinds of credential, because sending data and reading it are different jobs.

**Write keys** (`fk_…`) send data in. They ship in your website's JavaScript, they are public by design, and they never need an account — a browser or a backend job must never have to log in to report an event. Nothing about accounts changes ingest.

**Sessions and read keys** (`fr_…`) read data back. The dashboard API, the SQL endpoint and the MCP server all require one. A read key never touches accounts: it is pasted into agent configs and MCP clients, so it cannot add, remove or reset one even when the account that minted it is an admin. What it can write is a definition — a goal, a page group, an event hidden from the reports — because a definition is a reading of the data rather than the data itself, it is applied at query time, and it can be taken back. No key of any kind can change or delete an event that has arrived.

Getting there is a ladder, so nothing is in your way until it needs to be:

| | |
|---|---|
| `pnpm dev` | No login. Clone, point at ClickHouse, look at data. The sidebar says *No sign-in (dev)*. Run `FOURIER_REQUIRE_AUTH=true pnpm dev` to exercise the real flow locally. |
| First deploy | A create-your-account screen. Until someone claims it, every read endpoint is closed. |
| After that | Sign in, or send `Authorization: Bearer fr_…`. |

Accounts live in ClickHouse alongside everything else — no second database to run. Sessions are signed tokens rather than rows, so signing in doesn't write to ClickHouse, and `FOURIER_SECRET` rotation invalidates every one of them. Passwords are hashed with scrypt from Node's standard library, so there is no native dependency to build.

**Adding people** is the **Settings** page. An admin sets someone's email, an initial password and a role, and passes the two on however the team already talks — there is no mail server to configure, no invitation link to expire, and nothing to receive before you can sign in. The new person changes their password from the same page; an admin can set a fresh one for anybody locked out, which signs that person out everywhere.

Two roles. **Admins** add, remove and reset people. **Members** see everything else — all the data, the SQL endpoint, their own read keys. The first account is the admin; accounts it creates are members unless you say otherwise. The last admin can't be demoted or removed, and nobody can change their own role or delete their own account, so an instance can't be locked out of its own settings.

The `accounts` table carries `auth_provider` and `provider_user_id` from the first release, so adding Google or another OIDC provider later is additive rather than a migration.

Today every signed-in account can see every project — one install is one team, which is what self-hosting means. That rule lives in exactly one function, `canAccessProject` in `packages/core/src/auth.ts`, so growing into organisations and memberships later is a change there and nowhere else.

See `.env.example` for `FOURIER_SECRET`, `FOURIER_SETUP_TOKEN`, `FOURIER_REQUIRE_AUTH` and the cross-origin settings.

## Agents: API and MCP

Everything the dashboard shows comes from `/api/*`; the **API & MCP** page lists every endpoint, mints read keys, and has a SQL playground.

```bash
claude mcp add --transport http fourier http://localhost:5050/api/mcp \
  --header "Authorization: Bearer fr_YOUR_READ_KEY"
```

The header is only needed once the instance has accounts — in development, MCP works without it.

Tools: `list_projects`, `list_sources`, `get_overview`, `list_event_names`, `list_events`, `event_timeseries`, `event_property_keys`, `event_property_values`, `list_users`, `get_user`, `list_groups`, `get_group`, `list_touches`, `attribution_report`, `list_goals`, `goal_report`, `describe_schema`, `run_sql` read. `create_goal`, `update_goal` and `delete_goal` write, and are the only tools that do — they edit goals, the same rows the **Conversions** page edits, and nothing else. `run_sql` runs arbitrary ClickHouse SELECTs with `readonly=1`, a keyword guard, and the project bound server-side via the `{project_id}` placeholder.

Goals are worth calling out: an agent can read what counts as a conversion, define a new one — an event narrowed by its properties, or a page view, with an optional funnel to it — and then ask `goal_report` how it is doing. Because goals are matched when a report runs rather than at ingest, one an agent defines today reports the history you already have, and deleting it leaves the events untouched.

## Data model

ClickHouse, all times UTC. `events` is the source of truth, one row per message, tagged with the `source_id` it arrived on. `distinct_id` is `user_id` when identified, otherwise `anonymous_id`; `person_id` is the resolved person. Query `events_resolved` rather than `events` for anything per person. `user_traits`, `group_traits`, and `identities` hold merged traits and id links. Location lives on the event (`country`, `region`, `city`, `latitude`, `longitude`) and is rolled up to "last seen in" per person. Materialised views keep `user_stats`, `group_stats`, `group_members`, `event_stats_daily`, `actor_event_stats`, `sessions` and `touches` current on insert. `actor_event_stats` is those same counts split by event name, which is what lets a hidden event be subtracted from a total that was rolled up across all of them. `sessions.engaged_ms` is deliberately not one of those totals: it is summed from `$page_leave` at write time and is unaffected by what is hidden. `sessions` is one row per visit and is what Web Analytics counts; read it through `sessions_resolved`, which merges the aggregate states, resolves the visitor to a person, and classifies the visit's channel and whether it was a bot. `definitions` holds the goals, page groups and hidden events, in the control database alongside sources. Full description: `GET /api/projects/default/schema` or the `describe_schema` MCP tool.

## Repository

```
apps/web              Next.js dashboard, ingest (/v1), read API (/api), MCP (/api/mcp)
packages/sdk          `fourier` npm package: browser, Next.js, and server clients (MIT)
packages/core         ClickHouse schema, migrations, ingest, queries
examples/nextjs-demo  Instrumented example app with attribution test controls
infra/clickhouse      Local ClickHouse config and a docker-compose alternative
brand                 Mark, palette, and the generator for every icon and favicon
```

```
pnpm dev          starts local ClickHouse if needed, then the dashboard on :5050
pnpm dev:demo     example app on :5051
pnpm seed         demo data into the default project
pnpm mcp          MCP server over stdio (same tools as /api/mcp)
pnpm test         unit tests: SDK analytics.js parity, core goal matching
pnpm typecheck    all packages
pnpm build        all packages
pnpm brand        regenerate every icon, favicon, and social card from brand/
```

## Brand

The mark, the palette, and every icon come from [`brand/`](brand/README.md). Three colours for now — onyx `#141414`, platinum `#EEF0F2`, mint `#00FFAE` — and a dependency-free generator behind `pnpm brand` that rebuilds every favicon, app icon and social card from them. Change a colour in one place and everything follows.

## Roadmap

Saved reports (retention, trends), an event and property explorer, multi-project UI, OIDC sign-in, per-write-key rate limiting, and a single-process Docker image for non-Vercel self-hosting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests require accepting the [Contributor License Agreement](CLA.md), which is handled by a bot on your first PR.

## License

- The server, dashboard, and core (`apps/`, `packages/core`) are licensed under the [GNU Affero General Public License v3.0](LICENSE).
- The SDK (`packages/sdk`, the `fourier` npm package) and the example app are licensed under [MIT](packages/sdk/LICENSE), so they can be included in any application without restriction.

**What this means in practice**

- Running Fourier for your own product, on your own infrastructure or on Vercel, requires nothing from you. Use it, modify it, keep your changes private.
- If you offer Fourier itself to others as a hosted service, the AGPL requires you to publish your modifications to it under the same license.
- Your application code that calls the SDK is yours. The SDK is MIT precisely so that this is never in question.
- FourierHQ offers a hosted version and can provide a commercial license for organisations whose policies exclude AGPL software. Open an issue or get in touch.
