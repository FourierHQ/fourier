"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Availability,
  BreakdownRow,
  CombineProposal,
  Delta,
  FilterValues,
  Funnel,
  Goal,
  GoalDefinition,
  GoalSplit,
  PropertyFilter,
  SplitCatalog,
  SplitKeyCandidate,
  GoalConverterRow,
  GoalDetail,
  GoalSummaryRow,
  Headline,
  LandingPageRow,
  PageDetail,
  PageGroup,
  PageRow,
  RatePoint,
  SeriesPoint,
  ConversionCredit,
  ConvertingPageRow,
  ConversionPageRow,
  ConversionPages,
  SupportingActionRow,
  TrafficSeries,
  VisitorMix,
  WentOn,
} from "@fourierhq/core";
import { api, LIVE_INTERVAL, PROJECT } from "./api";
import { useEnvironmentValue } from "./environment";
import { useWebState } from "./web-state";

export type {
  Availability,
  BreakdownRow,
  CombineProposal,
  CreditRow,
  Delta,
  Funnel,
  FunnelStep,
  Goal,
  GoalDefinition,
  GoalSplit,
  SplitCatalog,
  SplitCatalogValue,
  SplitGoalConfig,
  SplitKeyCandidate,
  SplitValue,
  GoalConverterRow,
  GoalDetail,
  GoalSummaryRow,
  Headline,
  LandingPageRow,
  PageDetail,
  PageGroup,
  PageRow,
  RateValue,
  RateDelta,
  RatePoint,
  SeriesPoint,
  ConversionCredit,
  ConvertingPageRow,
  ConversionPageRow,
  ConversionPages,
  SupportingActionRow,
  TrafficSeries,
  VisitorMix,
  WentOn,
} from "@fourierhq/core";

/**
 * Each part of a report resolves on its own, so one failing query leaves a single card
 * showing an error and a retry instead of blanking the page around it.
 */
export type Settled<T> = { data: T } | { error: string };

export function unwrap<T>(s: Settled<T> | undefined): T | undefined {
  return s && "data" in s ? s.data : undefined;
}

export function errorOf(s: Settled<unknown> | undefined): string | undefined {
  return s && "error" in s ? s.error : undefined;
}

/**
 * What the conversion figures on screen are counting.
 *
 * Null means no primary goal is configured, which is a setup prompt rather than a zero.
 * Otherwise it is the goal the reader narrowed to, or all of them — the default, since
 * a site with three goals should answer "how is it doing" by counting visits that
 * completed any of them rather than one picked on their behalf.
 */
export function countingLabel(scope: ScopeEcho | undefined): string | null {
  if (!scope) return null;
  if (scope.goal) return scope.goal.name;
  return scope.goals.some((g) => g.type === "primary") ? "All conversions" : null;
}

export interface ScopeEcho {
  range: {
    preset: string;
    from: string;
    to: string;
    previous_from: string | null;
    previous_to: string | null;
    interval: "hour" | "day" | "week" | "month";
    timezone: string;
  };
  filters: Record<string, unknown>;
  goal: { id: string; name: string; split: GoalSplit | null } | null;
  goals: { id: string; name: string; type: "primary" | "supporting"; is_default: boolean; split: GoalSplit | null }[];
  page_groups: { id: string; name: string }[];
}

interface Report {
  scope: ScopeEcho;
  availability: Settled<Availability>;
}

export interface OverviewReport extends Report {
  headline: Settled<Headline>;
  trend: Settled<TrafficSeries>;
  conversion_trend: Settled<RatePoint[]>;
  channels: Settled<BreakdownRow[]>;
  landing_pages: Settled<LandingPageRow[]>;
  visitor_mix: Settled<VisitorMix>;
}

export interface AcquisitionReport extends Report {
  grouping: "channel" | "source" | "campaign";
  sort: "sessions" | "conversion_rate" | "converting_sessions";
  headline: Settled<Headline>;
  stack: Settled<{ channels: string[]; points: { bucket: string; values: Record<string, number> }[] }>;
  performance: Settled<BreakdownRow[]>;
  by_channel: Settled<BreakdownRow[]>;
}

