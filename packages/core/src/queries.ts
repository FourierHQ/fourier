import { getDataClient } from "./client";
import type { Scope } from "./environments";
import { assertReadOnlySql } from "./sql-guard";

type Row = Record<string, unknown>;

const CH_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?$/;

/** ClickHouse returns DateTime64 as "YYYY-MM-DD HH:MM:SS.mmm" in UTC; hand out ISO 8601. */
export function chDateToIso(v: unknown): unknown {
  return typeof v === "string" && CH_DATETIME.test(v) ? v.replace(" ", "T") + "Z" : v;
}

async function q<T = Row>(scope: Scope, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await getDataClient(scope.environment).query({ query, query_params: params, format: "JSONEachRow" });
  const rows = (await res.json()) as Row[];
  for (const r of rows) for (const k in r) r[k] = chDateToIso(r[k]);
  return rows as T[];
}

function parseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------- hidden events ----------
//
// An operator can tell Fourier that certain events are instrumentation rather than
// activity — $page_leave by default — and those names then leave every count, ranking,
// chart and listing below. Two mechanisms, because the data arrives two ways:
//
//  - Anything read from `events` / `events_resolved` simply adds a predicate.
//  - Anything read from a rollup (person_stats, group_stats, group_members,
//    person_sources) cannot: those tables have already summed across event names. Their
//    totals are corrected by subtracting the same rows out of `actor_event_stats`,
//    which is the identical count split by event.
//
// When nothing is hidden every query below is exactly the query it was before: the
// predicate is dropped and the subtraction join is never built.

/** Whether this scope excludes anything at all. Guards every branch below. */
function hasHidden(scope: Scope): boolean {
  return scope.hiddenEvents.length > 0;
}

/**
 * `AND event NOT IN (...)`, ready to append to a WHERE list, or null when nothing is
 * hidden. The names travel as a query parameter — an event name is operator input and
 * never reaches the SQL text.
 */
function hiddenFilter(scope: Scope, params: Record<string, unknown>, col = "event"): string | null {
  if (!hasHidden(scope)) return null;
  params.hidden = scope.hiddenEvents;
  return `${col} NOT IN ({hidden:Array(String)})`;
}

/** Push the exclusion onto a WHERE list, if there is one. */
function excludeHidden(scope: Scope, where: string[], params: Record<string, unknown>, col = "event"): void {
  const sql = hiddenFilter(scope, params, col);
  if (sql) where.push(sql);
}

/**
 * Hidden-event counts per actor, pre-aggregated to exactly one row per key so that
 * joining it to a rollup can never multiply the amount subtracted. `by` names the
 * columns to group on; the total lands in `hidden`.
 */
function hiddenCountsSql(by: string, extraWhere = ""): string {
  return `SELECT ${by}, sum(count) AS hidden
          FROM actor_event_stats
          WHERE project_id = {p:String} AND event IN ({hidden:Array(String)}) ${extraWhere}
          GROUP BY ${by}`;
}

/** A count that has had its hidden events taken out, and can never read below zero. */
function minusHidden(total: string, hidden: string): string {
  return `if(${total} > ${hidden}, ${total} - ${hidden}, 0)`;
}

// ---------- identity resolution ----------
//
// Resolution lives in the schema (identity_map, events_resolved, person_stats,
// touches_resolved). Queries here only read those views.

/** Resolve an id the caller has (user id or anonymous id) to the person id. */
async function resolvePersonId(scope: Scope, id: string): Promise<string> {
  const rows = await q<Row>(scope, `SELECT to_id FROM identity_map WHERE project_id = {p:String} AND from_id = {id:String}`, { p: scope.projectId, id });
  const uid = rows[0]?.to_id;
  return typeof uid === "string" && uid !== "" ? uid : id;
}

/** All raw distinct_ids that belong to a person: their user id plus linked anonymous ids. */
async function personIds(scope: Scope, personId: string): Promise<string[]> {
  const rows = await q<Row>(scope, `SELECT from_id FROM identity_map WHERE project_id = {p:String} AND to_id = {u:String}`, { p: scope.projectId, u: personId });
  return [personId, ...rows.map((r) => String(r.from_id)).filter((a) => a !== personId)];
}

// ---------- overview ----------

export interface Overview {
  total_events: number;
  total_users: number;
  identified_users: number;
  total_groups: number;
  events_24h: number;
  users_24h: number;
  first_event_at: string | null;
  last_event_at: string | null;
}

