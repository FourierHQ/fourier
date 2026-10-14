"use client";

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RelativeTime } from "@/components/relative-time";
import { PersonLabel } from "@/components/users-table";
import { CountChart, DurationChart, RateChart, TrendChart } from "@/components/web/charts";
import { ActiveFilters } from "@/components/web/controls";
import { DetailSheetContent, DetailSheetPages, DetailStat } from "@/components/web/detail-sheet";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { CONVERSIONS_NOTE, hasPrimaryGoal } from "@/components/web/page-detail";
import { PersonPage } from "@/components/web/person-page";
import { RankedTable } from "@/components/web/ranked-table";
import { QueryError } from "@/components/web/states";
import { WentOnPanel } from "@/components/web/went-on";
import { displayName, formatDuration, formatNumber, formatRate, formatRatio, shortPath } from "@/lib/format";
import {
  errorOf,
  unwrap,
  useWebCampaignDetail,
  type CampaignBreakdownRow,
  type CampaignDetail,
  type CampaignDimension,
  type CampaignDimensionKey,
  type CampaignRowFilter,
  type CampaignVisit,
  type RateValue,
  type ScopeEcho,
} from "@/lib/web-api";
import { P, useWebState } from "@/lib/web-state";

const HINTS = {
  visits: "Visits whose first page view carried this campaign's tag — the Sessions on its Campaigns row.",
  engaged:
    "Engaged visits as a share of the campaign's visits: more than one page, ten measured seconds, or one of your primary goals. The Campaigns row's number.",
  bounce:
    "Visits that saw one page, as a share of the visits that have finished. Reloading the landing page is a second page view, so a visit that reloaded did not bounce — it shows up in Pages per visit instead.",
  time: "Average foreground time the SDK measured across the whole visit, every page of it. Visits that never reported a measurement are left out rather than counted as zero.",
  pages: "Page views per visit, reloads included.",
  conversion: "Visits from this campaign that converted in that same visit — the Campaigns row's Conv. rate. Coming back another time to convert is in the next figure.",
  wentOn: (
    <>
      People, not visits: of everyone this campaign brought, how many converted afterwards — in that same visit, or by coming
      back another time, however they came back. Conversions before they first arrived from it do not count, and later ones
      are counted up to today. An association, not a cause.
    </>
  ),
};

type ChartKey = "traffic" | "engaged" | "bounce" | "time" | "conversion" | "conversions";

const CHARTS: { key: ChartKey; label: string; note: string; needsGoal?: boolean }[] = [
  { key: "traffic", label: "Visits", note: "Visits from this campaign. The previous period is dashed." },
  { key: "engaged", label: "Engaged", note: "Of the campaign's visits, the share that saw a second page, held attention for ten measured seconds, or completed a primary goal." },
  { key: "bounce", label: "Bounce rate", note: "Of the campaign's finished visits, the share that saw one page." },
  { key: "time", label: "Time per visit", note: "Measured time per visit, every page of it. Where nothing was measured for a while, dots mark the readings and the line joins them." },
  { key: "conversion", label: "Conv. rate", note: "Of the campaign's visits, the share that converted in that same visit.", needsGoal: true },
  {
    key: "conversions",
    label: "Conversions",
    note: CONVERSIONS_NOTE("people this campaign brought", "when their first visit from it began"),
    needsGoal: true,
  },
];

/**
 * How each split is named, what it reads, and what an empty value means in it. The
 * labels name the UTM parameter as well as the idea, because the reader set these tags
 * and will look for them by the name they typed.
 */
