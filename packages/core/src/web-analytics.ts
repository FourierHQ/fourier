/**
 * Web Analytics: the four reports, and the single set of metric definitions they share.
 *
 * Everything here is counted off one base query — `sessionBase` below — which resolves
 * the selected period and its comparison, applies the reader's filters, attaches the
 * selected goal, and tags each session as new or returning. Every number on every page
 * comes out of that same subquery. That is not tidiness for its own sake: the brief's
 * hardest requirement is that the same goal produces the same converting-session count
 * wherever it appears, and the only durable way to get that is for there to be exactly
 * one place where "a converting session" is expressed.
 *
 * Three rules are enforced structurally rather than remembered:
 *
 *  - A session converts at most once, however many times the goal fires inside it.
 *    `max()` over the session's events, never `count()`.
 *  - Numerator and denominator share a cohort. A session belongs to a period by when
 *    it *started*; a conversion inside it counts for that period even if the clock
 *    passed midnight mid-visit. Mixing event dates with session dates is how a
 *    conversion rate ends up above 100%.
 *  - A rate with no denominator is unavailable, not zero. `rate` is null, and the
 *    numerator and denominator travel with it so the UI can say "12 of 480".
 */

import { getDataClient } from "./client";
import { browserSql, channelSql, deviceSql } from "./classify";
import {
  type Goal,
  type GoalConfig,
  type GoalSplit,
  type GoalType,
  type PageGroup,
  Params,
  matchSql,
  normalizedPath,
  pageGroupSql,
  leafGoals,
  primaryGoals,
} from "./definitions";
import type { Scope } from "./environments";
import { alignOffsetMs, bucketSql, chTime, type ResolvedRange } from "./periods";
import { PAGE_LEAVE } from "./schema";

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v ?? 0);

async function q<T = Row>(scope: Scope, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await getDataClient(scope.environment).query({ query, query_params: params, format: "JSONEachRow" });
  return (await res.json()) as T[];
}

/**
 * How far past the end of a period to keep reading events when deciding which sessions
 * converted. A visit is dated by when it started, so a goal completed twenty minutes
 * after midnight belongs to the session that began the evening before — and if the scan
 * stopped at the period boundary that session would be counted in the denominator and
 * missing from the numerator. Twelve hours is far longer than any real visit and costs
 * one extra partition at the edges.
 */
const SESSION_TAIL_MS = 12 * 60 * 60 * 1000;

/**
 * The events a report reads to decide which sessions converted: both periods, plus the
 * tail. A split goal lists its values from exactly this window, so every event that can
 * complete the rollup also completes one of the rows beneath it — list them from a
 * narrower window and a value seen only in the tail is counted by the rollup and by no
 * row, and "any conversion", which reads the rows, misses it.
 */
export function goalScanWindow(range: ResolvedRange): { from: Date; to: Date } {
  return { from: range.previous ? range.previous.from : range.current.from, to: new Date(range.current.to.getTime() + SESSION_TAIL_MS) };
}

/**
 * Ten measured foreground seconds makes a session engaged on its own. Mirrored in the
 * `engaged_base` column of sessions_resolved, which is where it is actually applied.
 */
export const ENGAGED_MS_THRESHOLD = 10_000;

// ---------- shared result shapes ----------

/**
 * A value against its comparison. `change` is fractional (0.12 = up 12%) and is null
 * whenever dividing would be a lie: comparison switched off, or nothing to divide by.
 * The two are told apart by `previous`, which is null only when comparison is off.
 */
export interface Delta {
  current: number;
  previous: number | null;
  change: number | null;
}

export function delta(current: number, previous: number | null): Delta {
  if (previous === null || previous === 0) return { current, previous, change: null };
  return { current, previous, change: (current - previous) / previous };
}

/**
 * A rate that always shows its working. `rate` is a percentage or null; a reader who
 * sees "2.5%" can always also see "12 of 480", which is the difference between a
 * number they can act on and one they have to take on faith.
 */
export interface RateValue {
  rate: number | null;
  numerator: number;
  denominator: number;
}

export function rate(numerator: number, denominator: number): RateValue {
  return { rate: denominator > 0 ? (numerator / denominator) * 100 : null, numerator, denominator };
}

/** A rate and the same rate last period, for the change column. */
export interface RateDelta extends RateValue {
  previous: RateValue | null;
  /** Difference in percentage points. Null when either side is unavailable. */
  change_pp: number | null;
}

export function rateDelta(cur: [number, number], prev: [number, number] | null): RateDelta {
  const c = rate(cur[0], cur[1]);
  if (!prev) return { ...c, previous: null, change_pp: null };
  const p = rate(prev[0], prev[1]);
  return { ...c, previous: p, change_pp: c.rate !== null && p.rate !== null ? c.rate - p.rate : null };
}

export interface SeriesPoint {
  bucket: string;
  value: number;
  /** The comparison period's value for the same relative position, shifted to align. */
  previous: number | null;
}

/**
 * Both traffic metrics over one set of buckets. They are counted together rather than
 * on demand because they come from the same scan: fetching one per toggle would make
 * switching between Visitors and Sessions a round trip, and would leave the headline
 * card for whichever metric is not selected with no sparkline to draw.
 */
export interface TrafficSeries {
  visitors: SeriesPoint[];
  sessions: SeriesPoint[];
}

// ---------- scope ----------

export interface WebFilters {
  /** Which source — website or app — to report on. Null is all of them. */
  sourceId?: string | null;
  channel?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  country?: string | null;
  device?: string | null;
  browser?: string | null;
  visitor?: "new" | "returning" | null;
  /** Off by default. Reports exclude automated traffic unless asked not to. */
  includeBots?: boolean;
}

export interface WebScope {
  scope: Scope;
  range: ResolvedRange;
  filters: WebFilters;
  /** The goal conversion metrics are counted against. Null when none is configured. */
  goal: Goal | null;
  /** Every configured goal, primary and supporting. Engagement reads all the primaries. */
  goals: Goal[];
  pageGroups: PageGroup[];
}

/**
 * Whether there is anything to count conversions against.
 *
 * This asks whether a primary goal has been *configured*, not whether the reader has
 * narrowed to one — they do not have to. When it is false, conversion components show a
 * setup prompt rather than a row of zeroes, because a zero is a claim that nobody
 * converted and an unconfigured site is in no position to make it.
 */
export function hasGoal(w: WebScope): boolean {
  return primaryGoals(w.goals).length > 0;
}

/** What the conversion columns are counting, for a label. Null when nothing is configured. */
export function countingLabel(w: WebScope): string | null {
  if (w.goal) return w.goal.name;
  return hasGoal(w) ? "All conversions" : null;
}

// ---------- the base query every report is counted from ----------

interface Base {
  /** A `WITH ... AS (...)` prelude ending in a comma-free list, ready to prefix a SELECT. */
  cte: string;
  params: Record<string, unknown>;
  /**
   * Placeholders already bound in `params`, so a report that needs to scan `events`
   * alongside the sessions reuses the same project and the same window rather than
   * rebuilding them and risking a different one.
   */
  project: string;
  scanFrom: string;
  scanTo: string;
}

/**
 * Builds the CTEs. `base` is one row per session in either period, carrying everything
 * the four reports group by, plus the three derived judgements: did it convert, was it
 * engaged, and is its visitor new.
 */
function sessionBase(w: WebScope): Base {
  const p = new Params("w");
  const { scope, range, filters } = w;

  // Every timestamp below is bound as DateTime64(3,'UTC'), never bare DateTime64(3).
  // `chTime` emits UTC by construction, but ClickHouse parses a timestamp with no zone
  // in the SERVER's timezone — so on any install whose ClickHouse is not set to UTC,
  // a bare parameter silently becomes a different instant and every period boundary
  // shifts by that offset. It renders back identically, which is what makes it hard to
  // see: the reports look plausible and are quietly measuring the wrong hours.

  const curFrom = `{${p.add(chTime(range.current.from))}:DateTime64(3,'UTC')}`;
  const curTo = `{${p.add(chTime(range.current.to))}:DateTime64(3,'UTC')}`;
  const prevFrom = range.previous ? `{${p.add(chTime(range.previous.from))}:DateTime64(3,'UTC')}` : null;
  const prevTo = range.previous ? `{${p.add(chTime(range.previous.to))}:DateTime64(3,'UTC')}` : null;
  const project = `{${p.add(scope.projectId)}:String}`;

  const window = prevFrom
    ? `((s.started_at >= ${curFrom} AND s.started_at < ${curTo}) OR (s.started_at >= ${prevFrom} AND s.started_at < ${prevTo}))`
    : `(s.started_at >= ${curFrom} AND s.started_at < ${curTo})`;

  // Goal evaluation covers both periods in one pass, plus the tail (see SESSION_TAIL_MS).
  const scanFrom = `{${p.add(chTime(range.previous ? range.previous.from : range.current.from))}:DateTime64(3,'UTC')}`;
  const scanTo = `{${p.add(chTime(new Date(range.current.to.getTime() + SESSION_TAIL_MS)))}:DateTime64(3,'UTC')}`;

  // Leaves, not rollups: a split's rollup is the union of its values, so leaving it out
  // changes nothing but the length of the predicate.
  const primaries = leafGoals(primaryGoals(w.goals));
  // Engagement's goal leg reads EVERY primary goal, never the selected one. Otherwise
  // switching which goal you are looking at would silently move the engagement rate.
  const anyPrimary = primaries.length ? primaries.map((g) => matchSql(g.config, p)).join(" OR ") : "0";
  const selected = conversionMatchSql(w, p);

  const filterParts: string[] = [`s.project_id = ${project}`, window];
  if (!filters.includeBots) filterParts.push("s.is_bot = 0");
  const eq = (col: string, value: string | null | undefined) => {
    if (value === undefined || value === null || value === "") return;
    filterParts.push(`${col} = {${p.add(value)}:String}`);
  };
  eq("s.source_id", filters.sourceId);
  eq("s.channel", filters.channel);
  eq("s.utm_source", filters.utmSource);
  eq("s.utm_medium", filters.utmMedium);
  eq("s.utm_campaign", filters.utmCampaign);
  eq("s.country", filters.country);
  eq(deviceSql("s.user_agent"), filters.device);
  eq(browserSql("s.user_agent"), filters.browser);

  // First-seen is read over ALL history and is deliberately not subject to the report's
  // filters: someone who first arrived from an ad in March is a returning visitor in
  // September whatever this report is filtered to. Scoped to the selected source when there
  // is one, because "new to this site" is the question being asked.
  const firstSeenFilter = filters.sourceId ? `AND ps.source_id = {${p.add(filters.sourceId)}:String}` : "";

  // A session's visitor is new if they were first seen inside the period that session
  // belongs to — so the comparison period classifies against its own start, and the
  // change in returning share compares like with like.
  const newCutoff = prevFrom ? `if(s.started_at >= ${curFrom}, ${curFrom}, ${prevFrom})` : curFrom;

  const visitorFilter =
    filters.visitor === "new" ? "AND is_new = 1" : filters.visitor === "returning" ? "AND is_new = 0" : "";

  const cte = `WITH
  first_seen AS (
    SELECT if(im.to_id != '', im.to_id, ps.distinct_id) AS person_id, min(ps.first_seen) AS first_seen
    FROM person_sources AS ps
    LEFT JOIN identity_map AS im ON im.project_id = ps.project_id AND im.from_id = ps.distinct_id
    WHERE ps.project_id = ${project} ${firstSeenFilter}
    GROUP BY person_id
  ),
  goal_hits AS (
    SELECT
      session_id,
      max(${selected}) AS converted,
      max(${anyPrimary}) AS converted_any
    FROM events
    WHERE project_id = ${project}
      AND session_id != ''
      AND timestamp >= ${scanFrom}
      AND timestamp < ${scanTo}
    GROUP BY session_id
  ),
  base AS (
    SELECT
      s.session_id AS session_id,
      s.person_id AS person_id,
      s.source_id AS source_id,
      s.started_at AS started_at,
      s.ended_at AS ended_at,
      s.pageviews AS pageviews,
      s.events AS events,
      s.engaged_ms AS engaged_ms,
      s.identified AS identified,
      ${normalizedPath("s.entry_path")} AS entry_path,
      ${normalizedPath("s.exit_path")} AS exit_path,
      s.entry_title AS entry_title,
      s.channel AS channel,
      s.utm_source AS utm_source,
      s.utm_medium AS utm_medium,
      s.utm_campaign AS utm_campaign,
      s.referrer_host AS referrer_host,
      s.country AS country,
      ${deviceSql("s.user_agent")} AS device,
      ${browserSql("s.user_agent")} AS browser,
      if(s.started_at >= ${curFrom}, 'current', 'previous') AS period,
      toUInt8(ifNull(fs.first_seen, s.started_at) >= ${newCutoff}) AS is_new,
      toUInt8(ifNull(g.converted, 0)) AS converted,
      toUInt8(s.engaged_base = 1 OR ifNull(g.converted_any, 0) = 1) AS engaged
    FROM sessions_resolved AS s
    LEFT JOIN goal_hits AS g ON g.session_id = s.session_id
    LEFT JOIN first_seen AS fs ON fs.person_id = s.person_id
    WHERE ${filterParts.join(" AND ")}
  ),
  scoped AS (SELECT * FROM base WHERE 1 = 1 ${visitorFilter})`;

  return { cte, params: p.values, project, scanFrom, scanTo };
}