export async function getOverview(scope: Scope): Promise<Overview> {
  const recentWhere = ["project_id = {p:String}", "timestamp > now64(3) - INTERVAL 1 DAY"];
  const recentParams: Record<string, unknown> = { p: scope.projectId };
  excludeHidden(scope, recentWhere, recentParams);

  // First and last are read per event name rather than per person, because "when did
  // anything happen here" has to be answerable about the events that still count. A
  // hidden event is the last thing most page views produce, so leaving it in would
  // make "Last event" report instrumentation the rest of the page refuses to show.
  const boundsWhere = ["project_id = {p:String}"];
  const boundsParams: Record<string, unknown> = { p: scope.projectId };
  excludeHidden(scope, boundsWhere, boundsParams);

  const [[totals], [recent], [groups], [bounds], [hidden]] = await Promise.all([
    q<Row>(scope, `SELECT
        sum(event_count) AS total_events,
        count() AS total_users,
        countIf(is_identified = 1) AS identified_users
      FROM person_stats WHERE project_id = {p:String}`,
      { p: scope.projectId },
    ),
    q<Row>(scope, `SELECT count() AS events_24h, uniq(person_id) AS users_24h
       FROM events_resolved WHERE ${recentWhere.join(" AND ")}`,
      recentParams,
    ),
    q<Row>(scope, `SELECT uniq(group_id) AS total_groups FROM group_stats WHERE project_id = {p:String}`, { p: scope.projectId }),
    q<Row>(scope, `SELECT min(first_seen) AS first_event_at, max(last_seen) AS last_event_at
       FROM event_stats_daily WHERE ${boundsWhere.join(" AND ")}`,
      boundsParams,
    ),
    // The total comes from person_stats, which only ever counted messages carrying a
    // distinct_id — so the subtraction is restricted the same way, or a hidden event
    // from a server-side call with no distinct_id would be taken off a total it was
    // never added to.
    hasHidden(scope)
      ? q<Row>(scope, `SELECT sum(count) AS hidden FROM actor_event_stats
           WHERE project_id = {p:String} AND event IN ({hidden:Array(String)}) AND distinct_id != ''`,
          { p: scope.projectId, hidden: scope.hiddenEvents },
        )
      : Promise.resolve([] as Row[]),
  ]);
  const totalEvents = Math.max(Number(totals?.total_events ?? 0) - Number(hidden?.hidden ?? 0), 0);
  return {
    total_events: totalEvents,
    total_users: Number(totals?.total_users ?? 0),
    identified_users: Number(totals?.identified_users ?? 0),
    total_groups: Number(groups?.total_groups ?? 0),
    events_24h: Number(recent?.events_24h ?? 0),
    users_24h: Number(recent?.users_24h ?? 0),
    first_event_at: totalEvents ? ((bounds?.first_event_at as string) ?? null) : null,
    last_event_at: totalEvents ? ((bounds?.last_event_at as string) ?? null) : null,
  };
}

// ---------- events ----------