const DIMENSIONS: Record<CampaignDimensionKey, { label: string; column: string; note: string; none: string; mono?: boolean }> = {
  content: {
    label: "Ad",
    column: "utm_content",
    note: "The ad or link variant each click was tagged with (utm_content). Select one to narrow the whole drawer to it.",
    none: "Not tagged",
  },
  term: {
    label: "Term",
    column: "utm_term",
    note: "The keyword or audience each link was tagged with (utm_term). Select one to narrow the whole drawer to it.",
    none: "Not tagged",
  },
  source: {
    label: "Source",
    column: "utm_source / utm_medium",
    note: "Where the campaign ran, and as what (utm_source / utm_medium). Select one to narrow the whole drawer to it.",
    none: "Not tagged",
  },
  landing: {
    label: "Landing page",
    column: "Landing page",
    note: "The page each visit started on.",
    none: "(no page)",
    mono: true,
  },
  referrer: {
    label: "Referring site",
    column: "Referring site",
    note:
      "The site the browser says each click came from, whatever the tag says. Ads a network shows on other sites and apps arrive from the exchange or app that showed them, and in-app browsers often send no referrer at all — so this is where to look when a campaign's clicks do not behave like its audience.",
    none: "No referrer",
    mono: true,
  },
};

/** Which URL parameter each of a row's filters is. */
const FILTER_PARAMS: Record<keyof CampaignRowFilter, string> = {
  utmContent: P.utmContent,
  utmTerm: P.utmTerm,
  utmSource: P.utmSource,
  utmMedium: P.utmMedium,
  referrerHost: P.referrerHost,
};

/** The filters that, when set, mean the reader has narrowed a split to one of its rows. */
const DIMENSION_PARAMS: Record<CampaignDimensionKey, string[]> = {
  content: [P.utmContent],
  term: [P.utmTerm],
  source: [P.utmSource, P.utmMedium],
  landing: [],
  referrer: [P.referrerHost],
};

/**
 * One campaign, in a sheet over the Campaigns table it was opened from.
 *
 * The page drawer's sibling, and built the same way: in-section rather than a route, the
 * control bar behind it still applying, and the numbers at the top being the row that was
 * clicked. What it adds is the campaign's insides. A campaign is tagged several ways and
 * can vary on each — two ads, one audience, three networks, ten landing pages — so the
 * splits are offered only where this campaign actually varies, and choosing a row is a
 * filter like any other: every section re-reads under it and the chip says so.
 *
 * And the visits themselves. For a campaign of twenty clicks, a list of twenty visits —
 * where each came from, what device, what it read, for how long — is the answer, and any
 * rate above it is a summary of too few things to mean much. Each one opens its visitor
 * in the drawer, as the goal drawer opens a converter: the last step down, from a rate to
 * a row to the person behind it.
 */
export function CampaignDetailSheet({
  campaign,
  person,
  onSelectPerson,
  onBack,
  onClose,
}: {
  campaign: string | null;
  person: string | null;
  onSelectPerson: (personId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  // Kept loading behind the person page so Back is instant rather than a second wait.
  const report = useWebCampaignDetail(campaign);
  const detail = unwrap(report.data?.detail);
  const scope = report.data?.scope;
  const loading = report.isLoading;
  const stale = report.isPlaceholderData;
  const hasGoal = hasPrimaryGoal(scope);
  // Held here so it survives moving between campaigns, as the page drawer's does.
  const [chartKey, setChartKey] = useState<ChartKey>("traffic");

  return (
    <Sheet open={Boolean(campaign)} onOpenChange={(open) => !open && onClose()}>
      <DetailSheetContent>
        <DetailSheetPages over={person ? <PersonPage personId={person} onBack={onBack} backLabel={campaign ?? undefined} /> : null} overKey={person}>
          <SheetHeader>
            <SheetTitle className="truncate pr-8">{campaign}</SheetTitle>
            <SheetDescription>Visits that arrived tagged with this campaign</SheetDescription>
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
                <Strip detail={detail} hasGoal={hasGoal} loading={loading} />

                {hasGoal && (
                  <section>
                    <h3 className="mb-2 text-sm font-medium">
                      <MetricLabel hint={HINTS.wentOn}>Did they go on to convert?</MetricLabel>
                    </h3>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Of the people this campaign brought, who converted afterwards — before they left, or by coming back — against
                      every visitor in the period.
                    </p>
                    <div className="rounded-md border">
                      <WentOnPanel
                        value={detail?.went_on}
                        baseline={detail?.went_on_baseline}
                        subject="people this campaign brought"
                        loading={loading}
                        label="This campaign"
                        nobody="Nobody arrived through this campaign in the selected period."
                        caveat="a campaign aimed at people already looking for you would read well whatever its ad said."
                      />
                    </div>
                  </section>
                )}

                <OverTime detail={detail} hasGoal={hasGoal} scope={scope} chartKey={chartKey} onChartKey={setChartKey} loading={loading} />
                <Splits detail={detail} loading={loading} />
                <Visits detail={detail} hasGoal={hasGoal} loading={loading} onSelectPerson={onSelectPerson} />
                <Pages detail={detail} loading={loading} />
                <Actions detail={detail} scope={scope} loading={loading} />
              </>
            )}
          </div>
        </DetailSheetPages>
      </DetailSheetContent>
    </Sheet>
  );
}

