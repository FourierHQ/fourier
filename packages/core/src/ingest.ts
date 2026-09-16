import { z } from "zod";
import { getDataClient } from "./client";
import { DEFAULT_ENVIRONMENT, type Environment } from "./environments";
import { EMPTY_GEO, ensureGeoDb, geoFromContext, geoFromIp, type Geo } from "./geo";
import type { Project } from "./projects";

const json = z.record(z.string(), z.unknown());

export const messageSchema = z
  .object({
    type: z.enum(["track", "page", "screen", "identify", "group", "alias"]),
    messageId: z.string().min(1).max(200).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    sentAt: z.union([z.string(), z.number()]).optional(),
    anonymousId: z.union([z.string(), z.number()]).nullish(),
    userId: z.union([z.string(), z.number()]).nullish(),
    event: z.string().max(500).optional(),
    name: z.string().max(500).nullish(),
    category: z.string().max(500).nullish(),
    properties: json.nullish(),
    traits: json.nullish(),
    groupId: z.union([z.string(), z.number()]).nullish(),
    previousId: z.union([z.string(), z.number()]).nullish(),
    context: json.nullish(),
    integrations: z.unknown().optional(),
    writeKey: z.string().optional(),
  })
  .passthrough();

export type IncomingMessage = z.infer<typeof messageSchema>;

export const batchSchema = z.object({
  writeKey: z.string().optional(),
  batch: z.array(messageSchema).max(1000),
  sentAt: z.union([z.string(), z.number()]).optional(),
});

export interface EventRow {
  project_id: string;
  source_id: string;
  message_id: string;
  type: string;
  event: string;
  name: string;
  category: string;
  distinct_id: string;
  anonymous_id: string;
  user_id: string;
  group_id: string;
  person_id: string;
  session_id: string;
  session_start: number;
  timestamp: string;
  sent_at: string;
  properties: string;
  traits: string;
  context: string;
  url: string;
  host: string;
  path: string;
  search: string;
  referrer: string;
  referrer_host: string;
  title: string;
  user_agent: string;
  ip: string;
  locale: string;
  timezone: string;
  country: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  library_name: string;
  library_version: string;
}

