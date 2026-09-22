"use client";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { HorizontalBars, TrendChart } from "@/components/web/charts";
import { MetricLabel, RateCell } from "@/components/web/metric";
import { Panel, QueryError } from "@/components/web/states";
import { DETAIL_SHEET } from "@/components/web/detail-sheet";
import { formatNumber, formatRate } from "@/lib/format";
import { errorOf, unwrap, useWebPageDetail } from "@/lib/web-api";

/**
 * One page, in a sheet over the table it came from.
 *
 * In-section rather than a route of its own: it is a detail of the Pages report, and
 * pushing a route would make the back button leave the report instead of closing the
 * panel. The control bar behind it still applies, so the detail is scoped exactly the
 * way the table was.
 */
export function PageDetailSheet({
  path,
  basis,
  onClose,
}: {
  path: string | null;
  basis: "landing" | "viewers";
  onClose: () => void;
}) {
  const report = useWebPageDetail(path, basis);
  const detail = unwrap(report.data?.detail);
  const scope = report.data?.scope;
  const loading = report.isLoading;

  return (
    <Sheet open={Boolean(path)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className={DETAIL_SHEET}>
        <SheetHeader>
          <SheetTitle className="truncate font-mono text-sm">{path}</SheetTitle>
          <SheetDescription>{detail?.title || "Page detail"}</SheetDescription>
        </SheetHeader>

        <div className="space-y-6 p-4">
          {errorOf(report.data?.detail) ? (
            <QueryError message={errorOf(report.data?.detail)} onRetry={() => report.refetch()} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Landing sessions</p>
                  {loading ? <Skeleton className="mt-1 h-6 w-16" /> : <p className="text-xl font-semibold tabular-nums">{formatNumber(detail?.landing_sessions.current)}</p>}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Unique viewers</p>
                  {loading ? <Skeleton className="mt-1 h-6 w-16" /> : <p className="text-xl font-semibold tabular-nums">{formatNumber(detail?.unique_viewers.current)}</p>}
                </div>
              </div>

              <section>
                <h3 className="mb-2 text-sm font-medium">{basis === "landing" ? "Landing sessions over time" : "Unique viewers over time"}</h3>
                <TrendChart
                  data={detail?.trend}
                  label={basis === "landing" ? "Landing sessions" : "Unique viewers"}
                  interval={scope?.range.interval ?? "day"}
                  loading={loading}
                  className="h-[180px] w-full"
                />
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">Where visitors came from</h3>
                <p className="mb-2 text-xs text-muted-foreground">Acquisition of the visits that landed on this page.</p>
                <div className="rounded-md border">
                  <HorizontalBars
                    loading={loading}
                    emptyLabel="No visits started on this page in the selected period."
                    rows={(detail?.sources ?? []).map((s) => ({ key: s.key, value: s.sessions.current, sub: formatRate(s.share) }))}
                  />
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">What visitors did next</h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  The next page view recorded in the same visit. This is observed navigation, not intent — and a visit still in
                  progress is not counted as having left.
                </p>
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
                <Panel error={undefined}>
                  {!detail?.actions.length ? (
                    <p className="rounded-md border p-3 text-sm text-muted-foreground">
                      No supporting actions are configured. Define them under Conversions to see what people click here.
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
      </SheetContent>
    </Sheet>
  );
}
