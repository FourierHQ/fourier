"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WebControls, useClearFilters } from "@/components/web/controls";
import { DeltaBadge, MetricLabel, RateCell } from "@/components/web/metric";
import { PageDetailSheet } from "@/components/web/page-detail";
import { PageGroupsDialog } from "@/components/web/page-groups";
import { RankedTable, type Column } from "@/components/web/ranked-table";
import { NoMatches, NoTraffic, Panel } from "@/components/web/states";
import { formatDuration, formatNumber, shortPath } from "@/lib/format";
import { countingLabel, errorOf, unwrap, useWebPages, type LandingPageRow, type PageRow } from "@/lib/web-api";
import { useWebState } from "@/lib/web-state";

/** Extracted so `rows` is PageRow[] by construction rather than by a cast. */
function AllPagesTable({
  rows,
  loading,
  isGroups,
  columns,
  onSelect,
}: {
  rows: PageRow[] | undefined;
  loading?: boolean;
  isGroups: boolean;
  columns: Column<PageRow>[];
  onSelect?: (row: PageRow) => void;
}) {
  const busiest = Math.max(...(rows ?? []).map((r) => r.pageviews.current), 1);
  return (
    <RankedTable<PageRow>
      rows={rows}
      loading={loading}
      rowKey={(r) => r.path}
      barOf={(r) => r.pageviews.current / busiest}
      onSelect={onSelect}
      columns={columns}
      empty={<p className="px-6 py-6 text-sm text-muted-foreground">No page views recorded in this period.</p>}
      caption={
        <>
          No conversion rate here on purpose: whether a page was on the way to a conversion is not something this table can
          separate from everyone passing through it. Landing pages carry one because the visit started there.
          {isGroups && " Group totals are counted from the underlying visitors, not summed from page rows."}
        </>
      }
    />
  );
}

/**
 * Pages: which parts of the website attract attention and lead to action?
 *
 * Table first. Two tabs, because "the page a visit started on" and "a page a visit
 * happened to include" are different questions with different denominators, and the
 * single most common way to mislead with page analytics is to answer one with the other.
 */
