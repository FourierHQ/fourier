"use client";

import Link from "next/link";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { useOverview } from "@/lib/api";

export function useHost() {
  const [host, setHost] = useState(process.env.NEXT_PUBLIC_FOURIER_HOST ?? "");
  useEffect(() => {
    if (!host && typeof window !== "undefined") setHost(window.location.origin);
  }, [host]);
  return host || "http://localhost:5050";
}

export function SetupGuide({ compact = false }: { compact?: boolean }) {
  const { data } = useOverview();
  const host = useHost();
  const writeKey = data?.project.write_key ?? "…";
  const receiving = (data?.overview.total_events ?? 0) > 0;

  const envSnippet = `NEXT_PUBLIC_FOURIER_WRITE_KEY=${writeKey}\nNEXT_PUBLIC_FOURIER_HOST=${host}`;
  const appRouter = `// app/layout.tsx
import { FourierProvider } from "fourier/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <FourierProvider
          writeKey={process.env.NEXT_PUBLIC_FOURIER_WRITE_KEY!}
          host={process.env.NEXT_PUBLIC_FOURIER_HOST!}
        >
          {children}
        </FourierProvider>
      </body>
    </html>
  );
}`;
  const usage = `"use client";
import { useFourier } from "fourier/next";

export function UpgradeButton() {
  const fourier = useFourier();
  return (
    <button
      onClick={() => {
        fourier.identify("user_123", { email: "jane@acme.com", plan: "pro" });
        fourier.group("acme", { name: "Acme Inc", plan: "enterprise" });
        fourier.track("Upgrade Clicked", { plan: "pro" });
      }}
    >
      Upgrade
    </button>
  );
}`;
  const pagesRouter = `// pages/_app.tsx
import type { AppProps } from "next/app";
import { useEffect } from "react";
import { useRouter } from "next/router";
import fourier from "fourier";

fourier.init({
  writeKey: process.env.NEXT_PUBLIC_FOURIER_WRITE_KEY!,
  host: process.env.NEXT_PUBLIC_FOURIER_HOST!,
});

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  useEffect(() => {
    fourier.page();
    router.events.on("routeChangeComplete", () => fourier.page());
  }, [router.events]);
  return <Component {...pageProps} />;
}`;
  const server = `// app/api/checkout/route.ts (or any server code)
import { FourierServer } from "fourier/server";

const fourier = new FourierServer({
  writeKey: process.env.FOURIER_WRITE_KEY!,
  host: process.env.FOURIER_HOST!,
});

export async function POST(req: Request) {
  const { userId, amount } = await req.json();
  fourier.track({ userId, event: "Checkout Completed", properties: { amount } });
  await fourier.flush();
  return Response.json({ ok: true });
}`;
  const migrate = `// Already on Segment? Swap the import, keep every call.
- import { AnalyticsBrowser } from "@segment/analytics-next";
+ import { AnalyticsBrowser } from "fourier";

- const analytics = AnalyticsBrowser.load({ writeKey: "SEGMENT_KEY" });
+ const analytics = AnalyticsBrowser.load("${writeKey}", { host: "${host}" });

analytics.identify("user_123", { email: "jane@acme.com" });
analytics.group("acme", { name: "Acme Inc" });
analytics.track("Report Exported", { format: "csv" });
analytics.page();

// Or keep @segment/analytics-next installed and point it here instead:
AnalyticsBrowser.load(
  { writeKey: "${writeKey}", cdnURL: "${host}" },
  { integrations: { "Segment.io": { apiHost: "${host.replace(/^https?:\/\//, "")}/v1", protocol: "${host.startsWith("https") ? "https" : "http"}" } } },
);`;
  const curl = `curl -X POST ${host}/v1/track \\
  -H "Content-Type: application/json" \\
  -d '{"writeKey":"${writeKey}","userId":"user_123","event":"Test Event","properties":{"source":"curl"}}'`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>1. Install the SDK</CardTitle>
              <CardDescription>One package. Works in the browser, in Next.js, and on the server.</CardDescription>
            </div>
            <Status receiving={receiving} loading={!data} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock code="pnpm add fourier" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Write key</span>
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{writeKey}</code>
            <CopyButton value={writeKey} />
            <span className="ml-2 text-muted-foreground">Host</span>
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{host}</code>
            <CopyButton value={host} />
          </div>
          <CodeBlock title=".env.local" code={envSnippet} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Add it to your app</CardTitle>
          <CardDescription>Page views are tracked automatically on every route change.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="app">
            <TabsList>
              <TabsTrigger value="app">Next.js App Router</TabsTrigger>
              <TabsTrigger value="pages">Pages Router</TabsTrigger>
              <TabsTrigger value="server">Server</TabsTrigger>
              <TabsTrigger value="segment">From Segment</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
            </TabsList>
            <TabsContent value="app" className="space-y-3 pt-3">
              <CodeBlock title="app/layout.tsx" code={appRouter} />
              <CodeBlock title="components/upgrade-button.tsx" code={usage} />
            </TabsContent>
            <TabsContent value="pages" className="pt-3">
              <CodeBlock title="pages/_app.tsx" code={pagesRouter} />
            </TabsContent>
            <TabsContent value="server" className="pt-3">
              <CodeBlock title="route.ts" code={server} />
            </TabsContent>
            <TabsContent value="segment" className="pt-3">
              <CodeBlock title="Drop-in replacement" code={migrate} />
            </TabsContent>
            <TabsContent value="curl" className="pt-3">
              <CodeBlock code={curl} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {!compact && (
        <Card>
          <CardHeader>
            <CardTitle>3. Model users and companies</CardTitle>
            <CardDescription>The same calls as analytics.js. Companies come from <code className="font-mono text-xs">group()</code>.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <ApiRow name="identify(userId, traits)" desc="Who the user is. Traits merge over time: email, name, plan…" />
            <ApiRow name="track(event, properties)" desc="Something happened. Use Title Case event names." />
            <ApiRow name="page(name, properties)" desc="A page view. Automatic in the Next.js provider." />
            <ApiRow name="group(groupId, traits)" desc="Attach the user to a company / workspace. Every later event carries it." />
            <ApiRow name="alias(newId, previousId)" desc="Merge two ids, e.g. anonymous → signed up." />
            <ApiRow name="reset()" desc="On logout. Clears user and company, rotates the anonymous id." />
          </CardContent>
        </Card>
      )}

      {receiving && !compact && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
          <CheckCircle2 className="size-5 text-emerald-600" />
          <span>
            Events are flowing. <Link href="/events" className="font-medium underline">See the live feed</Link> or <Link href="/agents" className="font-medium underline">connect an agent</Link>.
          </span>
        </div>
      )}
    </div>
  );
}

function Status({ receiving, loading }: { receiving: boolean; loading: boolean }) {
  if (loading) return <Badge variant="outline">Checking…</Badge>;
  if (receiving)
    return (
      <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
        <CheckCircle2 className="size-3" /> Receiving events
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="size-3 animate-spin" /> Waiting for first event
    </Badge>
  );
}

function ApiRow({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="rounded-md border p-3">
      <code className="font-mono text-xs font-medium">{name}</code>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </div>
  );
}

export function SetupCallout() {
  return (
    <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-dashed p-5 sm:flex-row sm:items-center">
      <div>
        <h3 className="text-sm font-medium">No events yet</h3>
        <p className="text-sm text-muted-foreground">Install the snippet in your Next.js app. This page updates the moment the first event lands.</p>
      </div>
      <Button asChild>
        <Link href="/setup">Install snippet</Link>
      </Button>
    </div>
  );
}