/**
 * Every bucket in the selected period, whether or not anything happened in one.
 *
 * A `GROUP BY bucket` only emits the buckets that had rows, which is the right answer
 * to the question SQL was asked and the wrong shape for a chart. Two conversions a week
 * apart come back as two points, and a line chart joins them — drawing a flat line at 1
 * across five days on which nothing happened, and asserting five conversions that do not
 * exist. The fix is a dense left-hand side, so a bucket with nothing in it arrives as a
 * zero and says so.
 *
 * The bucket list is generated by walking the period an hour at a time and applying the
 * *same* `bucketSql` the series itself uses, rather than stepping by the interval. That
 * is not indirection for its own sake: local midnights are 23 or 25 hours apart across a
 * DST boundary, so a fixed one-day step drifts an hour and produces bucket keys that
 * join against nothing. Stepping by hour and bucketing makes the two sides identical by
 * construction. A year of hours is ~8,800 rows, which ClickHouse does not notice.
 *
 * Capped at now, so a chart of today shows the hours that have happened rather than a
 * row of zeroes stretching to midnight.
 */
function denseBuckets(w: WebScope, p: Params): string {
  const from = `{${p.add(chTime(w.range.current.from))}:DateTime64(3,'UTC')}`;
  const to = `{${p.add(chTime(w.range.current.to))}:DateTime64(3,'UTC')}`;
  return `buckets AS (
     SELECT DISTINCT ${bucketSql("t", w.range.interval, w.range.timezone)} AS bucket
     FROM (
       SELECT ${from} + toIntervalHour(number) AS t
       FROM numbers(toUInt64(dateDiff('hour', ${from}, ${to})) + 1)
     )
     WHERE t < ${to} AND t <= now64(3)
   )`;
}

/**
 * What counts as a conversion, as a predicate over one event row.
 *
 * With no goal named it is any primary goal — counted as distinct sessions downstream,
 * so a visit that signs up AND books a demo is one converting session and not two.
 * Summing the goals would produce a total larger than the visits it came from.
 *
 * Shared with the reports that have to find the conversion event itself rather than
 * just flag the session, so "where did it happen" can never drift from "did it happen".
 */
export function conversionMatchSql(w: WebScope, p: Params): string {
  if (w.goal) return matchSql(w.goal.config, p);
  const primaries = leafGoals(primaryGoals(w.goals));
  return primaries.length ? primaries.map((g) => matchSql(g.config, p)).join(" OR ") : "0";
}

/** Standard per-period aggregate columns, so every report counts them identically. */
const AGG = {
  sessions: `uniqExactIf(session_id, period = 'current')`,
  prevSessions: `uniqExactIf(session_id, period = 'previous')`,
  visitors: `uniqExactIf(person_id, period = 'current')`,
  prevVisitors: `uniqExactIf(person_id, period = 'previous')`,
  converting: `uniqExactIf(session_id, period = 'current' AND converted = 1)`,
  prevConverting: `uniqExactIf(session_id, period = 'previous' AND converted = 1)`,
  engagedSessions: `uniqExactIf(session_id, period = 'current' AND engaged = 1)`,
  prevEngagedSessions: `uniqExactIf(session_id, period = 'previous' AND engaged = 1)`,
};

/**
 * The same aggregate, bound to the left-hand table.
 *
 * goalSummary and supportingActions join `scoped` against a per-session flag table, and
 * both sides carry session_id. An unqualified reference is ambiguous: ClickHouse happens
 * to resolve it leftwards today, but if that ever changed the unmatched rows of a LEFT
 * JOIN would contribute an empty id, the denominator would collapse to roughly the
 * numerator, and conversion rates would climb towards 100% without anything erroring.
 */
const qualified = (agg: string) => agg.replace(/\b(session_id|person_id|period)\b/g, "s.$1");

const hasPrev = (w: WebScope) => w.range.previous !== null;
const prevOr = <T>(w: WebScope, v: T): T | null => (hasPrev(w) ? v : null);

// ---------- headline metrics ----------

export interface Headline {
  visitors: Delta;
  sessions: Delta;
  converting_sessions: Delta;
  conversion_rate: RateDelta;
  /** Null when no goal is configured — a setup state, not a zero. */
  /**
   * What the conversion figures count: a goal's name, "All conversions", or null when
   * none is configured — which the cards must render as a setup prompt, not a zero.
   */
  goal_name: string | null;
}

export async function headline(w: WebScope): Promise<Headline> {
  const { cte, params } = sessionBase(w);
  const [r] = await q<Row>(
    w.scope,
    `${cte}
     SELECT
       ${AGG.visitors} AS visitors, ${AGG.prevVisitors} AS prev_visitors,
       ${AGG.sessions} AS sessions, ${AGG.prevSessions} AS prev_sessions,
       ${AGG.converting} AS converting, ${AGG.prevConverting} AS prev_converting
     FROM scoped`,
    params,
  );
  const sessions = num(r?.sessions);
  const prevSessions = num(r?.prev_sessions);
  return {
    visitors: delta(num(r?.visitors), prevOr(w, num(r?.prev_visitors))),
    sessions: delta(sessions, prevOr(w, prevSessions)),
    converting_sessions: delta(num(r?.converting), prevOr(w, num(r?.prev_converting))),
    conversion_rate: rateDelta([num(r?.converting), sessions], prevOr(w, [num(r?.prev_converting), prevSessions] as [number, number])),
    goal_name: countingLabel(w),
  };
}

// ---------- trends ----------

/**
 * Visitors and sessions over time, with the comparison period drawn against each. The
 * previous series is shifted forward by the distance between the two period starts, so
 * bucket i of one lands on bucket i of the other and a single chart can draw both.
 */
export async function trend(w: WebScope): Promise<TrafficSeries> {
  const { cte, params } = sessionBase(w);
  const p = new Params("tb");
  const offset = alignOffsetMs(w.range);
  const bucket = bucketSql("started_at", w.range.interval, w.range.timezone);
  const shifted = bucketSql(`started_at + toIntervalMillisecond({shift:Int64})`, w.range.interval, w.range.timezone);

  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${denseBuckets(w, p)}
     SELECT
       b.bucket AS bucket,
       ifNull(a.visitors, 0) AS visitors,
       ifNull(a.prev_visitors, 0) AS prev_visitors,
       ifNull(a.sessions, 0) AS sessions,
       ifNull(a.prev_sessions, 0) AS prev_sessions
     FROM buckets AS b
     LEFT JOIN (
       SELECT
         bucket,
         sumIf(v, series = 'current') AS visitors,
         sumIf(v, series = 'previous') AS prev_visitors,
         sumIf(s, series = 'current') AS sessions,
         sumIf(s, series = 'previous') AS prev_sessions
       FROM (
         SELECT ${bucket} AS bucket, 'current' AS series, uniqExact(person_id) AS v, uniqExact(session_id) AS s
         FROM scoped WHERE period = 'current' GROUP BY bucket
         UNION ALL
         SELECT ${shifted} AS bucket, 'previous' AS series, uniqExact(person_id) AS v, uniqExact(session_id) AS s
         FROM scoped WHERE period = 'previous' GROUP BY bucket
       )
       GROUP BY bucket
     ) AS a ON a.bucket = b.bucket
     ORDER BY b.bucket`,
    { ...params, ...p.values, tz: w.range.timezone, shift: offset },
  );

  const series = (value: string, prev: string): SeriesPoint[] =>
    rows.map((r) => ({ bucket: String(r.bucket), value: num(r[value]), previous: hasPrev(w) ? num(r[prev]) : null }));
  return { visitors: series("visitors", "prev_visitors"), sessions: series("sessions", "prev_sessions") };
}

export interface RatePoint {
  bucket: string;
  rate: number | null;
  converting: number;
  sessions: number;
}

/** Conversion rate over time, carrying both counts so the tooltip can show the working. */
export async function conversionTrend(w: WebScope): Promise<RatePoint[]> {
  if (!hasGoal(w)) return [];
  const { cte, params } = sessionBase(w);
  const p = new Params("cb");
  const bucket = bucketSql("started_at", w.range.interval, w.range.timezone);
  // A bucket with no visits keeps a null rate — there is nothing to divide — but it has
  // to be present for the line to break there rather than span it.
  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${denseBuckets(w, p)}
     SELECT b.bucket AS bucket, ifNull(a.sessions, 0) AS sessions, ifNull(a.converting, 0) AS converting
     FROM buckets AS b
     LEFT JOIN (
       SELECT ${bucket} AS bucket, uniqExact(session_id) AS sessions, uniqExactIf(session_id, converted = 1) AS converting
       FROM scoped WHERE period = 'current' GROUP BY bucket
     ) AS a ON a.bucket = b.bucket
     ORDER BY b.bucket`,
    { ...params, ...p.values, tz: w.range.timezone },
  );
  return rows.map((r) => {
    const sessions = num(r.sessions);
    const converting = num(r.converting);
    return { bucket: String(r.bucket), sessions, converting, rate: sessions > 0 ? (converting / sessions) * 100 : null };
  });
}

