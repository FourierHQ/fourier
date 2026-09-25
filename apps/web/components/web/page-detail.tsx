"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChannelStack, DurationChart, RateChart, TrendChart, stackColors } from "@/components/web/charts";
import { ActiveFilters } from "@/components/web/controls";
import { DetailSheetContent, DetailStat } from "@/components/web/detail-sheet";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { SourceTree, type SourcePath } from "@/components/web/source-tree";
import { Panel, QueryError } from "@/components/web/states";
import { WENT_ON_HINT, WentOnPanel } from "@/components/web/went-on";
import { formatDuration, formatNumber, formatRate, formatRatio } from "@/lib/format";
import { errorOf, unwrap, useWebPageDetail, type PageDetail, type PageTimePoint, type RateValue, type ScopeEcho } from "@/lib/web-api";
import { P, useWebState } from "@/lib/web-state";

export type Basis = "landing" | "viewers";

/** What both drawers show: everything a page's drawer has, which a group's has too. */
export type DetailFigures = Omit<PageDetail, "path" | "title">;

export type ChartKey = "traffic" | "engaged" | "bounce" | "time" | "conversion" | "exit";

/**
 * Everything in a drawer that changes with the basis or with what it is about, in one
 * place — so switching cannot leave one section describing landings under a heading
 * about every visit, and the group drawer cannot inherit a sentence about "this page".
 */
export interface DetailCopy {
  scope: string;
  trendLabel: string;
  time: string;
  sources: string;
  next: string;
  subject: string;
  actions: string;
  /** The went-on panel's row for the thing itself. */
  label: string;
  hints: { engaged: string; bounce: string; exit: string; visits: string; conversion: string; wentOn: ReactNode; actions: string };
  /** The Over time chart's note for each measure the basis offers. */
  charts: Partial<Record<ChartKey, string>>;
  empty: { sources: string; actions: string; wentOn: string };
}

const PAGE_HINTS = {
  engaged:
    "Engaged visits as a share of visits that started on this page. A visit is engaged if it saw more than one page, held attention for ten measured seconds, or completed one of your primary goals.",
  bounce:
    "Visits that started on this page and saw no other page, as a share of those visits. Counted once a visit has finished, so someone still reading is not a bounce yet. Not the opposite of Engaged: a visit that read this one page for a minute bounced, and was engaged.",
  exit: "Views of this page that were the last page of the visit, as a share of its views — the All pages row's number. Exit rate, not bounce rate: a visit that read three pages and stopped here exits here but did not bounce. Visits still in progress count on neither side.",
  visits: "Visits that viewed this page at least once. Of these, the ones that started here are the landing sessions.",
  conversion:
    "Conversion within the visits that started here — the Landing pages row's number. Coming back another time to convert is in the next figure, not this one.",
  wentOn: WENT_ON_HINT,
  actions:
    "Fourier does not record whether a button was ever scrolled into view, so this is clickers as a share of everyone who viewed the page — not a click-through rate on impressions.",
};

const PAGE_EMPTY_ACTIONS = "None of your supporting actions were triggered on this page by these visits.";
const PAGE_EMPTY_WENT_ON = "Nobody reached this page this way in the selected period.";

const COPY: Record<Basis, DetailCopy> = {
  landing: {
    scope: "Visits that started on this page",
    trendLabel: "Landing sessions",
    time:
      "Average foreground time the SDK measured on this page, per view — here, only in visits that started on it. Views that never reported leaving are left out rather than counted as zero, so the measured views can be fewer than the visits.",
    sources: "Acquisition of the visits that landed on this page. Open a channel for the sites and campaigns inside it.",
    next:
      "The page viewed after landing here, once per visit — so “Left the site” is a bounce. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who landed here",
    actions: "Among visits that landed here: clickers as a share of the people whose visit started on this page.",
    label: "This page",
    hints: PAGE_HINTS,
    charts: {
      traffic: "Visits that started on this page. The previous period is dashed.",
      engaged: "Of the visits that started here, the share that saw a second page, held attention for ten measured seconds, or completed a primary goal.",
      bounce: "Of the finished visits that started here, the share that saw no other page.",
      time: "Measured time on this page per view, in visits that started here. Where nothing was measured for a while, dots mark the readings and the line joins them.",
      conversion: "Of the visits that started here, the share that converted in that same visit.",
    },
    empty: { sources: "No visits started on this page in the selected period.", actions: PAGE_EMPTY_ACTIONS, wentOn: PAGE_EMPTY_WENT_ON },
  },
  viewers: {
    scope: "Every visit that included this page, however it began",
    trendLabel: "Unique viewers",
    time:
      "Average foreground time the SDK measured on this page, per view — the All pages row's Avg. engagement. Views that never reported leaving are left out rather than counted as zero, which is why the measured views can be fewer than the page views.",
    sources:
      "How each visit that included this page began — the channel that brought the visit, not the link that led to the page. Open a channel for the sites and campaigns inside it.",
    next:
      "The next page view after each view of this page, in the same visit. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who viewed this page",
    actions: "Clickers as a share of everyone who viewed the page.",
    label: "This page",
    hints: PAGE_HINTS,
    charts: {
      traffic: "Distinct people who viewed this page. The previous period is dashed.",
      time: "Measured time on this page per view. Where nothing was measured for a while, dots mark the readings and the line joins them.",
      exit: "Of this page's views in finished visits, the share that were the visit's last page.",
    },
    empty: { sources: "Nobody viewed this page in the selected period.", actions: PAGE_EMPTY_ACTIONS, wentOn: PAGE_EMPTY_WENT_ON },
  },
};

