"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActiveFilters } from "@/components/web/controls";
import { DetailSheetContent, DetailStat } from "@/components/web/detail-sheet";
import { MetricLabel, RateCell } from "@/components/web/metric";
import {
  ActionsSection,
  BasisSwitch,
  DetailStrip,
  NextPagesSection,
  OverTimeSection,
  SourcesSection,
  hasPrimaryGoal,
  type Basis,
  type ChartKey,
  type DetailCopy,
} from "@/components/web/page-detail";
import { describeRules } from "@/components/web/page-groups";
import { RankedTable } from "@/components/web/ranked-table";
import { QueryError } from "@/components/web/states";
import { WentOnCell, WentOnPanel } from "@/components/web/went-on";
import { formatDuration, formatNumber, formatRate, shortPath } from "@/lib/format";
import { errorOf, unwrap, useWebPageGroupDetail, type GoalWentOn, type LandingPageRow, type PageGroupDetail, type PageRow } from "@/lib/web-api";

const GROUP_HINTS: DetailCopy["hints"] = {
  engaged:
    "Engaged visits as a share of visits that started on one of this group's pages — the grouped Landing pages row's number. A visit is engaged if it saw more than one page, held attention for ten measured seconds, or completed one of your primary goals.",
  bounce:
    "Visits that started in this group and saw no other page — not even another of its own — as a share of those visits. Counted once a visit has finished. A visit that read three of the group's pages and stopped did not bounce, which is why this can sit well under “Left the site” below.",
  exit: "Views of this group's pages that were the last page of the visit, as a share of those views — the grouped All pages row's number. Visits still in progress count on neither side.",
  visits: "Visits that viewed at least one of this group's pages. Of these, the ones that started on one are the landing sessions.",
  conversion:
    "Conversion within the visits that started in this group — the grouped Landing pages row's number. Coming back another time to convert is in the next figure, not this one.",
  wentOn: (
    <>
      People, not visits: of everyone whose visit reached one of this group&apos;s pages, how many converted afterwards — in
      that same visit, or by coming back another time. Counted from the first of its pages they reached, so someone who read
      three of them is one person, once. Conversions before that do not count, and later ones are counted up to today. An
      association, not a cause.
    </>
  ),
  actions:
    "Fourier does not record whether a button was ever scrolled into view, so this is clickers as a share of everyone who viewed one of this group's pages — not a click-through rate on impressions.",
};

const GROUP_EMPTY_ACTIONS = "None of your supporting actions were triggered on this group's pages by these visits.";
const GROUP_EMPTY_WENT_ON = "Nobody reached this group this way in the selected period.";