// ---------- rankings ----------

export interface BreakdownRow {
  key: string;
  sessions: Delta;
  /** Share of the period's sessions, 0-100. */
  share: number;
  engagement_rate: RateValue;
  converting_sessions: number;
  conversion_rate: RateValue;
}

export type Grouping = "channel" | "utm_source" | "utm_campaign" | "referrer_host" | "country" | "device" | "browser";

const GROUPINGS: Record<Grouping, string> = {
  channel: "channel",
  utm_source: "utm_source",
  utm_campaign: "utm_campaign",
  referrer_host: "referrer_host",
  country: "country",
  device: "device",
  browser: "browser",
};

/**
 * Sessions grouped by one dimension, with the rates that make the group worth reading.
 *
 * An empty campaign or source is labelled rather than dropped. A visit that arrived
 * with no campaign tag is a real visit, and folding it into nothing would make the
 * column add up to less than the total for no stated reason.
 */
export async function breakdown(
  w: WebScope,
  by: Grouping,
  opts: { limit?: number; orderBy?: "sessions" | "conversion_rate" | "converting_sessions" } = {},
): Promise<BreakdownRow[]> {
  const col = GROUPINGS[by] ?? GROUPINGS.channel;
  const { cte, params } = sessionBase(w);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 200);
  const order =
    opts.orderBy === "conversion_rate"
      ? "conversion_rate DESC, sessions DESC"
      : opts.orderBy === "converting_sessions"
        ? "converting DESC, sessions DESC"
        : "sessions DESC";

  const rows = await q<Row>(
    w.scope,
    `${cte},
     totals AS (SELECT uniqExactIf(session_id, period = 'current') AS total FROM scoped)
     SELECT
       if(${col} = '', '(none)', ${col}) AS key,
       ${AGG.sessions} AS sessions,
       ${AGG.prevSessions} AS prev_sessions,
       ${AGG.engagedSessions} AS engaged_sessions,
       ${AGG.converting} AS converting,
       if((SELECT total FROM totals) > 0, ${AGG.sessions} / (SELECT total FROM totals) * 100, 0) AS share,
       if(${AGG.sessions} > 0, ${AGG.converting} / ${AGG.sessions} * 100, NULL) AS conversion_rate
     FROM scoped
     GROUP BY key
     HAVING sessions > 0 OR prev_sessions > 0
     ORDER BY ${order}
     LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => {
    const sessions = num(r.sessions);
    return {
      key: String(r.key),
      sessions: delta(sessions, prevOr(w, num(r.prev_sessions))),
      share: num(r.share),
      engagement_rate: rate(num(r.engaged_sessions), sessions),
      converting_sessions: num(r.converting),
      conversion_rate: rate(num(r.converting), sessions),
    };
  });
}

// ---------- visitor mix ----------

export interface VisitorMix {
  new_visitors: number;
  returning_visitors: number;
  total: number;
  /** Returning as a share of all visitors, 0-100. Null when nobody visited. */
  returning_share: number | null;
  previous_returning_share: number | null;
  /** Percentage points, present only when both shares are available. */
  change_pp: number | null;
}

/**
 * New against returning, over the whole visible period.
 *
 * The two groups are mutually exclusive by construction: a visitor's status comes from
 * one first-seen timestamp compared against one cutoff, so a person cannot land in both
 * and the pair always sums to the visitor total. Somebody first seen inside the period
 * stays "new" for that period however many times they come back — which is why this is
 * counted from first_seen and not from anything about the individual visits.
 *
 * Note that the visitor filter is deliberately not applied here: this component IS the
 * filter's control surface, and a mix that only ever showed the half you had selected
 * would be a strange thing to click on.
 */
export async function visitorMix(w: WebScope): Promise<VisitorMix> {
  const unfiltered: WebScope = { ...w, filters: { ...w.filters, visitor: null } };
  const { cte, params } = sessionBase(unfiltered);
  const [r] = await q<Row>(
    w.scope,
    `${cte}
     SELECT
       uniqExactIf(person_id, period = 'current' AND is_new = 1) AS new_visitors,
       uniqExactIf(person_id, period = 'current' AND is_new = 0) AS returning_visitors,
       uniqExactIf(person_id, period = 'current') AS total,
       uniqExactIf(person_id, period = 'previous' AND is_new = 0) AS prev_returning,
       uniqExactIf(person_id, period = 'previous') AS prev_total
     FROM scoped`,
    params,
  );
  const total = num(r?.total);
  const returning = num(r?.returning_visitors);
  const prevTotal = num(r?.prev_total);
  const prevReturning = num(r?.prev_returning);
  const share = total > 0 ? (returning / total) * 100 : null;
  const prevShare = hasPrev(w) && prevTotal > 0 ? (prevReturning / prevTotal) * 100 : null;
  return {
    // A visitor active in both halves of the range is counted once, in whichever group
    // their first-seen puts them, so these two add to the total rather than over it.
    new_visitors: num(r?.new_visitors),
    returning_visitors: returning,
    total,
    returning_share: share,
    previous_returning_share: prevShare,
    change_pp: share !== null && prevShare !== null ? share - prevShare : null,
  };
}

// ---------- acquisition ----------

export interface StackedPoint {
  bucket: string;
  /** Channel name -> sessions. Channels outside the top five are summed into "Other channels". */
  values: Record<string, number>;
}

export const OTHER_CHANNELS = "Other channels";

/**
 * Sessions per channel over time, limited to the five biggest channels across the whole
 * range with everything else summed into one band. The five are chosen once, from the
 * period total, rather than per bucket — otherwise a channel would drop out of the
 * stack on its quiet days and the bands would jump around for no reason a reader could
 * see.
 */
export async function channelStack(w: WebScope): Promise<{ channels: string[]; points: StackedPoint[] }> {
  const { cte, params } = sessionBase(w);
  const bucket = bucketSql("started_at", w.range.interval, w.range.timezone);
  const rows = await q<Row>(
    w.scope,
    `${cte},
     top AS (
       SELECT channel FROM scoped WHERE period = 'current'
       GROUP BY channel ORDER BY uniqExact(session_id) DESC LIMIT 5
     )
     SELECT ${bucket} AS bucket,
            if(channel IN (SELECT channel FROM top), channel, {other:String}) AS band,
            uniqExact(session_id) AS sessions
     FROM scoped WHERE period = 'current'
     GROUP BY bucket, band ORDER BY bucket`,
    { ...params, tz: w.range.timezone, other: OTHER_CHANNELS },
  );

  const byBucket = new Map<string, Record<string, number>>();
  const seen = new Set<string>();
  for (const r of rows) {
    const b = String(r.bucket);
    const band = String(r.band);
    seen.add(band);
    const entry = byBucket.get(b) ?? {};
    entry[band] = num(r.sessions);
    byBucket.set(b, entry);
  }
  const channels = [...seen].filter((c) => c !== OTHER_CHANNELS).sort();
  if (seen.has(OTHER_CHANNELS)) channels.push(OTHER_CHANNELS);
  return { channels, points: [...byBucket].map(([bucket, values]) => ({ bucket, values })) };
}

// ---------- pages ----------

/**
 * How long after a visit's LAST event we are willing to call it finished. Sessions end
 * by inactivity, so a visit whose last event was four minutes ago has not exited the
 * page — it is still being read. Counting it as an exit would inflate the exit row for
 * the pages people are on right now, which are the ones you are usually looking at.
 *
 * Measured from ended_at, never from started_at: a visit that began two hours ago and
 * was still moving a minute ago is not finished, and asking when it started answers a
 * different question that happens to look like the right one.
 *
 * Shared by the exit rate in the pages table and the "left the site" row in page
 * detail, which are the same claim at two altitudes and must not disagree about which
 * visits have ended.
 */
const SESSION_SETTLED_MS = 30 * 60 * 1000;


export interface LandingPageRow {
  path: string;
  title: string;
  landing_sessions: Delta;
  engagement_rate: RateValue;
  converting_sessions: number;
  conversion_rate: RateValue;
}

/**
 * Landing pages: sessions whose first page view was this page, and what those sessions
 * went on to do.
 *
 * The conversion rate here is conversion *within sessions that started on this page* —
 * not conversion among everyone who ever saw it. The second is the number most tools
 * show and it is close to meaningless: a pricing page viewed by people who were always
 * going to convert will report a spectacular rate and tell you nothing about whether
 * the page works as an entry point.
 */
export async function landingPages(
  w: WebScope,
  opts: { limit?: number; groupBy?: "page" | "group"; orderBy?: "landing_sessions" | "converting_sessions" } = {},
): Promise<LandingPageRow[]> {
  const { cte, params } = sessionBase(w);
  const p = new Params("lp");
  const key = opts.groupBy === "group" ? pageGroupSql(w.pageGroups, "entry_path", p) : "entry_path";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  // Ranked by conversions, the busiest page is not usually the top row — which is the
  // point of asking. Sessions break the tie so a page with one of each does not outrank
  // a page with one conversion from a hundred visits by accident of ordering.
  const byConversions = opts.orderBy === "converting_sessions";
  const order = byConversions ? "converting DESC, sessions DESC" : "sessions DESC";
  // Ranked by conversions, a page with none is not a low-ranking row — it is not a row.
  // Ranked by traffic it is, because then the question is where people land.
  const having = byConversions ? "converting > 0" : "sessions > 0 OR prev_sessions > 0";

  const rows = await q<Row>(
    w.scope,
    `${cte}
     SELECT
       ${key} AS key,
       any(entry_title) AS title,
       ${AGG.sessions} AS sessions,
       ${AGG.prevSessions} AS prev_sessions,
       ${AGG.engagedSessions} AS engaged_sessions,
       ${AGG.converting} AS converting
     FROM scoped
     WHERE entry_path != ''
     GROUP BY key
     HAVING ${having}
     ORDER BY ${order}
     LIMIT ${limit}`,
    { ...params, ...p.values },
  );
  return rows.map((r) => {
    const sessions = num(r.sessions);
    return {
      path: String(r.key),
      title: String(r.title ?? ""),
      landing_sessions: delta(sessions, prevOr(w, num(r.prev_sessions))),
      engagement_rate: rate(num(r.engaged_sessions), sessions),
      converting_sessions: num(r.converting),
      conversion_rate: rate(num(r.converting), sessions),
    };
  });
}

export interface PageRow {
  path: string;
  title: string;
  unique_viewers: Delta;
  pageviews: Delta;
  /**
   * Mean measured foreground time per page view, in ms. Null when nothing was measured
   * — an older SDK, or a page nobody left normally — which is not the same as zero.
   */
  avg_engagement_ms: number | null;
  /** Page views that reported any engagement measurement at all, the denominator above. */
  measured_views: number;
  /**
   * Views of this page that turned out to be the visit's last page, over all views of
   * it. Not bounce rate: a visit that read three pages and stopped here exits here and
   * did not bounce. A session is counted once however often it saw the page, so the
   * numerator is sessions and the denominator is views — which is the conventional
   * definition, and the reason this can read low on a page people revisit mid-visit.
   *
   * Both sides count only visits that have gone quiet for SESSION_SETTLED_MS. Someone
   * reading the page right now has not left it, and the denominator drops their view
   * with the numerator rather than holding it against the page. On a live range that
   * makes this denominator smaller than `pageviews`; the UI shows it, so say so.
   */
  exit_rate: RateValue;
  cta_clickers: number;
}


/**
 * All pages: every page that was viewed, however the visit started.
 *
 * This deliberately carries no conversion rate. Viewing a page and later converting is
 * a correlation a table cannot separate from "everybody passes through here", and a
 * conversion column next to a page name is read as a claim that the page caused it.
 * Landing pages may carry one, because the session genuinely started there.
 */
export async function allPages(w: WebScope, opts: { limit?: number; groupBy?: "page" | "group" } = {}): Promise<PageRow[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("ap");
  const key = opts.groupBy === "group" ? pageGroupSql(w.pageGroups, "e.path", p) : normalizedPath("e.path");
  // The same key, applied to where the visit stopped. `exit_path` arrives from `base`
  // already normalised, so it is compared against the page key on equal terms; the group
  // expression normalises its own operand and is safe to apply a second time.
  const exitKey = opts.groupBy === "group" ? pageGroupSql(w.pageGroups, "exit_path", p) : "exit_path";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);

  // "CTA clickers" counts configured supporting actions. Nothing is auto-captured, so
  // with none configured this is honestly zero and the UI says the tracking is missing
  // rather than implying nobody clicked anything.
  const supporting = leafGoals(w.goals).filter((g) => g.config.type === "supporting");
  const ctaMatch = supporting.length ? supporting.map((g) => matchSql(g.config, p)).join(" OR ") : "0";

  const rows = await q<Row>(
    w.scope,
    `${cte},
     settled AS (
       SELECT session_id FROM scoped WHERE period = 'current'
       GROUP BY session_id HAVING max(ended_at) < now64(3) - toIntervalMillisecond({settled:Int64})
     ),
     page_events AS (
       SELECT
         ${key} AS key,
         b.period AS period,
         b.person_id AS person_id,
         e.type AS type,
         e.title AS title,
         toUInt8(e.event = {leave:String}) AS is_leave,
         if(e.event = {leave:String}, JSONExtractUInt(e.properties, 'engaged_ms'), 0) AS eng_ms,
         toUInt8(${ctaMatch}) AS is_cta,
         toUInt8(b.session_id IN (SELECT session_id FROM settled)) AS is_settled
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND e.session_id != ''
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
     ),
     exits AS (
       SELECT ${exitKey} AS key, uniqExactIf(session_id, period = 'current') AS exits
       FROM scoped
       WHERE exit_path != '' AND session_id IN (SELECT session_id FROM settled)
       GROUP BY key
     ),
     totals AS (
       SELECT
         key,
         anyIf(title, type = 'page' AND title != '') AS title,
         uniqExactIf(person_id, period = 'current' AND type = 'page') AS viewers,
         uniqExactIf(person_id, period = 'previous' AND type = 'page') AS prev_viewers,
         countIf(period = 'current' AND type = 'page') AS pageviews,
         countIf(period = 'previous' AND type = 'page') AS prev_pageviews,
         sumIf(eng_ms, period = 'current') AS eng_total,
         countIf(period = 'current' AND is_leave = 1 AND eng_ms > 0) AS measured,
         countIf(period = 'current' AND type = 'page' AND is_settled = 1) AS settled_views,
         uniqExactIf(person_id, period = 'current' AND is_cta = 1) AS cta_clickers
       FROM page_events
       GROUP BY key
       HAVING pageviews > 0 OR prev_pageviews > 0
     )
     SELECT t.*, ifNull(x.exits, 0) AS exits
     FROM totals AS t
     LEFT JOIN exits AS x ON x.key = t.key
     ORDER BY t.pageviews DESC
     LIMIT ${limit}`,
    { ...params, ...p.values, leave: PAGE_LEAVE, settled: SESSION_SETTLED_MS },
  );

  return rows.map((r) => {
    const measured = num(r.measured);
    return {
      path: String(r.key),
      title: String(r.title ?? ""),
      unique_viewers: delta(num(r.viewers), prevOr(w, num(r.prev_viewers))),
      pageviews: delta(num(r.pageviews), prevOr(w, num(r.prev_pageviews))),
      // Averaged over the views that actually reported a measurement, not over all
      // views. Dividing measured time by unmeasured views would report a number that
      // falls as instrumentation coverage falls, which is the opposite of the truth.
      avg_engagement_ms: measured > 0 ? num(r.eng_total) / measured : null,
      measured_views: measured,
      // Denominated in views, not sessions: "of everyone who saw this page, this many
      // went no further". Over views the page never had, the rate is unavailable rather
      // than 0%, which `rate` already handles.
      exit_rate: rate(num(r.exits), num(r.settled_views)),
      cta_clickers: num(r.cta_clickers),
    };
  });
}

// ---------- page detail ----------

export interface NextPageRow {
  path: string;
  sessions: number;
  /** True for the synthetic row counting visits that ended here. */
  is_exit: boolean;
}

export interface PageActionRow {
  name: string;
  clickers: number;
  /** Unique page viewers, the denominator. Exposure is not tracked; see click_rate_basis. */
  viewers: number;
  rate: RateValue;
}

export interface PageDetail {
  path: string;
  title: string;
  trend: SeriesPoint[];
  sources: BreakdownRow[];
  next_pages: NextPageRow[];
  actions: PageActionRow[];
  /**
   * Always "page_viewers" for now: Fourier does not record whether a CTA was ever
   * scrolled into view, so the denominator is everyone who saw the page. The UI must
   * label it as such rather than present it as a click-through rate on an impression.
   */
  click_rate_basis: "page_viewers" | "exposed_viewers";
  landing_sessions: Delta;
  unique_viewers: Delta;
}

export async function pageDetail(w: WebScope, path: string, opts: { basis?: "landing" | "viewers" } = {}): Promise<PageDetail> {
  const basis = opts.basis ?? "landing";
  const scopedToPage: WebScope = w;
  const [trendPoints, sources, nextPages, actions, totals] = await Promise.all([
    pageTrend(scopedToPage, path, basis),
    pageSources(scopedToPage, path),
    nextPagesAfter(scopedToPage, path),
    pageActions(scopedToPage, path),
    pageTotals(scopedToPage, path),
  ]);
  return {
    path,
    title: totals.title,
    trend: trendPoints,
    sources,
    next_pages: nextPages,
    actions,
    click_rate_basis: "page_viewers",
    landing_sessions: totals.landing_sessions,
    unique_viewers: totals.unique_viewers,
  };
}

async function pageTotals(w: WebScope, path: string): Promise<{ title: string; landing_sessions: Delta; unique_viewers: Delta }> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("pt");
  const target = `{${p.add(path)}:String}`;
  const [r] = await q<Row>(
    w.scope,
    `${cte},
     views AS (
       SELECT b.period AS period, b.person_id AS person_id, e.title AS title
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND e.type = 'page'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
         AND ${normalizedPath("e.path")} = ${target}
     )
     SELECT
       (SELECT anyIf(title, title != '') FROM views) AS title,
       (SELECT uniqExactIf(person_id, period = 'current') FROM views) AS viewers,
       (SELECT uniqExactIf(person_id, period = 'previous') FROM views) AS prev_viewers,
       uniqExactIf(session_id, period = 'current' AND entry_path = ${target}) AS landing,
       uniqExactIf(session_id, period = 'previous' AND entry_path = ${target}) AS prev_landing
     FROM scoped`,
    { ...params, ...p.values },
  );
  return {
    title: String(r?.title ?? ""),
    landing_sessions: delta(num(r?.landing), prevOr(w, num(r?.prev_landing))),
    unique_viewers: delta(num(r?.viewers), prevOr(w, num(r?.prev_viewers))),
  };
}

async function pageTrend(w: WebScope, path: string, basis: "landing" | "viewers"): Promise<SeriesPoint[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("pg");
  const target = `{${p.add(path)}:String}`;
  const offset = alignOffsetMs(w.range);
  const bucket = (col: string) => bucketSql(col, w.range.interval, w.range.timezone);
  const shift = `started_at + toIntervalMillisecond({shift:Int64})`;

  // Landing sessions are a property of the session row; unique viewers need the page
  // views themselves. Matching the report the reader arrived from, as the brief asks.
  // Wrapped around a dense bucket list, so a day nobody visited this page is a zero
  // rather than a missing point the line would be drawn straight through.
  const dense = (inner: string) => `SELECT b.bucket AS bucket, ifNull(a.value, 0) AS value, ifNull(a.previous, 0) AS previous
         FROM buckets AS b LEFT JOIN (${inner}) AS a ON a.bucket = b.bucket
         ORDER BY b.bucket`;

  const sql =
    basis === "landing"
      ? `${cte},
         ${denseBuckets(w, p)}
         ${dense(`SELECT bucket, sumIf(v, series = 'current') AS value, sumIf(v, series = 'previous') AS previous FROM (
           SELECT ${bucket("started_at")} AS bucket, 'current' AS series, uniqExact(session_id) AS v
           FROM scoped WHERE period = 'current' AND entry_path = ${target} GROUP BY bucket
           UNION ALL
           SELECT ${bucket(shift)} AS bucket, 'previous' AS series, uniqExact(session_id) AS v
           FROM scoped WHERE period = 'previous' AND entry_path = ${target} GROUP BY bucket
         ) GROUP BY bucket`)}`
      : `${cte},
         ${denseBuckets(w, p)},
         views AS (
           SELECT b.period AS period, b.person_id AS person_id, e.timestamp AS ts
           FROM events AS e
           INNER JOIN scoped AS b ON b.session_id = e.session_id
           WHERE e.project_id = ${project} AND e.type = 'page'
             AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
             AND ${normalizedPath("e.path")} = ${target}
         )
         ${dense(`SELECT bucket, sumIf(v, series = 'current') AS value, sumIf(v, series = 'previous') AS previous FROM (
           SELECT ${bucket("ts")} AS bucket, 'current' AS series, uniqExact(person_id) AS v
           FROM views WHERE period = 'current' GROUP BY bucket
           UNION ALL
           SELECT ${bucket("ts + toIntervalMillisecond({shift:Int64})")} AS bucket, 'previous' AS series, uniqExact(person_id) AS v
           FROM views WHERE period = 'previous' GROUP BY bucket
         ) GROUP BY bucket`)}`;

  const rows = await q<Row>(w.scope, sql, { ...params, ...p.values, tz: w.range.timezone, shift: offset });
  return rows.map((r) => ({ bucket: String(r.bucket), value: num(r.value), previous: hasPrev(w) ? num(r.previous) : null }));
}

/** Where the sessions that landed on this page came from. */
async function pageSources(w: WebScope, path: string): Promise<BreakdownRow[]> {
  const { cte, params } = sessionBase(w);
  const p = new Params("ps");
  const target = `{${p.add(path)}:String}`;
  const rows = await q<Row>(
    w.scope,
    `${cte},
     totals AS (SELECT uniqExactIf(session_id, period = 'current' AND entry_path = ${target}) AS total FROM scoped)
     SELECT
       if(channel = '', '(none)', channel) AS key,
       uniqExactIf(session_id, period = 'current') AS sessions,
       uniqExactIf(session_id, period = 'previous') AS prev_sessions,
       uniqExactIf(session_id, period = 'current' AND engaged = 1) AS engaged_sessions,
       uniqExactIf(session_id, period = 'current' AND converted = 1) AS converting,
       if((SELECT total FROM totals) > 0, uniqExactIf(session_id, period = 'current') / (SELECT total FROM totals) * 100, 0) AS share
     FROM scoped WHERE entry_path = ${target}
     GROUP BY key HAVING sessions > 0 ORDER BY sessions DESC LIMIT 10`,
    { ...params, ...p.values },
  );
  return rows.map((r) => {
    const sessions = num(r.sessions);
    return {
      key: String(r.key),
      sessions: delta(sessions, prevOr(w, num(r.prev_sessions))),
      share: num(r.share),
      engagement_rate: rate(num(r.engaged_sessions), sessions),
      converting_sessions: num(r.converting),
      conversion_rate: rate(num(r.converting), sessions),
    };
  });
}

/**
 * What was viewed next. Strictly the next recorded page view in the same visit — an
 * observation, not an intention. The "left the site" row counts only visits that have
 * since gone quiet for longer than a session can stay open; a visit still in progress
 * has not exited anything, and saying it has would overstate every exit rate during
 * the hours anyone is actually looking at this page.
 */
async function nextPagesAfter(w: WebScope, path: string): Promise<NextPageRow[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("np");
  const target = `{${p.add(path)}:String}`;
  const rows = await q<Row>(
    w.scope,
    `${cte},
     views AS (
       SELECT
         e.session_id AS session_id,
         e.timestamp AS ts,
         ${normalizedPath("e.path")} AS path,
         b.started_at AS started_at
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND e.type = 'page' AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
     ),
     ordered AS (
       SELECT
         session_id,
         path,
         ts,
         leadInFrame(path) OVER (PARTITION BY session_id ORDER BY ts ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS next_path
       FROM views
     ),
     settled AS (
       SELECT session_id FROM scoped WHERE period = 'current'
       GROUP BY session_id HAVING max(ended_at) < now64(3) - toIntervalMillisecond({settled:Int64})
     )
     SELECT
       multiIf(next_path != '', next_path, session_id IN (SELECT session_id FROM settled), '', NULL) AS key,
       uniqExact(session_id) AS sessions
     FROM ordered
     WHERE path = ${target}
     GROUP BY key
     HAVING isNotNull(key)
     ORDER BY sessions DESC LIMIT 10`,
    { ...params, ...p.values, settled: SESSION_SETTLED_MS },
  );
  return rows.map((r) => ({ path: String(r.key ?? ""), sessions: num(r.sessions), is_exit: String(r.key ?? "") === "" }));
}

/** Configured supporting actions fired on this page, and how many distinct people fired them. */
async function pageActions(w: WebScope, path: string): Promise<PageActionRow[]> {
  // Leaves, so first-match-wins names the specific value rather than the rollup holding it.
  const supporting = leafGoals(w.goals).filter((g) => g.config.type === "supporting");
  if (!supporting.length) return [];
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("pa");
  const target = `{${p.add(path)}:String}`;
  const branches = supporting.map((g) => `${matchSql(g.config, p)}, {${p.add(g.name)}:String}`).join(", ");

  const rows = await q<Row>(
    w.scope,
    `${cte},
     on_page AS (
       SELECT b.person_id AS person_id, e.type AS type, multiIf(${branches}, '') AS action
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
         AND ${normalizedPath("e.path")} = ${target}
     ),
     viewers AS (SELECT uniqExactIf(person_id, type = 'page') AS n FROM on_page)
     SELECT action AS name, uniqExact(person_id) AS clickers, (SELECT n FROM viewers) AS viewers
     FROM on_page WHERE action != ''
     GROUP BY action ORDER BY clickers DESC`,
    { ...params, ...p.values },
  );
  return rows.map((r) => {
    const clickers = num(r.clickers);
    const viewers = num(r.viewers);
    return { name: String(r.name), clickers, viewers, rate: rate(clickers, viewers) };
  });
}

// ---------- conversions ----------

export interface GoalSummaryRow {
  id: string;
  name: string;
  is_default: boolean;
  converting_sessions: Delta;
  conversion_rate: RateDelta;
  /** Set on the rows of a split goal: the rollup, each value, and any Other bucket. */
  split: GoalSplit | null;
}

/**
 * Every primary goal against the same denominator, so the rows are comparable with each
 * other and with the headline card on Overview.
 *
 * Supporting actions are absent by construction: they are reported in their own table
 * and never added into a conversion total. A click on a button that opens a booking
 * page is not a booking, and a total that adds the two is a number with no referent.
 */
export async function goalSummary(w: WebScope): Promise<GoalSummaryRow[]> {
  const primary = primaryGoals(w.goals);
  if (!primary.length) return [];
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("gs");
  const flags = primary.map((g, i) => `max(${matchSql(g.config, p)}) AS g${i}`).join(", ");
  const counts = primary
    .map((_, i) => `uniqExactIf(s.session_id, s.period = 'current' AND ifNull(h.g${i}, 0) = 1) AS c${i}, uniqExactIf(s.session_id, s.period = 'previous' AND ifNull(h.g${i}, 0) = 1) AS p${i}`)
    .join(", ");

  const [r] = await q<Row>(
    w.scope,
    `${cte},
     all_goals AS (
       SELECT session_id, ${flags}
       FROM events
       WHERE project_id = ${project} AND session_id != ''
         AND timestamp >= ${scanFrom} AND timestamp < ${scanTo}
       GROUP BY session_id
     )
     SELECT ${qualified(AGG.sessions)} AS sessions, ${qualified(AGG.prevSessions)} AS prev_sessions, ${counts}
     FROM scoped AS s LEFT JOIN all_goals AS h ON h.session_id = s.session_id`,
    { ...params, ...p.values },
  );

  const sessions = num(r?.sessions);
  const prevSessions = num(r?.prev_sessions);
  return primary.map((g, i) => {
    const cur = num(r?.[`c${i}`]);
    const prev = num(r?.[`p${i}`]);
    return {
      id: g.id,
      name: g.name,
      is_default: g.is_default,
      converting_sessions: delta(cur, prevOr(w, prev)),
      conversion_rate: rateDelta([cur, sessions], prevOr(w, [prev, prevSessions] as [number, number])),
      split: g.split ?? null,
    };
  });
}

export interface FunnelStep {
  name: string;
  sessions: number;
  /** Share of the step before, 0-100. Null on the first step, which has nothing before it. */
  step_rate: number | null;
  dropped: number;
  /** Share of the step before that did not continue, 0-100. Null on the first step. */
  drop_rate: number | null;
}

export interface Funnel {
  steps: FunnelStep[];
  /**
   * Conversions of this goal by any route at all. When a path-specific funnel is
   * configured this will usually exceed the last step, and the difference is people who
   * reached the goal another way — which is information, not an error in the funnel.
   */
  total_conversions: number;
  /** True when the steps come from a configured path rather than the default two. */
  is_path_specific: boolean;
}

/**
 * The default funnel is the honest one: a visit, and then the goal. A configured funnel
 * replaces it with named steps that a session must satisfy in order, inside that one
 * session.
 *
 * Every step counts distinct sessions, and a session counts once per step however many
 * times it repeats a step — clicking a button four times is one session that clicked it.
 * No engagement or CTA step is inserted: an invented step makes the drop-off look like
 * it happens somewhere it does not.
 */
export async function funnel(w: WebScope): Promise<Funnel> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const goal = w.goal;
  if (!hasGoal(w)) return { steps: [], total_conversions: 0, is_path_specific: false };

  // A path can only be drawn to one destination. Counting conversions across every
  // primary goal is a perfectly good number, but "demo page viewed, then form started,
  // then WHICHEVER of three things happened" is not a funnel — so a configured path is
  // used only when the reader has actually narrowed to the goal that owns it. Otherwise
  // this is the honest default: a visit, and then a conversion.
  const configured = goal?.config.funnel ?? [];
  const p = new Params("fn");

  if (!configured.length) {
    const [r] = await q<Row>(
      w.scope,
      `${cte} SELECT ${AGG.sessions} AS sessions, ${AGG.converting} AS converting FROM scoped`,
      { ...params, ...p.values },
    );
    const sessions = num(r?.sessions);
    const converting = num(r?.converting);
    return {
      steps: [
        { name: "Website session", sessions, step_rate: null, dropped: 0, drop_rate: null },
        {
          name: goal?.name ?? "Any conversion",
          sessions: converting,
          step_rate: sessions > 0 ? (converting / sessions) * 100 : null,
          dropped: sessions - converting,
          drop_rate: sessions > 0 ? ((sessions - converting) / sessions) * 100 : null,
        },
      ],
      total_conversions: converting,
      is_path_specific: false,
    };
  }

  const conds = configured.map((s) => matchSql(s.match, p)).join(", ");
  // windowFunnel returns how many steps a session reached in order. It refuses a
  // DateTime64, so the timestamp goes in as unsigned milliseconds rather than being
  // rounded to whole seconds: two steps a quarter-second apart are common, and rounding
  // would make their order a coin toss. The window is a day in the same units, wide
  // enough never to bind — the GROUP BY has already limited this to one visit.
  const rows = await q<Row>(
    w.scope,
    `${cte},
     levels AS (
       SELECT e.session_id AS session_id, windowFunnel(86400000)(toUInt64(toUnixTimestamp64Milli(e.timestamp)), ${conds}) AS level
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
       GROUP BY e.session_id
     )
     SELECT level, count() AS sessions FROM levels GROUP BY level ORDER BY level`,
    { ...params, ...p.values },
  );

  const byLevel = new Map<number, number>();
  for (const r of rows) byLevel.set(num(r.level), num(r.sessions));
  // A session that reached step 3 also reached steps 1 and 2, so each step is the tail
  // sum from its own level upward.
  const reached = configured.map((_, i) => {
    let total = 0;
    for (const [level, n] of byLevel) if (level >= i + 1) total += n;
    return total;
  });

  const [totals] = await q<Row>(w.scope, `${cte} SELECT ${AGG.converting} AS converting FROM scoped`, params);

  const steps: FunnelStep[] = configured.map((s, i) => {
    const sessions = reached[i];
    const before = i === 0 ? null : reached[i - 1];
    return {
      name: s.name,
      sessions,
      step_rate: before === null ? null : before > 0 ? (sessions / before) * 100 : null,
      dropped: before === null ? 0 : before - sessions,
      drop_rate: before === null ? null : before > 0 ? ((before - sessions) / before) * 100 : null,
    };
  });

  return { steps, total_conversions: num(totals?.converting), is_path_specific: true };
}

export interface SupportingActionRow {
  id: string;
  name: string;
  sessions: Delta;
  people: Delta;
  split: GoalSplit | null;
}

/**
 * Explicitly tracked supporting actions. Reported on their own and never folded into a
 * conversion total — that separation is the whole point of the primary/supporting split.
 */
export async function supportingActions(w: WebScope): Promise<SupportingActionRow[]> {
  const supporting = w.goals.filter((g) => g.config.type === "supporting");
  if (!supporting.length) return [];
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("sa");
  const flags = supporting.map((g, i) => `max(${matchSql(g.config, p)}) AS a${i}`).join(", ");
  const counts = supporting
    .map(
      (_, i) =>
        `uniqExactIf(s.session_id, s.period = 'current' AND ifNull(h.a${i}, 0) = 1) AS s${i},
         uniqExactIf(s.session_id, s.period = 'previous' AND ifNull(h.a${i}, 0) = 1) AS sp${i},
         uniqExactIf(s.person_id, s.period = 'current' AND ifNull(h.a${i}, 0) = 1) AS u${i},
         uniqExactIf(s.person_id, s.period = 'previous' AND ifNull(h.a${i}, 0) = 1) AS up${i}`,
    )
    .join(", ");

  const [r] = await q<Row>(
    w.scope,
    `${cte},
     acts AS (
       SELECT session_id, ${flags}
       FROM events
       WHERE project_id = ${project} AND session_id != ''
         AND timestamp >= ${scanFrom} AND timestamp < ${scanTo}
       GROUP BY session_id
     )
     SELECT ${counts} FROM scoped AS s LEFT JOIN acts AS h ON h.session_id = s.session_id`,
    { ...params, ...p.values },
  );

  return supporting.map((g, i) => ({
    id: g.id,
    name: g.name,
    sessions: delta(num(r?.[`s${i}`]), prevOr(w, num(r?.[`sp${i}`]))),
    people: delta(num(r?.[`u${i}`]), prevOr(w, num(r?.[`up${i}`]))),
    split: g.split ?? null,
  }));
}

// ---------- data-quality states ----------

/**
 * What the reports are allowed to claim. Section 9 of the brief turns on being able to
 * tell four different nothings apart: no traffic at all, traffic but no goal defined, a
 * goal defined that nobody has completed, and a measurement the SDK never sent. Each
 * needs a different sentence, and a zero is only honest for the third.
 */
export interface Availability {
  /**
   * Any session at all in the selected period for this site, before the reader's
   * filters. Paired with the report's own row count this separates "this site had no
   * traffic" from "these filters match none of it" — two different sentences, and the
   * caller already holds the second half, so it is not re-counted here.
   */
  has_traffic: boolean;
  has_primary_goal: boolean;
  has_supporting_actions: boolean;
  /** Whether any page view in range reported measured foreground time. */
  engagement_tracked: boolean;
}

export async function availability(w: WebScope): Promise<Availability> {
  // "No traffic" is asked without the reader's filters, so a report with no rows can say
  // whether the source is silent or the filters simply match nothing. The source selection
  // stays on: another source having traffic is not this one having traffic.
  const unfiltered: WebScope = {
    ...w,
    filters: { includeBots: w.filters.includeBots, sourceId: w.filters.sourceId },
  };
  const wide = sessionBase(unfiltered);
  const [all] = await q<Row>(
    w.scope,
    `${wide.cte} SELECT ${AGG.sessions} AS n, sumIf(engaged_ms, period = 'current') AS eng FROM scoped`,
    wide.params,
  );
  return {
    has_traffic: num(all?.n) > 0,
    has_primary_goal: primaryGoals(w.goals).length > 0,
    has_supporting_actions: w.goals.some((g) => g.config.type === "supporting"),
    engagement_tracked: num(all?.eng) > 0,
  };
}

// ---------- filter menus ----------

export interface FilterValues {
  sources: string[];
  campaigns: string[];
  mediums: string[];
  countries: string[];
}

/**
 * The values worth offering in the filter menus.
 *
 * Read with the dimension filters dropped, so that having selected one campaign you can
 * still switch to another: a menu populated from the already-filtered rows would narrow
 * to the single value you had picked, which is the classic filter-menu dead end.
 * The site selection and the date range do still apply — those genuinely change which
 * values exist.
 */
export async function filterValues(w: WebScope): Promise<FilterValues> {
  const unfiltered: WebScope = {
    ...w,
    filters: { sourceId: w.filters.sourceId, includeBots: w.filters.includeBots },
  };
  const { cte, params } = sessionBase(unfiltered);
  const pick = (col: string) =>
    `arraySort(arrayFilter(x -> x != '', groupUniqArrayIf(200)(${col}, period = 'current')))`;
  const [r] = await q<Row>(
    w.scope,
    `${cte}
     SELECT ${pick("utm_source")} AS sources, ${pick("utm_campaign")} AS campaigns,
            ${pick("utm_medium")} AS mediums, ${pick("country")} AS countries
     FROM scoped`,
    params,
  );
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    sources: list(r?.sources),
    campaigns: list(r?.campaigns),
    mediums: list(r?.mediums),
    countries: list(r?.countries),
  };
}

// ---------- which pages the converting visits went through ----------

export interface ConvertingPageRow {
  path: string;
  title: string;
  /** Converting sessions that included this page at any point. */
  converting_sessions: number;
  /** Share of all converting sessions that included it, 0-100. */
  converting_share: number;
  /** Every session that included it, converting or not — the baseline. */
  sessions: number;
  /** Share of all sessions that included it, 0-100. */
  session_share: number;
  /**
   * converting_share / session_share. Above 1 means the page turns up more often in
   * visits that converted than in visits generally. Null when the baseline is empty.
   */
  lift: number | null;
}

/**
 * Pages that converting visits passed through, against how often every visit passes
 * through them.
 *
 * The baseline is the whole report. "Seen in 62% of converting visits" is not a finding
 * — the home page is seen in 90% of everything — and a bare ranking of pages by
 * conversions is just a ranking of popular pages wearing a conversion label. Set against
 * the share of all visits, the same number becomes readable: 62% against a 31% baseline
 * is a page that converting visits seek out.
 *
 * It remains an association and the UI says so. A visit that converted and passed
 * through /pricing does not tell us /pricing did anything; people who are going to
 * convert read the pricing page, and people who read the pricing page convert, and this
 * query cannot separate the two. It is a place to look, not a conclusion.
 */
export async function pagesInConvertingSessions(w: WebScope, opts: { limit?: number; groupBy?: "page" | "group" } = {}): Promise<ConvertingPageRow[]> {
  if (!hasGoal(w)) return [];
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("cp");
  const key = opts.groupBy === "group" ? pageGroupSql(w.pageGroups, "e.path", p) : normalizedPath("e.path");
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);

  const rows = await q<Row>(
    w.scope,
    `${cte},
     totals AS (
       SELECT uniqExactIf(session_id, converted = 1) AS converting, uniqExact(session_id) AS sessions
       FROM scoped WHERE period = 'current'
     ),
     page_sessions AS (
       -- One row per (page, session): a visit that saw a page four times still only
       -- counts once towards it, the same way it converts only once.
       SELECT DISTINCT ${key} AS key, b.session_id AS session_id, b.converted AS converted, e.title AS title
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND e.type = 'page' AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
     )
     SELECT
       key,
       anyIf(title, title != '') AS title,
       uniqExactIf(session_id, converted = 1) AS converting,
       uniqExact(session_id) AS sessions,
       (SELECT converting FROM totals) AS total_converting,
       (SELECT sessions FROM totals) AS total_sessions
     FROM page_sessions
     GROUP BY key
     HAVING converting > 0
     ORDER BY converting DESC, sessions ASC
     LIMIT ${limit}`,
    { ...params, ...p.values },
  );

  return rows.map((r) => {
    const converting = num(r.converting);
    const sessions = num(r.sessions);
    const totalConverting = num(r.total_converting);
    const totalSessions = num(r.total_sessions);
    const convertingShare = totalConverting > 0 ? (converting / totalConverting) * 100 : 0;
    const sessionShare = totalSessions > 0 ? (sessions / totalSessions) * 100 : 0;
    return {
      path: String(r.key),
      title: String(r.title ?? ""),
      converting_sessions: converting,
      converting_share: convertingShare,
      sessions,
      session_share: sessionShare,
      lift: sessionShare > 0 ? convertingShare / sessionShare : null,
    };
  });
}

// ---------- who gets the credit ----------

export interface CreditRow {
  channel: string;
  /** Conversions by people this channel first brought to the site. */
  conversions: number;
  /** Of those, the ones that happened on that very first visit. */
  first_visit: number;
  /** Of those, the ones where the person left and came back another time to convert. */
  returned: number;
}

export interface ConversionCredit {
  rows: CreditRow[];
  total: number;
  /** Across all channels, conversions by someone returning. The reason this report exists. */
  returned: number;
}

/**
 * Conversions credited to whatever first brought that person to the site, split by
 * whether they converted there and then or came back to do it.
 *
 * Every other report credits the visit a conversion happened in, which is exact and
 * systematically under-credits the top of the funnel: a campaign that introduced
 * someone in March earns nothing when they return in September, type the address and
 * convert. That visit is Direct, and Direct did not do the work.
 *
 * This was two parallel columns — introduced against converting-visit — and it was
 * misread the same way twice, as though the second were a subset of the first. It is
 * not: they are two margins of a cross-tab, and a channel's two numbers can describe
 * entirely different people. So the comparison is gone and one total is decomposed
 * instead. `conversions` is the row's total and `first_visit + returned` is exactly it,
 * which is a relationship a reader can check on the row rather than take on trust.
 *
 * `returned` is the column worth reading. A channel with conversions only on the first
 * visit closes what it opens. A channel with a tail of returns is seeding demand that
 * some later visit gets the credit for everywhere else in this section.
 *
 * This is the one place here that looks across sessions; everything else is
 * session-scoped on purpose.
 */
export async function conversionCredit(w: WebScope, opts: { limit?: number } = {}): Promise<ConversionCredit> {
  if (!hasGoal(w)) return { rows: [], total: 0, returned: 0 };
  const { cte, params, project } = sessionBase(w);
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);

  // A touch is an arrival by definition, so it always has an entry page to classify;
  // the host comes off the landing URL. Repeated rows for one arrival are harmless
  // because argMin over them returns that arrival's channel either way.
  const touchChannel = channelSql({
    pageviews: "1",
    utm_source: "utm_source",
    utm_medium: "utm_medium",
    utm_campaign: "utm_campaign",
    referrer_host: "referrer_host",
    entry_host: "domain(landing_url)",
  });

  const rows = await q<Row>(
    w.scope,
    `${cte},
     person_first AS (
       SELECT person_id, argMin(${touchChannel}, timestamp) AS channel, min(timestamp) AS first_at, count() AS touches
       FROM touches_resolved
       WHERE project_id = ${project}
       GROUP BY person_id
     ),
     converting AS (
       SELECT session_id, person_id, started_at, channel AS visit_channel
       FROM scoped WHERE period = 'current' AND converted = 1
     ),
     credited AS (
       SELECT
         c.session_id AS session_id,
         -- Someone with no recorded touch keeps their visit's channel, so every
         -- conversion is credited to something rather than dropping out of the total.
         ifNull(nullIf(f.channel, ''), c.visit_channel) AS channel,
         -- A touch strictly before this visit began means they had been here before.
         -- Guarded on the join having matched: an unmatched row carries the epoch,
         -- which is before everything and would call every conversion a return.
         --
         -- Named is_return and not returned, because the aggregate below is called
         -- returned and ClickHouse resolves a WHERE or -If condition against aliases
         -- declared in the same SELECT. The condition would compare the aggregate with
         -- itself, which it rejects here — and silently matched every row the one time
         -- the types happened to line up. See the note in trend().
         toUInt8(f.touches > 0 AND f.first_at < c.started_at) AS is_return
       FROM converting AS c
       LEFT JOIN person_first AS f ON f.person_id = c.person_id
     )
     SELECT
       channel,
       uniqExact(session_id) AS conversions,
       uniqExactIf(session_id, is_return = 0) AS first_visit,
       uniqExactIf(session_id, is_return = 1) AS returned
     FROM credited
     GROUP BY channel
     ORDER BY conversions DESC`,
    params,
  );

  const all = rows.map((r) => ({
    channel: String(r.channel) || "Unattributed",
    conversions: num(r.conversions),
    first_visit: num(r.first_visit),
    returned: num(r.returned),
  }));
  return {
    rows: all.slice(0, limit),
    total: all.reduce((n, r) => n + r.conversions, 0),
    returned: all.reduce((n, r) => n + r.returned, 0),
  };
}

export interface ConversionPageRow {
  path: string;
  title: string;
  /** Conversions that happened on this page. */
  converted_on: number;
  /** Conversions that happened on the next page the visitor went to. */
  led_to: number;
  /** The two added, for ranking. Never a claim that one conversion happened twice. */
  involved: number;
}

export interface ConversionPages {
  rows: ConversionPageRow[];
  total: number;
  /**
   * Conversions on the page the visit arrived on. Nothing preceded them, so they count
   * under `converted_on` and toward no page's `led_to` — which is why the two columns
   * do not share a total.
   */
  on_arrival: number;
}

/**
 * Which pages produce conversions, told as two facts rather than one guess.
 *
 * `converted_on` is where the goal actually fired. `led_to` is the page the visitor was
 * on immediately before, when the conversion happened somewhere else.
 *
 * Both exist because a form is not always on a page of its own. A dedicated
 * /book-a-demo is a destination: it tops `converted_on` by construction and tells you
 * nothing you did not already know, while the page that sent them there is the one
 * worth having. But embed that same form on /product/analytics and the conversion page
 * IS the page doing the work — crediting its predecessor would hand the win to whatever
 * happened to come before. One site can have both arrangements, for the same goal.
 *
 * Nothing here infers which arrangement a page is in, because nothing reliably can.
 * Both numbers are observations and they sit side by side: conversions on it and none
 * led to it is a form people convert on; none on it and many led to it is a page that
 * persuades; both is a content page with a form embedded, which is the case that made
 * a single column wrong.
 *
 * Each column accounts for every conversion at most once — `converted_on` sums to the
 * total, `led_to` to the total minus those that converted on arrival — so neither can
 * double-count, and the two are never summed across pages.
 */
export async function conversionPages(w: WebScope, opts: { limit?: number; groupBy?: "page" | "group" } = {}): Promise<ConversionPages> {
  if (!hasGoal(w)) return { rows: [], total: 0, on_arrival: 0 };
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("lg");
  const conversion = conversionMatchSql(w, p);
  const key = opts.groupBy === "group" ? pageGroupSql(w.pageGroups, "page", p) : "page";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);

  const rows = await q<Row>(
    w.scope,
    `${cte},
     conv_events AS (
       -- The first completion in each visit, and the page it fired on. First and not
       -- last, because the visit converted the moment it first completed the goal, and
       -- anything after that is what someone did having already converted.
       SELECT
         e.session_id AS session_id,
         min(e.timestamp) AS at,
         argMin(${normalizedPath("e.path")}, e.timestamp) AS conv_path
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
         AND ${conversion}
       GROUP BY e.session_id
     ),
     views AS (
       SELECT e.session_id AS session_id, ${normalizedPath("e.path")} AS path, e.timestamp AS ts, e.title AS title
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND e.type = 'page' AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
     ),
     resolved AS (
       SELECT
         c.session_id AS session_id,
         c.conv_path AS conv_path,
         -- The last page before the conversion that is not the conversion page itself.
         -- Skipping the path and not just that one view matters when someone comes back
         -- to it: /demo, /pricing, /demo is led to by /pricing, not by /demo.
         argMaxIf(v.path, v.ts, v.ts <= c.at AND v.path != c.conv_path) AS from_page,
         countIf(v.ts <= c.at AND v.path != c.conv_path) AS earlier,
         anyIf(v.title, v.title != '') AS title
       FROM conv_events AS c
       LEFT JOIN views AS v ON v.session_id = c.session_id
       GROUP BY c.session_id, c.conv_path
     ),
     totals AS (SELECT uniqExact(session_id) AS n, uniqExactIf(session_id, earlier = 0) AS arrivals FROM resolved),
     roles AS (
       SELECT session_id, conv_path AS page, title, 'on' AS role FROM resolved
       UNION ALL
       SELECT session_id, from_page AS page, title, 'from' AS role FROM resolved WHERE earlier > 0
     )
     SELECT
       ${key} AS key,
       anyIf(title, title != '') AS title,
       uniqExactIf(session_id, role = 'on') AS converted_on,
       uniqExactIf(session_id, role = 'from') AS led_to,
       (SELECT n FROM totals) AS total,
       (SELECT arrivals FROM totals) AS on_arrival
     FROM roles
     GROUP BY key
     ORDER BY converted_on + led_to DESC
     LIMIT ${limit}`,
    { ...params, ...p.values },
  );

  return {
    rows: rows.map((r) => {
      const convertedOn = num(r.converted_on);
      const ledTo = num(r.led_to);
      return {
        path: String(r.key ?? ""),
        title: String(r.title ?? ""),
        converted_on: convertedOn,
        led_to: ledTo,
        involved: convertedOn + ledTo,
      };
    }),
    total: num(rows[0]?.total),
    on_arrival: num(rows[0]?.on_arrival),
  };
}

// ---------- one goal, and the people behind the number ----------

/**
 * A goal's completions over time, as a count rather than a rate.
 *
 * The rate chart beside it answers "is this working"; this answers "how much of it is
 * there", and the two move independently — a campaign that doubles traffic at a
 * slightly worse rate raises this line and lowers that one, and a reader who only has
 * the rate reads that as a failure.
 *
 * Counted as converting sessions, the same unit as the Goal performance table above it,
 * so a point on this line and a row in that table are the same number over a narrower
 * window. Not raw events: a visit that fires the goal twice is one conversion in both.
 */
export async function conversionVolume(w: WebScope): Promise<SeriesPoint[]> {
  if (!hasGoal(w)) return [];
  const { cte, params } = sessionBase(w);
  const p = new Params("cv");
  const bucket = (col: string) => bucketSql(col, w.range.interval, w.range.timezone);
  const shift = `started_at + toIntervalMillisecond({shift:Int64})`;
  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${denseBuckets(w, p)}
     SELECT b.bucket AS bucket, ifNull(a.value, 0) AS value, ifNull(a.previous, 0) AS previous
     FROM buckets AS b
     LEFT JOIN (
       SELECT bucket, sumIf(v, series = 'current') AS value, sumIf(v, series = 'previous') AS previous FROM (
         SELECT ${bucket("started_at")} AS bucket, 'current' AS series, uniqExactIf(session_id, converted = 1) AS v
         FROM scoped WHERE period = 'current' GROUP BY bucket
         UNION ALL
         SELECT ${bucket(shift)} AS bucket, 'previous' AS series, uniqExactIf(session_id, converted = 1) AS v
         FROM scoped WHERE period = 'previous' GROUP BY bucket
       ) GROUP BY bucket
     ) AS a ON a.bucket = b.bucket
     ORDER BY b.bucket`,
    { ...params, ...p.values, tz: w.range.timezone, shift: alignOffsetMs(w.range) },
  );
  return rows.map((r) => ({ bucket: String(r.bucket), value: num(r.value), previous: hasPrev(w) ? num(r.previous) : null }));
}