/**
 * Discriminated on `tab`, so the rows can only be read after checking which report
 * they came from.
 *
 * This is not pedantry. The tab lives in the URL and changes the instant it is clicked,
 * while the rows arrive later — and until they do, react-query hands back the previous
 * tab's payload as placeholder data. A component that decides what to render from the
 * URL therefore draws the new table over the old table's rows for one frame. With a
 * union of arrays that was a cast away from compiling, and it read `pageviews` off a
 * landing row and crashed.
 */
interface PagesReportBase extends Report {
  group_by: "page" | "group";
  /** The search these rows answer, which trails the box while a new one is in flight. */
  search: string | null;
  /** Every visitor in the report, asked the went-on question. Null with no goal configured. */
  went_on_baseline: Settled<WentOn | null>;
}

export type PagesReport =
  | (PagesReportBase & { tab: "landing"; rows: Settled<LandingPageRow[]> })
  | (PagesReportBase & { tab: "all"; rows: Settled<PageRow[]> });

export interface PageDetailReport {
  scope: ScopeEcho;
  path: string;
  basis: "landing" | "viewers";
  detail: Settled<PageDetail>;
}

export interface GoalDetailReport {
  scope: ScopeEcho;
  definition: string;
  detail: Settled<GoalDetail>;
}

interface ConversionsReportBase extends Report {
  headline: Settled<Headline>;
  goals: Settled<GoalSummaryRow[]>;
  trend: Settled<RatePoint[]>;
  volume: Settled<SeriesPoint[]>;
  funnel: Settled<Funnel>;
  supporting: Settled<SupportingActionRow[]>;
  credit: Settled<ConversionCredit>;
  landing: Settled<LandingPageRow[]>;
}

/** Discriminated on `pages` for the reason PagesReport is — the two modes have different rows. */
export type ConversionsReport =
  | (ConversionsReportBase & { pages: "leading"; page_rows: Settled<ConversionPages> })
  | (ConversionsReportBase & { pages: "anywhere"; page_rows: Settled<ConvertingPageRow[]> });

/**
 * The zone the reader's days are measured in.
 *
 * Sent with every request rather than written into the URL, so a link shared with a
 * colleague renders in their own days rather than silently in yours. Someone who wants
 * a view pinned to one zone — a report that has to mean the same thing to everyone —
 * puts `tz` in the URL and it wins, because `query()` merges the URL over this.
 */
function readerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * One request per report rather than one per card: every number on a page then
 * describes the same snapshot, which is the difference between a conversion rate that
 * matches its own numerator and one that was fetched a second later.
 */
function useReport<T>(name: string, extra: Record<string, string | null | undefined> = {}) {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ tz: readerTimezone(), ...extra, environment });
  return useQuery({
    queryKey: ["web", name, qs],
    queryFn: () => api<T>(`/api/projects/${PROJECT}/web/${name}?${qs}`),
    refetchInterval: LIVE_INTERVAL * 12,
    placeholderData: (prev) => prev,
    retry: 1,
  });
}

export const useWebOverview = () => useReport<OverviewReport>("overview");

export const useWebAcquisition = (groupBy: string, sort: string) => useReport<AcquisitionReport>("acquisition", { group_by: groupBy, sort });

export const useWebPages = (tab: string, groupBy: string, search: string | null) =>
  useReport<PagesReport>("pages", { tab, group_by: groupBy, q: search });

export const useWebConversions = (pages: string) => useReport<ConversionsReport>("conversions", { pages });

export function useWebPageDetail(path: string | null, basis: "landing" | "viewers") {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ tz: readerTimezone(), path, basis, environment });
  return useQuery({
    queryKey: ["web", "page-detail", qs],
    queryFn: () => api<PageDetailReport>(`/api/projects/${PROJECT}/web/page-detail?${qs}`),
    enabled: Boolean(path),
    placeholderData: (prev) => prev,
  });
}

