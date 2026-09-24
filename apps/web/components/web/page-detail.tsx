"use client";

import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HorizontalBars, TrendChart } from "@/components/web/charts";
import { DetailSheetContent, DetailStat } from "@/components/web/detail-sheet";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { Panel, QueryError } from "@/components/web/states";
import { WENT_ON_HINT, WentOnPanel } from "@/components/web/went-on";
import { formatNumber, formatRate, formatRatio } from "@/lib/format";
import { errorOf, unwrap, useWebPageDetail } from "@/lib/web-api";

type Basis = "landing" | "viewers";

/**
 * Everything in the drawer that changes with the basis, in one place — so switching
 * cannot leave one section describing landings under a heading about every visit.
 */
const COPY: Record<Basis, { scope: string; trend: string; trendLabel: string; sources: string; next: string; subject: string; actions: string }> = {
  landing: {
    scope: "Visits that started on this page",
    trend: "Landing sessions over time",
    trendLabel: "Landing sessions",
    sources: "Acquisition of the visits that landed on this page.",
    next:
      "The page viewed after landing here, once per visit — so “Left the site” is a bounce. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who landed here",
    actions: "Among visits that landed here: clickers as a share of the people whose visit started on this page.",
  },
  viewers: {
    scope: "Every visit that included this page, however it began",
    trend: "Unique viewers over time",
    trendLabel: "Unique viewers",
    sources: "How each visit that included this page began — the channel that brought the visit, not the link that led to the page.",
    next:
      "The next page view after each view of this page, in the same visit. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who viewed this page",
    actions: "Clickers as a share of everyone who viewed the page.",
  },
};

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
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {shown === "landing" ? (
                  <>
                    <DetailStat label="Landing sessions" value={detail?.landing_sessions.current} sub={<DeltaBadge delta={detail?.landing_sessions} />} loading={loading} />
                    <DetailStat
                      label="Engaged"
                      value={formatRate(detail?.landing_engagement_rate.rate)}
                      sub={detail && formatRatio(detail.landing_engagement_rate.numerator, detail.landing_engagement_rate.denominator, "visits")}
                      loading={loading}
                    />
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
                <h3 className="mb-2 text-sm font-medium">{copy.trend}</h3>
                <TrendChart
                  data={detail?.trend}
                  label={copy.trendLabel}
                  interval={scope?.range.interval ?? "day"}
                  loading={loading}
                  className="h-[180px] w-full"
                />
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">Where visitors came from</h3>
                <p className="mb-2 text-xs text-muted-foreground">{copy.sources}</p>
                <div className="rounded-md border">
                  <HorizontalBars
                    loading={loading}
                    emptyLabel={shown === "landing" ? "No visits started on this page in the selected period." : "Nobody viewed this page in the selected period."}
                    rows={(detail?.sources ?? []).map((s) => ({ key: s.key, value: s.sessions.current, sub: formatRate(s.share) }))}
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