/**
 * One person who completed a goal, as the drilldown lists them.
 *
 * `person_id` is the visitor resolved through identity_map — the same id the user page
 * is keyed on — so anonymous browsing that later identified is one row here and not two.
 */
export interface GoalConverterRow {
  person_id: string;
  is_identified: boolean;
  traits: Record<string, unknown>;
  group_id: string;
  country: string;
  city: string;
  /**
   * Times they completed it. Deliberately not the same unit as the goal table's
   * converting sessions: this is the drilldown, and "converted three times" is the
   * fact a person-level list exists to carry.
   */
  completions: number;
  /** Visits in which they completed it — which IS the table's unit, for reconciliation. */
  sessions: number;
  first_at: string;
  last_at: string;
  /** The page the most recent completion fired on. Blank for events sent without one. */
  last_path: string;
}

export interface GoalDetail {
  id: string;
  name: string;
  type: GoalType;
  /** The rule as it compiles, so the drawer can say what it counts and link to its events. */
  match: GoalConfig;
  split: GoalSplit | null;
  /** Distinct people who completed it, whatever the list below was truncated to. */
  people: Delta;
  /** Visits in which it was completed. The Goal performance table's number, exactly. */
  sessions: Delta;
  /** Every completion, counting repeats. Always at least `sessions`. */
  completions: Delta;
  /**
   * Completing visits over all visits in scope. For a supporting action this is a
   * participation rate and not a conversion rate, which the UI has to say.
   */
  rate: RateDelta;
  trend: SeriesPoint[];
  converters: GoalConverterRow[];
  /** How many people there are in total, so a truncated list can say what it is missing. */
  total_people: number;
}

