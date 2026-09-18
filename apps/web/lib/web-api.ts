"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Availability,
  BreakdownRow,
  Delta,
  FilterValues,
  Funnel,
  Goal,
  GoalSummaryRow,
  Headline,
  LandingPageRow,
  PageDetail,
  PageGroup,
  PageRow,
  RatePoint,
  SeriesPoint,
  SupportingActionRow,
  VisitorMix,
} from "@fourierhq/core";
import { api, LIVE_INTERVAL, PROJECT } from "./api";
import { useEnvironmentValue } from "./environment";
import { useWebState } from "./web-state";

export type {
  Availability,
  BreakdownRow,
  Delta,
  Funnel,
  FunnelStep,
  Goal,
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
  SupportingActionRow,
  VisitorMix,
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
  goal: { id: string; name: string } | null;
  goals: { id: string; name: string; type: "primary" | "supporting"; is_default: boolean }[];
  page_groups: { id: string; name: string }[];
}

interface Report {
  scope: ScopeEcho;
  availability: Settled<Availability>;
}

export interface OverviewReport extends Report {
  metric: "visitors" | "sessions";
  headline: Settled<Headline>;
  trend: Settled<SeriesPoint[]>;
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

export interface PagesReport extends Report {
  tab: "landing" | "all";
  group_by: "page" | "group";
  rows: Settled<LandingPageRow[] | PageRow[]>;
}

export interface PageDetailReport {
  scope: ScopeEcho;
  path: string;
  basis: "landing" | "viewers";
  detail: Settled<PageDetail>;
}

export interface ConversionsReport extends Report {
  headline: Settled<Headline>;
  goals: Settled<GoalSummaryRow[]>;
  trend: Settled<RatePoint[]>;
  funnel: Settled<Funnel>;
  supporting: Settled<SupportingActionRow[]>;
}

/**
 * One request per report rather than one per card: every number on a page then
 * describes the same snapshot, which is the difference between a conversion rate that
 * matches its own numerator and one that was fetched a second later.
 */
function useReport<T>(name: string, extra: Record<string, string | null | undefined> = {}) {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ ...extra, environment });
  return useQuery({
    queryKey: ["web", name, qs],
    queryFn: () => api<T>(`/api/projects/${PROJECT}/web/${name}?${qs}`),
    refetchInterval: LIVE_INTERVAL * 12,
    placeholderData: (prev) => prev,
    retry: 1,
  });
}

export const useWebOverview = (metric: "visitors" | "sessions") => useReport<OverviewReport>("overview", { metric });

export const useWebAcquisition = (groupBy: string, sort: string) => useReport<AcquisitionReport>("acquisition", { group_by: groupBy, sort });

export const useWebPages = (tab: string, groupBy: string) => useReport<PagesReport>("pages", { tab, group_by: groupBy });

export const useWebConversions = () => useReport<ConversionsReport>("conversions");

export function useWebPageDetail(path: string | null, basis: "landing" | "viewers") {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ path, basis, environment });
  return useQuery({
    queryKey: ["web", "page-detail", qs],
    queryFn: () => api<PageDetailReport>(`/api/projects/${PROJECT}/web/page-detail?${qs}`),
    enabled: Boolean(path),
    placeholderData: (prev) => prev,
  });
}

export function useWebFilterValues() {
  const environment = useEnvironmentValue();
  const { query } = useWebState();
  const qs = query({ environment });
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
    queryFn: () => api<{ goals: Goal[]; page_groups: PageGroup[] }>(`/api/projects/${PROJECT}/web/definitions`),
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
