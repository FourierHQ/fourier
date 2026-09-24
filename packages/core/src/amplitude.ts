/**
 * Import from Amplitude.
 *
 * Amplitude's Export API hands back every raw event for a range of hours. Each one is
 * translated into the analytics.js message the Fourier SDK would have sent for the same
 * moment, and then goes through `ingest()` like any other batch — so identity links,
 * person resolution, traits, sessions, touches and every rollup are built by exactly
 * the code that builds them for live traffic. There is no second write path to drift.
 *
 * Imports land in the Test environment only, for now. It is a database of its own with
 * no write key, so it can be emptied and filled again while the mapping is being judged,
 * and nothing in it can be mistaken for production traffic.
 *
 * Three rules keep a re-run and a later production import safe:
 * - `message_id` is `amp:` + Amplitude's own `uuid`, and ids already stored are skipped
 *   before the insert. Skipping afterwards would be too late: every materialised view
 *   counts a row the moment it is inserted, whether or not the row later merges away.
 * - Amplitude's `device_id` becomes `amp:<device_id>`. Amplitude and Fourier each set
 *   their own cookie, so the two id spaces can never refer to the same browser, and the
 *   prefix guarantees they never collide either. `user_id` is kept exactly as it is:
 *   it is the one id both tools share, and what joins a person's history across them.
 * - Amplitude's `session_id` is the session's start time in milliseconds, per device, so
 *   two devices opening a session in the same millisecond share one. The session id
 *   stored is `amp:<device_id>:<session_id>`.
 */
import { gunzipSync, inflateRawSync } from "node:zlib";
import { configFor, getDataClient } from "./client";
import { IMPORT_ENVIRONMENT, type Environment } from "./environments";
import { ingest, type IncomingMessage } from "./ingest";
import type { Project } from "./projects";

export type AmplitudeRegion = "us" | "eu";

export interface AmplitudeCredentials {
  apiKey: string;
  secretKey: string;
  region: AmplitudeRegion;
}

/** One line of an Export API file. Only the fields the import reads. */
export interface AmplitudeEvent {
  uuid?: string | null;
  $insert_id?: string | null;
  event_type?: string | null;
  event_time?: string | null;
  client_event_time?: string | null;
  user_id?: string | number | null;
  device_id?: string | null;
  amplitude_id?: string | number | null;
  session_id?: string | number | null;
  event_properties?: Record<string, unknown> | null;
  user_properties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  dma?: string | null;
  location_lat?: number | string | null;
  location_lng?: number | string | null;
  ip_address?: string | null;
  language?: string | null;
  library?: string | null;
  platform?: string | null;
  os_name?: string | null;
  os_version?: string | null;
  device_type?: string | null;
  device_family?: string | null;
  version_name?: string | null;
}

/** Stamped on every imported row, so provenance survives in `library_name` and can be queried. */
export const AMPLITUDE_LIBRARY = "amplitude-import";

const PAGE_VIEW = "[Amplitude] Page Viewed";

/**
 * Amplitude's own session markers. A Fourier session is read off the events inside it,
 * so these would only add two phantom events to every visit.
 */
export const AMPLITUDE_SESSION_MARKERS: readonly string[] = ["session_start", "session_end"];

/**
 * Events Amplitude's browser SDK sends about itself or the page, rather than about
 * anything a person did. Skipped unless asked for, for the reason Fourier hides its own
 * `$page_leave`: counted as activity, each one would inflate every event total.
 */
export const AMPLITUDE_INSTRUMENTATION: readonly string[] = [
  "[Amplitude] Replay Captured",
  "[Amplitude] Network Request",
  "[Amplitude] Web Vitals",
  "[Amplitude] Viewport Content Updated",
];

// ---------- fetching ----------

const EXPORT_URL: Record<AmplitudeRegion, string> = {
  us: "https://amplitude.com/api/2/export",
  eu: "https://analytics.eu.amplitude.com/api/2/export",
};

export class AmplitudeExportError extends Error {
  constructor(
    message: string,
    /** The status Amplitude answered with, so a route can pass on the right one. */
    readonly status: number,
  ) {
    super(message);
    this.name = "AmplitudeExportError";
  }
}

/** A calendar day in UTC, as `YYYY-MM-DD`. Null for anything else, including impossible dates. */
export function parseDay(day: unknown): string | null {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
}

/**
 * Every event Amplitude uploaded during one UTC day.
 *
 * The Export API selects by when Amplitude received an event, not when it happened, so
 * a day's file can hold a few events that took place earlier — an offline client
 * catching up. They are imported with the time they happened, like any late event.
 */
