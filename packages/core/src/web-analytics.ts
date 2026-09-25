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
import { browserSql, channelSql, deviceSql, referrerSql } from "./classify";
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
  /** The site or app that sent the visit, as classifyReferrer names it: "X", "LinkedIn", "someblog.dev". */
  referrer?: string | null;
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
  eq(referrerSql({ utm_source: "s.utm_source", referrer_host: "s.referrer_host", entry_host: "s.entry_host" }), filters.referrer);
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
      -- Normalised, except that empty stays empty. A visit with no page view — events
      -- only, the 'Unattributed' channel — has no landing page and no exit page, and
      -- every report tells it apart by entry_path = ''. normalizedPath() reads an empty
      -- path as the root, which is right for a page view and wrong here: it would land
      -- every one of those visits on "/", as a bounce, and exit them there too.
      if(s.entry_path = '', '', ${normalizedPath("s.entry_path")}) AS entry_path,
      if(s.exit_path = '', '', ${normalizedPath("s.exit_path")}) AS exit_path,
      s.entry_title AS entry_title,
      s.channel AS channel,
      s.utm_source AS utm_source,
      s.utm_medium AS utm_medium,
      s.utm_campaign AS utm_campaign,
      s.referrer_host AS referrer_host,
      ${referrerSql({ utm_source: "s.utm_source", referrer_host: "s.referrer_host", entry_host: "s.entry_host" })} AS referrer,
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

// ---------- did the people who reached a page go on to convert ----------

/**
 * Of the people whose visit reached a page, how many went on to convert — in that same
 * visit, or by coming back another time.
 *
 * Counted in people, not visits, because "came back later" is a fact about a person:
 * the visit that read the page and the visit that converted are different rows, and
 * only the person joins them. A person is counted once per page however many of their
 * visits reached it, and falls into at most one of the two halves — the same visit
 * wins — so `same_visit + later_visit` is exactly the numerator of `rate`.
 *
 * The conversion has to come at or after the page was reached. Someone who signed up
 * and then read the docs did not go on to convert from the docs; they had already done
 * it. And it is looked for up to now rather than up to the end of the period, since
 * "later" is the whole point — so a page read last week has had less time to be
 * followed by a return visit than one read last month, and a range that ends today
 * reads lower than the same range seen a month from now.
 *
 * Only the visit that reached the page is held to the report's filters. The visit that
 * converted is whatever it turned out to be — a paid-search reader who came back
 * direct a week later still went on to convert — and it may be on another source: a
 * marketing page read before signing up in the app is exactly the case this is for.
 *
 * Still an association. People who were going to convert anyway read the pricing page,
 * and the UI says so beside the number.
 */
export interface WentOn {
  /** People whose visit reached the page in the period: the denominator. */
  people: number;
  /** Converted in a visit that reached the page, after reaching it. */
  same_visit: number;
  /** Did not, but converted on a later visit. */
  later_visit: number;
  /** (same_visit + later_visit) of people. */
  rate: RateValue;
}

function wentOn(people: number, sameVisit: number, laterVisit: number): WentOn {
  return { people, same_visit: sameVisit, later_visit: laterVisit, rate: rate(sameVisit + laterVisit, people) };
}

/**
 * The CTEs that answer it, keyed however the caller keyed its `touches`.
 *
 * `touches` is one row per (key, person_id, session_id, reached_at): the moment a visit
 * in the current period first reached the thing being reported on — a page, a group,
 * or the site itself for the baseline. The result is `went_on (key, wo_people, wo_same,
 * wo_later)`. The column names are prefixed because ClickHouse resolves an -If
 * condition against aliases declared in the same SELECT (see conversionCredit), and a
 * count named `same_visit` beside a per-person flag of the same name is how that bites.
 */
function wentOnCtes(w: WebScope, p: Params, project: string, touches: string): string {
  const conversion = conversionMatchSql(w, p);
  const from = `{${p.add(chTime(w.range.current.from))}:DateTime64(3,'UTC')}`;
  return `touches AS (${touches}),
   conv_events AS (
     -- No upper bound: a return visit next week is still "went on to convert".
     SELECT session_id, timestamp AS ts
     FROM events
     WHERE project_id = ${project} AND session_id != '' AND timestamp >= ${from}
       AND (${conversion})
   ),
   conv_by_session AS (
     SELECT session_id, max(ts) AS last_at, count() AS n FROM conv_events GROUP BY session_id
   ),
   conv_by_person AS (
     -- Resolved through the session, the way every visitor in these reports is, so the
     -- person who converted is the same id as the person who read the page.
     SELECT r.person_id AS person_id, max(c.last_at) AS last_at, sum(c.n) AS n
     FROM conv_by_session AS c
     INNER JOIN (
       SELECT session_id, person_id FROM sessions_resolved
       WHERE project_id = ${project} AND session_id IN (SELECT session_id FROM conv_events)
     ) AS r ON r.session_id = c.session_id
     GROUP BY person_id
   ),
   reached AS (
     SELECT
       t.key AS key,
       t.person_id AS person_id,
       min(t.reached_at) AS first_reached,
       -- Guarded on the join having matched: an unmatched row carries the epoch and a
       -- zero count, and the count is what says so.
       max(toUInt8(cs.n > 0 AND cs.last_at >= t.reached_at)) AS in_visit
     FROM touches AS t
     LEFT JOIN conv_by_session AS cs ON cs.session_id = t.session_id
     GROUP BY key, person_id
   ),
   went_on AS (
     SELECT
       r.key AS key,
       uniqExact(r.person_id) AS wo_people,
       uniqExactIf(r.person_id, r.in_visit = 1) AS wo_same,
       uniqExactIf(r.person_id, r.in_visit = 0 AND cp.n > 0 AND cp.last_at >= r.first_reached) AS wo_later
     FROM reached AS r
     LEFT JOIN conv_by_person AS cp ON cp.person_id = r.person_id
     GROUP BY key
   )`;
}