const parseTraits = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "string" || v === "") return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Everything behind one row of the Goal performance table.
 *
 * The point of this existing at all: the Events view can list a goal's events, but it
 * cannot apply the control bar. "Who signed up" and "who signed up from paid search on
 * mobile in Germany" are different questions, and until now the second one had no
 * answer — following the Events link silently widened the filters back out and handed
 * back a longer list that looked like the same one.
 *
 * So this is counted off `sessionBase` like every other number in the section, which is
 * what makes the totals here reconcile with the row that was clicked rather than merely
 * resemble it.
 *
 * The goal is named explicitly rather than read from the scope: the drilldown is opened
 * on a row, and which goal the reader happens to have *selected* must not change what
 * the drawer over it is describing.
 */
export async function goalDetail(w: WebScope, goal: Goal, opts: { limit?: number } = {}): Promise<GoalDetail> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const [totals, trend, converters] = await Promise.all([
    goalTotals(w, goal),
    goalTrend(w, goal),
    goalConverters(w, goal, limit),
  ]);
  return {
    id: goal.id,
    name: goal.name,
    type: goal.config.type,
    match: goal.config,
    split: goal.split ?? null,
    ...totals,
    trend,
    converters: converters.rows,
    total_people: converters.total,
  };
}

/** The named goal's own flag per session, whatever the reader has selected. */
function goalActs(goal: Goal, p: Params, project: string, scanFrom: string, scanTo: string): string {
  // Compiled once and used twice: `matchSql` mints a fresh parameter per call, and two
  // copies of the same rule would bind the same values under different names.
  const hit = matchSql(goal.config, p);
  return `acts AS (
     SELECT
       session_id,
       max(${hit}) AS did,
       countIf(${hit}) AS n
     FROM events
     WHERE project_id = ${project} AND session_id != ''
       AND timestamp >= ${scanFrom} AND timestamp < ${scanTo}
     GROUP BY session_id
   )`;
}