export interface EventRecord {
  message_id: string;
  source_id: string;
  /** Resolved person: user_id, or the user an anonymous id later identified as, else the anonymous id. */
  person_id: string;
  type: string;
  event: string;
  name: string;
  distinct_id: string;
  anonymous_id: string;
  user_id: string;
  group_id: string;
  timestamp: string;
  received_at: string;
  properties: Record<string, unknown>;
  traits: Record<string, unknown>;
  context: Record<string, unknown>;
  url: string;
  path: string;
  referrer: string;
  title: string;
  user_agent: string;
  locale: string;
  library_name: string;
  /** Where this message came from, resolved at ingest. '' when nothing could resolve it. */
  country: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface EventsFilter {
  event?: string;
  sourceId?: string;
  type?: string;
  distinctId?: string;
  userId?: string;
  groupId?: string;
  /** ISO timestamp, events strictly before this (cursor) */
  before?: string;
  after?: string;
  search?: string;
  limit?: number;
}

export async function listEvents(scope: Scope, f: EventsFilter = {}): Promise<EventRecord[]> {
  const where = ["project_id = {p:String}"];
  const params: Record<string, unknown> = { p: scope.projectId, limit: Math.min(Math.max(f.limit ?? 50, 1), 1000) };
  // Asking for a hidden event by name still returns nothing: the feed, the chart and
  // the totals have to agree, and a deep link to an event that is hidden is a link to
  // something this project has said it does not count.
  excludeHidden(scope, where, params);
  if (f.event) {
    where.push("event = {event:String}");
    params.event = f.event;
  }
  if (f.type) {
    where.push("type = {type:String}");
    params.type = f.type;
  }
  if (f.sourceId) {
    where.push("source_id = {src:String}");
    params.src = f.sourceId;
  }
  if (f.distinctId) {
    // everything this person did, under any of their ids
    where.push(`(person_id = {did:String} OR user_id = {did:String} OR anonymous_id = {did:String})`);
    params.did = f.distinctId;
  }
  if (f.userId) {
    where.push("user_id = {uid:String}");
    params.uid = f.userId;
  }
  if (f.groupId) {
    where.push("group_id = {gid:String}");
    params.gid = f.groupId;
  }
  if (f.before) {
    where.push("timestamp < parseDateTime64BestEffort({before:String}, 3)");
    params.before = f.before;
  }
  if (f.after) {
    where.push("timestamp > parseDateTime64BestEffort({after:String}, 3)");
    params.after = f.after;
  }
  if (f.search) {
    where.push("(positionCaseInsensitive(event, {s:String}) > 0 OR positionCaseInsensitive(properties, {s:String}) > 0 OR positionCaseInsensitive(distinct_id, {s:String}) > 0)");
    params.s = f.search;
  }
  const rows = await q<Row>(scope, `SELECT message_id, source_id, person_id, type, event, name, distinct_id, anonymous_id, user_id, group_id,
            timestamp, received_at, properties, traits, context, url, path, referrer, title, user_agent, locale, library_name,
            country, region, city, latitude, longitude
     FROM events_resolved
     WHERE ${where.join(" AND ")}
     ORDER BY timestamp DESC
     LIMIT {limit:UInt32}`,
    params,
  );
  return rows.map((r) => ({
    ...(r as unknown as EventRecord),
    properties: parseJson(r.properties),
    traits: parseJson(r.traits),
    context: parseJson(r.context),
    latitude: Number(r.latitude ?? 0),
    longitude: Number(r.longitude ?? 0),
  }));
}

export interface EventName {
  event: string;
  type: string;
  count: number;
  users: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Every event name, newest counts first. `includeHidden` is for the settings screen
 * alone — it is how an operator picks something to hide, and how they find their way
 * back to something they have already hidden. Nothing that reports numbers uses it.
 */
export async function listEventNames(scope: Scope, opts: { days?: number; sourceId?: string; includeHidden?: boolean } = {}): Promise<EventName[]> {
  const where = ["project_id = {p:String}"];
  const params: Record<string, unknown> = { p: scope.projectId };
  if (!opts.includeHidden) excludeHidden(scope, where, params);
  if (opts.sourceId) {
    where.push("source_id = {src:String}");
    params.src = opts.sourceId;
  }
  if (opts.days) {
    where.push("timestamp >= now64(3) - INTERVAL {days:UInt32} DAY");
    params.days = opts.days;
  }
  const rows = await q<Row>(scope, `SELECT event, any(type) AS type, count() AS count, uniq(person_id) AS users, min(timestamp) AS first_seen, max(timestamp) AS last_seen
     FROM events_resolved WHERE ${where.join(" AND ")}
     GROUP BY event ORDER BY count DESC`,
    params,
  );
  return rows.map((r) => ({ ...(r as unknown as EventName), count: Number(r.count), users: Number(r.users) }));
}

export interface TimeseriesPoint {
  bucket: string;
  count: number;
  users: number;
}

export async function eventTimeseries(
  scope: Scope,
  opts: { event?: string; interval?: "hour" | "day" | "week" | "month"; from?: string; to?: string; groupId?: string; sourceId?: string } = {},
): Promise<TimeseriesPoint[]> {
  const interval = opts.interval ?? "day";
  const fn = { hour: "toStartOfHour", day: "toStartOfDay", week: "toStartOfWeek", month: "toStartOfMonth" }[interval];
  const where = ["project_id = {p:String}", "type NOT IN ('identify','group','alias')"];
  const params: Record<string, unknown> = { p: scope.projectId };
  excludeHidden(scope, where, params);
  if (opts.event) {
    where.push("event = {event:String}");
    params.event = opts.event;
  }
  if (opts.groupId) {
    where.push("group_id = {gid:String}");
    params.gid = opts.groupId;
  }
  if (opts.sourceId) {
    where.push("source_id = {src:String}");
    params.src = opts.sourceId;
  }
  if (opts.from) {
    where.push("timestamp >= parseDateTime64BestEffort({from:String}, 3)");
    params.from = opts.from;
  } else {
    where.push(`timestamp >= now64(3) - INTERVAL ${interval === "hour" ? "2 DAY" : interval === "day" ? "30 DAY" : interval === "week" ? "26 WEEK" : "12 MONTH"}`);
  }
  if (opts.to) {
    where.push("timestamp < parseDateTime64BestEffort({to:String}, 3)");
    params.to = opts.to;
  }
  const rows = await q<Row>(scope, `SELECT ${fn}(timestamp) AS bucket, count() AS count, uniq(person_id) AS users
     FROM events_resolved WHERE ${where.join(" AND ")}
     GROUP BY bucket ORDER BY bucket`,
    params,
  );
  return rows.map((r) => ({ bucket: String(r.bucket), count: Number(r.count), users: Number(r.users) }));
}

export async function propertyKeys(scope: Scope, event: string): Promise<{ key: string; count: number }[]> {
  // A hidden event has no properties to offer: it is not selectable anywhere that
  // would lead here, and answering would be the one place its rows leaked back out.
  if (scope.hiddenEvents.includes(event)) return [];
  const rows = await q<Row>(scope, `SELECT key, count() AS count
     FROM events ARRAY JOIN JSONExtractKeys(properties) AS key
     WHERE project_id = {p:String} AND event = {e:String} AND timestamp > now64(3) - INTERVAL 30 DAY
     GROUP BY key ORDER BY count DESC LIMIT 100`,
    { p: scope.projectId, e: event },
  );
  return rows.map((r) => ({ key: String(r.key), count: Number(r.count) }));
}

/**
 * The values a property actually takes, so narrowing a goal to `plan = free` is a
 * choice from the data rather than a guess at the spelling.
 *
 * Read as strings whatever the property's JSON type is, because that is how
 * `propertyFilterSql` compares them — a number written as `2` in the payload has to
 * offer itself here as "2" or the filter it produces would match nothing. Empty values
 * are dropped: an event that carries the key with an empty string is indistinguishable
 * here from one that does not carry it at all, and `exists` is the operator for that
 * question.
 */
export async function propertyValues(scope: Scope, event: string, key: string, limit = 200): Promise<{ value: string; count: number }[]> {
  // Hidden for the same reason its keys are: an event left out of the reports does not
  // get to hand back its rows one property at a time.
  if (scope.hiddenEvents.includes(event)) return [];
  const rows = await q<Row>(scope, `SELECT JSONExtractString(properties, {k:String}) AS value, count() AS count
     FROM events
     WHERE project_id = {p:String} AND event = {e:String} AND timestamp > now64(3) - INTERVAL 30 DAY
       AND JSONHas(properties, {k:String}) AND JSONExtractString(properties, {k:String}) != ''
     GROUP BY value ORDER BY count DESC LIMIT {lim:UInt32}`,
    { p: scope.projectId, e: event, k: key, lim: Math.min(Math.max(limit, 1), 1000) },
  );
  return rows.map((r) => ({ value: String(r.value), count: Number(r.count) }));
}

// ---------- users ----------

export interface UserRecord {
  distinct_id: string;
  is_identified: boolean;
  first_seen: string;
  last_seen: string;
  event_count: number;
  group_id: string;
  traits: Record<string, unknown>;
  /** Where they were last seen. Events carrying no location are ignored, so one
   *  server-side call does not blank out a person who has been browsing all week. */
  country: string;
  city: string;
}

export interface UsersFilter {
  search?: string;
  /** Only people seen on this source (site / app). */
  sourceId?: string;
  identifiedOnly?: boolean;
  groupId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "last_seen" | "first_seen" | "event_count";
}

export async function listUsers(scope: Scope, f: UsersFilter = {}): Promise<UserRecord[]> {
  const params: Record<string, unknown> = {
    p: scope.projectId,
    limit: Math.min(Math.max(f.limit ?? 50, 1), 1000),
    offset: Math.max(f.offset ?? 0, 0),
  };
  const where: string[] = [];
  if (f.identifiedOnly) where.push("is_identified = 1");
  if (f.search) {
    where.push("(positionCaseInsensitive(distinct_id, {s:String}) > 0 OR positionCaseInsensitive(traits, {s:String}) > 0)");
    params.s = f.search;
  }
  if (f.groupId) {
    where.push("group_id = {gid:String}");
    params.gid = f.groupId;
  }
  if (f.sourceId) {
    where.push(`r.person_id IN (SELECT if(i.to_id != '', i.to_id, ps.distinct_id) FROM person_sources AS ps
      LEFT JOIN (SELECT from_id, to_id FROM identity_map WHERE project_id = {p:String}) AS i ON i.from_id = ps.distinct_id
      WHERE ps.project_id = {p:String} AND ps.source_id = {src:String})`);
    params.src = f.sourceId;
  }
  // Hidden events come off each person's total before the sort, not after it, or the
  // busiest-looking person on page one would be whoever fired the most of them.
  // person_stats is already one row per person, so the join cannot duplicate anything;
  // the hidden side is resolved through the same identity map so both agree on who is
  // who after a sign-in.
  let count = "r.event_count";
  let hiddenJoin = "";
  if (hasHidden(scope)) {
    params.hidden = scope.hiddenEvents;
    hiddenJoin = `LEFT JOIN (
       SELECT if(i.to_id != '', i.to_id, a.distinct_id) AS person_id, sum(a.count) AS hidden
       FROM actor_event_stats AS a
       LEFT JOIN identity_map AS i ON i.project_id = a.project_id AND i.from_id = a.distinct_id
       WHERE a.project_id = {p:String} AND a.event IN ({hidden:Array(String)})
       GROUP BY person_id
     ) AS h ON h.person_id = r.person_id`;
    count = minusHidden("r.event_count", "ifNull(h.hidden, 0)");
  }
  // Ordered by the expression rather than by its alias, so the sort is over the
  // corrected count without depending on how aliases and column names resolve.
  const order = { last_seen: "last_seen DESC", first_seen: "first_seen DESC", event_count: `${count} DESC` }[f.orderBy ?? "last_seen"];
  const rows = await q<Row>(scope, `SELECT r.person_id AS distinct_id, r.is_identified AS is_identified, r.first_seen AS first_seen, r.last_seen AS last_seen,
            ${count} AS event_count, r.group_id AS group_id, r.country AS country, r.city AS city, t.traits AS traits
     FROM (SELECT * FROM person_stats WHERE project_id = {p:String}) AS r
     LEFT JOIN (SELECT user_id, traits FROM user_traits FINAL WHERE project_id = {p:String}) AS t ON t.user_id = r.person_id
     ${hiddenJoin}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${order}
     LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    params,
  );
  return rows.map(mapUser);
}

function mapUser(r: Row): UserRecord {
  return {
    distinct_id: String(r.distinct_id),
    is_identified: Number(r.is_identified) === 1,
    first_seen: String(r.first_seen),
    last_seen: String(r.last_seen),
    event_count: Number(r.event_count),
    group_id: String(r.group_id ?? ""),
    traits: parseJson(r.traits),
    country: String(r.country ?? ""),
    city: String(r.city ?? ""),
  };
}

export interface SourceUsage {
  source_id: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
}

export interface UserDetail extends UserRecord {
  anonymous_ids: string[];
  /** Which sites / apps this person has been seen on. */
  sources: SourceUsage[];
  groups: { group_id: string; traits: Record<string, unknown> }[];
  top_events: { event: string; count: number }[];
}

/** Accepts a user id or an anonymous id; returns the resolved person with everything they did. */
export async function getUser(scope: Scope, distinctId: string): Promise<UserDetail | null> {
  const personId = await resolvePersonId(scope, distinctId);
  const ids = await personIds(scope, personId);
  const params: Record<string, unknown> = { p: scope.projectId, d: personId, ids };
  const topWhere = ["project_id = {p:String}", "distinct_id IN ({ids:Array(String)})", "type IN ('track','page','screen')"];
  excludeHidden(scope, topWhere, params);
  const [users, groups, top, sources, hidden] = await Promise.all([
    q<Row>(scope, `SELECT {d:String} AS distinct_id, max(s.is_identified) AS is_identified, min(s.first_seen) AS first_seen, max(s.last_seen) AS last_seen,
              sum(s.event_count) AS event_count, argMaxMerge(s.last_group_id) AS group_id,
              argMaxMerge(s.last_country) AS country, argMaxMerge(s.last_city) AS city, any(t.traits) AS traits
       FROM user_stats AS s
       LEFT JOIN (SELECT user_id, traits FROM user_traits FINAL WHERE project_id = {p:String} AND user_id = {d:String}) AS t ON t.user_id = {d:String}
       WHERE s.project_id = {p:String} AND s.distinct_id IN ({ids:Array(String)})`,
      params,
    ),
    q<Row>(scope, `SELECT m.group_id AS group_id, any(g.traits) AS traits
       FROM group_members AS m
       LEFT JOIN (SELECT group_id, traits FROM group_traits FINAL WHERE project_id = {p:String}) AS g ON g.group_id = m.group_id
       WHERE m.project_id = {p:String} AND m.distinct_id IN ({ids:Array(String)})
       GROUP BY m.group_id ORDER BY max(m.last_seen) DESC`,
      params,
    ),
    q<Row>(scope, `SELECT event, count() AS count FROM events
       WHERE ${topWhere.join(" AND ")}
       GROUP BY event ORDER BY count DESC LIMIT 10`,
      params,
    ),
    q<Row>(scope, `SELECT source_id, min(first_seen) AS first_seen, max(last_seen) AS last_seen, sum(event_count) AS event_count
       FROM person_sources WHERE project_id = {p:String} AND distinct_id IN ({ids:Array(String)})
       GROUP BY source_id ORDER BY first_seen`,
      params,
    ),
    // This person's hidden events, per source, so both their total and the per-source
    // breakdown below it come down by the same amount and still add up.
    hasHidden(scope)
      ? q<Row>(scope, hiddenCountsSql("source_id", "AND distinct_id IN ({ids:Array(String)})"), { p: scope.projectId, ids, hidden: scope.hiddenEvents })
      : Promise.resolve([] as Row[]),
  ]);
  // Existence is judged on the raw total: someone whose every event is hidden is still
  // a person Fourier has seen, and their page should open and say zero rather than 404.
  if (!users[0] || Number(users[0].event_count) === 0) return null;
  const hiddenBySource = new Map(hidden.map((r) => [String(r.source_id), Number(r.hidden ?? 0)]));
  const hiddenTotal = [...hiddenBySource.values()].reduce((a, b) => a + b, 0);
  const user = mapUser(users[0]);
  user.event_count = Math.max(user.event_count - hiddenTotal, 0);
  // A person with a linked user id counts as identified even if only anonymous rows exist yet.
  if (ids.length > 1) user.is_identified = true;
  return {
    ...user,
    anonymous_ids: ids.slice(1),
    sources: sources.map((r) => ({
      source_id: String(r.source_id),
      first_seen: String(r.first_seen),
      last_seen: String(r.last_seen),
      event_count: Math.max(Number(r.event_count) - (hiddenBySource.get(String(r.source_id)) ?? 0), 0),
    })),
    groups: groups.map((r) => ({ group_id: String(r.group_id), traits: parseJson(r.traits) })),
    top_events: top.map((r) => ({ event: String(r.event), count: Number(r.count) })),
  };
}

// ---------- groups (companies) ----------

export interface GroupRecord {
  group_id: string;
  traits: Record<string, unknown>;
  first_seen: string;
  last_seen: string;
  event_count: number;
  user_count: number;
}

export async function listGroups(scope: Scope, f: { search?: string; limit?: number; offset?: number; orderBy?: "last_seen" | "event_count" | "user_count" } = {}): Promise<GroupRecord[]> {
  const params: Record<string, unknown> = {
    p: scope.projectId,
    limit: Math.min(Math.max(f.limit ?? 50, 1), 1000),
    offset: Math.max(f.offset ?? 0, 0),
  };
  const having: string[] = [];
  if (f.search) {
    having.push("(positionCaseInsensitive(group_id, {s:String}) > 0 OR positionCaseInsensitive(traits, {s:String}) > 0)");
    params.s = f.search;
  }
  // group_stats is an aggregating table, so a company can still be several unmerged
  // rows and `sum` is what adds them up. The hidden side is already one row per
  // company and repeats across those rows, so it is taken with `max`, not summed —
  // summing it would subtract the same events once per part.
  let count = "sum(s.event_count)";
  let hiddenJoin = "";
  if (hasHidden(scope)) {
    params.hidden = scope.hiddenEvents;
    hiddenJoin = `LEFT JOIN (${hiddenCountsSql("group_id", "AND group_id != ''")}) AS h ON h.group_id = g.group_id`;
    count = minusHidden("sum(s.event_count)", "max(ifNull(h.hidden, 0))");
  }
  const order = { last_seen: "last_seen DESC", event_count: `${count} DESC`, user_count: "user_count DESC" }[f.orderBy ?? "last_seen"];
  const rows = await q<Row>(scope, `SELECT g.group_id AS group_id, any(g.traits) AS traits,
            min(s.first_seen) AS first_seen, max(s.last_seen) AS last_seen,
            ${count} AS event_count, uniqMerge(s.users) AS user_count
     FROM (SELECT group_id, traits FROM group_traits FINAL WHERE project_id = {p:String}) AS g
     LEFT JOIN group_stats AS s ON s.group_id = g.group_id AND s.project_id = {p:String}
     ${hiddenJoin}
     GROUP BY g.group_id
     ${having.length ? `HAVING ${having.join(" AND ")}` : ""}
     ORDER BY ${order}
     LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    params,
  );
  return rows.map(mapGroup);
}

function mapGroup(r: Row): GroupRecord {
  return {
    group_id: String(r.group_id),
    traits: parseJson(r.traits),
    first_seen: String(r.first_seen),
    last_seen: String(r.last_seen),
    event_count: Number(r.event_count),
    user_count: Number(r.user_count),
  };
}

export interface GroupDetail extends GroupRecord {
  members: UserRecord[];
  /** Sites / apps the company's members use, with how many of them use each. */
  sources: (SourceUsage & { user_count: number })[];
  top_events: { event: string; count: number; users: number }[];
}

export async function getGroup(scope: Scope, groupId: string): Promise<GroupDetail | null> {
  const topWhere = ["project_id = {p:String}", "group_id = {g:String}", "type IN ('track','page','screen')"];
  const topParams: Record<string, unknown> = { p: scope.projectId, g: groupId };
  excludeHidden(scope, topWhere, topParams);
  const srcWhere = ["project_id = {p:String}", "group_id = {g:String}"];
  const srcParams: Record<string, unknown> = { p: scope.projectId, g: groupId };
  excludeHidden(scope, srcWhere, srcParams);
  const hiddenParams = { p: scope.projectId, g: groupId, hidden: scope.hiddenEvents };
  const [groups, members, top, sources, hiddenTotals, hiddenMembers] = await Promise.all([
    q<Row>(scope, `SELECT g.group_id AS group_id, any(g.traits) AS traits,
              min(s.first_seen) AS first_seen, max(s.last_seen) AS last_seen,
              sum(s.event_count) AS event_count, uniqMerge(s.users) AS user_count
       FROM (SELECT group_id, traits FROM group_traits FINAL WHERE project_id = {p:String} AND group_id = {g:String}) AS g
       LEFT JOIN group_stats AS s ON s.group_id = g.group_id AND s.project_id = {p:String}
       GROUP BY g.group_id`,
      { p: scope.projectId, g: groupId },
    ),
    q<Row>(scope, `SELECT
          if(i.to_id != '', i.to_id, m.distinct_id) AS distinct_id,
          max(if(i.to_id != '', 1, u.is_identified)) AS is_identified,
          min(m.first_seen) AS first_seen, max(m.last_seen) AS last_seen,
          sum(m.event_count) AS event_count, {g:String} AS group_id, any(t.traits) AS traits
       FROM group_members AS m
       LEFT JOIN (SELECT from_id, to_id FROM identity_map WHERE project_id = {p:String}) AS i ON i.from_id = m.distinct_id
       LEFT JOIN (SELECT distinct_id, max(is_identified) AS is_identified FROM user_stats WHERE project_id = {p:String} GROUP BY distinct_id) AS u ON u.distinct_id = m.distinct_id
       LEFT JOIN (SELECT user_id, traits FROM user_traits FINAL WHERE project_id = {p:String}) AS t ON t.user_id = if(i.to_id != '', i.to_id, m.distinct_id)
       WHERE m.project_id = {p:String} AND m.group_id = {g:String}
       GROUP BY distinct_id ORDER BY last_seen DESC LIMIT 500`,
      { p: scope.projectId, g: groupId },
    ),
    q<Row>(scope, `SELECT event, count() AS count, uniq(person_id) AS users FROM events_resolved
       WHERE ${topWhere.join(" AND ")}
       GROUP BY event ORDER BY count DESC LIMIT 20`,
      topParams,
    ),
    q<Row>(scope, `SELECT source_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen, count() AS event_count, uniq(person_id) AS user_count
       FROM events_resolved WHERE ${srcWhere.join(" AND ")}
       GROUP BY source_id ORDER BY first_seen`,
      srcParams,
    ),
    // The company's hidden events, and the same split per member. Two questions rather
    // than one sum of the other: the company total counts every event carrying this
    // group id, and a member total only counts those that also carried a distinct id.
    hasHidden(scope)
      ? q<Row>(scope, `SELECT sum(count) AS hidden FROM actor_event_stats
           WHERE project_id = {p:String} AND event IN ({hidden:Array(String)}) AND group_id = {g:String}`, hiddenParams)
      : Promise.resolve([] as Row[]),
    hasHidden(scope)
      ? q<Row>(scope, `SELECT if(i.to_id != '', i.to_id, a.distinct_id) AS distinct_id, sum(a.count) AS hidden
           FROM actor_event_stats AS a
           LEFT JOIN identity_map AS i ON i.project_id = a.project_id AND i.from_id = a.distinct_id
           WHERE a.project_id = {p:String} AND a.event IN ({hidden:Array(String)}) AND a.group_id = {g:String} AND a.distinct_id != ''
           GROUP BY distinct_id`, hiddenParams)
      : Promise.resolve([] as Row[]),
  ]);
  if (!groups[0]) return null;
  // Members are keyed by the person they resolve to, which is what the hidden counts
  // above were grouped by too, so a sign-in mid-visit cannot leave the subtraction
  // attached to the anonymous half of someone who is listed under their user id.
  const hiddenByMember = new Map(hiddenMembers.map((r) => [String(r.distinct_id), Number(r.hidden ?? 0)]));
  const group = mapGroup(groups[0]);
  group.event_count = Math.max(group.event_count - Number(hiddenTotals[0]?.hidden ?? 0), 0);
  return {
    ...group,
    members: members.map((r) => {
      const member = mapUser(r);
      member.event_count = Math.max(member.event_count - (hiddenByMember.get(member.distinct_id) ?? 0), 0);
      return member;
    }),
    sources: sources.map((r) => ({ source_id: String(r.source_id), first_seen: String(r.first_seen), last_seen: String(r.last_seen), event_count: Number(r.event_count), user_count: Number(r.user_count) })),
    top_events: top.map((r) => ({ event: String(r.event), count: Number(r.count), users: Number(r.users) })),
  };
}

// ---------- raw SQL (agents) ----------

export interface SqlResult {
  columns: { name: string; type: string }[];
  rows: Row[];
  row_count: number;
  elapsed_ms: number;
}

/**
 * Run read-only SQL. `{project_id}` in the query is replaced with the bound project.
 * Enforced by ClickHouse readonly=1 plus a keyword guard.
 */
export async function runSql(scope: Scope, sql: string, opts: { limit?: number } = {}): Promise<SqlResult> {
  const safe = assertReadOnlySql(sql).replace(/\{project_id\}/g, "{project_id:String}");
  const started = Date.now();
  const res = await getDataClient(scope.environment).query({
    query: safe,
    query_params: { project_id: scope.projectId },
    format: "JSONCompactEachRowWithNamesAndTypes",
    clickhouse_settings: {
      readonly: "1",
      max_result_rows: String(Math.min(opts.limit ?? 1000, 10_000)),
      result_overflow_mode: "break",
      max_execution_time: 30,
    },
  });
  const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown[]);
  const names = (lines[0] ?? []) as string[];
  const types = (lines[1] ?? []) as string[];
  const rows = lines.slice(2).map((vals) => Object.fromEntries(names.map((n, i) => [n, vals[i]])));
  return {
    columns: names.map((n, i) => ({ name: n, type: types[i] })),
    rows,
    row_count: rows.length,
    elapsed_ms: Date.now() - started,
  };
}


// ---------- attribution ----------

export interface TouchRecord {
  message_id: string;
  source_id: string;
  person_id: string;
  distinct_id: string;
  group_id: string;
  session_id: string;
  timestamp: string;
  kind: "campaign" | "referral" | "direct";
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  referrer: string;
  referrer_host: string;
  landing_url: string;
  landing_path: string;
}

const TOUCH_COLS = `message_id, source_id, person_id, distinct_id, group_id, session_id, timestamp, kind,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, referrer_host, landing_url, landing_path`;

export interface TouchesFilter {
  personId?: string;
  sourceId?: string;
  groupId?: string;
  kind?: TouchRecord["kind"];
  /** Drop 'direct' arrivals, the usual choice for last-touch. */
  excludeDirect?: boolean;
  before?: string;
  after?: string;
  limit?: number;
}

function touchWhere(scope: Scope, f: TouchesFilter) {
  const where = ["project_id = {p:String}"];
  const params: Record<string, unknown> = { p: scope.projectId, limit: Math.min(Math.max(f.limit ?? 100, 1), 1000) };
  if (f.personId) {
    where.push("person_id = {pid:String}");
    params.pid = f.personId;
  }
  if (f.groupId) {
    // every touch by anyone who belongs to the company, including their pre-signup arrivals
    where.push(`person_id IN (SELECT if(i.to_id != '', i.to_id, m.distinct_id) FROM group_members AS m
      LEFT JOIN (SELECT from_id, to_id FROM identity_map WHERE project_id = {p:String}) AS i ON i.from_id = m.distinct_id
      WHERE m.project_id = {p:String} AND m.group_id = {gid:String})`);
    params.gid = f.groupId;
  }
  if (f.kind) {
    where.push("kind = {kind:String}");
    params.kind = f.kind;
  }
  if (f.sourceId) {
    where.push("source_id = {src:String}");
    params.src = f.sourceId;
  }
  if (f.excludeDirect) where.push("kind != 'direct'");
  if (f.before) {
    where.push("timestamp < parseDateTime64BestEffort({before:String}, 3)");
    params.before = f.before;
  }
  if (f.after) {
    where.push("timestamp > parseDateTime64BestEffort({after:String}, 3)");
    params.after = f.after;
  }
  return { where: where.join(" AND "), params };
}

/**
 * What makes two rows the same arrival: one person, one session, landing with the same
 * attribution. Events other than the first carry the referrer of the page that loaded them,
 * so a single arrival can leave a row per event; older rows predate the ingest-side fix and
 * are still in the table. A session that genuinely changes attribution partway through — an
 * external link back in under a new campaign — keeps both, because the key covers the
 * campaign too. Sessionless rows (server-side messages) fall back to message_id, so they
 * never collapse into each other.
 */
const ARRIVAL_KEY = `person_id, if(session_id != '', session_id, message_id), kind,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host`;

/** Every recorded arrival, newest first, one row per arrival. */
export async function listTouches(scope: Scope, f: TouchesFilter = {}): Promise<TouchRecord[]> {
  const { where, params } = touchWhere(scope, f);
  // The earliest row of an arrival is the arrival: it holds the landing page that was actually
  // landed on, and the time it happened. message_id makes the sort key unique, so the pick is
  // defined rather than left to chance when two rows share a millisecond — belt and braces, since
  // no test can tell it apart from its absence: ClickHouse happens to order equal keys stably.
  return q<TouchRecord>(
    scope,
    `SELECT ${TOUCH_COLS} FROM (
       SELECT ${TOUCH_COLS} FROM touches_resolved
       WHERE ${where}
       ORDER BY timestamp ASC, message_id ASC
       LIMIT 1 BY ${ARRIVAL_KEY}
     )
     ORDER BY timestamp DESC LIMIT {limit:UInt32}`,
    params,
  );
}

export interface Attribution {
  first_touch: TouchRecord | null;
  /** Last non-direct touch when one exists, else the last touch. */
  last_touch: TouchRecord | null;
  touch_count: number;
  touches: TouchRecord[];
}

function pickAttribution(touches: TouchRecord[]): Attribution {
  // touches are newest first
  const chronological = [...touches].reverse();
  const first = chronological[0] ?? null;
  const lastNonDirect = touches.find((t) => t.kind !== "direct") ?? null;
  return { first_touch: first, last_touch: lastNonDirect ?? touches[0] ?? null, touch_count: touches.length, touches };
}

export async function personAttribution(scope: Scope, personId: string, limit = 100): Promise<Attribution> {
  return pickAttribution(await listTouches(scope, { personId, limit }));
}

export interface GroupAttribution extends Attribution {
  /** First touch per member, so you can see how each person in the company arrived. */
  by_member: { person_id: string; first_touch: TouchRecord }[];
}

export async function groupAttribution(scope: Scope, groupId: string, limit = 200): Promise<GroupAttribution> {
  const touches = await listTouches(scope, { groupId, limit });
  const firstByMember = new Map<string, TouchRecord>();
  for (const t of [...touches].reverse()) if (!firstByMember.has(t.person_id)) firstByMember.set(t.person_id, t);
  return {
    ...pickAttribution(touches),
    by_member: [...firstByMember].map(([person_id, first_touch]) => ({ person_id, first_touch })),
  };
}

export type AttributionDimension = "utm_source" | "utm_medium" | "utm_campaign" | "referrer_host" | "landing_path" | "kind" | "source_id";
export type AttributionModel = "first" | "last";

export interface AttributionRow {
  key: string;
  people: number;
  identified_people: number;
  companies: number;
}

/**
 * People (and their companies) grouped by the value of one touch dimension under a
 * first-touch or last-touch model. `last` ignores direct arrivals when the person has any other touch.
 */
export async function attributionReport(
  scope: Scope,
  opts: { model?: AttributionModel; by?: AttributionDimension; identifiedOnly?: boolean; groupId?: string; sourceId?: string; from?: string; to?: string; limit?: number } = {},
): Promise<AttributionRow[]> {
  const dims: AttributionDimension[] = ["utm_source", "utm_medium", "utm_campaign", "referrer_host", "landing_path", "kind", "source_id"];
  const by = dims.includes(opts.by ?? "utm_source") ? (opts.by ?? "utm_source") : "utm_source";
  const model = opts.model === "last" ? "last" : "first";
  const { where, params } = touchWhere(scope, { groupId: opts.groupId, sourceId: opts.sourceId, after: opts.from, before: opts.to });
  params.limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  // pick one touch per person, then group people by the dimension. No dedupe needed: argMin and
  // argMax over the repeated rows of one arrival return that arrival's value either way, and the
  // counts are over people, not touches.
  const col = by === "source_id" ? "if(source_id = '', 'default', source_id)" : by;
  const pick =
    model === "first"
      ? `argMin(${col}, timestamp)`
      : `if(countIf(kind != 'direct') > 0, argMaxIf(${col}, timestamp, kind != 'direct'), argMax(${col}, timestamp))`;
  const rows = await q<Row>(scope, `SELECT
        if(key = '', if({by:String} = 'kind', 'direct', '(none)'), key) AS key,
        count() AS people,
        countIf(is_identified = 1) AS identified_people,
        uniqIf(group_id, group_id != '') AS companies
     FROM (
       SELECT t.person_id AS person_id, ${pick} AS key, any(ps.is_identified) AS is_identified, any(ps.group_id) AS group_id
       FROM touches_resolved AS t
       LEFT JOIN (SELECT person_id, is_identified, group_id FROM person_stats WHERE project_id = {p:String}) AS ps ON ps.person_id = t.person_id
       WHERE ${where}
       GROUP BY t.person_id
     )
     ${opts.identifiedOnly ? "WHERE is_identified = 1" : ""}
     GROUP BY key ORDER BY people DESC LIMIT {limit:UInt32}`,
    { ...params, by },
  );
  return rows.map((r) => ({ key: String(r.key), people: Number(r.people), identified_people: Number(r.identified_people), companies: Number(r.companies) }));
}