export async function fetchAmplitudeDay(credentials: AmplitudeCredentials, day: string, fetchImpl: typeof fetch = fetch): Promise<AmplitudeEvent[]> {
  const compact = day.replaceAll("-", "");
  const url = `${EXPORT_URL[credentials.region]}?start=${compact}T00&end=${compact}T23`;
  const auth = Buffer.from(`${credentials.apiKey}:${credentials.secretKey}`).toString("base64");
  const res = await fetchImpl(url, { headers: { Authorization: `Basic ${auth}` } });

  // 404 is Amplitude saying there is no data in the range, which is an answer, not a failure.
  if (res.status === 404) return [];
  if (res.status === 401 || res.status === 403) {
    throw new AmplitudeExportError(
      `Amplitude rejected the API key and secret key (${res.status}). Check both come from the same project, and that the region is right — an EU project's keys are refused by the US endpoint.`,
      res.status,
    );
  }
  if (res.status === 400) throw new AmplitudeExportError(`Amplitude would not export ${day}: its export limit is 4 GB per request.`, res.status);
  if (res.status === 504) throw new AmplitudeExportError(`Amplitude timed out exporting ${day}. Retrying the day usually works.`, res.status);
  if (res.status === 429) throw new AmplitudeExportError(`Amplitude is rate limiting exports. Wait a minute and retry ${day}.`, res.status);
  if (!res.ok) {
    // The body is Amplitude's, never ours, so it cannot echo the credentials back.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new AmplitudeExportError(`Amplitude export failed for ${day} (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
  }
  return parseExportArchive(Buffer.from(await res.arrayBuffer()));
}

/**
 * A zip of gzipped JSON-lines files, one or more per hour. Also accepts a bare gzip or
 * plain JSON lines, so a file downloaded by hand parses the same way.
 */
export function parseExportArchive(buf: Buffer): AmplitudeEvent[] {
  const files = isZip(buf) ? unzip(buf) : [buf];
  const out: AmplitudeEvent[] = [];
  for (const file of files) {
    const text = (isGzip(file) ? gunzipSync(file) : file).toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as AmplitudeEvent);
      } catch {
        // A torn line is one event, not a reason to lose the day. It shows up as the
        // gap between Amplitude's own count and ours.
      }
    }
  }
  return out;
}

function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * The files in a zip archive, read through its central directory — the only place the
 * sizes are reliable when an entry was streamed with a data descriptor. Stored and
 * deflated entries are all a zip writer produces for this, and Amplitude caps an export
 * at 4 GB, so there is no Zip64 to handle.
 */
function unzip(buf: Buffer): Buffer[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Amplitude's export is not a readable zip archive");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Buffer[] = [];
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Amplitude's export has a damaged zip directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.push(data);
    else if (method === 8) out.push(inflateRawSync(data));
    else throw new Error(`Amplitude's export uses zip compression method ${method}, which the importer does not read`);
  }
  return out;
}

// ---------- mapping ----------

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/** Amplitude writes the literal "EMPTY" where it has no value for an attribution field. */
function value(v: unknown): string {
  const s = str(v).trim();
  return s === "EMPTY" || s === "(none)" ? "" : s;
}

/**
 * Amplitude's `YYYY-MM-DD HH:MM:SS.ffffff`, always UTC. Microseconds are cut to the
 * milliseconds Fourier stores, and the result is ISO so nothing downstream guesses.
 */
export function parseAmplitudeTime(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(str(v));
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  return isNaN(new Date(iso).getTime()) ? null : iso;
}

/** The URL of the page an event happened on, and the parts of it Fourier keeps. */
function pageOf(props: Record<string, unknown>) {
  const url = value(props["[Amplitude] Page Location"]) || value(props["[Amplitude] Page URL"]);
  if (!url) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  return {
    url,
    path: value(props["[Amplitude] Page Path"]) || parsed?.pathname || "",
    search: parsed?.search ?? "",
    title: value(props["[Amplitude] Page Title"]),
    referrer: value(props.referrer),
    params: parsed?.searchParams ?? null,
  };
}

/** The keys the page view's own columns are filled from, dropped from its properties. */
const PAGE_KEYS = new Set([
  "[Amplitude] Page Location",
  "[Amplitude] Page URL",
  "[Amplitude] Page Path",
  "[Amplitude] Page Title",
  "[Amplitude] Page Domain",
  "referrer",
]);

const UTM = ["source", "medium", "campaign", "content", "term"] as const;

/**
 * UTMs the way the Fourier SDK records them: read off the page's query string, keyed
 * without the `utm_` prefix. Amplitude's copy on the event is the fallback, for a page
 * view whose URL it recorded without the query.
 */
