# @fourierhq/sdk

Open source product analytics SDK. Drop-in compatible with Segment's analytics.js API: `identify`, `track`, `page`, `group`, `alias`, `reset`, `user()`, `ready()`, `on()`, `trackLink`, `trackForm`, source middleware and the same `ajs_*` cookies, so an existing Segment install keeps its anonymous ids.

It talks to a [Fourier](https://github.com/FourierHQ/fourier) server you run yourself — self-hosted or on Vercel, with ClickHouse underneath. The SDK is MIT; the server is AGPL-3.0.

```bash
pnpm add @fourierhq/sdk
```

## Next.js (App Router)

```tsx
// app/layout.tsx
import { FourierProvider } from "@fourierhq/sdk/next";

export default function RootLayout({ children }) {
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

export function UpgradeButton() {
  const fourier = useFourier();
  return <button onClick={() => fourier.track("Upgrade Clicked", { plan: "pro" })}>Upgrade</button>;
}
```

Page views are tracked automatically on route changes.

## Anywhere in the browser

```ts
import fourier from "@fourierhq/sdk";
fourier.init({ writeKey: "...", host: "https://analytics.example.com" });
fourier.identify("user_123", { email: "jane@acme.com", plan: "pro" });
fourier.group("acme", { name: "Acme Inc", plan: "enterprise" });
fourier.track("Report Exported", { format: "csv" });
```

## Server (API routes, server actions, cron)

```ts
import { FourierServer } from "@fourierhq/sdk/server";
const fourier = new FourierServer({ writeKey: process.env.FOURIER_WRITE_KEY!, host: process.env.FOURIER_HOST! });
fourier.track({ userId: "user_123", event: "Invoice Paid", properties: { amount: 4900 } });
await fourier.closeAndFlush();
```

## Several sites, one identity

```ts
fourier.init({
  writeKey,                       // this site's own source key from the dashboard
  host,
  cookieDomain: ".example.com",   // subdomains share the anonymous id via the cookie
  crossDomain: ["example.io"],    // links to other domains carry it as ?ajs_aid=… (and ?ajs_uid=… when identified)
});
fourier.decorateUrl("https://app.example.io/signup"); // for URLs you build yourself
fourier.newSession();                                  // force a new session (attribution touch)
```

## Companies / workspaces

`group(groupId, traits)` registers a company and links the current user to it. Every subsequent event carries `context.groupId`, so the dashboard and the query API can roll users and events up by company.