function Strip({ detail, hasGoal, loading }: { detail: CampaignDetail | undefined; hasGoal: boolean; loading?: boolean }) {
  const ratio = (v: RateValue | null | undefined, unit: string) => (v ? formatRatio(v.numerator, v.denominator, unit) : undefined);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <DetailStat label={<MetricLabel hint={HINTS.visits}>Visits</MetricLabel>} value={detail?.visits.current} sub={<DeltaBadge delta={detail?.visits} />} loading={loading} />
      <DetailStat label="Visitors" value={detail?.visitors.current} sub={<DeltaBadge delta={detail?.visitors} />} loading={loading} />
      <DetailStat
        label={<MetricLabel hint={HINTS.engaged}>Engaged</MetricLabel>}
        value={formatRate(detail?.engagement_rate.rate)}
        sub={ratio(detail?.engagement_rate, "visits")}
        loading={loading}
      />
      <DetailStat
        label={<MetricLabel hint={HINTS.bounce}>Bounce rate</MetricLabel>}
        value={formatRate(detail?.bounce_rate.rate)}
        sub={ratio(detail?.bounce_rate, "finished visits")}
        loading={loading}
      />
      <DetailStat
        label={<MetricLabel hint={HINTS.time}>Time per visit</MetricLabel>}
        value={formatDuration(detail?.avg_visit_ms)}
        sub={detail && (detail.measured_visits ? `${formatNumber(detail.measured_visits)} measured visits` : "Nothing measured")}
        loading={loading}
      />
      <DetailStat
        label={<MetricLabel hint={HINTS.pages}>Pages per visit</MetricLabel>}
        value={detail?.pages_per_visit == null ? "—" : detail.pages_per_visit.toFixed(1)}
        loading={loading}
      />
      <DetailStat
        label={<MetricLabel hint={HINTS.conversion}>Conv. rate</MetricLabel>}
        value={detail?.conversion_rate ? formatRate(detail.conversion_rate.rate) : "—"}
        sub={detail?.conversion_rate ? ratio(detail.conversion_rate, "visits") : detail && !hasGoal ? "No goal configured" : undefined}
        loading={loading}
      />
      <DetailStat
        label={<MetricLabel hint={HINTS.wentOn}>Went on to convert</MetricLabel>}
        value={detail?.went_on ? formatRate(detail.went_on.rate.rate) : "—"}
        sub={detail?.went_on ? formatRatio(detail.went_on.rate.numerator, detail.went_on.people, "people") : detail && !hasGoal ? "No goal configured" : undefined}
        loading={loading}
      />
    </div>
  );
}

