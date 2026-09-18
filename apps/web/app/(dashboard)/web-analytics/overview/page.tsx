"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversionRateChart, TrendChart, VisitorMixBar } from "@/components/web/charts";
import { WebControls, useClearFilters } from "@/components/web/controls";
import { ConversionCard, DeltaBadge, MetricCard, MetricLabel, RateCell } from "@/components/web/metric";
import { RankedTable } from "@/components/web/ranked-table";
import { NeedsGoal, NoMatches, NoTraffic, Panel } from "@/components/web/states";
import { formatNumber, formatPoints, formatRate, shortPath } from "@/lib/format";
import { errorOf, unwrap, useWebOverview, type BreakdownRow, type LandingPageRow } from "@/lib/web-api";
import { P, WEB_ROOT, useWebState } from "@/lib/web-state";

/**
 * Overview: how is the website performing, and what changed?
 *
 * Trends above rankings, four headline cards and no more. No funnel, no widget grid,
 * and no headline card for bounce rate or pages per session — those are diagnostics you
 * reach for after something moves, not the first thing to look at.
 */
export default function OverviewPage() {
  const [metric, setMetric] = useState<"visitors" | "sessions">("visitors");
  const report = useWebOverview(metric);
  const router = useRouter();
  const { href, set } = useWebState();
  const clearFilters = useClearFilters();

  const scope = report.data?.scope;
  const h = unwrap(report.data?.headline);
  const trend = unwrap(report.data?.trend);
  const conv = unwrap(report.data?.conversion_trend);
  const channels = unwrap(report.data?.channels);
  const landing = unwrap(report.data?.landing_pages);
  const mix = unwrap(report.data?.visitor_mix);
  const avail = unwrap(report.data?.availability);
  const interval = scope?.range.interval ?? "day";
  const goalName = scope?.goal?.name ?? null;
  const loading = report.isLoading;

  if (report.isSuccess && avail && !avail.has_traffic) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <WebControls scope={scope} />
        <Card>
          <CardContent className="p-0">
            <NoTraffic />
          </CardContent>
        </Card>
      </div>
    );
  }

  const noMatches = avail?.has_traffic && !avail.has_matches;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <WebControls scope={scope} />

      {noMatches ? (
        <Card>
          <CardContent className="p-0">
            <NoMatches onClear={clearFilters} />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Visitors"
              hint="Distinct tracked identities with activity in this period. These are browsers we can recognise, not guaranteed unique people: a cleared cookie or a second device counts again."
              value={formatNumber(h?.visitors.current)}
              delta={h?.visitors}
              sparkline={metric === "visitors" ? trend : undefined}
              loading={loading}
            />
            <MetricCard
              title="Sessions"
              hint="Visits. A new session starts after 30 minutes of inactivity."
              value={formatNumber(h?.sessions.current)}
              delta={h?.sessions}
              sparkline={metric === "sessions" ? trend : undefined}
              loading={loading}
            />
            <ConversionCard
              title="Converting sessions"
              goalName={goalName}
              value={formatNumber(h?.converting_sessions.current)}
              delta={h?.converting_sessions}
              loading={loading}
            />
            <ConversionCard
              title="Conversion rate"
              goalName={goalName}
              value={formatRate(h?.conversion_rate.rate)}
              rate={h?.conversion_rate}
              loading={loading}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Traffic over time</CardTitle>
                    <CardDescription>Previous period shown dashed</CardDescription>
                  </div>
                  <Tabs value={metric} onValueChange={(v) => setMetric(v as typeof metric)}>
                    <TabsList className="h-7">
                      <TabsTrigger value="visitors" className="px-2 text-[11px]">
                        Visitors
                      </TabsTrigger>
                      <TabsTrigger value="sessions" className="px-2 text-[11px]">
                        Sessions
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              </CardHeader>
              <CardContent>
                <Panel error={errorOf(report.data?.trend)} onRetry={() => report.refetch()}>
                  <TrendChart data={trend} label={metric === "visitors" ? "Visitors" : "Sessions"} interval={interval} loading={loading} />
                </Panel>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Conversion rate over time</CardTitle>
                <CardDescription>{goalName ? goalName : "No goal selected"}</CardDescription>
              </CardHeader>
              <CardContent className={goalName ? undefined : "p-0"}>
                <Panel error={errorOf(report.data?.conversion_trend)} onRetry={() => report.refetch()}>
                  {goalName ? (
                    <ConversionRateChart data={conv} interval={interval} loading={loading} className="h-[240px] w-full" />
                  ) : (
                    <NeedsGoal />
                  )}
                </Panel>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>
                <MetricLabel hint="New means first observed by Fourier, over this site's whole tracking history — not only this period. Cookie resets, unlinked devices and the date you installed tracking all affect it. These are tracked identities, not guaranteed unique people.">
                  Visitor mix
                </MetricLabel>
              </CardTitle>
              <CardDescription>
                New and returning visitors
                {mix?.change_pp != null && (
                  <>
                    {" · "}returning share {formatPoints(mix.change_pp)} vs previous period
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Panel error={errorOf(report.data?.visitor_mix)} onRetry={() => report.refetch()}>
                {mix && <VisitorMixBar newVisitors={mix.new_visitors} returningVisitors={mix.returning_visitors} onSelect={(which) => set({ [P.visitor]: which })} />}
              </Panel>
            </CardContent>
          </Card>

          {/* Side by side only once there is genuinely room: these carry five columns
              each, and at half of a laptop screen the conversion rate — the reason the
              table exists — is the one that gets cut off. */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Top channels</CardTitle>
                <CardDescription>Where this period&apos;s visits came from</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Panel error={errorOf(report.data?.channels)} onRetry={() => report.refetch()}>
                  <RankedTable<BreakdownRow>
                    rows={channels}
                    loading={loading}
                    rowKey={(r) => r.key}
                    barOf={(r) => r.share / 100}
                    // A channel opens Acquisition already filtered to it, rather than a
                    // dead end that makes you re-find it.
                    onSelect={(r) => router.push(href(`${WEB_ROOT}/acquisition`, { [P.channel]: r.key }))}
                    empty={<p className="px-6 py-6 text-sm text-muted-foreground">No visits recorded in this period.</p>}
                    columns={[
                      { key: "key", header: "Channel", cell: (r) => <span className="font-medium">{r.key}</span> },
                      { key: "sessions", header: "Sessions", cell: (r) => formatNumber(r.sessions.current) },
                      { key: "change", header: "Change", cell: (r) => <DeltaBadge delta={r.sessions} /> },
                      { key: "converting", header: "Converting", cell: (r) => (goalName ? formatNumber(r.converting_sessions) : "—") },
                      { key: "rate", header: "Conv. rate", cell: (r) => (goalName ? <RateCell value={r.conversion_rate} /> : <span className="text-muted-foreground">—</span>) },
                    ]}
                  />
                </Panel>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Top landing pages</CardTitle>
                <CardDescription>Visits that started on each page</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Panel error={errorOf(report.data?.landing_pages)} onRetry={() => report.refetch()}>
                  <RankedTable<LandingPageRow>
                    rows={landing}
                    loading={loading}
                    rowKey={(r) => r.path}
                    barOf={(r) => r.landing_sessions.current / Math.max(...(landing ?? []).map((x) => x.landing_sessions.current), 1)}
                    onSelect={(r) => router.push(href(`${WEB_ROOT}/pages`, { page: r.path }))}
                    empty={<p className="px-6 py-6 text-sm text-muted-foreground">No landing pages recorded in this period.</p>}
                    columns={[
                      { key: "path", header: "Landing page", cell: (r) => <span className="font-medium" title={r.path}>{shortPath(r.path, 32)}</span> },
                      { key: "sessions", header: "Sessions", cell: (r) => formatNumber(r.landing_sessions.current) },
                      { key: "change", header: "Change", cell: (r) => <DeltaBadge delta={r.landing_sessions} /> },
                      { key: "converting", header: "Converting", cell: (r) => (goalName ? formatNumber(r.converting_sessions) : "—") },
                      { key: "rate", header: "Conv. rate", cell: (r) => (goalName ? <RateCell value={r.conversion_rate} /> : <span className="text-muted-foreground">—</span>) },
                    ]}
                  />
                </Panel>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
