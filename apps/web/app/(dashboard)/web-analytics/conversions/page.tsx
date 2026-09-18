"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConversionRateChart, FunnelSteps } from "@/components/web/charts";
import { WebControls } from "@/components/web/controls";
import { ManageGoalsDialog } from "@/components/web/goals";
import { ExploreLink } from "@/components/web/explore-link";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { RankedTable } from "@/components/web/ranked-table";
import { NeedsGoal, NoTraffic, Panel } from "@/components/web/states";
import { formatNumber, formatPoints } from "@/lib/format";
import { errorOf, unwrap, useWebConversions, useWebDefinitions, type GoalSummaryRow } from "@/lib/web-api";
import { P, useWebState } from "@/lib/web-state";

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
  const report = useWebConversions();
  const defs = useWebDefinitions();
  const configOf = (id: string) => defs.data?.goals.find((g) => g.id === id);

  const scope = report.data?.scope;
  const goals = unwrap(report.data?.goals);
  const trend = unwrap(report.data?.trend);
  const fn = unwrap(report.data?.funnel);
  const supporting = unwrap(report.data?.supporting);
  const avail = unwrap(report.data?.availability);
  const goalName = scope?.goal?.name ?? null;
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
                  <CardDescription>Every primary goal, against the same sessions. Select one to use it across the section.</CardDescription>
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
                <CardTitle>{goalName ?? "Selected goal"} over time</CardTitle>
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
                  {fn?.is_path_specific ? "One path to this goal" : "A visit, and then the goal"}
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
