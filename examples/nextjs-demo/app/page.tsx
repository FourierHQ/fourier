"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFourier } from "fourier/next";

const CAMPAIGNS = [
  { label: "Twitter · launch", query: "utm_source=twitter&utm_medium=social&utm_campaign=launch" },
  { label: "Google Ads · spring-promo", query: "utm_source=google&utm_medium=cpc&utm_campaign=spring-promo&utm_term=product+analytics" },
  { label: "Newsletter · weekly", query: "utm_source=newsletter&utm_medium=email&utm_campaign=weekly&utm_content=cta-top" },
  { label: "Product Hunt · launch", query: "utm_source=producthunt&utm_medium=social&utm_campaign=launch" },
  { label: "LinkedIn · case-study", query: "utm_source=linkedin&utm_medium=social&utm_campaign=case-study" },
];
const REFERRERS = [
  { label: "Google (organic)", url: "https://www.google.com/" },
  { label: "Hacker News", url: "https://news.ycombinator.com/item?id=1" },
  { label: "Partner blog", url: "https://blog.partner.example/why-fourier" },
  { label: "GitHub README", url: "https://github.com/example/fourier" },
];
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMPANIES = [
  { id: "acme", name: "Acme Inc", plan: "enterprise" },
  { id: "globex", name: "Globex", plan: "pro" },
  { id: "demo-co", name: "Demo Co", plan: "free" },
];