/** Visits that started on a page reach it when they start. */
const landingTouches = (key: string, where = "1 = 1") =>
  `SELECT ${key} AS key, person_id, session_id, started_at AS reached_at
   FROM scoped WHERE period = 'current' AND entry_path != '' AND ${where}`;

/** Any other visit reaches a page at its first view of it. */
const viewTouches = (key: string, project: string, scanFrom: string, scanTo: string, where = "1 = 1") =>
  `SELECT ${key} AS key, b.person_id AS person_id, b.session_id AS session_id, min(e.timestamp) AS reached_at
   FROM events AS e
   INNER JOIN scoped AS b ON b.session_id = e.session_id
   WHERE e.project_id = ${project} AND e.session_id != '' AND e.type = 'page' AND b.period = 'current'
     AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo} AND ${where}
   GROUP BY key, person_id, session_id`;

async function wentOnTotal(w: WebScope, touches: (b: Base) => string, p: Params): Promise<WentOn | null> {
  if (!hasGoal(w)) return null;
  const b = sessionBase(w);
  const [r] = await q<Row>(
    w.scope,
    `${b.cte}, ${wentOnCtes(w, p, b.project, touches(b))}
     SELECT sum(wo_people) AS people, sum(wo_same) AS same, sum(wo_later) AS later FROM went_on`,
    { ...b.params, ...p.values },
  );
  return wentOn(num(r?.people), num(r?.same), num(r?.later));
}

/**
 * The same question asked of every visitor in the report: of the people with a visit in
 * the period, how many converted at or after its start. A page's own rate means little
 * on its own — 4% is excellent on a site where 1% of visitors ever convert and poor on
 * one where 10% do — and this is what it has to be read against.
 */
export function wentOnBaseline(w: WebScope): Promise<WentOn | null> {
  return wentOnTotal(w, () => `SELECT '' AS key, person_id, session_id, started_at AS reached_at FROM scoped WHERE period = 'current'`, new Params("wb"));
}

/**
 * The typed search on a page table, as a HAVING clause over the row's key.
 *
 * A HAVING and never a WHERE: it chooses which rows to show and must not change what is
 * on them. Filtering the underlying views by title in a WHERE would drop the views of a
 * page whose title changed during the period and quietly shrink the row that is left —
 * a search that edits the numbers it finds.
 *
 * A pasted URL is searched for by its path, because that is what a row is keyed on and
 * nobody means the scheme.
 */
export function pageSearchNeedle(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      // not a URL after all; search for what was typed
    }
  }
  return s ? s.slice(0, 200) : null;
}

/** A bound needle, and the predicate that looks for it in a column. Null when nothing was typed. */
function pageSearch(raw: string | null | undefined, p: Params): { matches: (col: string) => string } | null {
  const needle = pageSearchNeedle(raw);
  if (!needle) return null;
  const q = `{${p.add(needle)}:String}`;
  return { matches: (col) => `positionCaseInsensitiveUTF8(${col}, ${q}) > 0` };
}

// ---------- sorting the page tables ----------

/** What each page table can be sorted by. The route accepts these names and nothing else. */
export const LANDING_SORTS = ["path", "landing_sessions", "engagement_rate", "converting_sessions", "conversion_rate", "went_on", "change"] as const;
export const PAGE_SORTS = ["path", "unique_viewers", "pageviews", "avg_engagement", "exit_rate", "cta_clickers", "went_on"] as const;
export type LandingSort = (typeof LANDING_SORTS)[number];
export type PageSort = (typeof PAGE_SORTS)[number];
export interface TableSort<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

/**
 * One ORDER BY, from a column's value and what breaks its ties.
 *
 * Applied before the LIMIT, over every row the report has, so sorting by exit rate finds
 * the highest exit rate on the site rather than the highest among the fifty busiest
 * pages — the same reason the search runs on the server.
 *
 * A value that cannot be computed — a rate over nothing, engagement nobody measured —
 * sorts last in either direction: it is not the lowest value, it is not a value. And a
 * rate's ties go to the larger denominator whichever way the column is sorted, so 100% of
 * forty views comes before 100% of one; the "1 of 1" rows are still there, and their
 * working is on the row, but they do not win a tie against evidence.
 */
function sortSql(value: string, dir: "asc" | "desc", ties: string[]): string {
  return [`${value} ${dir === "asc" ? "ASC" : "DESC"} NULLS LAST`, ...ties].join(", ");
}

/** A rate as a sortable value: null, not zero, when there is nothing to divide by. */
const rateSql = (numerator: string, denominator: string) => `if(${denominator} > 0, ${numerator} / ${denominator}, NULL)`;

/**
 * The period-over-period change as a sortable value. Up from nothing is the largest rise
 * there is, so it sorts as infinity rather than as missing; with comparison off, or with
 * nothing in either period, there is no change to rank and it goes last.
 */
const changeSql = (cur: string, prev: string) => `multiIf(${prev} > 0, (${cur} - ${prev}) / ${prev}, ${cur} > 0, inf, NULL)`;

