"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  Account,
  Attribution,
  AttributionDimension,
  AttributionModel,
  AttributionRow,
  Environment,
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
} from "@fourierhq/core";

export type {
  Account,
  Attribution,
  AttributionDimension,
  AttributionModel,
  AttributionRow,
  Environment,
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

import { useEnvironmentValue } from "./environment";

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

// ---------- accounts ----------

export function useAccounts() {
  return useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/api/accounts").then((r) => r.accounts), retry: false });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; name?: string; role?: string }) =>
      api<{ account: Account }>("/api/accounts", { method: "POST", body: JSON.stringify(input) }).then((r) => r.account),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; email?: string; role?: string; password?: string }) =>
      api<{ account: Account }>(`/api/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }).then((r) => r.account),
    // Renaming yourself changes the name in the sidebar, which comes from
    // auth-status rather than this list.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["auth-status"] });
    },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { current_password: string; new_password: string }) =>
      api<{ ok: true }>("/api/auth/password", { method: "POST", body: JSON.stringify(input) }),
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

/** A source plus its write key in each environment. */
export interface SourceWithKeys extends Source {
  keys: Partial<Record<Environment, string>>;
}

export function useSources() {
  return useQuery({
    queryKey: ["sources"],
    queryFn: () => api<{ sources: SourceWithKeys[] }>(`/api/projects/${PROJECT}/sources`).then((r) => r.sources),
  });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ source: SourceWithKeys }>(`/api/projects/${PROJECT}/sources`, { method: "POST", body: JSON.stringify({ name }) }).then((r) => r.source),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources"] }),
  });
}

export function useOverview(opts?: Opts<{ project: Project; overview: Overview }>) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["overview", environment],
    queryFn: () => api<{ project: Project; overview: Overview }>(`/api/projects/${PROJECT}/overview${qs({ environment })}`),
    refetchInterval: LIVE_INTERVAL,
    ...opts,
  });
}

export function useEventNames(days?: number, source?: string) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["event-names", environment, days, source],
    queryFn: () => api<{ events: EventName[] }>(`/api/projects/${PROJECT}/events/names${qs({ days, source, environment })}`).then((r) => r.events),
    refetchInterval: LIVE_INTERVAL * 2,
  });
}

/**
 * The properties a named event carries, and the values one of them takes — the two
 * halves of "signup completed, where plan is free".
 *
 * Both are suggestions rather than a closed set: they describe the last 30 days of the
 * environment on screen, while a goal is a rule about all of history. So neither is
 * allowed to be the only way to name a property, and both stay disabled until there is
 * an event to ask about.
 */
export function useEventPropertyKeys(event: string | null | undefined) {
  const environment = useEnvironmentValue();
  const name = event?.trim() ?? "";
  return useQuery({
    queryKey: ["property-keys", environment, name],
    queryFn: () => api<{ keys: { key: string; count: number }[] }>(`/api/projects/${PROJECT}/properties${qs({ event: name, environment })}`).then((r) => r.keys),
    enabled: Boolean(name),
    staleTime: 60_000,
  });
}

export function useEventPropertyValues(event: string | null | undefined, key: string | null | undefined) {
  const environment = useEnvironmentValue();
  const name = event?.trim() ?? "";
  const prop = key?.trim() ?? "";
  return useQuery({
    queryKey: ["property-values", environment, name, prop],
    queryFn: () =>
      api<{ values: { value: string; count: number }[] }>(`/api/projects/${PROJECT}/properties${qs({ event: name, key: prop, environment })}`).then((r) => r.values),
    enabled: Boolean(name && prop),
    staleTime: 60_000,
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
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["events", environment, params],
    queryFn: () => api<{ events: EventRecord[]; next_before: string | null }>(`/api/projects/${PROJECT}/events${qs({ ...params, environment })}`),
    refetchInterval: LIVE_INTERVAL,
    placeholderData: (prev) => prev,
    ...opts,
  });
}

export function useTimeseries(params: { event?: string; group_id?: string; source?: string; interval?: "hour" | "day" | "week" | "month"; from?: string; to?: string }) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["timeseries", environment, params],
    queryFn: () => api<{ interval: string; series: TimeseriesPoint[] }>(`/api/projects/${PROJECT}/timeseries${qs({ ...params, environment })}`).then((r) => r.series),
    refetchInterval: LIVE_INTERVAL * 6,
    placeholderData: (prev) => prev,
  });
}

export function useUsers(params: { q?: string; identified?: boolean; group_id?: string; source?: string; order_by?: string; limit?: number; offset?: number }) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["users", environment, params],
    queryFn: () => api<{ users: UserRecord[] }>(`/api/projects/${PROJECT}/users${qs({ ...params, environment })}`).then((r) => r.users),
    refetchInterval: LIVE_INTERVAL * 2,
    placeholderData: (prev) => prev,
  });
}

export function useUser(distinctId: string) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["user", environment, distinctId],
    queryFn: () => api<{ user: UserDetail; events: EventRecord[]; attribution: Attribution }>(`/api/projects/${PROJECT}/users/${encodeURIComponent(distinctId)}?limit=200&environment=${environment}`),
    refetchInterval: LIVE_INTERVAL,
    enabled: !!distinctId,
  });
}

export function useGroups(params: { q?: string; order_by?: string; limit?: number; offset?: number }) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["groups", environment, params],
    queryFn: () => api<{ groups: GroupRecord[] }>(`/api/projects/${PROJECT}/groups${qs({ ...params, environment })}`).then((r) => r.groups),
    refetchInterval: LIVE_INTERVAL * 2,
    placeholderData: (prev) => prev,
  });
}

export function useGroup(groupId: string) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["group", environment, groupId],
    queryFn: () => api<{ group: GroupDetail; events: EventRecord[]; attribution: GroupAttribution }>(`/api/projects/${PROJECT}/groups/${encodeURIComponent(groupId)}?limit=200&environment=${environment}`),
    refetchInterval: LIVE_INTERVAL,
    enabled: !!groupId,
  });
}

export function useAttributionReport(params: { model?: AttributionModel; by?: AttributionDimension; identified?: boolean; group_id?: string; limit?: number }) {
  const environment = useEnvironmentValue();
  return useQuery({
    queryKey: ["attribution", environment, params],
    queryFn: () => api<{ model: AttributionModel; by: AttributionDimension; rows: AttributionRow[] }>(`/api/projects/${PROJECT}/attribution${qs({ ...params, environment })}`),
    refetchInterval: LIVE_INTERVAL * 6,
    placeholderData: (prev) => prev,
  });
}

export function runSql(sql: string, limit?: number, environment?: string) {
  return api<SqlResult & { project_id: string }>(`/api/projects/${PROJECT}/query${qs({ environment })}`, { method: "POST", body: JSON.stringify({ sql, limit }) });
}