async function goalTotals(w: WebScope, goal: Goal): Promise<Pick<GoalDetail, "people" | "sessions" | "completions" | "rate">> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("gt");
  const [r] = await q<Row>(
    w.scope,
    `${cte},
     ${goalActs(goal, p, project, scanFrom, scanTo)}
     SELECT
       uniqExactIf(s.session_id, s.period = 'current' AND ifNull(h.did, 0) = 1) AS sessions,
       uniqExactIf(s.session_id, s.period = 'previous' AND ifNull(h.did, 0) = 1) AS prev_sessions,
       uniqExactIf(s.person_id, s.period = 'current' AND ifNull(h.did, 0) = 1) AS people,
       uniqExactIf(s.person_id, s.period = 'previous' AND ifNull(h.did, 0) = 1) AS prev_people,
       sumIf(ifNull(h.n, 0), s.period = 'current') AS completions,
       sumIf(ifNull(h.n, 0), s.period = 'previous') AS prev_completions,
       ${qualified(AGG.sessions)} AS all_sessions,
       ${qualified(AGG.prevSessions)} AS prev_all_sessions
     FROM scoped AS s LEFT JOIN acts AS h ON h.session_id = s.session_id`,
    { ...params, ...p.values },
  );
  const cur = num(r?.sessions);
  const prev = num(r?.prev_sessions);
  return {
    people: delta(num(r?.people), prevOr(w, num(r?.prev_people))),
    sessions: delta(cur, prevOr(w, prev)),
    completions: delta(num(r?.completions), prevOr(w, num(r?.prev_completions))),
    rate: rateDelta([cur, num(r?.all_sessions)], prevOr(w, [prev, num(r?.prev_all_sessions)] as [number, number])),
  };
}

