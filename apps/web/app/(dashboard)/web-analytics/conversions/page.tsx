"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { ConversionRateChart, CountChart, FunnelSteps, SplitBars } from "@/components/web/charts";
import { WebControls } from "@/components/web/controls";
import { ManageGoalsDialog } from "@/components/web/goals";
import { GoalDetailSheet } from "@/components/web/goal-detail";
import { GoalMark } from "@/components/web/goal-mark";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { RankedTable } from "@/components/web/ranked-table";
import { NeedsGoal, NoTraffic, Panel } from "@/components/web/states";
import { formatNumber, formatPoints, formatRate, shortPath } from "@/lib/format";
import {
  countingLabel,
  errorOf,
  unwrap,
  useWebConversions,
  type ConvertingPageRow,
  type GoalSummaryRow,
  type LandingPageRow,
  type ConversionPages,
  type ConversionPageRow,
  type SeriesPoint,
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
 * Narrowing the section to one goal, as a control of its own.
 *
 * It used to be the row click, which is now the drilldown — the more useful of the two
 * and the one a reader reaches for. Selection stays available because it is what makes
 * the funnel, the credited channels and the page tables describe a single goal, and it
 * is a toggle: clicking the selected goal returns the section to counting all of them.
 */
function SelectGoalButton({ id, selected, onToggle }: { id: string; selected: boolean; onToggle: (id: string | null) => void }) {
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      className="h-7 px-2 text-xs font-normal"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(selected ? null : id);
      }}
      title={selected ? "Stop narrowing to this goal" : "Narrow the funnel, channels and page tables below to this goal"}
    >
      {selected ? (
        <>
          <Check className="size-3" /> Selected
        </>
      ) : (
        "Select"
      )}
    </Button>
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
  // The drilldown, in the URL for the reason every other selection here is: a drawer
  // open on one goal's converters is a view worth sending to someone. `drill` is which
  // goal the drawer is describing, `person` which of its people it has moved on to —
  // and neither is a control-bar parameter, so neither follows you to another report.
  const drill = get("drill");
  const drillPerson = get("person");
  const report = useWebConversions(pagesMode);
  const scope = report.data?.scope;
  const goals = unwrap(report.data?.goals);
  const trend = unwrap(report.data?.trend);
  const volume = unwrap(report.data?.volume) as SeriesPoint[] | undefined;
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
                  <CardDescription>
                    Every primary goal, against the same sessions. Click a row for the people behind it; select one to
                    narrow the whole section.
                  </CardDescription>
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
                  // The row is the drilldown: clicking a number opens the people behind
                  // it, which is what a reader reaches for. Narrowing the section is the
                  // other thing you can do with a goal, and it has its own control on
                  // the right rather than sharing the row click with this.
                  onSelect={(r) => set({ drill: r.id, person: null })}
                  empty={<p className="px-6 py-6 text-sm text-muted-foreground">No primary goals configured.</p>}
                  columns={[
                    {
                      key: "name",
                      header: "Goal",
                      cell: (r) => (
                        <span className="flex items-center gap-2">
                          <GoalMark name={r.name} />
                          <span className="font-medium">{r.name}</span>
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
                    {
                      key: "select",
                      header: <span className="sr-only">Narrow to this goal</span>,
                      className: "w-[116px]",
                      cell: (r) => <SelectGoalButton id={r.id} selected={r.id === selectedGoal} onToggle={(id) => set({ [P.goal]: id })} />,
                    },
                  ]}
                />
              </Panel>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Volume and rate, side by side and never on one pair of axes. They move
                independently — a campaign that doubles traffic at a slightly worse rate
                raises the left chart and lowers the right one — and a reader holding
                only the rate reads that as a failure. Two axes on one chart can be
                scaled to show any relationship you like, so: two charts. */}
            <Card>
              <CardHeader>
                <CardTitle>{goalName ?? "Conversions"} over time</CardTitle>
                <CardDescription>
                  Converting visits per {scope?.range.interval ?? "day"} — the same unit as the table above, over a
                  narrower window
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Panel error={errorOf(report.data?.volume)} onRetry={() => report.refetch()}>
                  <CountChart
                    data={volume}
                    label={goalName ? `${goalName} — converting visits` : "Converting visits"}
                    interval={scope?.range.interval ?? "day"}
                    loading={loading}
                    className="h-[240px] w-full"
                  />
                </Panel>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Conversion rate over time</CardTitle>
                <CardDescription>The same conversions as a share of visits, with the counts behind each point</CardDescription>
              </CardHeader>
              <CardContent>
                <Panel error={errorOf(report.data?.trend)} onRetry={() => report.refetch()}>
                  <ConversionRateChart data={trend} interval={scope?.range.interval ?? "day"} loading={loading} className="h-[240px] w-full" />
                </Panel>
              </CardContent>
            </Card>
          </div>

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

          <Card>
            <CardHeader>
              <CardTitle>What first brought the people who converted</CardTitle>
              <CardDescription>
                Credited to the channel that introduced each person, wherever they eventually converted. Every other report
                credits the visit it happened in instead.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Panel error={errorOf(report.data?.credit)} onRetry={() => report.refetch()}>
                <SplitBars
                  loading={loading}
                  parts={[
                    { label: "On that first visit", color: "var(--chart-1)" },
                    { label: "Came back to convert", color: "var(--chart-3)" },
                  ]}
                  emptyLabel="No conversions to credit in this period."
                  onSelect={(channel) => set({ [P.channel]: channel })}
                  rows={(credit?.rows ?? []).map((r) => ({ key: r.channel, total: r.conversions, values: [r.first_visit, r.returned] }))}
                />
                <p className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                  {credit && credit.returned > 0 ? (
                    <>
                      {formatNumber(credit.returned)} of {formatNumber(credit.total)} conversions came from someone who had been
                      here before. Every other report credits those to whatever brought them back — this credits what found them
                      in the first place.
                    </>
                  ) : (
                    <>
                      Everyone who converted did so on their first visit, so this matches the Acquisition report exactly. The two
                      diverge once people start returning before they convert.
                    </>
                  )}{" "}
                  A channel&apos;s conversions split into the two segments and nothing else, so the bar is the row&apos;s total.
                  &ldquo;First&rdquo; means the first arrival Fourier recorded: anyone already visiting before you installed
                  tracking counts from their next visit, so on a young install almost everything lands in the first segment.
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
                        // Same drilldown as a goal: "who clicked this" is the same
                        // question as "who converted", asked of a rule that is
                        // deliberately not counted as a conversion.
                        <TableRow
                          key={a.id}
                          className="cursor-pointer"
                          onClick={() => set({ drill: a.id, person: null })}
                          tabIndex={0}
                          onKeyDown={(e) => (e.key === "Enter" ? set({ drill: a.id, person: null }) : undefined)}
                        >
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <GoalMark type="supporting" name={a.name} />
                              <span className="font-medium">{a.name}</span>
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

      <GoalDetailSheet
        definition={drill}
        person={drillPerson}
        scope={scope}
        onSelectPerson={(id) => set({ person: id })}
        onBack={() => set({ person: null })}
        onClose={() => set({ drill: null, person: null })}
      />
    </div>
  );
}
