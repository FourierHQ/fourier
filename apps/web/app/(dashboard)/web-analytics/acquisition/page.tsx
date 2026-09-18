"use client";

import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChannelStack, HorizontalBars } from "@/components/web/charts";
import { WebControls, useClearFilters } from "@/components/web/controls";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { RankedTable } from "@/components/web/ranked-table";
import { NoMatches, NoTraffic, Panel } from "@/components/web/states";
import { formatNumber, formatRate, formatRatio } from "@/lib/format";
import { countingLabel, errorOf, unwrap, useWebAcquisition, type BreakdownRow } from "@/lib/web-api";
import { P, WEB_ROOT, useWebState } from "@/lib/web-state";

/**
 * Acquisition: where is traffic coming from, and which sources bring visitors who act?
 *
 * Channels, sources and campaigns are one report with a grouping control, not three
 * sidebar entries. Drilling in — Paid Social, then LinkedIn, then a campaign — adds a
 * filter to the shared control bar rather than navigating somewhere new, so the way
 * back out is the same chip you would use anywhere else in the section.
 */

const GROUPS = [
  { value: "channel", label: "Channels", column: "Channel", param: P.channel },
  // "Campaign source", not "Source": a source in Fourier is a website or app with
  // its own write key, and that word is already taken by the control bar.
  { value: "source", label: "Campaign sources", column: "Campaign source", param: P.utmSource },
  { value: "campaign", label: "Campaigns", column: "Campaign", param: P.utmCampaign },
] as const;

type GroupValue = (typeof GROUPS)[number]["value"];