function campaignOf(props: Record<string, unknown>, params: URLSearchParams | null): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of UTM) {
    const v = value(params?.get(`utm_${k}`)) || value(props[`utm_${k}`]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Amplitude groups are `{ type: value | value[] }`; a Fourier event belongs to one
 * company. The first value of the first type is the one kept — right for the common
 * case of a single account type, and stated here because it is a choice.
 */
function groupOf(groups: Record<string, unknown> | null | undefined): string {
  if (!groups) return "";
  for (const v of Object.values(groups)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first != null && str(first) !== "") return str(first);
  }
  return "";
}

let countryCodes: Map<string, string> | null = null;

/** A retired region code replaced by the one that succeeded it (UK → GB), per CLDR. */
function canonicalRegion(code: string): string {
  try {
    return Intl.getCanonicalLocales(`und-${code}`)[0].split("-")[1] ?? code;
  } catch {
    return code;
  }
}

function countryKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\.?\s/g, "saint ")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** Names Amplitude uses that the English region names from ICU spell differently. */
const COUNTRY_ALIASES: Record<string, string> = {
  "Czech Republic": "CZ",
  "Hong Kong": "HK",
  Macau: "MO",
  Macao: "MO",
  "Macao SAR China": "MO",
  Turkey: "TR",
  "Ivory Coast": "CI",
  "Cote d'Ivoire": "CI",
  Macedonia: "MK",
  "Republic of Korea": "KR",
  "Korea, Republic of": "KR",
  Myanmar: "MM",
  Burma: "MM",
  Palestine: "PS",
  Swaziland: "SZ",
  Congo: "CG",
  "Republic of the Congo": "CG",
  "Democratic Republic of the Congo": "CD",
  "DR Congo": "CD",
  "United States of America": "US",
  USA: "US",
  UK: "GB",
  "Great Britain": "GB",
  "The Netherlands": "NL",
  "Vatican City": "VA",
};

/**
 * Amplitude stores a country's English name; Fourier stores its ISO 3166-1 code, which
 * is what the location reports and flags read. Built once from ICU's own names, so
 * every country Node knows maps without a hand-kept table. A name that still does not
 * match is left out rather than guessed; the original stays on the event's context.
 */
export function countryCode(name: unknown): string {
  const raw = value(name);
  if (!raw) return "";
  if (/^[A-Za-z]{2}$/.test(raw)) return canonicalRegion(raw.toUpperCase());
  if (!countryCodes) {
    countryCodes = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        // ICU still names retired codes (UK, BU, YU, ZR…) after the country that replaced
        // them, and "UK" sorts after "GB": without this, the retired one would win.
        if (canonicalRegion(code) !== code) continue;
        let label: string | undefined;
        try {
          label = names.of(code);
        } catch {
          label = undefined;
        }
        if (label && label !== code) countryCodes.set(countryKey(label), code);
      }
    }
    for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) countryCodes.set(countryKey(alias), code);
  }
  return countryCodes.get(countryKey(raw)) ?? "";
}

export interface AmplitudeMapOptions {
  /** Skip AMPLITUDE_INSTRUMENTATION. Defaults to true. */
  skipInstrumentation?: boolean;
}

export type AmplitudeMapped = { message: IncomingMessage } | { skipped: string };

/**
 * One Amplitude event as the analytics.js message the Fourier SDK would have sent.
 * Returns why it was left out instead, when it was.
 */