/** The page drawer's wording, for a group: the same sections, about several pages at once. */
const COPY: Record<Basis, DetailCopy> = {
  landing: {
    scope: "Visits that started on one of its pages",
    trendLabel: "Landing sessions",
    time:
      "Average foreground time the SDK measured on this group's pages, per view — here, only in visits that started in the group. Views that never reported leaving are left out rather than counted as zero, so the measured views can be fewer than the visits.",
    sources: "Acquisition of the visits that landed in this group. Open a channel for the sites and campaigns inside it.",
    next:
      "Where each visit went when it first left the group, once per visit — the next page outside it, which is not usually the next page. “Left the site” is every visit that ended without leaving: the bounces, and the visits that read several of its pages and stopped.",
    subject: "people who landed in this group",
    actions: "Among visits that landed in this group: clickers as a share of the people whose visit started on one of its pages.",
    label: "This group",
    hints: GROUP_HINTS,
    charts: {
      traffic: "Visits that started on one of this group's pages. The previous period is dashed.",
      engaged: "Of the visits that started in this group, the share that saw a second page, held attention for ten measured seconds, or completed a primary goal.",
      bounce: "Of the finished visits that started in this group, the share that saw no other page.",
      time: "Measured time on this group's pages per view, in visits that started in it. Where nothing was measured for a while, dots mark the readings and the line joins them.",
      conversion: "Of the visits that started in this group, the share that converted in that same visit.",
    },
    empty: { sources: "No visits started on this group's pages in the selected period.", actions: GROUP_EMPTY_ACTIONS, wentOn: GROUP_EMPTY_WENT_ON },
  },
  viewers: {
    scope: "Every visit that included one of its pages, however it began",
    trendLabel: "Unique viewers",
    time:
      "Average foreground time the SDK measured on this group's pages, per view — the grouped All pages row's Avg. engagement. Views that never reported leaving are left out rather than counted as zero, which is why the measured views can be fewer than the page views.",
    sources:
      "How each visit that included one of this group's pages began — the channel that brought the visit, not the link that led into the group. Open a channel for the sites and campaigns inside it.",
    next:
      "Where visits went each time they left the group: the page after the last of each run of its pages. A visit that left and came back is counted for each place it went. Observed navigation, not intent, and a visit still in progress is not counted as having left.",
    subject: "people who viewed one of its pages",
    actions: "Clickers as a share of everyone who viewed one of this group's pages.",
    label: "This group",
    hints: GROUP_HINTS,
    charts: {
      traffic: "Distinct people who viewed one of this group's pages. The previous period is dashed.",
      time: "Measured time on this group's pages per view. Where nothing was measured for a while, dots mark the readings and the line joins them.",
      exit: "Of this group's page views in finished visits, the share that were the visit's last page.",
    },
    empty: { sources: "Nobody viewed this group's pages in the selected period.", actions: GROUP_EMPTY_ACTIONS, wentOn: GROUP_EMPTY_WENT_ON },
  },
};

/** How many of the group's pages show before the list is opened out. */
const PAGES_SHOWN = 10;

/**
 * One page group, in the sheet the page drawer uses.
 *
 * Everything the page drawer has, for the group: the strip at the top is the group's row
 * in the grouped table on either basis, and each section below is the page drawer's,
 * counted by the same queries over the group's pages. Then what only a group has — the
 * pages inside it, each of which opens its own drawer; where visitors went when they
 * left it, rather than which of its pages they read next; and its conversions broken
 * down by goal and by where they happened, because "is this part of the site working"
 * is what a group is made to answer.
 */
export function PageGroupDetailSheet({
  group,
  basis,
  onBasisChange,
  onClose,
  onSelectPage,
}: {
  group: string | null;
  basis: Basis;
  onBasisChange: (basis: Basis) => void;
  onClose: () => void;
  /** Open one of the group's pages in its own drawer. */
  onSelectPage: (path: string) => void;
}) {
  const report = useWebPageGroupDetail(group, basis);
  const detail = unwrap(report.data?.detail);
  const scope = report.data?.scope;
  const loading = report.isLoading;
  // As in the page drawer: the numbers on screen are labelled by the basis they are for,
  // not the one just asked for.
  const shown: Basis = report.data?.basis ?? basis;
  const copy = COPY[shown];
  const stale = report.isPlaceholderData;
  const hasGoal = hasPrimaryGoal(scope);
  const [chartKey, setChartKey] = useState<ChartKey>("traffic");
  // The group the payload on screen is about, which trails `group` while another loads.
  const rules = detail && report.data?.group === group ? detail.rules : undefined;

  return (
    <Sheet open={Boolean(group)} onOpenChange={(open) => !open && onClose()}>
      <DetailSheetContent>
        <SheetHeader>
          <SheetTitle className="truncate pr-8">{group}</SheetTitle>
          <SheetDescription className={rules ? "font-mono text-xs" : undefined}>
            {rules ? describeRules(rules) : rules === null ? "Every page that none of your groups' rules claim" : "Page group"}
          </SheetDescription>
          <BasisSwitch basis={basis} onChange={onBasisChange} scope={copy.scope} labels={["Landing pages", "All visits"]} />
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
              {hasGoal && <GroupConversions detail={detail} copy={copy} loading={loading} />}
              <GroupPages detail={detail} shown={shown} hasGoal={hasGoal} loading={loading} onSelect={onSelectPage} />
              <OverTimeSection detail={detail} shown={shown} copy={copy} hasGoal={hasGoal} scope={scope} chartKey={chartKey} onChartKey={setChartKey} loading={loading} />
              <SourcesSection detail={detail} shown={shown} copy={copy} scope={scope} loading={loading} noun="this group's pages" />
              <NextPagesSection detail={detail} copy={copy} loading={loading} title="Where they went next" />
              <ActionsSection detail={detail} copy={copy} scope={scope} loading={loading} title="Actions on these pages" />
            </>
          )}
        </div>
      </DetailSheetContent>
    </Sheet>
  );
}