export default function AcquisitionPage() {
  const { get, set, href } = useWebState();
  const router = useRouter();
  const clearFilters = useClearFilters();

  // What the reader asked for; the tabs render from this so a click responds at once.
  const grouping = (get("group_by") as GroupValue) ?? "channel";
  const sort = get("sort") ?? "sessions";
  const report = useWebAcquisition(grouping, sort);

  // What is on screen. The rows keep the same shape across groupings so this cannot
  // crash the way the Pages tabs did, but labelling a column "Campaign" over channel
  // rows for a frame is its own small lie, and the response already says which it is.
  const shown = (report.data?.grouping as GroupValue) ?? grouping;
  const stale = report.isPlaceholderData;

  const scope = report.data?.scope;
  const stack = unwrap(report.data?.stack);
  const performance = unwrap(report.data?.performance);
  const byChannel = unwrap(report.data?.by_channel);
  const avail = unwrap(report.data?.availability);
  // What the conversion columns count: one goal, all of them, or nothing yet.
  const goalName = countingLabel(scope);
  const loading = report.isLoading;
  const group = GROUPS.find((g) => g.value === shown) ?? GROUPS[0];

  // The drilldown path, read straight off the filters that produced it.
  const trail = ([
    [P.channel, get(P.channel)],
    [P.utmSource, get(P.utmSource)],
    [P.utmCampaign, get(P.utmCampaign)],
  ] as [string, string | null][])
    .filter(([, label]) => Boolean(label))
    .map(([param, label]) => ({ param, label: label as string }));

  /** Clicking a row narrows to it and steps the grouping on to the next level. */
  const drill = (row: BreakdownRow) => {
    const next: Record<string, string | null> = { [group.param]: row.key === "(none)" ? null : row.key };
    if (shown === "channel") next.group_by = "source";
    else if (shown === "source") next.group_by = "campaign";
    set(next);
  };

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

  return (
    <div className="space-y-6 p-4 md:p-6">
      <WebControls scope={scope} />

      {trail.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => set({ [P.channel]: null, [P.utmSource]: null, [P.utmCampaign]: null, group_by: "channel" })}>
            All traffic
          </Button>
          {trail.map((t, i) => (
            <span key={t.param} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 font-medium"
                // Stepping back to a level drops everything below it, so the scope on
                // screen always matches the trail above it.
                onClick={() => set(Object.fromEntries(trail.slice(i + 1).map((x) => [x.param, null])))}
              >
                {t.label}
              </Button>
            </span>
          ))}
        </div>
      )}

      {avail?.has_traffic && !stale && (performance?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="p-0">
            <NoMatches onClear={clearFilters} />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Traffic by channel over time</CardTitle>
              <CardDescription>Sessions from the five biggest channels; everything else is grouped together</CardDescription>
            </CardHeader>
            <CardContent>
              <Panel error={errorOf(report.data?.stack)} onRetry={() => report.refetch()}>
                <ChannelStack channels={stack?.channels} points={stack?.points} interval={scope?.range.interval ?? "day"} loading={loading} />
              </Panel>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Acquisition performance</CardTitle>
                  <CardDescription>
                    {goalName ? <>Conversions in sessions from each {group.column.toLowerCase()}, counting &ldquo;{goalName}&rdquo;</> : "Select a goal to see conversions"}
                  </CardDescription>
                </div>
                <Tabs value={grouping} onValueChange={(v) => set({ group_by: v })}>
                  <TabsList className="h-7">
                    {GROUPS.map((g) => (
                      <TabsTrigger key={g.value} value={g.value} className="px-2 text-[11px]">
                        {g.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Panel error={errorOf(report.data?.performance)} onRetry={() => report.refetch()}>
                <div className={stale ? "opacity-60 transition-opacity" : "transition-opacity"}>
                <RankedTable<BreakdownRow>
                  rows={performance}
                  loading={loading}
                  rowKey={(r) => r.key}
                  barOf={(r) => r.share / 100}
                  sort={sort}
                  onSort={(k) => set({ sort: k })}
                  onSelect={shown === "campaign" ? undefined : drill}
                  empty={<p className="px-6 py-6 text-sm text-muted-foreground">Nothing recorded for this grouping in the selected period.</p>}
                  caption={
                    <>
                      Conversion rates are shown with the number of sessions behind them. A high rate on a handful of visits is
                      noise, not a winner.
                      {shown !== "campaign" && " Select a row to drill in."}
                    </>
                  }
                  columns={[
                    {
                      key: "key",
                      header: group.column,
                      cell: (r) => (
                        <span className="font-medium">
                          {/* An untagged visit is a real visit. Naming it keeps the
                              column adding up to the total instead of quietly losing rows. */}
                          {r.key === "(none)" ? <span className="text-muted-foreground">Not tagged</span> : r.key}
                        </span>
                      ),
                    },
                    { key: "sessions", header: "Sessions", sortKey: "sessions", cell: (r) => formatNumber(r.sessions.current) },
                    { key: "share", header: "Share", cell: (r) => formatRate(r.share) },
                    {
                      key: "engagement",
                      header: <MetricLabel hint="A visit is engaged if it saw more than one page, held attention for ten measured seconds, or completed one of your primary goals. The goal you have selected does not change this.">Engaged</MetricLabel>,
                      cell: (r) => <RateCell value={r.engagement_rate} />,
                    },
                    { key: "converting", header: "Converting", sortKey: "converting_sessions", cell: (r) => (goalName ? formatNumber(r.converting_sessions) : <span className="text-muted-foreground">—</span>) },
                    { key: "rate", header: "Conv. rate", sortKey: "conversion_rate", cell: (r) => (goalName ? <RateCell value={r.conversion_rate} /> : <span className="text-muted-foreground">—</span>) },
                    { key: "change", header: "Change", cell: (r) => <DeltaBadge delta={r.sessions} /> },
                  ]}
                />
                </div>
              </Panel>
            </CardContent>
          </Card>

          {goalName && (
            <Card>
              <CardHeader>
                <CardTitle>Conversion rate by channel</CardTitle>
                <CardDescription>Counting &ldquo;{goalName}&rdquo;, with the sessions behind each rate</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Panel error={errorOf(report.data?.by_channel)} onRetry={() => report.refetch()}>
                  <HorizontalBars
                    loading={loading}
                    emptyLabel="No conversions recorded in this period."
                    formatValue={(n) => formatRate(n)}
                    onSelect={(key) => router.push(href(`${WEB_ROOT}/acquisition`, { [P.channel]: key }))}
                    rows={(byChannel ?? [])
                      .filter((r) => r.conversion_rate.rate !== null)
                      .map((r) => ({
                        key: r.key,
                        // Ranked by rate, but the bar is the rate and the label carries
                        // the counts, so a 100% channel with two visits reads as what it is.
                        value: Math.round((r.conversion_rate.rate ?? 0) * 10) / 10,
                        sub: formatRatio(r.conversion_rate.numerator, r.conversion_rate.denominator),
                      }))
                      .sort((a, b) => b.value - a.value)}
                  />
                </Panel>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
