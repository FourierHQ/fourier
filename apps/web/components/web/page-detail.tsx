"use client";

import { useState } from "react";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChannelStack, DurationChart, HorizontalBars, RateChart, TrendChart, stackColors } from "@/components/web/charts";
import { DetailSheetContent, DetailStat } from "@/components/web/detail-sheet";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { Panel, QueryError } from "@/components/web/states";
import { WENT_ON_HINT, WentOnPanel } from "@/components/web/went-on";
import { formatDuration, formatNumber, formatRate, formatRatio } from "@/lib/format";
import { errorOf, unwrap, useWebPageDetail, type PageDetail, type PageTimePoint, type RateValue } from "@/lib/web-api";

type Basis = "landing" | "viewers";

/**
 * Everything in the drawer that changes with the basis, in one place — so switching
 * cannot leave one section describing landings under a heading about every visit.
 */
const COPY: Record<Basis, { scope: string; trendLabel: string; time: string; sources: string; next: string; subject: string; actions: string }> = {
  landing: {
    scope: "Visits that started on this page",
    trendLabel: "Landing sessions",
    time:
      "Average foreground time the SDK measured on this page, per view — here, only in visits that started on it. Views that never reported leaving are left out rather than counted as zero, so the measured views can be fewer than the visits.",
    sources: "Acquisition of the visits that landed on this page.",
    next:
      "The page viewed after landing here, once per visit — so “Left the site” is a bounce. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who landed here",
    actions: "Among visits that landed here: clickers as a share of the people whose visit started on this page.",
  },
  viewers: {
    scope: "Every visit that included this page, however it began",
    trendLabel: "Unique viewers",
    time:
      "Average foreground time the SDK measured on this page, per view — the All pages row's Avg. engagement. Views that never reported leaving are left out rather than counted as zero, which is why the measured views can be fewer than the page views.",
    sources: "How each visit that included this page began — the channel that brought the visit, not the link that led to the page.",
    next:
      "The next page view after each view of this page, in the same visit. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who viewed this page",
    actions: "Clickers as a share of everyone who viewed the page.",
  },
};

const ENGAGED_HINT =
  "Engaged visits as a share of visits that started on this page. A visit is engaged if it saw more than one page, held attention for ten measured seconds, or completed one of your primary goals.";

const BOUNCE_HINT =
  "Visits that started on this page and saw no other page, as a share of those visits. Counted once a visit has finished, so someone still reading is not a bounce yet. Not the opposite of Engaged: a visit that read this one page for a minute bounced, and was engaged.";

const EXIT_HINT =
  "Views of this page that were the last page of the visit, as a share of its views — the All pages row's number. Exit rate, not bounce rate: a visit that read three pages and stopped here exits here but did not bounce. Visits still in progress count on neither side.";

type ChartKey = "traffic" | "engaged" | "bounce" | "time" | "conversion" | "exit";

/**
 * What the Over time chart can draw, per basis: the strip above it, less the figures
 * that are not a series. Engagement, bounce and conversion are offered on the landing
 * basis only and exit rate on the viewers basis only — over the other population each
 * is either arithmetic or another metric's double (see PageTimePoint in core) — which is
 * why the two lists are not the same list.
 */
const CHARTS: Record<Basis, { key: ChartKey; label: string; note: string }[]> = {
  landing: [
    { key: "traffic", label: "Sessions", note: "Visits that started on this page. The previous period is dashed." },
    { key: "engaged", label: "Engaged", note: "Of the visits that started here, the share that saw a second page, held attention for ten measured seconds, or completed a primary goal." },
    { key: "bounce", label: "Bounce rate", note: "Of the finished visits that started here, the share that saw no other page." },
    { key: "time", label: "Time on page", note: "Measured time on this page per view, in visits that started here. A gap is a stretch in which nothing was measured, not one in which nobody read." },
    { key: "conversion", label: "Conv. rate", note: "Of the visits that started here, the share that converted in that same visit." },
  ],
  viewers: [
    { key: "traffic", label: "Viewers", note: "Distinct people who viewed this page. The previous period is dashed." },
    { key: "time", label: "Time on page", note: "Measured time on this page per view. A gap is a stretch in which nothing was measured, not one in which nobody read." },
    { key: "exit", label: "Exit rate", note: "Of this page's views in finished visits, the share that were the visit's last page." },
  ],
};

