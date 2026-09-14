"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  Attribution,
  AttributionDimension,
  AttributionModel,
  AttributionRow,
  EventName,
  EventRecord,
  GroupDetail,
  GroupRecord,
  Overview,
  Project,
  GroupAttribution,
  Source,
  SqlResult,
  TimeseriesPoint,
  TouchRecord,
  UserDetail,
  UserRecord,
} from "@fourier/core";

export type {
  Attribution,
  AttributionDimension,
  AttributionModel,
  AttributionRow,
  EventName,
  EventRecord,
  GroupAttribution,
  GroupDetail,
  GroupRecord,
  Overview,
  Project,
  Source,
  SqlResult,
  TimeseriesPoint,
  TouchRecord,
  UserDetail,
  UserRecord,
};

export const PROJECT = "default";
export const LIVE_INTERVAL = 5_000;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  return body as T;
}

function qs(params: object): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
}

type Opts<T> = Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">;

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ ok: boolean; clickhouse: { url: string; database: string; version?: string; error?: string }; default_project_id?: string }>("/api/health"),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api<{ projects: Project[] }>("/api/projects").then((r) => r.projects) });
}

export function useSources() {
  return useQuery({ queryKey: ["sources"], queryFn: () => api<{ sources: Source[] }>(`/api/projects/${PROJECT}/sources`).then((r) => r.sources) });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ source: Source }>(`/api/projects/${PROJECT}/sources`, { method: "POST", body: JSON.stringify({ name }) }).then((r) => r.source),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources"] }),
  });
}

export function useOverview(opts?: Opts<{ project: Project; overview: Overview }>) {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api<{ project: Project; overview: Overview }>(`/api/projects/${PROJECT}/overview`),
    refetchInterval: LIVE_INTERVAL,
    ...opts,
  });
}

export function useEventNames(days?: number, source?: string) {
  return useQuery({
    queryKey: ["event-names", days, source],
    queryFn: () => api<{ events: EventName[] }>(`/api/projects/${PROJECT}/events/names${qs({ days, source })}`).then((r) => r.events),
    refetchInterval: LIVE_INTERVAL * 2,
  });
}

export interface EventsParams {
  event?: string;
  type?: string;
  source?: string;
  distinct_id?: string;
  group_id?: string;
  q?: string;
  before?: string;
  after?: string;
  limit?: number;
}

export function useEvents(params: EventsParams, opts?: Opts<{ events: EventRecord[]; next_before: string | null }>) {
  return useQuery({
    queryKey: ["events", params],
    queryFn: () => api<{ events: EventRecord[]; next_before: string | null }>(`/api/projects/${PROJECT}/events${qs(params)}`),
    refetchInterval: LIVE_INTERVAL,
    placeholderData: (prev) => prev,
    ...opts,
  });
}

export function useTimeseries(params: { event?: string; group_id?: string; source?: string; interval?: "hour" | "day" | "week" | "month"; from?: string; to?: string }) {
  return useQuery({
    queryKey: ["timeseries", params],
    queryFn: () => api<{ interval: string; series: TimeseriesPoint[] }>(`/api/projects/${PROJECT}/timeseries${qs(params)}`).then((r) => r.series),
    refetchInterval: LIVE_INTERVAL * 6,
    placeholderData: (prev) => prev,
  });
}

export function useUsers(params: { q?: string; identified?: boolean; group_id?: string; source?: string; order_by?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ["users", params],
    queryFn: () => api<{ users: UserRecord[] }>(`/api/projects/${PROJECT}/users${qs(params)}`).then((r) => r.users),
    refetchInterval: LIVE_INTERVAL * 2,
    placeholderData: (prev) => prev,
  });
}

export function useUser(distinctId: string) {
  return useQuery({
    queryKey: ["user", distinctId],
    queryFn: () => api<{ user: UserDetail; events: EventRecord[]; attribution: Attribution }>(`/api/projects/${PROJECT}/users/${encodeURIComponent(distinctId)}?limit=200`),
    refetchInterval: LIVE_INTERVAL,
    enabled: !!distinctId,
  });
}

export function useGroups(params: { q?: string; order_by?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ["groups", params],
    queryFn: () => api<{ groups: GroupRecord[] }>(`/api/projects/${PROJECT}/groups${qs(params)}`).then((r) => r.groups),
    refetchInterval: LIVE_INTERVAL * 2,
    placeholderData: (prev) => prev,
  });
}

export function useGroup(groupId: string) {
  return useQuery({
    queryKey: ["group", groupId],
    queryFn: () => api<{ group: GroupDetail; events: EventRecord[]; attribution: GroupAttribution }>(`/api/projects/${PROJECT}/groups/${encodeURIComponent(groupId)}?limit=200`),
    refetchInterval: LIVE_INTERVAL,
    enabled: !!groupId,
  });
}

export function useAttributionReport(params: { model?: AttributionModel; by?: AttributionDimension; identified?: boolean; group_id?: string; limit?: number }) {
  return useQuery({
    queryKey: ["attribution", params],
    queryFn: () => api<{ model: AttributionModel; by: AttributionDimension; rows: AttributionRow[] }>(`/api/projects/${PROJECT}/attribution${qs(params)}`),
    refetchInterval: LIVE_INTERVAL * 6,
    placeholderData: (prev) => prev,
  });
}

export function runSql(sql: string, limit?: number) {
  return api<SqlResult & { project_id: string }>(`/api/projects/${PROJECT}/query`, { method: "POST", body: JSON.stringify({ sql, limit }) });
}