export function mapAmplitudeEvent(e: AmplitudeEvent, opts: AmplitudeMapOptions = {}): AmplitudeMapped {
  const name = str(e.event_type);
  const uuid = str(e.uuid ?? e.$insert_id);
  const timestamp = parseAmplitudeTime(e.event_time ?? e.client_event_time);
  const device = str(e.device_id);
  const userId = str(e.user_id);

  if (!name || !uuid || !timestamp) return { skipped: "Unreadable" };
  if (!device && !userId) return { skipped: "No user or device" };
  if (AMPLITUDE_SESSION_MARKERS.includes(name)) return { skipped: name };
  if ((opts.skipInstrumentation ?? true) && AMPLITUDE_INSTRUMENTATION.includes(name)) return { skipped: name };
  // Group traits arrive keyed by group type and value; Fourier's companies have no type
  // to file them under yet. Counted so their absence is visible rather than silent.
  if (name === "$groupidentify") return { skipped: name };
  // Traits belong to a user id. An anonymous $identify is Amplitude recording campaign
  // properties on a device, which the page views already carry.
  if (name === "$identify" && !userId) return { skipped: "Anonymous $identify" };

  const props = { ...(e.event_properties ?? {}) };
  const page = pageOf(props);
  const campaign = campaignOf(props, page?.params ?? null);

  const sessionMs = Number(e.session_id);
  const clientTime = parseAmplitudeTime(e.client_event_time);
  const session =
    sessionMs > 0
      ? {
          id: `amp:${device || userId}:${sessionMs}`,
          // Amplitude's session id is the time of the session's first event on the
          // client's clock, so the event recorded at that instant is where the visit
          // began — what the SDK marks isNew, and what makes it an arrival.
          isNew: clientTime !== null && Math.abs(Date.parse(clientTime) - sessionMs) < 1000,
        }
      : undefined;
  const groupId = groupOf(e.groups);

  const code = countryCode(e.country);
  const context: Record<string, unknown> = {
    library: { name: AMPLITUDE_LIBRARY, version: str(e.library) },
    ...(page && { page: { url: page.url, path: page.path, search: page.search, title: page.title, referrer: page.referrer } }),
    ...(campaign && { campaign }),
    ...(session && { session }),
    ...(e.ip_address && { ip: str(e.ip_address) }),
    ...(code && {
      geo: {
        country: code,
        city: value(e.city),
        latitude: e.location_lat ?? undefined,
        longitude: e.location_lng ?? undefined,
      },
    }),
    os: { name: str(e.os_name), version: str(e.os_version) },
    device: { type: str(e.device_type), model: str(e.device_family) },
    // What Amplitude said that has no Fourier column: full region and country names (the
    // columns take ISO codes), its own ids, and its language, which is a name like
    // "English" rather than the locale the column expects.
    amplitude: {
      amplitude_id: e.amplitude_id ?? null,
      device_id: device || null,
      session_id: sessionMs > 0 ? sessionMs : null,
      country: e.country ?? null,
      region: e.region ?? null,
      dma: e.dma ?? null,
      language: e.language ?? null,
      platform: e.platform ?? null,
      version_name: e.version_name ?? null,
    },
  };

  const base = {
    messageId: `amp:${uuid}`,
    timestamp,
    ...(device && { anonymousId: `amp:${device}` }),
    ...(userId && { userId }),
    ...(groupId && { groupId }),
    context,
  };

  if (name === "$identify") {
    return { message: { ...base, type: "identify", traits: { ...(e.user_properties ?? {}) } } };
  }

  if (name === PAGE_VIEW && page) {
    const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !PAGE_KEYS.has(k)));
    return {
      message: {
        ...base,
        type: "page",
        properties: { url: page.url, path: page.path, search: page.search, title: page.title, referrer: page.referrer, ...rest },
      },
    };
  }

  return { message: { ...base, type: "track", event: name, properties: props } };
}

export interface AmplitudeMapResult {
  messages: IncomingMessage[];
  /** Left out, by reason — an event name for the ones skipped on purpose. */
  skipped: Record<string, number>;
}

export function mapAmplitudeEvents(events: AmplitudeEvent[], opts: AmplitudeMapOptions = {}): AmplitudeMapResult {
  const messages: IncomingMessage[] = [];
  const skipped: Record<string, number> = {};
  for (const e of events) {
    const m = mapAmplitudeEvent(e, opts);
    if ("message" in m) messages.push(m.message);
    else skipped[m.skipped] = (skipped[m.skipped] ?? 0) + 1;
  }
  return { messages, skipped };
}

// ---------- writing ----------

/** The largest batch the ingest endpoints accept, and so the size ingest() is proven at. */
const CHUNK = 1000;

export interface AmplitudeImportOptions {
  credentials: AmplitudeCredentials;
  /** A UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Which of the project's sources the events are filed under. */
  sourceId: string;
  skipInstrumentation?: boolean;
  environment?: Environment;
  fetchImpl?: typeof fetch;
}

export interface AmplitudeImportResult {
  day: string;
  /** Events in Amplitude's export for the day. */
  fetched: number;
  imported: number;
  /** Already in the environment from an earlier run, and left alone. */
  existing: number;
  skipped: Record<string, number>;
  /** Refused by ingest itself. Should always be zero; reported so it can be seen if not. */
  rejected: number;
}

/**
 * Import one UTC day. A day is the unit because it is what one request to Amplitude and
 * one request to this server can each finish comfortably, and running a day twice is
 * harmless: every event already stored is skipped before anything is written.
 */