/**
 * The group's conversions, three ways: did the people who reached it go on to convert,
 * which goals did they go on to, and how many of the period's conversions happened on
 * its pages or right after one.
 */
function GroupConversions({ detail, copy, loading }: { detail: PageGroupDetail | undefined; copy: DetailCopy; loading?: boolean }) {
  const byGoal = detail?.by_goal ?? [];
  const conversions = detail?.conversions;
  return (
    <section className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-medium">
          <MetricLabel hint={copy.hints.wentOn}>Did they go on to convert?</MetricLabel>
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Of the {copy.subject}, who converted afterwards — before they left, or by coming back — against every visitor in the
          period.
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
          {byGoal.length > 0 && Boolean(detail?.went_on?.people) && <GoalBreakdown rows={byGoal} />}
        </div>
      </div>

      {conversions && conversions.total > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Where the conversions happened</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Every conversion in the period, however its visit began — the Conversions report&apos;s page credit, for this group.
          </p>
          <div className="grid grid-cols-2 gap-4 rounded-md border p-4">
            <DetailStat
              label={
                <MetricLabel hint="Conversions whose goal fired on one of this group's pages: the first completion in each visit, so a visit is one conversion however often it completed the goal.">
                  On these pages
                </MetricLabel>
              }
              value={conversions.converted_on}
              sub={`${formatRate((conversions.converted_on / conversions.total) * 100)} of ${formatNumber(conversions.total)} conversions`}
            />
            <DetailStat
              label={
                <MetricLabel hint="Conversions on another page, where the page just before it was one of this group's. When both are in the group — a form on one page reached from another — it counts here and beside, so the two are never added.">
                  Right after one of them
                </MetricLabel>
              }
              value={conversions.led_to}
              sub={`${formatRate((conversions.led_to / conversions.total) * 100)} of ${formatNumber(conversions.total)} conversions`}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/** Went-on, one goal at a time, beside the same for every visitor. */
function GoalBreakdown({ rows }: { rows: GoalWentOn[] }) {
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>By goal</TableHead>
            <TableHead className="text-right">This group</TableHead>
            <TableHead className="text-right">Every visitor</TableHead>
            <TableHead className="text-right">
              <MetricLabel hint="This group's rate over every visitor's. Above 1× means the people who reached it went on to this goal more often than visitors generally.">
                vs. all
              </MetricLabel>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const ratio = r.baseline.rate.rate && r.went_on.rate.rate != null ? r.went_on.rate.rate / r.baseline.rate.rate : null;
            return (
              <TableRow key={r.goal_id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right">
                  <RateCell value={r.went_on.rate} unit="people" />
                </TableCell>
                <TableCell className="text-right">
                  <RateCell value={r.baseline.rate} unit="people" />
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{ratio != null ? `${ratio.toFixed(1)}×` : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
        Each goal asked on its own. Someone who completed two is in both rows, so the rows add up to more than the figure above.
      </p>
    </div>
  );
}

/**
 * The pages inside the group, as their own rows in the Pages table — the same numbers,
 * restricted to this group — each opening its page's drawer.
 *
 * The bar is the page's share of the group: of its landings, which the pages divide
 * between them, or of its viewers, who may each have read several.
 */
function GroupPages({
  detail,
  shown,
  hasGoal,
  loading,
  onSelect,
}: {
  detail: PageGroupDetail | undefined;
  shown: Basis;
  hasGoal: boolean;
  loading?: boolean;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = detail?.pages;
  // Each went-on bar is a share of everyone who went on to convert, as in the table.
  const allConverted = detail?.went_on_baseline ? detail.went_on_baseline.same_visit + detail.went_on_baseline.later_visit : null;
  const count = detail?.page_count ?? 0;
  const listed = pages?.rows.length ?? 0;
  const empty = (
    <p className="px-4 py-6 text-sm text-muted-foreground">
      {shown === "landing" ? "No visits started on this group's pages in the selected period." : "None of this group's pages were viewed in the selected period."}
    </p>
  );
  const pageCell = (r: { path: string; title: string }) => (
    <span className="font-medium" title={r.title && r.title !== r.path ? `${r.path} — ${r.title}` : r.path}>
      {shortPath(r.path, 36)}
    </span>
  );
  const wentOnColumn = {
    key: "went_on",
    header: "Went on to convert",
    cell: (r: LandingPageRow | PageRow) => (hasGoal ? <WentOnCell value={r.went_on} total={allConverted} /> : <span className="text-muted-foreground">—</span>),
  };
  const more =
    listed > PAGES_SHOWN ? (
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Show fewer" : `Show all ${formatNumber(listed)}`}
      </Button>
    ) : null;
  const caption = (
    <span className="flex flex-wrap items-center justify-between gap-2">
      <span>
        Open a page for its own drawer.
        {count > listed && ` The ${formatNumber(listed)} busiest of ${formatNumber(count)}; search the Pages table for the rest.`}
      </span>
      {more}
    </span>
  );
  const visible = <T,>(rows: T[]) => (expanded ? rows : rows.slice(0, PAGES_SHOWN));

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        Pages in this group
        {detail && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{formatNumber(count)}</span>}
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        {shown === "landing"
          ? "Where the visits that landed in this group started, as each page's row in the Landing pages table."
          : "Every page of the group that was viewed, as its row in the All pages table."}
      </p>
      <div className="rounded-md border">
        {!pages || pages.basis === "landing" ? (
          <RankedTable<LandingPageRow>
            rows={pages ? visible(pages.rows) : undefined}
            loading={loading}
            rowKey={(r) => r.path}
            barOf={(r) => r.landing_sessions.current / Math.max(detail?.landing_sessions.current ?? 0, 1)}
            onSelect={(r) => onSelect(r.path)}
            empty={empty}
            caption={caption}
            columns={[
              { key: "path", header: "Landing page", cell: pageCell },
              { key: "sessions", header: "Landing sessions", cell: (r) => formatNumber(r.landing_sessions.current) },
              { key: "engaged", header: "Engaged", cell: (r) => <RateCell value={r.engagement_rate} /> },
              {
                key: "rate",
                header: "Conv. rate",
                cell: (r) => (hasGoal ? <RateCell value={r.conversion_rate} /> : <span className="text-muted-foreground">—</span>),
              },
              wentOnColumn,
            ]}
          />
        ) : (
          <RankedTable<PageRow>
            rows={visible(pages.rows)}
            loading={loading}
            rowKey={(r) => r.path}
            barOf={(r) => r.unique_viewers.current / Math.max(detail?.unique_viewers.current ?? 0, 1)}
            onSelect={(r) => onSelect(r.path)}
            empty={empty}
            caption={caption}
            columns={[
              { key: "path", header: "Page", cell: pageCell },
              { key: "viewers", header: "Unique viewers", cell: (r) => formatNumber(r.unique_viewers.current) },
              {
                key: "time",
                header: "Time on page",
                cell: (r) => (
                  <span className="inline-flex flex-col items-end leading-tight">
                    <span>{formatDuration(r.avg_engagement_ms)}</span>
                    {r.measured_views > 0 && <span className="text-[11px] text-muted-foreground">{formatNumber(r.measured_views)} measured</span>}
                  </span>
                ),
              },
              { key: "exit", header: "Exit rate", cell: (r) => <RateCell value={r.exit_rate} unit="views" /> },
              wentOnColumn,
            ]}
          />
        )}
      </div>
    </section>
  );
}

