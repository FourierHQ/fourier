"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversionRateChart, FunnelSteps } from "@/components/web/charts";
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
  type CreditRow,
  type GoalSummaryRow,
  type LandingPageRow,
  type LeadingPageRow,
} from "@/lib/web-api";
import { P, useWebState } from "@/lib/web-state";

/** Extracted so each mode's rows are typed by the branch that reaches them, not by a cast. */
function LeadingPages({ rows, loading }: { rows: LeadingPageRow[] | undefined; loading?: boolean }) {
  const most = Math.max(...(rows ?? []).map((r) => r.converting_sessions), 1);
  return (
    <RankedTable<LeadingPageRow>
      rows={rows}
      loading={loading}
      rowKey={(r) => (r.is_entry ? "__entry__" : r.path)}
      barOf={(r) => r.converting_sessions / most}
      empty={<p className="px-6 py-6 text-sm text-muted-foreground">No conversions recorded in this period.</p>}
      caption="The page the conversion fired on is excluded — it cannot have sent anyone to itself, and leaving it in would rank your form above everything that led people to it."
      columns={[
        {
          key: "path",
          header: "Page",
          cell: (r) =>
            r.is_entry ? (
              <span className="text-muted-foreground">Converted on the page they arrived on</span>
            ) : (
              <span className="font-medium" title={r.path}>
                {shortPath(r.path, 26)}
              </span>
            ),
        },
        { key: "sessions", header: "Conversions", cell: (r) => formatNumber(r.converting_sessions) },
        { key: "share", header: "Share", cell: (r) => formatRate(r.share) },
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
              <CardTitle>Where the credit goes</CardTitle>
              <CardDescription>
                The same {formatNumber(credit?.total)} conversions, credited three ways. The totals are identical — only the
                distribution moves.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Panel error={errorOf(report.data?.credit)} onRetry={() => report.refetch()}>
                <RankedTable<CreditRow>
                  rows={credit?.rows}
                  loading={loading}
                  rowKey={(r) => r.channel}
                  barOf={(r) => (credit?.total ? r.first_touch / credit.total : 0)}
                  onSelect={(r) => set({ [P.channel]: r.channel })}
                  empty={<p className="px-6 py-6 text-sm text-muted-foreground">No conversions to credit in this period.</p>}
                  caption={
                    <>
                      <strong className="font-medium">Visit</strong> is where the converting visit came from — the same number
                      Acquisition shows. <strong className="font-medium">First touch</strong> credits whatever first brought that
                      person to the site, however long ago. <strong className="font-medium">Last touch</strong> credits their most
                      recent campaign or referral before the visit, ignoring direct arrivals. A channel that is small under Visit
                      and large under First touch is doing work the other reports cannot see.
                    </>
                  }
                  columns={[
                    { key: "channel", header: "Channel", cell: (r) => <span className="font-medium">{r.channel}</span> },
                    { key: "entry", header: "Visit", cell: (r) => formatNumber(r.entry) },
                    {
                      key: "first",
                      header: (
                        <MetricLabel hint="The person's first ever recorded arrival, which may be months before they converted.">
                          First touch
                        </MetricLabel>
                      ),
                      cell: (r) => formatNumber(r.first_touch),
                    },
                    {
                      key: "last",
                      header: (
                        <MetricLabel hint="Their most recent campaign or referral at or before the converting visit began. Direct arrivals are skipped, since a visit raises its own, which would make this column a copy of the first.">
                          Last touch
                        </MetricLabel>
                      ),
                      cell: (r) => formatNumber(r.last_touch),
                    },
                  ]}
                />
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
                    <CardTitle>Pages that lead to conversions</CardTitle>
                    <CardDescription>
                      {data?.pages === "anywhere"
                        ? "Pages the converting visits went through, against how often every visit sees them"
                        : "The last page before the one the conversion happened on"}
                    </CardDescription>
                  </div>
                  <Tabs value={pagesMode} onValueChange={(v) => set({ pages: v === "leading" ? null : v })}>
                    <TabsList className="h-7">
                      <TabsTrigger value="leading" className="px-2 text-[11px]">
                        Led to it
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
                      <LeadingPages rows={unwrap(data?.page_rows)} loading={loading} />
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