export async function importAmplitudeDay(project: Project, opts: AmplitudeImportOptions): Promise<AmplitudeImportResult> {
  const environment = opts.environment ?? IMPORT_ENVIRONMENT;
  if (environment !== IMPORT_ENVIRONMENT) {
    throw new Error(`Imports can only write to the ${IMPORT_ENVIRONMENT} environment for now`);
  }
  const day = parseDay(opts.day);
  if (!day) throw new Error(`Not a day: ${String(opts.day)}. Expected YYYY-MM-DD.`);

  const events = await fetchAmplitudeDay(opts.credentials, day, opts.fetchImpl);
  const { messages, skipped } = mapAmplitudeEvents(events, { skipInstrumentation: opts.skipInstrumentation });

  const existingIds = await storedImportIds(environment, project.id, messages);
  const fresh = messages.filter((m) => !existingIds.has(m.messageId!));

  let imported = 0;
  let rejected = 0;
  const receivedAt = new Date();
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const r = await ingest(project, fresh.slice(i, i + CHUNK), { sourceId: opts.sourceId, receivedAt }, environment);
    imported += r.accepted;
    rejected += r.rejected;
  }
  return { day, fetched: events.length, imported, existing: messages.length - fresh.length, skipped, rejected };
}

/**
 * Imported ids already stored across the span these messages cover. Asked by time range
 * and prefix rather than by listing the ids: a day can hold tens of thousands, and query
 * parameters travel in the URL.
 */
async function storedImportIds(environment: Environment, projectId: string, messages: IncomingMessage[]): Promise<Set<string>> {
  if (messages.length === 0) return new Set();
  let min = Infinity;
  let max = -Infinity;
  for (const m of messages) {
    const t = new Date(String(m.timestamp)).getTime();
    if (t < min) min = t;
    if (t > max) max = t;
  }
  // ISO with its Z, parsed by ClickHouse, as queries.ts does: a DateTime64 parameter
  // without a zone is read in the server's timezone, which is rarely UTC on a laptop.
  const res = await getDataClient(environment).query({
    query: `SELECT DISTINCT message_id FROM events
            WHERE project_id = {p:String}
              AND timestamp >= parseDateTime64BestEffort({from:String}, 3)
              AND timestamp <= parseDateTime64BestEffort({to:String}, 3)
              AND startsWith(message_id, 'amp:')`,
    query_params: { p: projectId, from: new Date(min).toISOString(), to: new Date(max).toISOString() },
    format: "JSONEachRow",
  });
  return new Set(((await res.json()) as { message_id: string }[]).map((r) => r.message_id));
}

export interface ImportEnvironmentStatus {
  environment: Environment;
  events: number;
  /** Of those, rows the Amplitude import wrote. */
  imported: number;
  first: string | null;
  last: string | null;
}

/** What the import environment holds for a project, so the dashboard can say. */
export async function importStatus(projectId: string, environment: Environment = IMPORT_ENVIRONMENT): Promise<ImportEnvironmentStatus> {
  const res = await getDataClient(environment).query({
    query: `SELECT count() AS events, countIf(library_name = {lib:String}) AS imported, min(timestamp) AS first, max(timestamp) AS last
            FROM events WHERE project_id = {p:String}`,
    query_params: { p: projectId, lib: AMPLITUDE_LIBRARY },
    format: "JSONEachRow",
  });
  const [row] = (await res.json()) as { events: string | number; imported: string | number; first: string; last: string }[];
  const events = Number(row?.events ?? 0);
  return {
    environment,
    events,
    imported: Number(row?.imported ?? 0),
    first: events > 0 ? row.first : null,
    last: events > 0 ? row.last : null,
  };
}

/**
 * Empty the import environment: every table in its database, for every project.
 *
 * Truncated rather than deleted by project, because a rollup cannot be deleted from by
 * project cleanly and a half-emptied environment is worse than a full one. The views are
 * left alone — they hold no rows — and so is `_migrations`, so the schema is not rebuilt.
 * The table list is read from ClickHouse, so a table added later is emptied too.
 */
export async function emptyImportEnvironment(environment: Environment = IMPORT_ENVIRONMENT): Promise<{ tables: string[] }> {
  if (environment !== IMPORT_ENVIRONMENT) throw new Error(`Only the ${IMPORT_ENVIRONMENT} environment can be emptied`);
  const client = getDataClient(environment);
  const res = await client.query({
    query: `SELECT name FROM system.tables
            WHERE database = {db:String} AND engine NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView') AND name != '_migrations'`,
    query_params: { db: configFor(environment).database },
    format: "JSONEachRow",
  });
  const tables = ((await res.json()) as { name: string }[]).map((r) => r.name);
  for (const t of tables) {
    await client.command({ query: `TRUNCATE TABLE IF EXISTS \`${t.replace(/`/g, "``")}\``, clickhouse_settings: { wait_end_of_query: 1 } });
  }
  return { tables };
}