/** One rate from each bucket, as the rate chart draws it. A rate the basis does not carry is a gap. */
const rateSeries = (points: PageTimePoint[] | undefined, pick: (p: PageTimePoint) => RateValue | null) =>
  points?.map((p) => ({ bucket: p.bucket, ...(pick(p) ?? { rate: null, numerator: 0, denominator: 0 }) }));

/**
 * One page, in a sheet over the table it came from.
 *
 * In-section rather than a route of its own: it is a detail of the Pages report, and
 * pushing a route would make the back button leave the report instead of closing the
 * panel. The control bar behind it still applies, so the detail is scoped exactly the
 * way the table was.
 *
 * It opens on the population of the tab it was opened from and can switch between the
 * two — the visits that landed here, or every visit that included it — and every section
 * follows the switch. The numbers at the top are the row that was clicked, on either
 * basis, and the tests hold them to it.
 */
export function PageDetailSheet({
  path,
  basis,
  onBasisChange,
  onClose,
}: {
  path: string | null;
  basis: Basis;
  onBasisChange: (basis: Basis) => void;
  onClose: () => void;
}) {
  const report = useWebPageDetail(path, basis);
  const detail = unwrap(report.data?.detail);
  const scope = report.data?.scope;
  const loading = report.isLoading;
  // Which basis the numbers on screen are for. While a switch is in flight the previous
  // basis's payload is still showing, and labelling it with the new one would put the
  // landing figures under "All visits" for a moment — exactly the mismatch this avoids.
  const shown: Basis = report.data?.basis ?? basis;
  const copy = COPY[shown];
  const stale = report.isPlaceholderData;
  const hasGoal = Boolean(scope?.goals.some((g) => g.type === "primary"));
  const interval = scope?.range.interval ?? "day";

  // Which measure the chart draws. Kept across a switch of basis where the other basis
  // has it too, so moving between the tabs keeps Time on page on screen; where it does
  // not, the chart falls back to traffic rather than drawing a rate the basis lacks.
  const [chartKey, setChartKey] = useState<ChartKey>("traffic");
  const charts = CHARTS[shown].filter((c) => c.key !== "conversion" || hasGoal);
  const chart = charts.find((c) => c.key === chartKey) ?? charts[0];
  const points = detail?.over_time;
  const colorOf = stackColors(detail?.channels_over_time.channels);

  return (
    <Sheet open={Boolean(path)} onOpenChange={(open) => !open && onClose()}>
      <DetailSheetContent>
        <SheetHeader>
          <SheetTitle className="truncate pr-8 font-mono text-sm">{path}</SheetTitle>
          <SheetDescription>{detail?.title || "Page detail"}</SheetDescription>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Tabs value={basis} onValueChange={(v) => onBasisChange(v === "viewers" ? "viewers" : "landing")}>
              <TabsList className="h-7">
                <TabsTrigger value="landing" className="px-2 text-[11px]">
                  Landing page
                </TabsTrigger>
                <TabsTrigger value="viewers" className="px-2 text-[11px]">
                  All visits
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="text-xs text-muted-foreground">{copy.scope}</span>
          </div>
        </SheetHeader>

        <div className={stale ? "space-y-6 p-4 opacity-60 transition-opacity" : "space-y-6 p-4 transition-opacity"}>
          {errorOf(report.data?.detail) ? (
            <QueryError message={errorOf(report.data?.detail)} onRetry={() => report.refetch()} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {shown === "landing" ? (
                  <>
                    <DetailStat label="Landing sessions" value={detail?.landing_sessions.current} sub={<DeltaBadge delta={detail?.landing_sessions} />} loading={loading} />
                    <DetailStat
                      label={<MetricLabel hint={ENGAGED_HINT}>Engaged</MetricLabel>}
                      value={formatRate(detail?.landing_engagement_rate.rate)}
                      sub={detail && formatRatio(detail.landing_engagement_rate.numerator, detail.landing_engagement_rate.denominator, "visits")}
                      loading={loading}
                    />
                    <DetailStat
                      label={<MetricLabel hint={BOUNCE_HINT}>Bounce rate</MetricLabel>}
                      value={formatRate(detail?.bounce_rate?.rate)}
                      sub={detail?.bounce_rate && formatRatio(detail.bounce_rate.numerator, detail.bounce_rate.denominator, "finished visits")}
                      loading={loading}
                    />
                    <TimeOnPage detail={detail} hint={copy.time} loading={loading} />
                    <DetailStat
                      label={
                        <MetricLabel hint="Conversion within the visits that started here — the Landing pages row's number. Coming back another time to convert is in the next figure, not this one.">
                          Conv. rate
                        </MetricLabel>
                      }
                      value={detail?.landing_conversion_rate ? formatRate(detail.landing_conversion_rate.rate) : "—"}
                      sub={detail?.landing_conversion_rate && formatRatio(detail.landing_conversion_rate.numerator, detail.landing_conversion_rate.denominator, "visits")}
                      loading={loading}
                    />
                  </>
                ) : (
                  <>
                    <DetailStat label="Unique viewers" value={detail?.unique_viewers.current} sub={<DeltaBadge delta={detail?.unique_viewers} />} loading={loading} />
                    <DetailStat label="Page views" value={detail?.pageviews.current} sub={<DeltaBadge delta={detail?.pageviews} />} loading={loading} />
                    <DetailStat
                      label={
                        <MetricLabel hint="Visits that viewed this page at least once. Of these, the ones that started here are the landing sessions.">
                          Visits including it
                        </MetricLabel>
                      }
                      value={detail?.sessions.current}
                      sub={detail && `${formatNumber(detail.landing_sessions.current)} landed here`}
                      loading={loading}
                    />
                    <TimeOnPage detail={detail} hint={copy.time} loading={loading} />
                    <DetailStat
                      label={<MetricLabel hint={EXIT_HINT}>Exit rate</MetricLabel>}
                      value={formatRate(detail?.exit_rate?.rate)}
                      sub={detail?.exit_rate && formatRatio(detail.exit_rate.numerator, detail.exit_rate.denominator, "views")}
                      loading={loading}
                    />
                  </>
                )}
                <DetailStat
                  label={<MetricLabel hint={WENT_ON_HINT}>Went on to convert</MetricLabel>}
                  value={detail?.went_on ? formatRate(detail.went_on.rate.rate) : "—"}
                  sub={
                    detail?.went_on
                      ? formatRatio(detail.went_on.rate.numerator, detail.went_on.people, "people")
                      : detail && !hasGoal
                        ? "No goal configured"
                        : undefined
                  }
                  loading={loading}
                />
              </div>

              {hasGoal && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    <MetricLabel hint={WENT_ON_HINT}>Did they go on to convert?</MetricLabel>
                  </h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Of the {copy.subject}, who converted afterwards — before they left, or by coming back — against every
                    visitor in the period.
                  </p>
                  <div className="rounded-md border">
                    <WentOnPanel value={detail?.went_on} baseline={detail?.went_on_baseline} subject={copy.subject} loading={loading} />
                  </div>
                </section>
              )}

              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">Over time</h3>
                  {/* Five measures do not fit a phone-width drawer; they scroll rather than
                      push the whole panel sideways. */}
                  <Tabs value={chart.key} onValueChange={(v) => setChartKey(v as ChartKey)} className="max-w-full overflow-x-auto">
                    <TabsList className="h-7">
                      {charts.map((c) => (
                        <TabsTrigger key={c.key} value={c.key} className="px-2 text-[11px]">
                          {c.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
                <p className="mb-2 text-xs text-muted-foreground">{chart.note}</p>
                {/* Keyed on the measure, so switching draws the new line fresh rather than
                    animating the last one into it — a bounce rate morphing out of a
                    conversion rate is a picture of a relationship that is not there. */}
                <div key={chart.key}>
                  {chart.key === "traffic" ? (
                    <TrendChart data={detail?.trend} label={copy.trendLabel} interval={interval} loading={loading} className="h-[180px] w-full" />
                  ) : chart.key === "time" ? (
                    <DurationChart
                      data={points?.map((p) => ({ bucket: p.bucket, value: p.avg_engagement_ms, measured: p.measured_views }))}
                      label="Time on page"
                      interval={interval}
                      loading={loading}
                      className="h-[180px] w-full"
                    />
                  ) : chart.key === "engaged" ? (
                    <RateChart data={rateSeries(points, (p) => p.engagement_rate)} label="Engaged" unit="visits" fullScale interval={interval} loading={loading} className="h-[180px] w-full" />
                  ) : chart.key === "bounce" ? (
                    <RateChart data={rateSeries(points, (p) => p.bounce_rate)} label="Bounce rate" unit="finished visits" fullScale interval={interval} loading={loading} className="h-[180px] w-full" />
                  ) : chart.key === "exit" ? (
                    <RateChart data={rateSeries(points, (p) => p.exit_rate)} label="Exit rate" unit="views" fullScale interval={interval} loading={loading} className="h-[180px] w-full" />
                  ) : (
                    <RateChart data={rateSeries(points, (p) => p.conversion_rate)} label="Conv. rate" unit="visits" interval={interval} loading={loading} className="h-[180px] w-full" />
                  )}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">Where visitors came from</h3>
                <p className="mb-2 text-xs text-muted-foreground">{copy.sources}</p>
                <div className="rounded-md border">
                  {/* The same visits over time, above the ranking of them. The list is
                      keyed to the bands by colour, so it stands in for the legend. */}
                  {(loading || Boolean(detail?.sources.length)) && (
                    <div className="border-b px-2 pt-3 pb-1">
                      <ChannelStack
                        channels={detail?.channels_over_time.channels}
                        points={detail?.channels_over_time.points}
                        interval={interval}
                        loading={loading}
                        legend={false}
                        className="h-[160px] w-full"
                      />
                    </div>
                  )}
                  <HorizontalBars
                    loading={loading}
                    emptyLabel={shown === "landing" ? "No visits started on this page in the selected period." : "Nobody viewed this page in the selected period."}
                    rows={(detail?.sources ?? []).map((s) => ({ key: s.key, value: s.sessions.current, sub: formatRate(s.share), color: colorOf(s.key) }))}
                  />
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">What visitors did next</h3>
                <p className="mb-2 text-xs text-muted-foreground">{copy.next}</p>
                <div className="rounded-md border">
                  {loading ? (
                    <div className="space-y-2 p-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-6" />
                      ))}
                    </div>
                  ) : !detail?.next_pages.length ? (
                    <p className="p-3 text-sm text-muted-foreground">No onward navigation recorded yet.</p>
                  ) : (
                    <Table>
                      <TableBody>
                        {detail.next_pages.map((n) => (
                          <TableRow key={n.is_exit ? "__exit__" : n.path}>
                            <TableCell className={n.is_exit ? "text-muted-foreground" : "font-mono text-xs"}>
                              {n.is_exit ? "Left the site" : n.path}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(n.sessions)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">
                  <MetricLabel hint="Fourier does not record whether a button was ever scrolled into view, so this is clickers as a share of everyone who viewed the page — not a click-through rate on impressions.">
                    Actions on this page
                  </MetricLabel>
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">{copy.actions}</p>
                <Panel error={undefined}>
                  {!detail?.actions.length ? (
                    <p className="rounded-md border p-3 text-sm text-muted-foreground">
                      {scope?.goals.some((g) => g.type === "supporting")
                        ? "None of your supporting actions were triggered on this page by these visits."
                        : "No supporting actions are configured. Define them under Conversions to see what people click here."}
                    </p>
                  ) : (
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Action</TableHead>
                            <TableHead className="text-right">Clickers</TableHead>
                            <TableHead className="text-right">Clickers / page viewers</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.actions.map((a) => (
                            <TableRow key={a.name}>
                              <TableCell className="font-medium">{a.name}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatNumber(a.clickers)}</TableCell>
                              <TableCell className="text-right">
                                <RateCell value={a.rate} unit="viewers" />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Panel>
              </section>
            </>
          )}
        </div>
      </DetailSheetContent>
    </Sheet>
  );
}

/** Time on the page, for either basis: the mean, and how many views it is over. */
function TimeOnPage({ detail, hint, loading }: { detail: PageDetail | undefined; hint: string; loading?: boolean }) {
  return (
    <DetailStat
      label={<MetricLabel hint={hint}>Time on page</MetricLabel>}
      value={formatDuration(detail?.avg_engagement_ms)}
      sub={detail && (detail.measured_views ? `${formatNumber(detail.measured_views)} measured views` : "Nothing measured")}
      loading={loading}
    />
  );
}