export interface LandingPageRow {
  path: string;
  title: string;
  landing_sessions: Delta;
  engagement_rate: RateValue;
  converting_sessions: number;
  conversion_rate: RateValue;
  /** People who landed here and converted then or later. Null when no goal is configured. */
  went_on: WentOn | null;
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
  opts: {
    limit?: number;
    groupBy?: "page" | "group";
    orderBy?: "landing_sessions" | "converting_sessions";
    /** Typed by the reader: rows whose page, title or group name contains it. */
    search?: string | null;
    /** A column the reader sorted by. Takes precedence over `orderBy`, and changes only the order. */
    sort?: TableSort<LandingSort> | null;
  } = {},
): Promise<LandingPageRow[]> {
  const { cte, params, project } = sessionBase(w);
  const p = new Params("lp");
  const isGroups = opts.groupBy === "group";
  const key = isGroups ? pageGroupSql(w.pageGroups, "entry_path", p) : "entry_path";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  // Ranked by conversions, the busiest page is not usually the top row — which is the
  // point of asking. Sessions break the tie so a page with one of each does not outrank
  // a page with one conversion from a hundred visits by accident of ordering.
  const byConversions = opts.orderBy === "converting_sessions" && !opts.sort;
  // Ranked by conversions, a page with none is not a low-ranking row — it is not a row.
  // Ranked by traffic it is, because then the question is where people land. A column
  // the reader sorted by is the second case: sorting reorders the table, it does not
  // decide what is in it.
  const having = byConversions ? "converting > 0" : "sessions > 0 OR prev_sessions > 0";
  // A group is found by its name; a page by its path or by any title it had.
  const search = pageSearch(opts.search, p);
  const titleHit = search && !isGroups ? `, max(${search.matches("entry_title")}) AS title_hit` : "";
  const searchHaving = search ? ` AND (${search.matches("key")}${titleHit ? " OR title_hit = 1" : ""})` : "";
  const withWent = hasGoal(w);
  const sort: TableSort<LandingSort> = opts.sort ?? { key: byConversions ? "converting_sessions" : "landing_sessions", dir: "desc" };
  const went = "(wo_same + wo_later)";
  const order = (() => {
    const busiest = ["l.sessions DESC", "row_key ASC"];
    switch (sort.key) {
      case "path":
        return sortSql("row_key", sort.dir, []);
      case "engagement_rate":
        return sortSql(rateSql("l.engaged_sessions", "l.sessions"), sort.dir, busiest);
      case "converting_sessions":
        return sortSql("l.converting", sort.dir, busiest);
      case "conversion_rate":
        return sortSql(rateSql("l.converting", "l.sessions"), sort.dir, busiest);
      case "went_on":
        return withWent ? sortSql(rateSql(went, "wo_people"), sort.dir, [`${went} DESC`, "wo_people DESC", ...busiest]) : busiest.join(", ");
      case "change":
        return sortSql(changeSql("l.sessions", "l.prev_sessions"), sort.dir, busiest);
      default:
        return sortSql("l.sessions", sort.dir, ["row_key ASC"]);
    }
  })();

  const rows = await q<Row>(
    w.scope,
    `${cte}${withWent ? `, ${wentOnCtes(w, p, project, landingTouches(key))}` : ""}
     SELECT l.*, l.key AS row_key${withWent ? ", ifNull(g.wo_people, 0) AS wo_people, ifNull(g.wo_same, 0) AS wo_same, ifNull(g.wo_later, 0) AS wo_later" : ""}
     FROM (
       SELECT
         ${key} AS key,
         any(entry_title) AS title,
         ${AGG.sessions} AS sessions,
         ${AGG.prevSessions} AS prev_sessions,
         ${AGG.engagedSessions} AS engaged_sessions,
         ${AGG.converting} AS converting
         ${titleHit}
       FROM scoped
       WHERE entry_path != ''
       GROUP BY key
       HAVING (${having})${searchHaving}
     ) AS l
     ${withWent ? "LEFT JOIN went_on AS g ON g.key = l.key" : ""}
     -- Ordered and limited after the join, so a sort on went-on ranks every page by it.
     ORDER BY ${order}
     LIMIT ${limit}`,
    { ...params, ...p.values },
  );
  return rows.map((r) => {
    const sessions = num(r.sessions);
    return {
      path: String(r.row_key),
      title: String(r.title ?? ""),
      landing_sessions: delta(sessions, prevOr(w, num(r.prev_sessions))),
      engagement_rate: rate(num(r.engaged_sessions), sessions),
      converting_sessions: num(r.converting),
      conversion_rate: rate(num(r.converting), sessions),
      went_on: withWent ? wentOn(num(r.wo_people), num(r.wo_same), num(r.wo_later)) : null,
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
  /** People who viewed it and converted afterwards, then or later. Null when no goal is configured. */
  went_on: WentOn | null;
}


/**
 * All pages: every page that was viewed, however the visit started.
 *
 * This deliberately carries no per-visit conversion rate. "Visits that included this
 * page, and converted" is a correlation a table cannot separate from "everybody passes
 * through here", and a conversion column next to a page name is read as a claim that
 * the page caused it. What it carries instead is `went_on`: people, counted only for
 * conversions that came after they saw the page, and read against a site-wide baseline
 * in the UI — the same association, stated in the terms that make it hard to misread.
 */
export async function allPages(
  w: WebScope,
  opts: { limit?: number; groupBy?: "page" | "group"; search?: string | null; sort?: TableSort<PageSort> | null } = {},
): Promise<PageRow[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("ap");
  const isGroups = opts.groupBy === "group";
  const key = isGroups ? pageGroupSql(w.pageGroups, "e.path", p) : normalizedPath("e.path");
  const search = pageSearch(opts.search, p);
  // Qualified, because the SELECT this lands in also declares `anyIf(title, …) AS title`,
  // and a bare `title` beside it resolves to that aggregate rather than the column.
  const titleHit = search && !isGroups ? `, maxIf(${search.matches("pe.title")}, pe.type = 'page') AS title_hit` : "";
  const searchHaving = search ? ` AND (${search.matches("key")}${titleHit ? " OR title_hit = 1" : ""})` : "";
  const withWent = hasGoal(w);
  // Read off page_events, which has already joined every view to its visit: the first
  // view of each page in each visit is where that visit reached it.
  const touches = `SELECT key, person_id, session_id, min(ts) AS reached_at
     FROM page_events WHERE period = 'current' AND type = 'page'
     GROUP BY key, person_id, session_id`;
  // The same key, applied to where the visit stopped. `exit_path` arrives from `base`
  // already normalised, so it is compared against the page key on equal terms; the group
  // expression normalises its own operand and is safe to apply a second time.
  const exitKey = opts.groupBy === "group" ? pageGroupSql(w.pageGroups, "exit_path", p) : "exit_path";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const sort: TableSort<PageSort> = opts.sort ?? { key: "pageviews", dir: "desc" };
  const went = "(wo_same + wo_later)";
  const order = (() => {
    const busiest = ["t.pageviews DESC", "row_key ASC"];
    switch (sort.key) {
      case "path":
        return sortSql("row_key", sort.dir, []);
      case "unique_viewers":
        return sortSql("t.viewers", sort.dir, busiest);
      case "avg_engagement":
        return sortSql(rateSql("t.eng_total", "t.measured"), sort.dir, ["t.measured DESC", ...busiest]);
      case "exit_rate":
        return sortSql(rateSql("exits", "t.settled_views"), sort.dir, ["t.settled_views DESC", ...busiest]);
      case "cta_clickers":
        return sortSql("t.cta_clickers", sort.dir, busiest);
      case "went_on":
        return withWent ? sortSql(rateSql(went, "wo_people"), sort.dir, [`${went} DESC`, "wo_people DESC", ...busiest]) : busiest.join(", ");
      default:
        return sortSql("t.pageviews", sort.dir, ["row_key ASC"]);
    }
  })();

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
         b.session_id AS session_id,
         e.timestamp AS ts,
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
     ),${withWent ? `\n     ${wentOnCtes(w, p, project, touches)},` : ""}
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
         ${titleHit}
       FROM page_events AS pe
       GROUP BY key
       HAVING (pageviews > 0 OR prev_pageviews > 0)${searchHaving}
     )
     -- The key under a name of its own: with a second join, ClickHouse names the
     -- column from \`t.*\` "t.key" to tell it from the other tables' keys, and a row
     -- read by \`key\` then comes back with no path at all.
     SELECT t.*, t.key AS row_key, ifNull(x.exits, 0) AS exits${withWent ? ", ifNull(g.wo_people, 0) AS wo_people, ifNull(g.wo_same, 0) AS wo_same, ifNull(g.wo_later, 0) AS wo_later" : ""}
     FROM totals AS t
     LEFT JOIN exits AS x ON x.key = t.key
     ${withWent ? "LEFT JOIN went_on AS g ON g.key = t.key" : ""}
     ORDER BY ${order}
     LIMIT ${limit}`,
    { ...params, ...p.values, leave: PAGE_LEAVE, settled: SESSION_SETTLED_MS },
  );

  return rows.map((r) => {
    const measured = num(r.measured);
    return {
      path: String(r.row_key),
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
      went_on: withWent ? wentOn(num(r.wo_people), num(r.wo_same), num(r.wo_later)) : null,
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

/**
 * Which visits a page's drawer describes.
 *
 * `landing` is the visits that started on the page — the Landing pages tab's row, and
 * the only population a per-visit conversion rate is honest for. `viewers` is every
 * visit that included it however it began — the All pages tab's row. The drawer opens
 * on whichever tab the reader came from and can switch, and every section of it follows
 * the switch: a trend of landings above a list of where *all* viewers came from would be
 * two populations presented as one.
 */
export type PageBasis = "landing" | "viewers";

export interface PageDetail {
  path: string;
  title: string;
  basis: PageBasis;
  trend: SeriesPoint[];
  /** Channel, then referrer, then campaign, each with the quality figures for its own visits. */
  source_tree: SourceNode[];
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
  pageviews: Delta;
  /** Visits that included the page at all, however they began. */
  sessions: Delta;
  /** Of the visits that landed here, the same number as the Landing pages row. */
  landing_engagement_rate: RateValue;
  /** Of the visits that landed here. Null when no goal is configured. */
  landing_conversion_rate: RateValue | null;
  /** For the basis on screen. Null when no goal is configured. */
  went_on: WentOn | null;
  /** The same question of every visitor in the report, to read `went_on` against. */
  went_on_baseline: WentOn | null;
  /**
   * Mean measured foreground time per view of the page, among the visits on the basis.
   * Null when nothing was measured, which is not zero. On the viewers basis it is the All
   * pages row's figure; on the landing basis, the same measurement taken only in visits
   * that started here.
   */
  avg_engagement_ms: number | null;
  /** Views that reported a measurement: the denominator of `avg_engagement_ms`. */
  measured_views: number;
  /** Landing basis only; null on the viewers basis. See PageTimePoint. */
  bounce_rate: RateValue | null;
  /** Viewers basis only, and the All pages row's number; null on the landing basis. */
  exit_rate: RateValue | null;
  /** The figures above, bucket by bucket. Every bucket in the period, sums to them exactly. */
  over_time: PageTimePoint[];
  /**
   * How the visits on the basis arrived, bucket by bucket: the five biggest channels over
   * the period and the rest as "Other channels", the same bands the Acquisition chart uses.
   */
  channels_over_time: { channels: string[]; points: StackedPoint[] };
}

/**
 * The drawer's quality figures for one slice of the visits on a basis: a bucket of the
 * chart, or a channel, referrer or campaign in the source tree.
 *
 * Each rate is present only on the basis it is honest for, and null on the other:
 *
 *  - Engagement and bounce describe visits that *started* here. Over every visit that
 *    included the page they are mostly arithmetic — a visit that reached this page from
 *    another one has seen two pages, so it is engaged and did not bounce, whatever the
 *    page did — and an inner page would read as near-perfect for reasons of its position.
 *  - Exit rate describes views of the page, however the visit began. Restricted to
 *    visits that landed here, it is the bounce rate again under another name.
 *  - Conversion rate per visit is the landing rate, for the reason the Landing pages
 *    table gives: over every visit that included a page it flatters the pages people
 *    pass on their way to converting anyway.
 *
 * Bounce and exit count only visits that have gone quiet for SESSION_SETTLED_MS, on both
 * sides of the division — someone still reading the page has not left it — so in a live
 * slice their denominators are smaller than the visit count beside them.
 */
export interface PageQualityFigures {
  /** Null where nothing was measured: a gap in the line, not a zero. */
  avg_engagement_ms: number | null;
  measured_views: number;
  engagement_rate: RateValue | null;
  bounce_rate: RateValue | null;
  exit_rate: RateValue | null;
  /** Landing basis with a goal configured; null otherwise. */
  conversion_rate: RateValue | null;
}

/**
 * One bucket of the chart. A visit belongs to the bucket it started in, as it belongs to
 * the period it started in, so every count is additive across buckets and the headline
 * figures are their sums.
 */
export interface PageTimePoint extends PageQualityFigures {
  bucket: string;
}

/** One row of the source tree: a channel, a referrer within it, or a campaign within that. */
export interface SourceNode extends PageQualityFigures {
  /** The channel, referrer or campaign. Empty where the visits had none: no referrer to name, an untagged link. */
  key: string;
  level: "channel" | "referrer" | "campaign";
  visits: number;
  /** Of every visit on the basis, 0-100. */
  share: number;
  /** The row summing whatever is past the biggest few at its level. Not a value, so not one to filter by. */
  rest: boolean;
  children: SourceNode[];
}

export async function pageDetail(w: WebScope, path: string, opts: { basis?: PageBasis } = {}): Promise<PageDetail> {
  const basis = opts.basis ?? "landing";
  const [trendPoints, sourceTree, nextPages, actions, totals, went, baseline, quality, channels] = await Promise.all([
    pageTrend(w, path, basis),
    pageSourceTree(w, path, basis),
    nextPagesAfter(w, path, basis),
    pageActions(w, path, basis),
    pageTotals(w, path),
    pageWentOn(w, path, basis),
    wentOnBaseline(w),
    pageQuality(w, path, basis),
    pageChannels(w, path, basis),
  ]);
  return {
    path,
    title: totals.title,
    basis,
    trend: trendPoints,
    source_tree: sourceTree,
    next_pages: nextPages,
    actions,
    click_rate_basis: "page_viewers",
    landing_sessions: totals.landing_sessions,
    unique_viewers: totals.unique_viewers,
    pageviews: totals.pageviews,
    sessions: totals.sessions,
    landing_engagement_rate: totals.landing_engagement_rate,
    landing_conversion_rate: hasGoal(w) ? totals.landing_conversion_rate : null,
    went_on: went,
    went_on_baseline: baseline,
    ...quality,
    channels_over_time: channels,
  };
}

/**
 * The visits a basis covers, as a CTE named `page_sessions` over both periods.
 *
 * Views are matched on the normalised path exactly as the All pages row keys them, and
 * landings on `entry_path` exactly as the Landing pages row does, so the drawer's
 * numbers are the row's numbers rather than a near relation of them.
 */
function pageSessionsCte(basis: PageBasis, target: string, project: string, scanFrom: string, scanTo: string): string {
  return basis === "landing"
    ? `page_sessions AS (SELECT session_id FROM scoped WHERE entry_path = ${target})`
    : `page_sessions AS (
         SELECT DISTINCT e.session_id AS session_id
         FROM events AS e
         INNER JOIN scoped AS b ON b.session_id = e.session_id
         WHERE e.project_id = ${project} AND e.session_id != '' AND e.type = 'page'
           AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
           AND ${normalizedPath("e.path")} = ${target}
       )`;
}

interface PageTotals {
  title: string;
  landing_sessions: Delta;
  unique_viewers: Delta;
  pageviews: Delta;
  sessions: Delta;
  landing_engagement_rate: RateValue;
  landing_conversion_rate: RateValue;
}

async function pageTotals(w: WebScope, path: string): Promise<PageTotals> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("pt");
  const target = `{${p.add(path)}:String}`;
  // Two one-row aggregates side by side rather than a column of scalar subqueries, each
  // of which would re-read the page's views from scratch.
  const [r] = await q<Row>(
    w.scope,
    `${cte},
     views AS (
       SELECT b.period AS period, b.person_id AS person_id, b.session_id AS session_id, e.title AS title
       FROM events AS e
       INNER JOIN scoped AS b ON b.session_id = e.session_id
       WHERE e.project_id = ${project} AND e.session_id != '' AND e.type = 'page'
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
         AND ${normalizedPath("e.path")} = ${target}
     )
     SELECT v.*, l.*
     FROM (
       SELECT
         anyIf(title, title != '') AS page_title,
         uniqExactIf(person_id, period = 'current') AS viewers,
         uniqExactIf(person_id, period = 'previous') AS prev_viewers,
         countIf(period = 'current') AS pageviews,
         countIf(period = 'previous') AS prev_pageviews,
         uniqExactIf(session_id, period = 'current') AS visits,
         uniqExactIf(session_id, period = 'previous') AS prev_visits
       FROM views
     ) AS v
     CROSS JOIN (
       SELECT
         uniqExactIf(session_id, period = 'current') AS landing,
         uniqExactIf(session_id, period = 'previous') AS prev_landing,
         uniqExactIf(session_id, period = 'current' AND engaged = 1) AS landing_engaged,
         uniqExactIf(session_id, period = 'current' AND converted = 1) AS landing_converting
       FROM scoped WHERE entry_path = ${target}
     ) AS l`,
    { ...params, ...p.values },
  );
  const landing = num(r?.landing);
  return {
    title: String(r?.page_title ?? ""),
    landing_sessions: delta(landing, prevOr(w, num(r?.prev_landing))),
    unique_viewers: delta(num(r?.viewers), prevOr(w, num(r?.prev_viewers))),
    pageviews: delta(num(r?.pageviews), prevOr(w, num(r?.prev_pageviews))),
    sessions: delta(num(r?.visits), prevOr(w, num(r?.prev_visits))),
    landing_engagement_rate: rate(num(r?.landing_engaged), landing),
    landing_conversion_rate: rate(num(r?.landing_converting), landing),
  };
}

/** One page's went-on, counted exactly the way its table row is. */
function pageWentOn(w: WebScope, path: string, basis: PageBasis): Promise<WentOn | null> {
  const p = new Params("pw");
  const target = `{${p.add(path)}:String}`;
  return wentOnTotal(
    w,
    (b) =>
      basis === "landing"
        ? landingTouches("''", `entry_path = ${target}`)
        : viewTouches("''", b.project, b.scanFrom, b.scanTo, `${normalizedPath("e.path")} = ${target}`),
    p,
  );
}

async function pageTrend(w: WebScope, path: string, basis: PageBasis): Promise<SeriesPoint[]> {
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

type PageQuality = Pick<PageDetail, "avg_engagement_ms" | "measured_views" | "bounce_rate" | "exit_rate" | "over_time">;

/**
 * The counts every quality figure is divided out of. Each is a count of visits, or a sum
 * over visits, and a visit belongs to exactly one bucket and one channel, referrer and
 * campaign — so every one of them is additive: a total is the sum of its buckets, and a
 * channel the sum of its referrers.
 */
interface QualityCounts {
  visits: number;
  engaged: number;
  converting: number;
  /** Visits that have gone quiet for SESSION_SETTLED_MS: the bounce denominator. */
  finished: number;
  bounced: number;
  exits: number;
  /** This page's views in finished visits: the exit denominator. */
  finished_views: number;
  eng_total: number;
  measured: number;
}

/**
 * How each count is taken over `quality_visits`. Prefixed so that none shares a name
 * with a column its own -If condition reads: ClickHouse resolves those against the
 * SELECT's aliases first.
 */
const QUALITY_COUNTS: [keyof QualityCounts, string, string][] = [
  ["visits", "n_visits", "uniqExact(session_id)"],
  ["engaged", "n_engaged", "uniqExactIf(session_id, engaged = 1)"],
  ["converting", "n_converting", "uniqExactIf(session_id, converted = 1)"],
  ["finished", "n_finished", "uniqExactIf(session_id, is_settled = 1)"],
  ["bounced", "n_bounced", "uniqExactIf(session_id, is_bounce = 1)"],
  ["exits", "n_exits", "uniqExactIf(session_id, is_exit = 1)"],
  ["finished_views", "n_finished_views", "sum(finished_views)"],
  ["eng_total", "n_eng_total", "sum(eng_total)"],
  ["measured", "n_measured", "sum(measured)"],
];
const qualityCountsSql = QUALITY_COUNTS.map(([, name, expr]) => `${expr} AS ${name}`).join(",\n       ");
const countsOf = (r: Row): QualityCounts =>
  Object.fromEntries(QUALITY_COUNTS.map(([key, name]) => [key, num(r[name])])) as unknown as QualityCounts;
const addCounts = (a: QualityCounts, b: QualityCounts, sign = 1): QualityCounts =>
  Object.fromEntries(QUALITY_COUNTS.map(([key]) => [key, a[key] + sign * b[key]])) as unknown as QualityCounts;
const NO_COUNTS = Object.fromEntries(QUALITY_COUNTS.map(([key]) => [key, 0])) as unknown as QualityCounts;

/** The figures for one slice of the visits, each on the basis it is honest for. See PageQualityFigures. */
function qualityOf(c: QualityCounts, basis: PageBasis, withGoal: boolean): PageQualityFigures {
  const landing = basis === "landing";
  return {
    avg_engagement_ms: c.measured > 0 ? c.eng_total / c.measured : null,
    measured_views: c.measured,
    engagement_rate: landing ? rate(c.engaged, c.visits) : null,
    bounce_rate: landing ? rate(c.bounced, c.finished) : null,
    exit_rate: landing ? null : rate(c.exits, c.finished_views),
    conversion_rate: landing && withGoal ? rate(c.converting, c.visits) : null,
  };
}

/**
 * The visits on a basis, one row each, carrying everything the quality figures count
 * and everything they are sliced by. Ends in a CTE named `quality_visits`; the chart
 * groups it by bucket and the source tree by channel, referrer and campaign, so both
 * count the same visits the same way.
 *
 * Each measure is counted the way the row it matches counts it. A bounce is a finished
 * visit that saw one page — the "Left the site" row of the landing basis's next pages,
 * which follows the landing view and finds nothing after it. An exit is a finished visit
 * whose last view was this page, over this page's views in finished visits: the All
 * pages row, restricted to nothing. Time on the page is summed out of this page's own
 * $page_leave measurements, averaged over the views that reported one, as All pages does.
 */
function qualityVisitsCtes(basis: PageBasis, target: string, project: string, scanFrom: string, scanTo: string): string {
  return `${pageSessionsCte(basis, target, project, scanFrom, scanTo)},
     settled AS (
       SELECT session_id FROM scoped WHERE period = 'current'
       GROUP BY session_id HAVING max(ended_at) < now64(3) - toIntervalMillisecond({settled:Int64})
     ),
     page_visits AS (
       SELECT session_id, started_at, engaged, converted, pageviews, exit_path, channel, referrer, utm_campaign,
              toUInt8(session_id IN (SELECT session_id FROM settled)) AS is_settled
       FROM scoped
       WHERE period = 'current' AND session_id IN (SELECT session_id FROM page_sessions)
     ),
     on_page AS (
       -- This page's own views and measurements, once per visit, so the join below adds
       -- one row to each visit rather than one per event.
       SELECT
         e.session_id AS session_id,
         countIf(e.type = 'page') AS views,
         sumIf(JSONExtractUInt(e.properties, 'engaged_ms'), e.event = {leave:String}) AS eng_total,
         countIf(e.event = {leave:String} AND JSONExtractUInt(e.properties, 'engaged_ms') > 0) AS measured
       FROM events AS e
       WHERE e.project_id = ${project} AND e.session_id != ''
         AND e.timestamp >= ${scanFrom} AND e.timestamp < ${scanTo}
         AND ${normalizedPath("e.path")} = ${target}
         AND e.session_id IN (SELECT session_id FROM page_visits)
       GROUP BY session_id
     ),
     quality_visits AS (
       SELECT
         v.session_id AS session_id,
         v.started_at AS started_at,
         -- Labelled as the channel chart labels them, so a band and a row agree.
         if(v.channel = '', '(none)', v.channel) AS k_channel,
         v.referrer AS k_referrer,
         v.utm_campaign AS k_campaign,
         v.engaged AS engaged,
         v.converted AS converted,
         v.is_settled AS is_settled,
         toUInt8(v.is_settled = 1 AND v.pageviews <= 1) AS is_bounce,
         toUInt8(v.is_settled = 1 AND v.exit_path = ${target}) AS is_exit,
         if(v.is_settled = 1, o.views, 0) AS finished_views,
         o.eng_total AS eng_total,
         o.measured AS measured
       FROM page_visits AS v
       LEFT JOIN on_page AS o ON o.session_id = v.session_id
     )`;
}

/**
 * Time on the page, engagement, bounce and exit, per bucket and in total, for the visits
 * on the basis on screen. See PageQualityFigures for which rate belongs to which basis.
 *
 * One scan, counted per bucket, with the totals summed from the buckets in TypeScript
 * rather than asked for separately: a headline that is the sum of the chart beneath it
 * cannot disagree with it.
 */
async function pageQuality(w: WebScope, path: string, basis: PageBasis): Promise<PageQuality> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("pq");
  const target = `{${p.add(path)}:String}`;
  const withGoal = hasGoal(w);
  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${denseBuckets(w, p)},
     ${qualityVisitsCtes(basis, target, project, scanFrom, scanTo)}
     SELECT
       b.bucket AS bucket,
       ${QUALITY_COUNTS.map(([, name]) => `ifNull(a.${name}, 0) AS ${name}`).join(", ")}
     FROM buckets AS b
     LEFT JOIN (
       SELECT
         ${bucketSql("started_at", w.range.interval, w.range.timezone)} AS bucket,
         ${qualityCountsSql}
       FROM quality_visits
       GROUP BY bucket
     ) AS a ON a.bucket = b.bucket
     ORDER BY b.bucket`,
    { ...params, ...p.values, tz: w.range.timezone, leave: PAGE_LEAVE, settled: SESSION_SETTLED_MS },
  );

  const buckets = rows.map((r) => ({ bucket: String(r.bucket), counts: countsOf(r) }));
  const total = qualityOf(buckets.reduce((t, b) => addCounts(t, b.counts), NO_COUNTS), basis, withGoal);
  return {
    avg_engagement_ms: total.avg_engagement_ms,
    measured_views: total.measured_views,
    bounce_rate: total.bounce_rate,
    exit_rate: total.exit_rate,
    over_time: buckets.map((b) => ({ bucket: b.bucket, ...qualityOf(b.counts, basis, withGoal) })),
  };
}

/** How many referrers under a channel, and campaigns under a referrer, before the rest are summed into one row. */
const SOURCE_TREE_BRANCHES = 8;

/**
 * Where the visits on the basis came from, as a tree: channel, then the site or app
 * that sent them (classifyReferrer), then the campaign they were tagged with.
 *
 * The three levels nest, which is what lets one list answer "which network?" and "which
 * campaign?" without a second control to choose between them. The medium is left out
 * because it is what the channel is already made of; the referrer and the tag's source
 * are two answers to one question and classifyReferrer has already merged them.
 *
 * Every node carries the drawer's quality figures for its own visits, so X can be read
 * against LinkedIn on bounce or time on page, not only on volume. They are counted from
 * the same per-visit rows as the chart and the headline (qualityVisitsCtes), so the
 * channels sum to the headline and each node to its children.
 *
 * A node's children are its biggest few, then one row summing the rest — derived by
 * subtraction, which the counts being additive makes exact. A node whose only child has
 * no name has no children: Direct has no referrer beneath it, and a referrer none of
 * whose visits were tagged has no campaigns, and a single "(none)" row would say only
 * that.
 */
async function pageSourceTree(w: WebScope, path: string, basis: PageBasis): Promise<SourceNode[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("px");
  const target = `{${p.add(path)}:String}`;
  const withGoal = hasGoal(w);
  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${qualityVisitsCtes(basis, target, project, scanFrom, scanTo)}
     SELECT 'channel' AS level, k_channel AS k1, '' AS k2, '' AS k3, ${qualityCountsSql}
     FROM quality_visits GROUP BY k1
     UNION ALL
     SELECT * FROM (
       SELECT 'referrer' AS level, k_channel AS k1, k_referrer AS k2, '' AS k3, ${qualityCountsSql}
       FROM quality_visits GROUP BY k1, k2
       ORDER BY n_visits DESC, k2 ASC LIMIT ${SOURCE_TREE_BRANCHES} BY k1
     )
     UNION ALL
     SELECT * FROM (
       SELECT 'campaign' AS level, k_channel AS k1, k_referrer AS k2, k_campaign AS k3, ${qualityCountsSql}
       FROM quality_visits GROUP BY k1, k2, k3
       ORDER BY n_visits DESC, k3 ASC LIMIT ${SOURCE_TREE_BRANCHES} BY k1, k2
     )`,
    { ...params, ...p.values, leave: PAGE_LEAVE, settled: SESSION_SETTLED_MS },
  );

  type Level = SourceNode["level"];
  const at = (level: Level) =>
    rows
      .filter((r) => r.level === level)
      .map((r) => ({ k1: String(r.k1), k2: String(r.k2), k3: String(r.k3), counts: countsOf(r) }))
      .sort((a, b) => b.counts.visits - a.counts.visits || (a.k1 + a.k2 + a.k3).localeCompare(b.k1 + b.k2 + b.k3));
  const channels = at("channel");
  const referrers = at("referrer");
  const campaigns = at("campaign");
  const total = channels.reduce((n, c) => n + c.counts.visits, 0);

  const node = (level: Level, key: string, counts: QualityCounts, rest = false, children: SourceNode[] = []): SourceNode => ({
    key,
    level,
    visits: counts.visits,
    share: total > 0 ? (counts.visits / total) * 100 : 0,
    rest,
    children,
    ...qualityOf(counts, basis, withGoal),
  });
  const branch = (level: Level, parent: QualityCounts, kids: { key: string; counts: QualityCounts; children?: SourceNode[] }[]): SourceNode[] => {
    const nodes = kids.map((k) => node(level, k.key, k.counts, false, k.children));
    const rest = kids.reduce((t, k) => addCounts(t, k.counts, -1), parent);
    if (rest.visits > 0) nodes.push(node(level, "", rest, true));
    return nodes.length === 1 && nodes[0].key === "" && !nodes[0].rest ? [] : nodes;
  };

  return channels.map((c) =>
    node(
      "channel",
      c.k1,
      c.counts,
      false,
      branch(
        "referrer",
        c.counts,
        referrers
          .filter((r) => r.k1 === c.k1)
          .map((r) => ({
            key: r.k2,
            counts: r.counts,
            children: branch(
              "campaign",
              r.counts,
              campaigns.filter((m) => m.k1 === c.k1 && m.k2 === r.k2).map((m) => ({ key: m.k3, counts: m.counts })),
            ),
          })),
      ),
    ),
  );
}

/**
 * Where the visits on the basis came from, over time — the source tree below it, spread
 * across the period.
 *
 * Banded the way the Acquisition chart bands the whole site: the five biggest channels
 * over the period, chosen once rather than per bucket, and everything else as "Other
 * channels". Every bucket in the period is present, empty or not, so this lines up with
 * the chart above it and a quiet week reads as a quiet week rather than as no week.
 * Channels are listed biggest first, which is the order of the tree beneath.
 */
async function pageChannels(w: WebScope, path: string, basis: PageBasis): Promise<{ channels: string[]; points: StackedPoint[] }> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("pc");
  const target = `{${p.add(path)}:String}`;
  const rows = await q<Row>(
    w.scope,
    `${cte},
     ${denseBuckets(w, p)},
     ${pageSessionsCte(basis, target, project, scanFrom, scanTo)},
     visits AS (
       -- Labelled exactly as the source tree labels them, so a band and a row agree.
       SELECT session_id, started_at, if(channel = '', '(none)', channel) AS channel
       FROM scoped
       WHERE period = 'current' AND session_id IN (SELECT session_id FROM page_sessions)
     ),
     top AS (
       SELECT channel FROM visits GROUP BY channel ORDER BY uniqExact(session_id) DESC, channel ASC LIMIT 5
     )
     SELECT b.bucket AS bucket, a.band AS band, ifNull(a.sessions, 0) AS sessions
     FROM buckets AS b
     LEFT JOIN (
       SELECT
         ${bucketSql("started_at", w.range.interval, w.range.timezone)} AS bucket,
         if(channel IN (SELECT channel FROM top), channel, {other:String}) AS band,
         uniqExact(session_id) AS sessions
       FROM visits
       GROUP BY bucket, band
     ) AS a ON a.bucket = b.bucket
     ORDER BY b.bucket`,
    { ...params, ...p.values, tz: w.range.timezone, other: OTHER_CHANNELS },
  );

  const byBucket = new Map<string, Record<string, number>>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    const b = String(r.bucket);
    const entry = byBucket.get(b) ?? {};
    byBucket.set(b, entry);
    // A bucket nobody arrived in comes back once with no band; it is still a bucket.
    const sessions = num(r.sessions);
    if (sessions === 0) continue;
    const band = String(r.band);
    entry[band] = sessions;
    totals.set(band, (totals.get(band) ?? 0) + sessions);
  }
  const channels = [...totals]
    .filter(([c]) => c !== OTHER_CHANNELS)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
  if (totals.has(OTHER_CHANNELS)) channels.push(OTHER_CHANNELS);
  return { channels, points: [...byBucket].map(([bucket, values]) => ({ bucket, values })) };
}