export interface IngestMeta {
  /** Which source (write key) the batch arrived on. */
  sourceId?: string;
  ip?: string;
  userAgent?: string;
  receivedAt?: Date;
  /** What the CDN in front of us said about the connecting address. See ./geo. */
  geo?: Geo | null;
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function toIso(v: string | number | undefined, fallback: Date): string {
  if (v == null) return fmt(fallback);
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return isNaN(d.getTime()) ? fmt(fallback) : fmt(d);
}

/** ClickHouse-friendly `YYYY-MM-DD HH:MM:SS.mmm` in UTC. */
function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function normalize(project: Project, msg: IncomingMessage, meta: IngestMeta = {}): EventRow {
  const now = meta.receivedAt ?? new Date();
  const ctx = (msg.context ?? {}) as Record<string, unknown>;
  const page = (ctx.page ?? {}) as Record<string, unknown>;
  const props = (msg.properties ?? {}) as Record<string, unknown>;
  const campaign = (ctx.campaign ?? {}) as Record<string, unknown>;
  const library = (ctx.library ?? {}) as Record<string, unknown>;

  const userId = str(msg.userId);
  const anonymousId = str(msg.anonymousId);
  const groupId = str(msg.groupId ?? ctx.groupId);
  const session = (ctx.session ?? {}) as Record<string, unknown>;

  // Clock skew correction, like Segment: timestamp + (received - sentAt)
  let ts = toIso(msg.timestamp, now);
  if (msg.sentAt && msg.timestamp) {
    const sent = new Date(msg.sentAt).getTime();
    const orig = new Date(msg.timestamp).getTime();
    if (!isNaN(sent) && !isNaN(orig)) {
      const skew = now.getTime() - sent;
      if (Math.abs(skew) > 1000) ts = fmt(new Date(orig + skew));
    }
  }

  const eventName =
    msg.type === "track"
      ? msg.event ?? ""
      : msg.type === "page"
        ? "$page"
        : msg.type === "screen"
          ? "$screen"
          : msg.type === "identify"
            ? "$identify"
            : msg.type === "group"
              ? "$group"
              : "$alias";

  const url = str(props.url ?? page.url);
  const referrer = str(props.referrer ?? page.referrer);

  // Location, in order of how much we trust it. The edge headers in `meta.geo` describe
  // whoever opened the connection — which is the visitor for a browser, but the
  // customer's own server when a server-side SDK relays events for its users. Those
  // messages say so by carrying context.ip, and that is the cue to ignore the edge and
  // resolve the address they named instead.
  const ctxIp = str(ctx.ip);
  const ip = ctxIp || str(meta.ip);
  const relayed = ctxIp !== "" && ctxIp !== str(meta.ip);
  const geo = geoFromContext(ctx) ?? (relayed ? null : meta.geo) ?? geoFromIp(ip) ?? EMPTY_GEO;

  return {
    project_id: project.id,
    source_id: meta.sourceId ?? "default",
    message_id: msg.messageId ?? crypto.randomUUID(),
    type: msg.type,
    event: eventName,
    name: str(msg.name ?? (msg.type === "page" || msg.type === "screen" ? props.name : "")),
    category: str(msg.category ?? props.category),
    distinct_id: userId || anonymousId,
    anonymous_id: anonymousId,
    user_id: userId,
    group_id: groupId,
    // provisional; resolved against identities in ingest()
    person_id: userId || anonymousId,
    session_id: str(session.id ?? ctx.sessionId),
    session_start: session.isNew === true || session.start === true ? 1 : 0,
    timestamp: ts,
    sent_at: toIso(msg.sentAt, now),
    properties: JSON.stringify(msg.properties ?? {}),
    traits: JSON.stringify(msg.traits ?? {}),
    context: JSON.stringify(ctx),
    url,
    host: hostOf(url),
    path: str(props.path ?? page.path),
    search: str(props.search ?? page.search),
    referrer,
    referrer_host: hostOf(referrer),
    title: str(props.title ?? page.title),
    user_agent: str(ctx.userAgent ?? meta.userAgent),
    ip,
    locale: str(ctx.locale),
    timezone: str(ctx.timezone ?? get(ctx, ["timezone"])),
    country: geo.country,
    region: geo.region,
    city: geo.city,
    latitude: geo.latitude,
    longitude: geo.longitude,
    utm_source: str(campaign.source),
    utm_medium: str(campaign.medium),
    utm_campaign: str(campaign.name ?? campaign.campaign),
    utm_content: str(campaign.content),
    utm_term: str(campaign.term),
    library_name: str(library.name),
    library_version: str(library.version),
  };
}

async function loadTraits(environment: Environment, table: "user_traits" | "group_traits", idCol: "user_id" | "group_id", projectId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, Record<string, unknown>>();
  const res = await getDataClient(environment).query({
    query: `SELECT ${idCol} AS id, traits FROM ${table} FINAL WHERE project_id = {p:String} AND ${idCol} IN ({ids:Array(String)})`,
    query_params: { p: projectId, ids },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { id: string; traits: string }[];
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    try {
      out.set(r.id, JSON.parse(r.traits));
    } catch {
      out.set(r.id, {});
    }
  }
  return out;
}

/** Known id -> user_id links for the given ids (anonymous ids or previous user ids). */
async function loadIdentityLinks(environment: Environment, projectId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const res = await getDataClient(environment).query({
    query: `SELECT from_id, to_id FROM identity_map WHERE project_id = {p:String} AND from_id IN ({ids:Array(String)})`,
    query_params: { p: projectId, ids },
    format: "JSONEachRow",
  });
  for (const r of (await res.json()) as { from_id: string; to_id: string }[]) out.set(r.from_id, r.to_id);
  return out;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
}

/**
 * Persist a batch into one environment's database.
 *
 * The environment is decided by the write key the request authenticated with, never by
 * anything in the payload — a preview deployment holds only the preview key, so it
 * cannot reach production's tables however its client is configured.
 */
export async function ingest(
  project: Project,
  messages: IncomingMessage[],
  meta: IngestMeta = {},
  environment: Environment = DEFAULT_ENVIRONMENT,
): Promise<IngestResult> {
  const client = getDataClient(environment);
  // Opens the optional local geo database on the first batch and is a no-op after that,
  // which is what lets normalize() resolve an address without being async.
  await ensureGeoDb();
  const rows: EventRow[] = [];
  const accepted: IncomingMessage[] = [];
  let rejected = 0;
  for (const m of messages) {
    if (m.type === "track" && !m.event) {
      rejected++;
      continue;
    }
    if (!m.userId && !m.anonymousId) {
      rejected++;
      continue;
    }
    rows.push(normalize(project, m, meta));
    accepted.push(m);
  }
  if (rows.length === 0) return { accepted: 0, rejected };

  // --- traits: merge per id within the batch, then against stored state ---
  const userTraitUpdates = new Map<string, Record<string, unknown>>();
  const groupTraitUpdates = new Map<string, Record<string, unknown>>();
  const identityLinks: { anonymous_id: string; user_id: string; created_at: string }[] = [];

  const now = fmt(meta.receivedAt ?? new Date());
  const links = new Map<string, string>(); // from_id -> to_id, this batch
  for (const [i, r] of rows.entries()) {
    const src = accepted[i];
    if (r.user_id && r.anonymous_id && r.user_id !== r.anonymous_id) links.set(r.anonymous_id, r.user_id);
    if (r.type === "alias" && r.user_id) {
      const prev = str(src.previousId);
      if (prev && prev !== r.user_id) links.set(prev, r.user_id);
    }
  }
  for (const r of rows) {
    if (r.type === "identify" && r.user_id) {
      const t = JSON.parse(r.traits) as Record<string, unknown>;
      userTraitUpdates.set(r.user_id, { ...(userTraitUpdates.get(r.user_id) ?? {}), ...t });
    }
    if (r.type === "group" && r.group_id) {
      const t = JSON.parse(r.traits) as Record<string, unknown>;
      groupTraitUpdates.set(r.group_id, { ...(groupTraitUpdates.get(r.group_id) ?? {}), ...t });
    }
  }
  // `created_at` is stamped here, on arrival, and never from the message. The
  // identity_map view breaks conflicts with argMin(user_id, created_at) — one
  // anonymous id claimed by two users resolves to the earliest link — so this
  // column decides who owns a contested identity. A write key is public by
  // design (it ships in the page source), and a message timestamp is whatever
  // the sender says it is: taken from there, anyone could backdate an alias to
  // 1970 and win that argMin against the real link, pulling another person's
  // whole history onto their own person_id.
  let linkIndex = 0;
  const arrival = meta.receivedAt ?? new Date();
  for (const [from, to] of links) {
    // Same batch, same arrival: offset by insertion order so a tie never resolves arbitrarily.
    identityLinks.push({ anonymous_id: from, user_id: to, created_at: fmt(new Date(arrival.getTime() + linkIndex++)) });
  }

  // --- person_id: resolve anonymous rows against links known before this batch and within it ---
  const unresolved = [...new Set(rows.filter((r) => !r.user_id && r.anonymous_id).map((r) => r.anonymous_id))];
  const known = await loadIdentityLinks(environment, project.id, unresolved.filter((id) => !links.has(id)));
  for (const r of rows) {
    if (r.user_id) {
      // one level of user -> user alias recorded in this batch
      r.person_id = links.get(r.user_id) ?? r.user_id;
    } else {
      r.person_id = links.get(r.anonymous_id) ?? known.get(r.anonymous_id) ?? r.anonymous_id;
    }
  }

  // Ensure a group row exists even when only referenced (no traits yet).
  const seenGroups = new Set(rows.filter((r) => r.group_id).map((r) => r.group_id));
  const [existingUsers, existingGroups] = await Promise.all([
    loadTraits(environment, "user_traits", "user_id", project.id, [...userTraitUpdates.keys()]),
    loadTraits(environment, "group_traits", "group_id", project.id, [...new Set([...groupTraitUpdates.keys(), ...seenGroups])]),
  ]);

  const userTraitRows = [...userTraitUpdates].map(([user_id, t]) => ({
    project_id: project.id,
    user_id,
    traits: JSON.stringify({ ...(existingUsers.get(user_id) ?? {}), ...t }),
    updated_at: now,
  }));
  const groupTraitRows = [...groupTraitUpdates].map(([group_id, t]) => ({
    project_id: project.id,
    group_id,
    traits: JSON.stringify({ ...(existingGroups.get(group_id) ?? {}), ...t }),
    updated_at: now,
  }));

  for (const g of seenGroups) {
    if (!groupTraitUpdates.has(g) && !existingGroups.has(g)) {
      // Placeholder with the lowest possible version so any real traits row wins the merge.
      groupTraitRows.push({ project_id: project.id, group_id: g, traits: "{}", updated_at: "1970-01-01 00:00:00.000" });
    }
  }

  const inserts: Promise<unknown>[] = [client.insert({ table: "events", values: rows, format: "JSONEachRow" })];
  if (userTraitRows.length) inserts.push(client.insert({ table: "user_traits", values: userTraitRows, format: "JSONEachRow" }));
  if (groupTraitRows.length) inserts.push(client.insert({ table: "group_traits", values: groupTraitRows, format: "JSONEachRow" }));
  if (identityLinks.length) {
    const dedup = new Map(identityLinks.map((l) => [`${l.anonymous_id}|${l.user_id}`, { project_id: project.id, ...l }]));
    inserts.push(client.insert({ table: "identities", values: [...dedup.values()], format: "JSONEachRow" }));
  }
  await Promise.all(inserts);
  return { accepted: rows.length, rejected };
}
