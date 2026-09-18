"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversionRateChart, FunnelSteps, PairedBars } from "@/components/web/charts";
import { WebControls } from "@/components/web/controls";
import { ManageGoalsDialog } from "@/components/web/goals";
import { ExploreLink } from "@/components/web/explore-link";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { RankedTable } from "@/components/web/ranked-table";
import { NeedsGoal, NoTraffic, Panel } from "@/components/web/states";
import { formatNumber, formatPoints, formatRate, shortPath } from "@/lib/format";
import {
  countingLabel,
  errorOf,
  unwrap,
  useWebConversions,
  useWebDefinitions,
  type ConvertingPageRow,
  type GoalSummaryRow,
  type LandingPageRow,
  type ConversionPages,
  type ConversionPageRow,
} from "@/lib/web-api";
import { P, useWebState } from "@/lib/web-state";

/** Extracted so each mode's rows are typed by the branch that reaches them, not by a cast. */
function ConversionPagesTable({ data, loading }: { data: ConversionPages | undefined; loading?: boolean }) {
  const rows = data?.rows;
  const most = Math.max(...(rows ?? []).map((r) => r.involved), 1);
  return (
    <RankedTable<ConversionPageRow>
      rows={rows}
      loading={loading}
      rowKey={(r) => r.path}
      barOf={(r) => r.involved / most}
      empty={<p className="px-6 py-6 text-sm text-muted-foreground">No conversions recorded in this period.</p>}
      caption={
        <>
          Two separate counts, never added together. A page with conversions <em>on</em> it and none <em>led to</em> is a form
          people convert on; the reverse is a page that persuades and hands off. Both, and it is a content page with a form
          embedded.
          {data && data.on_arrival > 0 && (
            <> {formatNumber(data.on_arrival)} of {formatNumber(data.total)} converted on the page they arrived on, so nothing preceded them.</>
          )}
        </>
      }
      columns={[
        { key: "path", header: "Page", cell: (r) => <span className="font-medium" title={r.path}>{shortPath(r.path, 26)}</span> },
        {
          key: "on",
          header: (
            <MetricLabel hint="The goal fired while the visitor was on this page — a form on the page itself, or a confirmation page they were sent to.">
              Converted on it
            </MetricLabel>
          ),
          cell: (r) => (r.converted_on > 0 ? formatNumber(r.converted_on) : <span className="text-muted-foreground">—</span>),
        },
        {
          key: "led",
          header: (
            <MetricLabel hint="The visitor was here immediately before converting somewhere else. A page with a form embedded will show both columns, which is the point of having two.">
              Led to one
            </MetricLabel>
          ),
          cell: (r) => (r.led_to > 0 ? formatNumber(r.led_to) : <span className="text-muted-foreground">—</span>),
        },
      ]}
    />
  );
}

function AssociatedPages({ rows, loading }: { rows: ConvertingPageRow[] | undefined; loading?: boolean }) {
  return (
    <RankedTable<ConvertingPageRow>
      rows={rows}
      loading={loading}
      rowKey={(r) => r.path}
      barOf={(r) => r.converting_share / 100}
      empty={<p className="px-6 py-6 text-sm text-muted-foreground">No conversions recorded in this period.</p>}
      caption="An association, not a cause. People who were going to convert read the pricing page, and people who read the pricing page convert; this cannot separate the two. The baseline is what makes it readable — a page seen by 60% of converting visits and 60% of all visits is telling you nothing."
      columns={[
        { key: "path", header: "Page", cell: (r) => <span className="font-medium" title={r.path}>{shortPath(r.path, 24)}</span> },
        {
          key: "share",
          header: (
            <MetricLabel hint="Converting visits that included this page, against all visits that included it. Above 1.0 means converting visits seek it out.">
              Of converting / of all
            </MetricLabel>
          ),
          cell: (r) => (
            <span className="inline-flex flex-col items-end leading-tight">
              <span className="tabular-nums">
                {formatRate(r.converting_share)} <span className="text-muted-foreground">/ {formatRate(r.session_share)}</span>
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">{formatNumber(r.converting_sessions)} of {formatNumber(r.sessions)} visits</span>
            </span>
          ),
        },
        { key: "lift", header: "Ratio", cell: (r) => (r.lift == null ? "—" : `${r.lift.toFixed(1)}×`) },
      ]}
    />
  );
}

/**
 * Conversions: are visitors completing the actions we care about, and where do they
 * drop off?
 *
 * Primary goals and supporting actions are reported in separate tables that never share
 * a total. That is the whole point of the distinction — a click that opens a booking
 * page added to confirmed bookings produces a number describing nothing.
 */