/**
 * What was viewed next. Strictly the next recorded page view in the same visit — an
 * observation, not an intention. The "left the site" row counts only visits that have
 * since gone quiet for longer than a session can stay open; a visit still in progress
 * has not exited anything, and saying it has would overstate every exit rate during
 * the hours anyone is actually looking at this page.
 *
 * On the landing basis it is the page after the landing, once per visit — so the rows
 * account for every settled visit that started here exactly once, and "left the site"
 * is a bounce. On the viewers basis it follows every view of the page, so a visit that
 * came back to it twice and went somewhere different each time appears under both.
 */
async function nextPagesAfter(w: WebScope, path: string, basis: PageBasis): Promise<NextPageRow[]> {
  const { cte, params, project, scanFrom, scanTo } = sessionBase(w);
  const p = new Params("np");
  const target = `{${p.add(path)}:String}`;
  const landing = basis === "landing";
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
         ${landing ? `AND b.entry_path = ${target}` : ""}
     ),
     ordered AS (
       SELECT
         session_id,
         path,
         ts,
         leadInFrame(path) OVER (PARTITION BY session_id ORDER BY ts ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS next_path,
         -- Which view of this path within the visit. The landing basis keeps only the
         -- first, which in a visit that started here is the landing itself.
         row_number() OVER (PARTITION BY session_id, path ORDER BY ts ASC) AS nth_view
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
     WHERE path = ${target} ${landing ? "AND nth_view = 1" : ""}
     GROUP BY key
     HAVING isNotNull(key)
     ORDER BY sessions DESC LIMIT 10`,
    { ...params, ...p.values, settled: SESSION_SETTLED_MS },
  );
  return rows.map((r) => ({ path: String(r.key ?? ""), sessions: num(r.sessions), is_exit: String(r.key ?? "") === "" }));
}

/**
 * Configured supporting actions fired on this page, and how many distinct people fired
 * them — among the visits on the basis on screen, so on the landing basis both the
 * clickers and the viewers they are divided by are people whose visit started here.
 */
async function pageActions(w: WebScope, path: string, basis: PageBasis): Promise<PageActionRow[]> {
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
         ${basis === "landing" ? `AND b.entry_path = ${target}` : ""}
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
  referrers: string[];
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
     SELECT ${pick("utm_source")} AS sources, ${pick("referrer")} AS referrers, ${pick("utm_campaign")} AS campaigns,
            ${pick("utm_medium")} AS mediums, ${pick("country")} AS countries
     FROM scoped`,
    params,
  );
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    sources: list(r?.sources),
    referrers: list(r?.referrers),
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
