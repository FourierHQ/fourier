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

/**
 * Empty by default, because the dashboard and the API normally share an origin.
 * Set NEXT_PUBLIC_FOURIER_API_URL to point this build at a Fourier server
 * deployed somewhere else — that server must then name this origin in
 * FOURIER_ALLOWED_ORIGINS so the browser will send the session cookie.
 */
export const API_BASE = (process.env.NEXT_PUBLIC_FOURIER_API_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly setupRequired = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    // The session is an HttpOnly cookie; without this a cross-origin dashboard
    // would send every request anonymously.
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; setup_required?: boolean };
    throw new ApiError(b.error ?? `Request failed: ${res.status}`, res.status, Boolean(b.setup_required));
  }
  return body as T;
}

// ---------- auth ----------

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface AuthStatus {
  setup_required: boolean;
  setup_token_required: boolean;
  auth_disabled: boolean;
  user: SessionUser | null;
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<AuthStatus>("/api/auth/status"),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<{ user: SessionUser }>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; name?: string; token?: string }) =>
      api<{ user: SessionUser }>("/api/auth/setup", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export interface ApiKey {
  id: string;
  account_id: string;
  name: string;
  prefix: string;
  last_used_at: string;
  created_at: string;
}

export function useApiKeys() {
  return useQuery({ queryKey: ["api-keys"], queryFn: () => api<{ keys: ApiKey[] }>("/api/keys").then((r) => r.keys), retry: false });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ key: ApiKey; plaintext: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
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