function OverTime({
  detail,
  hasGoal,
  scope,
  chartKey,
  onChartKey,
  loading,
}: {
  detail: CampaignDetail | undefined;
  hasGoal: boolean;
  scope: ScopeEcho | undefined;
  chartKey: ChartKey;
  onChartKey: (key: ChartKey) => void;
  loading?: boolean;
}) {
  const interval = scope?.range.interval ?? "day";
  const charts = CHARTS.filter((c) => hasGoal || !c.needsGoal);
  const chart = charts.find((c) => c.key === chartKey) ?? charts[0];
  const points = detail?.over_time;
  const rates = (pick: (p: NonNullable<typeof points>[number]) => RateValue | null) =>
    points?.map((p) => ({ bucket: p.bucket, ...(pick(p) ?? { rate: null, numerator: 0, denominator: 0 }) }));
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Over time</h3>
        <Tabs value={chart.key} onValueChange={(v) => onChartKey(v as ChartKey)} className="max-w-full overflow-x-auto overflow-y-hidden">
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
      {/* Keyed on the measure, so switching draws the new line fresh rather than morphing
          the last one into it. */}
      <div key={chart.key}>
        {chart.key === "traffic" ? (
          <TrendChart data={detail?.trend} label="Visits" interval={interval} loading={loading} className="h-[180px] w-full" />
        ) : chart.key === "time" ? (
          <DurationChart
            data={points?.map((p) => ({ bucket: p.bucket, value: p.avg_visit_ms, measured: p.measured_visits }))}
            label="Time per visit"
            unit="measured visits"
            interval={interval}
            loading={loading}
            className="h-[180px] w-full"
          />
        ) : chart.key === "engaged" ? (
          <RateChart data={rates((p) => p.engagement_rate)} label="Engaged" unit="visits" fullScale interval={interval} loading={loading} className="h-[180px] w-full" />
        ) : chart.key === "bounce" ? (
          <RateChart data={rates((p) => p.bounce_rate)} label="Bounce rate" unit="finished visits" fullScale interval={interval} loading={loading} className="h-[180px] w-full" />
        ) : chart.key === "conversions" ? (
          points?.every((p) => !p.converters) ? (
            <p className="flex h-[180px] items-center justify-center rounded-md border border-dashed px-4 text-center text-sm text-muted-foreground">
              Nobody this campaign brought went on to convert in this period.
            </p>
          ) : (
            <CountChart
              data={points?.map((p) => ({ bucket: p.bucket, value: p.converters ?? 0, previous: null }))}
              label="Went on to convert"
              interval={interval}
              loading={loading}
              className="h-[180px] w-full"
            />
          )
        ) : (
          <RateChart data={rates((p) => p.conversion_rate)} label="Conv. rate" unit="visits" interval={interval} loading={loading} className="h-[180px] w-full" />
        )}
      </div>
    </section>
  );
}

/**
 * The ways this campaign varies, one tab each, and the ones it does not as a line of
 * what every visit had in common.
 *
 * A split with a single value is not hidden for tidiness: a tab that always says "100%
 * linkedin" is a table of one row that the reader has to open to learn nothing. But the
 * value is still worth knowing — it is how the campaign was tagged — so it is said once,
 * above the tabs. A split the reader has narrowed to one row keeps its tab, so the way
 * back out is where they left it.
 */