export default function ConversionsPage() {
  const { get, set } = useWebState();
  const pagesMode = get("pages") === "anywhere" ? "anywhere" : "leading";
  const report = useWebConversions(pagesMode);
  const defs = useWebDefinitions();
  const configOf = (id: string) => defs.data?.goals.find((g) => g.id === id);

  const scope = report.data?.scope;
  const goals = unwrap(report.data?.goals);
  const trend = unwrap(report.data?.trend);
  const fn = unwrap(report.data?.funnel);
  const supporting = unwrap(report.data?.supporting);
  const credit = unwrap(report.data?.credit);
  const landing = unwrap(report.data?.landing);
  const avail = unwrap(report.data?.availability);
  // Which mode the rows on screen are for, not which the URL asks for — the two differ
  // while a switch is in flight, and they have different shapes.
  const data = report.data;
  const stale = report.isPlaceholderData;
  // What the conversion columns count: one goal, all of them, or nothing yet.
  const goalName = countingLabel(scope);
  const loading = report.isLoading;
  const selectedGoal = get(P.goal) ?? scope?.goal?.id ?? null;

  if (report.isSuccess && avail && !avail.has_traffic && !avail.has_primary_goal) {
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

      {avail && !avail.has_primary_goal ? (
        <Card>
          <CardContent className="p-0">
            <NeedsGoal action={<ManageGoalsDialog />} />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Goal performance</CardTitle>
                  <CardDescription>Every primary goal, against the same sessions. Select one to narrow the whole section to it.</CardDescription>
                </div>
                <ManageGoalsDialog />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Panel error={errorOf(report.data?.goals)} onRetry={() => report.refetch()}>
                <RankedTable<GoalSummaryRow>
                  rows={goals}
                  loading={loading}
                  rowKey={(r) => r.id}
                  // Selecting a goal here is what changes it everywhere else, since the
                  // selection lives in the URL the whole section reads.
                  onSelect={(r) => set({ [P.goal]: r.id })}
                  empty={<p className="px-6 py-6 text-sm text-muted-foreground">No primary goals configured.</p>}
                  columns={[
                    {
                      key: "name",
                      header: "Goal",
                      cell: (r) => (
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{r.name}</span>
                          {r.id === selectedGoal && (
                            <Badge variant="secondary" className="font-normal">
                              Selected
                            </Badge>
                          )}
                          <ExploreLink goal={configOf(r.id)} scope={scope} />
                        </span>
                      ),
                    },
                    { key: "converting", header: "Converting sessions", cell: (r) => formatNumber(r.converting_sessions.current) },
                    { key: "rate", header: "Conversion rate", cell: (r) => <RateCell value={r.conversion_rate} /> },
                    {
                      key: "change",
                      header: "Change",
                      cell: (r) => (
                        <span className="inline-flex flex-col items-end leading-tight">
                          <DeltaBadge delta={r.converting_sessions} />
                          {r.conversion_rate.change_pp != null && (
                            <span className="text-[11px] text-muted-foreground">{formatPoints(r.conversion_rate.change_pp)}</span>
                          )}
                        </span>
                      ),
                    },
                  ]}
                />
              </Panel>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{goalName ?? "Conversions"} over time</CardTitle>
                <CardDescription>Conversion rate, with the sessions behind each point</CardDescription>
              </CardHeader>
              <CardContent>
                <Panel error={errorOf(report.data?.trend)} onRetry={() => report.refetch()}>
                  <ConversionRateChart data={trend} interval={scope?.range.interval ?? "day"} loading={loading} className="h-[240px] w-full" />
                </Panel>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <MetricLabel hint="Every step counts distinct sessions, and a session has to satisfy the steps in order within one visit. Repeating a step does not count twice.">
                    Conversion funnel
                  </MetricLabel>
                </CardTitle>
                <CardDescription>
                  {fn?.is_path_specific
                    ? "One path to this goal"
                    : selectedGoal
                      ? "A visit, and then the goal"
                      : "A visit, and then any conversion. Narrow to one goal to see a configured path."}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Panel error={errorOf(report.data?.funnel)} onRetry={() => report.refetch()}>
                  <FunnelSteps steps={fn?.steps} loading={loading} />
                  {/* A configured funnel describes one route. People who reached the goal
                      another way are still conversions, and the difference is worth naming
                      rather than leaving as an apparent contradiction between two numbers. */}
                  {fn?.is_path_specific && fn.total_conversions > (fn.steps.at(-1)?.sessions ?? 0) && (
                    <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                      {formatNumber(fn.total_conversions)} sessions completed this goal in total —{" "}
                      {formatNumber(fn.total_conversions - (fn.steps.at(-1)?.sessions ?? 0))} of them reached it by a route other than
                      this one. This funnel describes one path, not every path.
                    </p>
                  )}
                </Panel>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What introduced the people who converted</CardTitle>
              <CardDescription>
                Every other report credits the visit a conversion happened in. Many of these people arrived for the first time
                long before that — this is where they originally came from.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Panel error={errorOf(report.data?.credit)} onRetry={() => report.refetch()}>
                <PairedBars
                  loading={loading}
                  leftLabel="Introduced them"
                  rightLabel="Converting visit"
                  shiftLabel={(n, leans) => (leans === "left" ? `introduced ${formatNumber(n)} more` : `closed ${formatNumber(n)} more`)}
                  emptyLabel="No conversions to credit in this period."
                  onSelect={(channel) => set({ [P.channel]: channel })}
                  rows={(credit?.rows ?? []).map((r) => ({ key: r.channel, left: r.introduced, right: r.visit }))}
                />
                <p className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                  Both bars count the same {formatNumber(credit?.total)} conversions — only the credit moves. A channel longer on
                  the first bar brings people who convert later through something else, which no session-scoped report can show;
                  longer on the second means it closes people that something else introduced.{" "}
                  <strong className="font-medium">Introduced them</strong> is the first arrival Fourier recorded, not the first
                  ever: anyone already visiting before you installed tracking counts from their next visit, so a large Direct bar
                  here is usually the age of your data rather than a channel.
                </p>
              </Panel>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Top converting landing pages</CardTitle>
                <CardDescription>Ranked by conversions, not by traffic — the busiest entry point is rarely the best one</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Panel error={errorOf(report.data?.landing)} onRetry={() => report.refetch()}>
                  <RankedTable<LandingPageRow>
                    rows={landing}
                    loading={loading}
                    rowKey={(r) => r.path}
                    barOf={(r) => r.converting_sessions / Math.max(...(landing ?? []).map((x) => x.converting_sessions), 1)}
                    empty={<p className="px-6 py-6 text-sm text-muted-foreground">No landing pages converted in this period.</p>}
                    columns={[
                      { key: "path", header: "Landing page", cell: (r) => <span className="font-medium" title={r.path}>{shortPath(r.path, 26)}</span> },
                      { key: "converting", header: "Converting", cell: (r) => formatNumber(r.converting_sessions) },
                      { key: "rate", header: "Conv. rate", cell: (r) => <RateCell value={r.conversion_rate} /> },
                    ]}
                  />
                </Panel>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Pages that convert</CardTitle>
                    <CardDescription>
                      {data?.pages === "anywhere"
                        ? "Pages the converting visits went through, against how often every visit sees them"
                        : "Where conversions happened, and which pages led to them"}
                    </CardDescription>
                  </div>
                  <Tabs value={pagesMode} onValueChange={(v) => set({ pages: v === "leading" ? null : v })}>
                    <TabsList className="h-7">
                      <TabsTrigger value="leading" className="px-2 text-[11px]">
                        Direct
                      </TabsTrigger>
                      <TabsTrigger value="anywhere" className="px-2 text-[11px]">
                        Anywhere in visit
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <Panel error={errorOf(data?.page_rows)} onRetry={() => report.refetch()}>
                  <div className={stale ? "opacity-60 transition-opacity" : "transition-opacity"}>
                    {data?.pages === "anywhere" ? (
                      <AssociatedPages rows={unwrap(data.page_rows)} loading={loading} />
                    ) : (
                      <ConversionPagesTable data={unwrap(data?.page_rows)} loading={loading} />
                    )}
                  </div>
                </Panel>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Supporting actions</CardTitle>
              <CardDescription>Tracked clicks, form starts and downloads. Reported on their own, never added to conversions.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Panel error={errorOf(report.data?.supporting)} onRetry={() => report.refetch()}>
                {!supporting?.length ? (
                  <p className="px-6 py-6 text-sm text-muted-foreground">
                    No supporting actions configured. Add one to see what people click on the way to converting — and to fill the
                    CTA column on the Pages report, which has nothing to count until then.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Action</TableHead>
                        <TableHead className="text-right">Sessions</TableHead>
                        <TableHead className="text-right">People</TableHead>
                        <TableHead className="text-right">Change</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {supporting.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <span className="font-medium">{a.name}</span>
                              <ExploreLink goal={configOf(a.id)} scope={scope} />
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatNumber(a.sessions.current)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNumber(a.people.current)}</TableCell>
                          <TableCell className="text-right">
                            <DeltaBadge delta={a.sessions} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Panel>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