/** This goal's completing visits per bucket, with the comparison period aligned onto it. */
async function goalTrend(w: WebScope, goal: Goal): Promise<SeriesPoint[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("gr");
  const bucket = (col: string) => bucketSql(col, w.range.interval, w.range.timezone);
  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${denseBuckets(w, p)},
     ${goalActs(goal, p, project, scanFrom, scanTo)}
     SELECT b.bucket AS bucket, ifNull(a.value, 0) AS value, ifNull(a.previous, 0) AS previous
     FROM buckets AS b
     LEFT JOIN (
       SELECT bucket, sumIf(v, series = 'current') AS value, sumIf(v, series = 'previous') AS previous FROM (
         SELECT ${bucket("s.started_at")} AS bucket, 'current' AS series, uniqExact(s.session_id) AS v
         FROM scoped AS s INNER JOIN acts AS h ON h.session_id = s.session_id
         WHERE s.period = 'current' AND h.did = 1 GROUP BY bucket
         UNION ALL
         SELECT ${bucket("s.started_at + toIntervalMillisecond({shift:Int64})")} AS bucket, 'previous' AS series, uniqExact(s.session_id) AS v
         FROM scoped AS s INNER JOIN acts AS h ON h.session_id = s.session_id
         WHERE s.period = 'previous' AND h.did = 1 GROUP BY bucket
       ) GROUP BY bucket
     ) AS a ON a.bucket = b.bucket
     ORDER BY b.bucket`,
    { ...params, ...p.values, tz: w.range.timezone, shift: alignOffsetMs(w.range) },
  );
  return rows.map((r) => ({ bucket: String(r.bucket), value: num(r.value), previous: hasPrev(w) ? num(r.previous) : null }));
}

/**
 * The people themselves, most recent completion first.
 *
 * Ordered by recency rather than by volume because the question this answers is "who is
 * doing this now" — a list topped by whoever has the biggest count is a leaderboard, and
 * a leaderboard is stable for weeks while the thing a reader opened the drawer to see
 * changes every day.
 */
async function goalConverters(w: WebScope, goal: Goal, limit: number): Promise<{ rows: GoalConverterRow[]; total: number }> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("gc");
  const rows = await q<Row>(
    w.scope,
    `${cte},
     conv AS (
       SELECT b.person_id AS person_id, b.session_id AS session_id, e.timestamp AS ts, ${normalizedPath("e.path")} AS path
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND b.period = 'current'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
         AND ${matchSql(goal.config, p)}
     ),
     people AS (
       SELECT
         person_id,
         count() AS completions,
         uniqExact(session_id) AS sessions,
         min(ts) AS first_at,
         max(ts) AS last_at,
         argMax(path, ts) AS last_path
       FROM conv GROUP BY person_id
     )
     SELECT
       pe.person_id AS person_id,
       pe.completions AS completions,
       pe.sessions AS sessions,
       pe.first_at AS first_at,
       pe.last_at AS last_at,
       pe.last_path AS last_path,
       (SELECT uniqExact(person_id) FROM conv) AS total_people,
       ifNull(st.is_identified, 0) AS is_identified,
       ifNull(st.group_id, '') AS group_id,
       ifNull(st.country, '') AS country,
       ifNull(st.city, '') AS city,
       ifNull(tr.traits, '') AS traits
     FROM people AS pe
     LEFT JOIN (
       SELECT person_id, is_identified, group_id, country, city FROM person_stats WHERE project_id = ${project}
     ) AS st ON st.person_id = pe.person_id
     LEFT JOIN (
       SELECT user_id, traits FROM user_traits FINAL WHERE project_id = ${project}
     ) AS tr ON tr.user_id = pe.person_id
     ORDER BY last_at DESC
     LIMIT ${limit}`,
    { ...params, ...p.values },
  );
  return {
    rows: rows.map((r) => ({
      person_id: String(r.person_id ?? ""),
      is_identified: num(r.is_identified) === 1,
      traits: parseTraits(r.traits),
      group_id: String(r.group_id ?? ""),
      country: String(r.country ?? ""),
      city: String(r.city ?? ""),
      completions: num(r.completions),
      sessions: num(r.sessions),
      first_at: String(r.first_at ?? ""),
      last_at: String(r.last_at ?? ""),
      last_path: String(r.last_path ?? ""),
    })),
    total: num(rows[0]?.total_people),
  };
}