function Splits({ detail, loading }: { detail: CampaignDetail | undefined; loading?: boolean }) {
  const { get, set } = useWebState();
  const [chosen, setChosen] = useState<CampaignDimensionKey | null>(null);
  const narrowed = (d: CampaignDimension) => DIMENSION_PARAMS[d.key].some((k) => Boolean(get(k)));
  const varying = (detail?.breakdown ?? []).filter((d) => d.values > 1 || narrowed(d));
  const fixed = (detail?.breakdown ?? []).filter((d) => d.values === 1 && !narrowed(d) && d.rows[0]?.key);
  const dim = varying.find((d) => d.key === chosen) ?? varying[0];
  const meta = dim ? DIMENSIONS[dim.key] : null;

  const narrowTo = (filter: CampaignRowFilter) =>
    set(Object.fromEntries(Object.entries(filter).map(([k, v]) => [FILTER_PARAMS[k as keyof CampaignRowFilter], v])));
  const widen = (d: CampaignDimension) => set(Object.fromEntries(DIMENSION_PARAMS[d.key].map((k) => [k, null])));
  const label = (r: CampaignBreakdownRow, key: CampaignDimensionKey) =>
    r.rest ? <span className="text-muted-foreground">Everything else</span> : r.key ? r.key : <span className="text-muted-foreground">{DIMENSIONS[key].none}</span>;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">How it splits</h3>
        {varying.length > 1 && (
          <Tabs value={dim?.key} onValueChange={(v) => setChosen(v as CampaignDimensionKey)} className="max-w-full overflow-x-auto overflow-y-hidden">
            <TabsList className="h-7">
              {varying.map((d) => (
                <TabsTrigger key={d.key} value={d.key} className="px-2 text-[11px]">
                  {DIMENSIONS[d.key].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      </div>
      {fixed.length > 0 && (
        <p className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>Every visit:</span>
          {fixed.map((d) => (
            <Badge key={d.key} variant="outline" className="max-w-full gap-1 font-normal">
              <span className="text-muted-foreground">{DIMENSIONS[d.key].label}</span>
              <span className={DIMENSIONS[d.key].mono ? "truncate font-mono text-[11px]" : "truncate"}>{d.rows[0].key}</span>
            </Badge>
          ))}
        </p>
      )}
      {loading && !detail ? (
        <Skeleton className="h-32" />
      ) : !dim || !meta ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          {detail?.visits.current ? "Every visit was tagged the same way, landed on the same page and came from the same site." : "No visits from this campaign in the selected period."}
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            {meta.note}
            {narrowed(dim) && (
              <>
                {" "}
                <button type="button" onClick={() => widen(dim)} className="font-medium text-foreground underline-offset-2 hover:underline">
                  Show every {meta.label.toLowerCase()}
                </button>
              </>
            )}
          </p>
          <div className="rounded-md border">
            <RankedTable<CampaignBreakdownRow>
              rows={dim.rows}
              rowKey={(r) => (r.rest ? "__rest__" : r.key)}
              barOf={(r) => r.share / 100}
              onSelect={(r) => r.filter && narrowTo(r.filter)}
              canSelect={(r) => Boolean(r.filter)}
              columns={[
                {
                  key: "key",
                  header: meta.column,
                  className: "max-w-[260px]",
                  cell: (r) => <span className={meta.mono && r.key && !r.rest ? "block truncate font-mono text-xs" : "block truncate font-medium"}>{label(r, dim.key)}</span>,
                },
                { key: "visits", header: "Visits", cell: (r) => formatNumber(r.visits) },
                { key: "engaged", header: <MetricLabel hint={HINTS.engaged}>Engaged</MetricLabel>, cell: (r) => <RateCell value={r.engagement_rate} unit="visits" /> },
                { key: "time", header: <MetricLabel hint={HINTS.time}>Time / visit</MetricLabel>, cell: (r) => formatDuration(r.avg_visit_ms) },
                { key: "pages", header: <MetricLabel hint={HINTS.pages}>Pages</MetricLabel>, className: "hidden sm:table-cell", cell: (r) => (r.pages_per_visit == null ? "—" : r.pages_per_visit.toFixed(1)) },
                { key: "conv", header: "Conv. rate", cell: (r) => <RateCell value={r.conversion_rate} unit="visits" /> },
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}

/** Consecutive repeats folded into a count, so ten reloads read as one page ×10 rather than a wall of the same path. */
function pathTrail(paths: string[]): string {
  const runs: { path: string; n: number }[] = [];
  for (const p of paths) {
    const last = runs.at(-1);
    if (last?.path === p) last.n++;
    else runs.push({ path: p, n: 1 });
  }
  return runs.map((r) => `${shortPath(r.path, 28)}${r.n > 1 ? ` ×${r.n}` : ""}`).join(" → ");
}

function Visits({
  detail,
  hasGoal,
  loading,
  onSelectPerson,
}: {
  detail: CampaignDetail | undefined;
  hasGoal: boolean;
  loading?: boolean;
  onSelectPerson: (personId: string) => void;
}) {
  const visits = detail?.recent_visits;
  const total = detail?.visits.current ?? 0;
  // The ad column earns its place only when there is more than one ad to tell apart.
  const showAd = (detail?.breakdown.find((d) => d.key === "content")?.values ?? 0) > 1;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">Visits</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        {visits && total > visits.length ? `The latest ${formatNumber(visits.length)} of ${formatNumber(total)} visits` : "Every visit"}, newest first. Time is
        the attention the SDK measured across the visit. &ldquo;&lt;1s&rdquo; is a visit that left before any page held it for a
        second; a dash is one still in progress, or from a browser that does not measure it. Select a visit for everything
        its visitor did, before and since.
      </p>
      <div className="rounded-md border">
        {loading && !detail ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !visits?.length ? (
          <p className="p-3 text-sm text-muted-foreground">No visits from this campaign in the selected period.</p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Visitor</TableHead>
                <TableHead className="hidden w-[16%] sm:table-cell">Device</TableHead>
                <TableHead className="hidden w-[30%] sm:table-cell">{showAd ? "Ad · referring site" : "Referring site"}</TableHead>
                <TableHead className="w-[56px] text-right">Time</TableHead>
                <TableHead className="w-[76px] text-right">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visits.map((v) => (
                <VisitRow key={v.session_id} v={v} showAd={showAd} hasGoal={hasGoal} onSelect={() => onSelectPerson(v.person_id)} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function VisitRow({ v, showAd, hasGoal, onSelect }: { v: CampaignVisit; showAd: boolean; hasGoal: boolean; onSelect: () => void }) {
  const ad = v.utm_content || <span className="text-muted-foreground">Not tagged</span>;
  const from = v.referring_host || <span className="font-sans text-muted-foreground">No referrer</span>;
  return (
    <TableRow className="cursor-pointer" onClick={onSelect} tabIndex={0} onKeyDown={(e) => (e.key === "Enter" ? onSelect() : undefined)}>
      <TableCell className="overflow-hidden align-top">
        {/* Named the way the goal drawer and the Events view name people, so the same
            person reads the same everywhere. Where they were for this visit, not where they
            were last seen. */}
        <PersonLabel
          label={displayName(v.traits, v.person_id)}
          personId={v.person_id}
          identified={v.person_identified}
          country={v.country}
          city={v.city}
          mono={false}
          className="text-sm font-medium"
        />
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-[11px] text-muted-foreground">
          <RelativeTime value={v.started_at} className="shrink-0 tabular-nums" />
          {v.city && <span className="truncate">· {v.city}</span>}
        </div>
        {/* A line of its own, so a reload loop's "×11" is never the part that gets cut off. */}
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={v.paths.join(" → ")}>
          {formatNumber(v.pageviews)} {v.pageviews === 1 ? "page" : "pages"} · {pathTrail(v.paths)}
        </div>
        {/* A phone has no room for the next two columns, so what they say folds in here. */}
        <div className="mt-0.5 truncate text-[11px] sm:hidden">
          {showAd && <>{ad} · </>}
          <span className="font-mono text-muted-foreground">{from}</span>
        </div>
      </TableCell>
      <TableCell className="hidden overflow-hidden align-top text-xs sm:table-cell">
        <span className="block truncate">{v.device}</span>
        <span className="block truncate text-muted-foreground">{v.browser}</span>
      </TableCell>
      <TableCell className="hidden overflow-hidden align-top text-xs sm:table-cell">
        {showAd && <span className="block truncate">{ad}</span>}
        <span className={showAd ? "block truncate font-mono text-[11px] text-muted-foreground" : "block truncate font-mono text-[11px]"} title={v.referring_host}>
          {from}
        </span>
      </TableCell>
      <TableCell className="text-right align-top text-xs tabular-nums">
        <VisitTime v={v} />
      </TableCell>
      <TableCell className="text-right align-top">
        <Outcome v={v} hasGoal={hasGoal} />
      </TableCell>
    </TableRow>
  );
}

/**
 * A visit's time, saying which kind of nothing a zero is. The SDK reports attention from
 * one second up, so a finished visit it measured with no report is a glance — not a gap
 * in the data, which is what a bare dash beside it would have suggested.
 */
const TIME_NOTES: Record<CampaignVisit["time"], string> = {
  measured: "Foreground time the SDK measured across the visit.",
  under_a_second:
    "Under a second of attention: no page held it for a full second, which is where the SDK starts reporting. A visit whose closing report was lost in transit reads the same way.",
  in_progress: "Still in progress: time is reported as the visitor leaves each page.",
  not_measured: "Not measured: whatever sent this visit does not report attention.",
};

function VisitTime({ v }: { v: CampaignVisit }) {
  const note = TIME_NOTES[v.time];
  if (v.time === "measured") return <span title={note}>{formatDuration(v.engaged_ms)}</span>;
  if (v.time === "under_a_second") return <span title={note}>&lt;1s</span>;
  return (
    <span className="text-muted-foreground" title={note}>
      —
    </span>
  );
}

function Outcome({ v, hasGoal }: { v: CampaignVisit; hasGoal: boolean }): ReactNode {
  if (hasGoal && v.converted) return <Badge className="h-5 px-1.5 text-[11px]">Converted</Badge>;
  if (hasGoal && v.converted_later)
    return (
      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]" title="Did not convert in this visit, but did on a later one">
        Later
      </Badge>
    );
  return <span className="text-xs text-muted-foreground">{v.engaged ? "Engaged" : "—"}</span>;
}

function Pages({ detail, loading }: { detail: CampaignDetail | undefined; loading?: boolean }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">What they read</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Every page these visits viewed, however far in — the All pages rows for this campaign&apos;s visits, busiest first.
      </p>
      <div className="rounded-md border">
        {loading && !detail ? (
          <Skeleton className="m-3 h-16" />
        ) : !detail?.pages.length ? (
          <p className="p-3 text-sm text-muted-foreground">No page views recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Page</TableHead>
                <TableHead className="text-right">Viewers</TableHead>
                <TableHead className="text-right">Views</TableHead>
                <TableHead className="text-right">Time on page</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.pages.map((p) => (
                <TableRow key={p.path}>
                  <TableCell className="max-w-[280px] truncate font-mono text-xs" title={p.path}>
                    {p.path}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(p.unique_viewers.current)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(p.pageviews.current)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(p.avg_engagement_ms)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function Actions({ detail, scope, loading }: { detail: CampaignDetail | undefined; scope: ScopeEcho | undefined; loading?: boolean }) {
  const visits = detail?.visits.current ?? 0;
  const configured = scope?.goals.some((g) => g.type === "supporting");
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">Actions in these visits</h3>
      <p className="mb-2 text-xs text-muted-foreground">Your supporting actions — the clicks and steps short of a conversion — anywhere in the campaign&apos;s visits.</p>
      {loading && !detail ? (
        <Skeleton className="h-12" />
      ) : !configured ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">No supporting actions are configured. Define them under Conversions to see what these visitors clicked.</p>
      ) : !detail?.actions.some((a) => a.sessions.current > 0) ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">None of your supporting actions happened in these visits.</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead className="text-right">Visits</TableHead>
                <TableHead className="text-right">Of the campaign&apos;s visits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.actions
                .filter((a) => a.sessions.current > 0)
                .map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(a.people.current)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(a.sessions.current)}</TableCell>
                    <TableCell className="text-right">
                      <RateCell value={{ rate: visits ? (a.sessions.current / visits) * 100 : null, numerator: a.sessions.current, denominator: visits }} unit="visits" />
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