/**
 * What the Over time chart can draw, per basis: the strip above it, less the figures
 * that are not a series. Engagement, bounce and conversion are offered on the landing
 * basis only and exit rate on the viewers basis only — over the other population each
 * is either arithmetic or another metric's double (see PageTimePoint in core) — which is
 * why the two lists are not the same list.
 */
const CHARTS: Record<Basis, { key: ChartKey; label: string }[]> = {
  landing: [
    { key: "traffic", label: "Sessions" },
    { key: "engaged", label: "Engaged" },
    { key: "bounce", label: "Bounce rate" },
    { key: "time", label: "Time on page" },
    { key: "conversion", label: "Conv. rate" },
  ],
  viewers: [
    { key: "traffic", label: "Viewers" },
    { key: "time", label: "Time on page" },
    { key: "exit", label: "Exit rate" },
  ],
};

/** One rate from each bucket, as the rate chart draws it. A bucket with nothing to divide has no rate, and the line joins across it. */
const rateSeries = (points: PageTimePoint[] | undefined, pick: (p: PageTimePoint) => RateValue | null) =>
  points?.map((p) => ({ bucket: p.bucket, ...(pick(p) ?? { rate: null, numerator: 0, denominator: 0 }) }));

/** Whether a primary goal is configured, which is what every conversion figure waits on. */
export const hasPrimaryGoal = (scope: ScopeEcho | undefined) => Boolean(scope?.goals.some((g) => g.type === "primary"));

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
 *
 * Opened from a group's drawer, it says so above its title and can go back to it.
 */
export function PageDetailSheet({
  path,
  basis,
  onBasisChange,
  onClose,
  backTo,
}: {
  path: string | null;
  basis: Basis;
  onBasisChange: (basis: Basis) => void;
  onClose: () => void;
  backTo?: { label: string; onBack: () => void } | null;
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
  const hasGoal = hasPrimaryGoal(scope);
  // Held here rather than in the chart, so it survives the drawer closing and opening on
  // another page: someone reading time on page across five pages wants it to stay put.
  const [chartKey, setChartKey] = useState<ChartKey>("traffic");

  return (
    <Sheet open={Boolean(path)} onOpenChange={(open) => !open && onClose()}>
      <DetailSheetContent>
        <SheetHeader>
          {backTo && (
            <button
              type="button"
              onClick={backTo.onBack}
              className="-ml-1 inline-flex w-fit items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="size-3" aria-hidden />
              {backTo.label}
            </button>
          )}
          <SheetTitle className="truncate pr-8 font-mono text-sm">{path}</SheetTitle>
          <SheetDescription>{detail?.title || "Page detail"}</SheetDescription>
          <BasisSwitch basis={basis} onChange={onBasisChange} scope={copy.scope} labels={["Landing page", "All visits"]} />
          {/* The control bar is behind the drawer, so what the drawer is narrowed to has
              to be said in it — and undone from it. */}
          <div className="pt-1 empty:hidden">
            <ActiveFilters scope={scope} />
          </div>
        </SheetHeader>

        <div className={stale ? "space-y-6 p-4 opacity-60 transition-opacity" : "space-y-6 p-4 transition-opacity"}>
          {errorOf(report.data?.detail) ? (
            <QueryError message={errorOf(report.data?.detail)} onRetry={() => report.refetch()} />
          ) : (
            <>
              <DetailStrip detail={detail} shown={shown} copy={copy} hasGoal={hasGoal} loading={loading} />

              {hasGoal && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    <MetricLabel hint={copy.hints.wentOn}>Did they go on to convert?</MetricLabel>
                  </h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Of the {copy.subject}, who converted afterwards — before they left, or by coming back — against every
                    visitor in the period.
                  </p>
                  <div className="rounded-md border">
                    <WentOnPanel
                      value={detail?.went_on}
                      baseline={detail?.went_on_baseline}
                      subject={copy.subject}
                      loading={loading}
                      label={copy.label}
                      nobody={copy.empty.wentOn}
                    />
                  </div>
                </section>
              )}

              <OverTimeSection detail={detail} shown={shown} copy={copy} hasGoal={hasGoal} scope={scope} chartKey={chartKey} onChartKey={setChartKey} loading={loading} />
              <SourcesSection detail={detail} shown={shown} copy={copy} scope={scope} loading={loading} />
              <NextPagesSection detail={detail} copy={copy} loading={loading} title="What visitors did next" />
              <ActionsSection detail={detail} copy={copy} scope={scope} loading={loading} title="Actions on this page" />
            </>
          )}
        </div>
      </DetailSheetContent>
    </Sheet>
  );
}