export default function PagesPage() {
  const { get, set } = useWebState();
  const clearFilters = useClearFilters();

  // What the reader has asked for. The controls render from this so a click responds
  // immediately, even while the rows for it are still on their way.
  const tab = get("tab") === "all" ? "all" : "landing";
  const groupBy = get("group_by") === "group" ? "group" : "page";
  const selected = get("page");
  const report = useWebPages(tab, groupBy);

  // What is actually on screen. Deliberately NOT the two above: until the new rows
  // arrive, react-query hands back the previous tab's payload, and the two tabs have
  // different row shapes. Rendering the table the URL asks for over the data the server
  // last sent is how "All pages" read `pageviews` off a landing row.
  const data = report.data;
  const scope = data?.scope;
  const avail = unwrap(data?.availability);
  // What the conversion columns count: one goal, all of them, or nothing yet.
  const goalName = countingLabel(scope);
  const loading = report.isLoading;
  const isGroups = data?.group_by === "group";
  // The rows on screen belong to a request that has been superseded; say so quietly
  // rather than letting a stale table look live.
  const stale = report.isPlaceholderData;
  // How many rows came back, whichever shape they are. Narrowing to read the count
  // rather than casting, so this keeps working when a third tab appears.
  const rowCount = data && "data" in data.rows ? data.rows.data.length : undefined;

  if (report.isSuccess && avail && !avail.has_traffic) {
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

  const landingColumns = [
    {
      key: "path",
      header: isGroups ? "Group" : "Landing page",
      cell: (r: LandingPageRow) => (
        <span className="font-medium" title={r.path}>
          {isGroups ? r.path : shortPath(r.path)}
        </span>
      ),
    },
    { key: "sessions", header: "Landing sessions", cell: (r: LandingPageRow) => formatNumber(r.landing_sessions.current) },
    {
      key: "engagement",
      header: (
        <MetricLabel hint="Engaged visits as a share of visits that started on this page. A visit is engaged if it saw more than one page, held attention for ten measured seconds, or completed one of your primary goals.">
          Engaged
        </MetricLabel>
      ),
      cell: (r: LandingPageRow) => <RateCell value={r.engagement_rate} />,
    },
    { key: "converting", header: "Converting", cell: (r: LandingPageRow) => (goalName ? formatNumber(r.converting_sessions) : <span className="text-muted-foreground">—</span>) },
    {
      key: "rate",
      header: (
        <MetricLabel hint="Conversion within the visits that started on this page — not conversion among everyone who happened to see it. The second number flatters pages that people reach on their way to converting anyway.">
          Conv. rate
        </MetricLabel>
      ),
      cell: (r: LandingPageRow) => (goalName ? <RateCell value={r.conversion_rate} /> : <span className="text-muted-foreground">—</span>),
    },
    { key: "change", header: "Change", cell: (r: LandingPageRow) => <DeltaBadge delta={r.landing_sessions} /> },
  ];

  const allColumns = [
    {
      key: "path",
      header: isGroups ? "Group" : "Page",
      cell: (r: PageRow) => (
        <span className="font-medium" title={r.path}>
          {isGroups ? r.path : shortPath(r.path)}
        </span>
      ),
    },
    { key: "viewers", header: "Unique viewers", cell: (r: PageRow) => formatNumber(r.unique_viewers.current) },
    { key: "views", header: "Page views", cell: (r: PageRow) => formatNumber(r.pageviews.current) },
    {
      key: "engagement",
      header: (
        <MetricLabel hint="Average foreground time actually measured on this page. Blank where nothing was measured — an older SDK, or views that never reported leaving — which is not the same as nobody reading it.">
          Avg. engagement
        </MetricLabel>
      ),
      cell: (r: PageRow) => (
        <span className="inline-flex flex-col items-end leading-tight">
          <span>{formatDuration(r.avg_engagement_ms)}</span>
          {r.measured_views > 0 && <span className="text-[11px] text-muted-foreground">{formatNumber(r.measured_views)} measured</span>}
        </span>
      ),
    },
    {
      key: "cta",
      header: (
        <MetricLabel hint="Distinct people who triggered one of your configured supporting actions on this page. Nothing is captured automatically — define the actions on the Conversions page.">
          CTA clickers
        </MetricLabel>
      ),
      cell: (r: PageRow) => (avail?.has_supporting_actions ? formatNumber(r.cta_clickers) : <span className="text-muted-foreground">Not tracked</span>),
    },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <WebControls scope={scope} />

      {avail?.has_traffic && !stale && rowCount === 0 ? (
        <Card>
          <CardContent className="p-0">
            <NoMatches onClear={clearFilters} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle>{tab === "landing" ? "Landing pages" : "All pages"}</CardTitle>
                <CardDescription>
                  {tab === "landing"
                    ? "Visits that started on each page, and what those visits went on to do"
                    : "Every page that was viewed, however the visit began"}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Tabs value={tab} onValueChange={(v) => set({ tab: v })}>
                  <TabsList className="h-7">
                    <TabsTrigger value="landing" className="px-2 text-[11px]">
                      Landing pages
                    </TabsTrigger>
                    <TabsTrigger value="all" className="px-2 text-[11px]">
                      All pages
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Tabs value={groupBy} onValueChange={(v) => set({ group_by: v })}>
                  <TabsList className="h-7">
                    <TabsTrigger value="page" className="px-2 text-[11px]">
                      Pages
                    </TabsTrigger>
                    <TabsTrigger value="group" className="px-2 text-[11px]">
                      Groups
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <PageGroupsDialog />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Panel error={errorOf(data?.rows)} onRetry={() => report.refetch()}>
              <div className={stale ? "opacity-60 transition-opacity" : "transition-opacity"}>
              {data?.tab === "all" ? (
                <AllPagesTable
                  rows={unwrap(data.rows)}
                  loading={loading}
                  isGroups={isGroups}
                  columns={allColumns}
                  onSelect={isGroups ? undefined : (r) => set({ page: r.path, basis: "viewers" })}
                />
              ) : (
                <RankedTable<LandingPageRow>
                  rows={unwrap(data?.rows)}
                  loading={loading}
                  rowKey={(r) => r.path}
                  barOf={(r) => r.landing_sessions.current / Math.max(...(unwrap(data?.rows) ?? []).map((x) => x.landing_sessions.current), 1)}
                  // Groups are a rollup, not a page, so there is no page detail behind them.
                  onSelect={isGroups ? undefined : (r) => set({ page: r.path, basis: "landing" })}
                  columns={landingColumns}
                  empty={<p className="px-6 py-6 text-sm text-muted-foreground">No landing pages recorded in this period.</p>}
                  caption={isGroups ? "Group totals are counted from the underlying visits, not summed from the pages inside them — someone who saw three pages in a group is one visitor to it." : undefined}
                />
              )}
              </div>
            </Panel>
          </CardContent>
        </Card>
      )}

      <PageDetailSheet path={selected} basis={get("basis") === "viewers" ? "viewers" : "landing"} onClose={() => set({ page: null, basis: null })} />
    </div>
  );
}