export default function Home() {
  const fourier = useFourier();
  const [log, setLog] = useState<string[]>([]);
  const [user, setUser] = useState<string | null>(null);
  const [company, setCompany] = useState<string | null>(null);

  useEffect(() => {
    setUser(fourier.userId());
    setCompany(fourier.groupId());
    // Once the automatic page view has captured utm_* from the URL, tidy the address bar.
    const tidy = location.search.includes("utm_") ? setTimeout(() => history.replaceState(null, "", location.pathname), 1500) : null;
    const onAny = (...args: unknown[]) => {
      const [name] = args;
      setLog((l) => [`${new Date().toLocaleTimeString()}  ${String(name ?? "")}`, ...l].slice(0, 30));
    };
    fourier.on("track", (event) => onAny(`track  ${String(event)}`));
    fourier.on("page", () => onAny("page"));
    fourier.on("identify", () => onAny("identify"));
    fourier.on("group", () => onAny("group"));
    return () => {
      if (tidy) clearTimeout(tidy);
      fourier.off("track");
      fourier.off("page");
      fourier.off("identify");
      fourier.off("group");
    };
  }, [fourier]);

  const login = () => {
    const id = `demo_user_${Math.floor(Math.random() * 1000)}`;
    fourier.identify(id, { email: `${id}@example.com`, name: id.replace("demo_user_", "Demo User "), plan: "trial" });
    setUser(id);
  };
  const joinCompany = (c: (typeof COMPANIES)[number]) => {
    fourier.group(c.id, { name: c.name, plan: c.plan, industry: "Software" });
    setCompany(c.id);
  };

  // --- attribution helpers: each simulates an arrival as a new session ---
  const arriveFromReferrer = (url: string) => {
    fourier.newSession();
    fourier.page({ referrer: url });
  };
  const arriveDirect = () => {
    fourier.newSession();
    fourier.page({ referrer: "" });
  };
  const arriveFromCampaign = (query: string) => {
    // no reload: inject the campaign into context the way the SDK does when utm_* is in the URL
    const p = new URLSearchParams(query);
    fourier.newSession();
    fourier.page(
      { referrer: "" },
      {
        context: {
          campaign: {
            source: p.get("utm_source") ?? "",
            medium: p.get("utm_medium") ?? "",
            name: p.get("utm_campaign") ?? "",
            content: p.get("utm_content") ?? "",
            term: p.get("utm_term") ?? "",
          },
        },
      },
    );
  };

  /** Anonymous campaign landing → browse → sign up → identify + company → later return visits. */
  const fullJourney = async () => {
    fourier.reset();
    setUser(null);
    setCompany(null);
    const campaign = pick(CAMPAIGNS);
    const c = pick(COMPANIES);
    const id = `journey_user_${Math.floor(Math.random() * 1000)}`;
    arriveFromCampaign(campaign.query);
    await wait(150);
    fourier.page("Pricing", { path: "/pricing", url: `${location.origin}/pricing`, referrer: `${location.origin}/` });
    await wait(150);
    fourier.track("Signed Up", { method: "email", campaign: campaign.label });
    fourier.identify(id, { email: `${id}@${c.id}.com`, name: id.replace("journey_user_", "Journey User "), plan: c.plan });
    fourier.group(c.id, { name: c.name, plan: c.plan, industry: "Software" });
    setUser(id);
    setCompany(c.id);
    await wait(150);
    arriveFromReferrer(pick(REFERRERS).url);
    fourier.track("Report Created", { type: "funnel", rows: 120 });
    await wait(150);
    arriveDirect();
    fourier.track("Report Exported", { format: "csv" });
    await fourier.flush();
  };

  return (
    <main>
      <h1>Fourier demo app</h1>
      <p>
        A Next.js app instrumented with <code>fourier/next</code>. Click around, then watch the events land in the dashboard at{" "}
        <a className="btn" href={process.env.NEXT_PUBLIC_FOURIER_HOST ?? "http://localhost:5050"} target="_blank" rel="noreferrer">
          localhost:5050
        </a>
      </p>

      <section>
        <h2>1. Identify</h2>
        <div className="row">
          <button className="primary" onClick={login}>
            {user ? `Logged in as ${user}` : "Log in (identify)"}
          </button>
          <button
            onClick={() => {
              fourier.reset();
              setUser(null);
              setCompany(null);
            }}
          >
            Log out (reset)
          </button>
        </div>
      </section>

      <section>
        <h2>2. Company (group)</h2>
        <div className="row">
          {COMPANIES.map((c) => (
            <button key={c.id} className={company === c.id ? "primary" : ""} onClick={() => joinCompany(c)}>
              {c.name}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>3. Track</h2>
        <div className="row">
          <button onClick={() => fourier.track("Report Created", { type: "funnel", rows: Math.floor(Math.random() * 5000) })}>Report Created</button>
          <button onClick={() => fourier.track("Report Exported", { format: "csv" })}>Report Exported</button>
          <button onClick={() => fourier.track("Upgrade Clicked", { from_plan: "trial", to_plan: "pro" })}>Upgrade Clicked</button>
          <button onClick={() => fourier.track("Checkout Completed", { plan: "pro", amount: 4900, currency: "USD" })}>Checkout Completed</button>
        </div>
      </section>

      <section>
        <h2>4. Attribution: campaigns (UTM)</h2>
        <p style={{ marginBottom: 8, fontSize: 13 }}>Links reload the page with UTM parameters, exactly like an ad click. Buttons simulate the same arrival without a reload.</p>
        <div className="row" style={{ marginBottom: 8 }}>
          {CAMPAIGNS.map((c) => (
            <a key={c.query} className="btn" href={`/?${c.query}`}>
              ↗ {c.label}
            </a>
          ))}
        </div>
        <div className="row">
          {CAMPAIGNS.map((c) => (
            <button key={c.query} onClick={() => arriveFromCampaign(c.query)}>
              {c.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>5. Attribution: referrals and direct</h2>
        <p style={{ marginBottom: 8, fontSize: 13 }}>Each click starts a new session and records a page view with that referrer.</p>
        <div className="row">
          {REFERRERS.map((r) => (
            <button key={r.url} onClick={() => arriveFromReferrer(r.url)}>
              {r.label}
            </button>
          ))}
          <button onClick={arriveDirect}>Direct (bookmark)</button>
        </div>
      </section>

      <section>
        <h2>6. Full journey</h2>
        <p style={{ marginBottom: 8, fontSize: 13 }}>
          Resets to a fresh anonymous visitor, lands from a random campaign, browses pricing, signs up and joins a company, then returns via a referrer and directly. Open the
          user in the dashboard to see all three touches attributed to them.
        </p>
        <div className="row">
          <button className="primary" onClick={fullJourney}>
            Run full journey
          </button>
        </div>
      </section>

      <section>
        <h2>7. Page views (automatic)</h2>
        <div className="row">
          <Link className="btn" href="/pricing">
            /pricing
          </Link>
          <Link className="btn" href="/docs">
            /docs
          </Link>
        </div>
      </section>

      <section>
        <h2>Client log</h2>
        <div className="log">{log.length === 0 ? <div>Nothing yet</div> : log.map((l, i) => <div key={i}>{l}</div>)}</div>
      </section>
    </main>
  );
}