/** Landings or every visit, and a line saying which, under a drawer's title. */
export function BasisSwitch({ basis, onChange, scope, labels }: { basis: Basis; onChange: (basis: Basis) => void; scope: string; labels: [string, string] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <Tabs value={basis} onValueChange={(v) => onChange(v === "viewers" ? "viewers" : "landing")}>
        <TabsList className="h-7">
          <TabsTrigger value="landing" className="px-2 text-[11px]">
            {labels[0]}
          </TabsTrigger>
          <TabsTrigger value="viewers" className="px-2 text-[11px]">
            {labels[1]}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <span className="text-xs text-muted-foreground">{scope}</span>
    </div>
  );
}

/**
 * The strip of numbers at the top of a drawer: the row it was opened from, on the basis
 * on screen, and went on to convert beside them.
 */
export function DetailStrip({
  detail,
  shown,
  copy,
  hasGoal,
  loading,
}: {
  detail: DetailFigures | undefined;
  shown: Basis;
  copy: DetailCopy;
  hasGoal: boolean;
  loading?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {shown === "landing" ? (
        <>
          <DetailStat label="Landing sessions" value={detail?.landing_sessions.current} sub={<DeltaBadge delta={detail?.landing_sessions} />} loading={loading} />
          <DetailStat
            label={<MetricLabel hint={copy.hints.engaged}>Engaged</MetricLabel>}
            value={formatRate(detail?.landing_engagement_rate.rate)}
            sub={detail && formatRatio(detail.landing_engagement_rate.numerator, detail.landing_engagement_rate.denominator, "visits")}
            loading={loading}
          />
          <DetailStat
            label={<MetricLabel hint={copy.hints.bounce}>Bounce rate</MetricLabel>}
            value={formatRate(detail?.bounce_rate?.rate)}
            sub={detail?.bounce_rate && formatRatio(detail.bounce_rate.numerator, detail.bounce_rate.denominator, "finished visits")}
            loading={loading}
          />
          <TimeOnPage detail={detail} hint={copy.time} loading={loading} />
          <DetailStat
            label={<MetricLabel hint={copy.hints.conversion}>Conv. rate</MetricLabel>}
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
            label={<MetricLabel hint={copy.hints.visits}>Visits including it</MetricLabel>}
            value={detail?.sessions.current}
            sub={detail && `${formatNumber(detail.landing_sessions.current)} landed here`}
            loading={loading}
          />
          <TimeOnPage detail={detail} hint={copy.time} loading={loading} />
          <DetailStat
            label={<MetricLabel hint={copy.hints.exit}>Exit rate</MetricLabel>}
            value={formatRate(detail?.exit_rate?.rate)}
            sub={detail?.exit_rate && formatRatio(detail.exit_rate.numerator, detail.exit_rate.denominator, "views")}
            loading={loading}
          />
        </>
      )}
      <DetailStat
        label={<MetricLabel hint={copy.hints.wentOn}>Went on to convert</MetricLabel>}
        value={detail?.went_on ? formatRate(detail.went_on.rate.rate) : "—"}
        sub={
          detail?.went_on ? formatRatio(detail.went_on.rate.numerator, detail.went_on.people, "people") : detail && !hasGoal ? "No goal configured" : undefined
        }
        loading={loading}
      />
    </div>
  );
}

