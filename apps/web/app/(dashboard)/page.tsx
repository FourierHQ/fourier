"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TimeseriesChart } from "@/components/timeseries-chart";
import { EventsTable } from "@/components/events-table";
import { SetupCallout, SetupGuide } from "@/components/setup-guide";
import { RelativeTime } from "@/components/relative-time";
import { useAttributionReport, useEventNames, useEvents, useOverview, useTimeseries } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState } from "react";
import { eventLabel, formatNumber } from "@/lib/format";

function SourcesCard() {
  const [by, setBy] = useState<"utm_source" | "referrer_host" | "utm_campaign" | "kind">("utm_source");
  const report = useAttributionReport({ model: "first", by, identified: true, limit: 8 });
  const labels = { utm_source: "Source", referrer_host: "Referrer", utm_campaign: "Campaign", kind: "Type" } as const;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Where sign-ups come from</CardTitle>
            <CardDescription>First touch of identified people</CardDescription>
          </div>
          <Tabs value={by} onValueChange={(v) => setBy(v as typeof by)}>
            <TabsList className="h-7">
              {(Object.keys(labels) as (keyof typeof labels)[]).map((k) => (
                <TabsTrigger key={k} value={k} className="px-2 text-[11px]">
                  {labels[k]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {report.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : !report.data?.rows.length ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">No arrivals recorded yet. Touches appear once identified users have page views with UTMs, referrers, or new sessions.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labels[by]}</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead className="text-right">Companies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.data.rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="font-medium">{r.key}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.people)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(r.companies)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function OverviewPage() {
  const overview = useOverview();
  const o = overview.data?.overview;
  const hasEvents = (o?.total_events ?? 0) > 0;
  const series = useTimeseries({ interval: "day" });
  const names = useEventNames(30);
  const recent = useEvents({ limit: 10 }, { enabled: hasEvents });

  if (overview.isSuccess && !hasEvents) {
    return (
      <>
        <PageHeader title="Overview" />
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
          <SetupCallout />
          <SetupGuide compact />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Overview" description={overview.data?.project.name} />
      <div className="space-y-6 p-4 md:p-6">
        {overview.isError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <span className="font-medium">Can&apos;t reach ClickHouse.</span> {overview.error.message}. Check <code className="font-mono text-xs">CLICKHOUSE_URL</code> in <code className="font-mono text-xs">.env</code> and that the server is running.
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Events" value={o?.total_events} loading={overview.isLoading} hint={o ? `${formatNumber(o.events_24h)} in the last 24h` : undefined} />
          <StatCard title="Users" value={o?.total_users} loading={overview.isLoading} hint={o ? `${formatNumber(o.identified_users)} identified · ${formatNumber(o.users_24h)} active today` : undefined} />
          <StatCard title="Companies" value={o?.total_groups} loading={overview.isLoading} hint="From group() calls" />
          <StatCard title="Last event" value={o?.last_event_at ? <RelativeTime value={o.last_event_at} /> : "—"} loading={overview.isLoading} hint={o?.first_event_at ? <>First event <RelativeTime value={o.first_event_at} /></> : undefined} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Events and unique users per day, last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <TimeseriesChart data={series.data} loading={series.isLoading} />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Top events</CardTitle>
              <CardDescription>Last 30 days</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {names.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                      <TableHead className="text-right">Users</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(names.data ?? []).slice(0, 10).map((e) => (
                      <TableRow key={e.event}>
                        <TableCell>
                          <Link href={`/events?event=${encodeURIComponent(e.event)}`} className="font-medium hover:underline">
                            {eventLabel(e)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(e.count)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(e.users)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <SourcesCard />
          </div>
          <Card className="lg:col-span-3">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Live feed</CardTitle>
                  <CardDescription>Most recent events</CardDescription>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/events">
                    All events <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <EventsTable events={recent.data?.events} loading={recent.isLoading} showCompany={false} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