/**
 * The people behind one goal, under the filters currently on screen.
 *
 * Keyed on the whole query string like every other report, so opening the drawer after
 * changing a filter cannot serve the previous filter's people out of the cache.
 */
export function useWebGoalDetail(definition: string | null) {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ tz: readerTimezone(), definition, environment });
  return useQuery({
    queryKey: ["web", "goal-detail", qs],
    queryFn: () => api<GoalDetailReport>(`/api/projects/${PROJECT}/web/goal-detail?${qs}`),
    enabled: Boolean(definition),
    placeholderData: (prev) => prev,
  });
}

export function useWebFilterValues() {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ tz: readerTimezone(), environment });
  return useQuery({
    queryKey: ["web", "filters", qs],
    queryFn: () => api<FilterValues & { channels: string[]; devices: string[]; browsers: string[] }>(`/api/projects/${PROJECT}/web/filters?${qs}`),
    staleTime: 60_000,
  });
}

// ---------- definitions ----------

/**
 * Goals and page groups live in the control database and are shared across
 * environments, so this query is deliberately not keyed on the environment: the same
 * goal is the same goal whether you are looking at production or preview.
 */
export function useWebDefinitions() {
  return useQuery({
    queryKey: ["web", "definitions"],
    queryFn: () => api<{ goals: GoalDefinition[]; page_groups: PageGroup[]; combinable: CombineProposal[] }>(`/api/projects/${PROJECT}/web/definitions`),
  });
}

/**
 * Which of an event's properties are worth splitting a goal by, best first. Read from the
 * environment on screen, like the property pickers beside it.
 */
export function useSplitCandidates(event: string | null | undefined, properties: PropertyFilter[] | undefined) {
  const environment = useEnvironmentValue();
  const name = event?.trim() ?? "";
  const props = JSON.stringify(properties ?? []);
  return useQuery({
    queryKey: ["web", "split-candidates", environment, name, props],
    queryFn: () =>
      api<{ candidates: SplitKeyCandidate[] }>(
        `/api/projects/${PROJECT}/web/goal-values?${new URLSearchParams({ event: name, properties: props, environment })}`,
      ).then((r) => r.candidates),
    enabled: Boolean(name),
    staleTime: 60_000,
  });
}

/** Every value a split would produce, named the way the reports will name it. */
export function useSplitCatalog(
  rule: { event: string; properties?: PropertyFilter[]; key: string; label_key?: string | null; type: "primary" | "supporting" } | null,
) {
  const environment = useEnvironmentValue();
  const params = rule
    ? new URLSearchParams({
        event: rule.event.trim(),
        properties: JSON.stringify(rule.properties ?? []),
        key: rule.key.trim(),
        type: rule.type,
        environment,
        ...(rule.label_key ? { label_key: rule.label_key } : {}),
      }).toString()
    : "";
  return useQuery({
    queryKey: ["web", "split-catalog", params],
    queryFn: () => api<{ catalog: SplitCatalog }>(`/api/projects/${PROJECT}/web/goal-values?${params}`).then((r) => r.catalog),
    enabled: Boolean(rule?.event.trim() && rule.key.trim()),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export interface SaveDefinition {
  kind: "goal" | "page_group";
  id?: string;
  name: string;
  config: unknown;
  position?: number;
  is_default?: boolean;
}

export function useSaveDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveDefinition) =>
      api<{ definition: Goal | PageGroup }>(`/api/projects/${PROJECT}/web/definitions`, { method: "POST", body: JSON.stringify(input) }),
    // Every report depends on the definitions, so they all become stale together.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web"] }),
  });
}

export function useDeleteDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: "goal" | "page_group"; id: string }) =>
      api<{ ok: true }>(`/api/projects/${PROJECT}/web/definitions?kind=${kind}&definition=${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web"] }),
  });
}