/** The Over time chart, on whichever of the basis's measures is chosen. */
export function OverTimeSection({
  detail,
  shown,
  copy,
  hasGoal,
  scope,
  chartKey,
  onChartKey,
  loading,
}: {
  detail: DetailFigures | undefined;
  shown: Basis;
  copy: DetailCopy;
  hasGoal: boolean;
  scope: ScopeEcho | undefined;
  chartKey: ChartKey;
  onChartKey: (key: ChartKey) => void;
  loading?: boolean;
}) {
  const interval = scope?.range.interval ?? "day";
  // Kept across a switch of basis where the other basis has it too, so moving between
  // the tabs keeps Time on page on screen; where it does not, the chart falls back to
  // traffic rather than drawing a rate the basis lacks.
  const charts = CHARTS[shown].filter((c) => c.key !== "conversion" || hasGoal);
  const chart = charts.find((c) => c.key === chartKey) ?? charts[0];
  const points = detail?.over_time;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Over time</h3>
        {/* Five measures do not fit a phone-width drawer; they scroll rather than push the
            whole panel sideways. */}
        <Tabs value={chart.key} onValueChange={(v) => onChartKey(v as ChartKey)} className="max-w-full overflow-x-auto">
          <TabsList className="h-7">
            {charts.map((c) => (
              <TabsTrigger key={c.key} value={c.key} className="px-2 text-[11px]">
                {c.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{copy.charts[chart.key]}</p>
      {/* Keyed on the measure, so switching draws the new line fresh rather than animating
          the last one into it — a bounce rate morphing out of a conversion rate is a
          picture of a relationship that is not there. */}
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
  );
}

/** Where the visits on the basis came from: channels over time, above the tree of them. */
export function SourcesSection({
  detail,
  shown,
  copy,
  scope,
  loading,
  noun,
}: {
  detail: DetailFigures | undefined;
  shown: Basis;
  copy: DetailCopy;
  scope: ScopeEcho | undefined;
  loading?: boolean;
  /** What the tree's column hints call the thing: "this page", "this group's pages". */
  noun?: string;
}) {
  const interval = scope?.range.interval ?? "day";
  const colorOf = stackColors(detail?.channels_over_time.channels);
  // Narrowing to a row of the source tree is a filter like any other: it goes in the URL,
  // the chips below the header show it, and every section re-reads under it. A row sets
  // its whole path and clears anything deeper, so choosing X after a campaign of X
  // widens back out to all of X.
  const { get, set } = useWebState();
  const activeSource: SourcePath | null = get(P.channel)
    ? { channel: get(P.channel)!, referrer: get(P.referrer) ?? undefined, campaign: get(P.utmCampaign) ?? undefined }
    : null;
  const filterTo = (p: SourcePath) => set({ [P.channel]: p.channel, [P.referrer]: p.referrer ?? null, [P.utmCampaign]: p.campaign ?? null });

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">Where visitors came from</h3>
      <p className="mb-2 text-xs text-muted-foreground">{copy.sources}</p>
      <div className="rounded-md border">
        {/* The same visits over time, above the tree of them. The channel rows are keyed
            to the bands by colour, so they stand in for the legend. */}
        {(loading || Boolean(detail?.source_tree.length)) && (
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
        <SourceTree
          nodes={detail?.source_tree}
          basis={shown}
          colorOf={colorOf}
          loading={loading}
          active={activeSource}
          onFilter={filterTo}
          emptyLabel={copy.empty.sources}
          noun={noun}
        />
      </div>
    </section>
  );
}

/** Where the visits went next, and the ones that left the site instead. */
export function NextPagesSection({ detail, copy, loading, title }: { detail: DetailFigures | undefined; copy: DetailCopy; loading?: boolean; title: string }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
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
                    {/* In a group's drawer, which section each destination is in. */}
                    {n.group && <span className="ml-2 font-sans text-[11px] text-muted-foreground">{n.group}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(n.sessions)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

/** The configured supporting actions fired by the visits on the basis, and who fired them. */
export function ActionsSection({
  detail,
  copy,
  scope,
  loading,
  title,
}: {
  detail: DetailFigures | undefined;
  copy: DetailCopy;
  scope: ScopeEcho | undefined;
  loading?: boolean;
  title: string;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        <MetricLabel hint={copy.hints.actions}>{title}</MetricLabel>
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">{copy.actions}</p>
      <Panel error={undefined}>
        {loading && !detail ? (
          <Skeleton className="h-12" />
        ) : !detail?.actions.length ? (
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            {scope?.goals.some((g) => g.type === "supporting")
              ? copy.empty.actions
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
  );
}

/** Time on the page, for either basis: the mean, and how many views it is over. */
function TimeOnPage({ detail, hint, loading }: { detail: DetailFigures | undefined; hint: string; loading?: boolean }) {
  return (
    <DetailStat
      label={<MetricLabel hint={hint}>Time on page</MetricLabel>}
      value={formatDuration(detail?.avg_engagement_ms)}
      sub={detail && (detail.measured_views ? `${formatNumber(detail.measured_views)} measured views` : "Nothing measured")}
      loading={loading}
    />
  );
}
