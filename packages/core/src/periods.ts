/**
 * Date ranges and the period they are compared against.
 *
 * One module because the comparison rule is the thing most easily got wrong in four
 * different ways on four different pages. Today is eleven hours old; last Tuesday is
 * twenty-four. Comparing the two and reporting "traffic down 54%" is the single most
 * common lie an analytics dashboard tells, and it tells it every morning.
 *
 * So a comparison period here is never simply "the same length, earlier". It is the
 * same length *and the same elapsed distance into it*: if the selected range is 30 days
 * of which 12 hours have actually happened, the previous period is the equivalent 29
 * days and 12 hours, measured from its own start. Bucket i of one lines up with bucket
 * i of the other, and the last bucket of each is partial in the same way.
 */

export type IntervalUnit = "hour" | "day" | "week" | "month";

/** Half-open [from, to). Every query in this section uses >= from AND < to. */
export interface Period {
  from: Date;
  to: Date;
}

export interface Comparison extends Period {
  /**
   * How much of the current period has actually elapsed, in ms. The previous period
   * covers exactly this much from its own start, which is what makes the two
   * comparable when the current one is still running.
   */
  elapsed_ms: number;
}

export interface ResolvedRange {
  current: Period;
  /** Null when the reader has turned comparison off. */
  previous: Comparison | null;
  interval: IntervalUnit;
  /** IANA name. Bucket boundaries and "today" are computed in it, not in UTC. */
  timezone: string;
  preset: RangePreset | "custom";
}

export const RANGE_PRESETS = ["today", "yesterday", "7d", "30d", "90d", "12m", "mtd", "ytd"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
  mtd: "Month to date",
  ytd: "Year to date",
};

export const DEFAULT_PRESET: RangePreset = "30d";

function isPreset(v: unknown): v is RangePreset {
  return typeof v === "string" && (RANGE_PRESETS as readonly string[]).includes(v);
}

/**
 * Midnight at the start of `at`'s day in `timezone`, as a UTC instant. Derived from
 * Intl rather than an offset table so it is right across a DST boundary, where a
 * "day" is 23 or 25 hours and a naive subtraction quietly loses or repeats an hour.
 */
function startOfDay(at: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // The wall-clock time in the zone, minus the same instant read as UTC, is the offset.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = asUtc - Math.floor(at.getTime() / 1000) * 1000;
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")) - offset);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Calendar-aware month arithmetic in the given zone, so "12 months" is not 360 days. */
function addMonths(d: Date, n: number, timezone: string): Date {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = f.formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const target = new Date(Date.UTC(get("year"), get("month") - 1 + n, 1));
  const day = Math.min(get("day"), new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate());
  return startOfDay(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day, 12)), timezone);
}

/** Bucket width that puts a useful number of points on a chart for a range of this size. */
export function intervalFor(from: Date, to: Date): IntervalUnit {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days <= 2) return "hour";
  if (days <= 92) return "day";
  if (days <= 730) return "week";
  return "month";
}

export interface RangeInput {
  preset?: string | null;
  /** ISO date or timestamp. Only read when preset is "custom" or absent. */
  from?: string | null;
  to?: string | null;
  compare?: boolean;
  timezone?: string | null;
  /** Injectable for tests. */
  now?: Date;
}

function validTimezone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function presetPeriod(preset: RangePreset, now: Date, tz: string): Period {
  const today = startOfDay(now, tz);
  const tomorrow = addDays(today, 1);
  switch (preset) {
    case "today":
      return { from: today, to: tomorrow };
    case "yesterday":
      return { from: addDays(today, -1), to: today };
    case "7d":
      return { from: addDays(today, -6), to: tomorrow };
    case "30d":
      return { from: addDays(today, -29), to: tomorrow };
    case "90d":
      return { from: addDays(today, -89), to: tomorrow };
    case "12m":
      return { from: addMonths(today, -12, tz), to: tomorrow };
    case "mtd":
      return { from: startOfMonth(now, tz), to: tomorrow };
    case "ytd":
      return { from: startOfYear(now, tz), to: tomorrow };
  }
}

function startOfMonth(at: Date, tz: string): Date {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return startOfDay(new Date(Date.UTC(get("year"), get("month") - 1, 1, 12)), tz);
}

function startOfYear(at: Date, tz: string): Date {
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(at));
  return startOfDay(new Date(Date.UTC(year, 0, 1, 12)), tz);
}

/**
 * Turn what the URL said into the two periods every report runs against.
 *
 * Comparison is on unless it was explicitly switched off, and defaults to the period
 * immediately before the selected one — the "preceding equivalent period" a reader
 * means by "vs previous".
 */
export function resolveRange(input: RangeInput = {}): ResolvedRange {
  const now = input.now ?? new Date();
  const timezone = validTimezone(input.timezone);

  let preset: RangePreset | "custom";
  let current: Period;
  if (input.preset === "custom" || (!isPreset(input.preset) && (input.from || input.to))) {
    preset = "custom";
    const from = input.from ? new Date(input.from) : addDays(startOfDay(now, timezone), -29);
    // An inclusive end date in the URL ("to=2026-09-18") means all of that day, so a
    // bare date is pushed to the following midnight. A full timestamp is taken as given.
    const rawTo = input.to ? new Date(input.to) : addDays(startOfDay(now, timezone), 1);
    const dateOnly = typeof input.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.to);
    const to = dateOnly ? addDays(startOfDay(rawTo, timezone), 1) : rawTo;
    // An unparseable or inverted custom range falls back to the default rather than
    // throwing: a bad URL should show the default report, not an error page.
    const usable = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from;
    if (!usable) preset = DEFAULT_PRESET;
    current = usable ? { from, to } : presetPeriod(DEFAULT_PRESET, now, timezone);
  } else {
    preset = isPreset(input.preset) ? input.preset : DEFAULT_PRESET;
    current = presetPeriod(preset, now, timezone);
  }

  const length = current.to.getTime() - current.from.getTime();
  // How much of the selected range has actually happened. A range entirely in the past
  // has elapsed fully; one that includes now is only as old as now.
  const elapsed = Math.max(0, Math.min(now.getTime(), current.to.getTime()) - current.from.getTime());

  const previous: Comparison | null =
    input.compare === false
      ? null
      : {
          from: new Date(current.from.getTime() - length),
          // Not `current.from`: the previous period is cut to the same elapsed distance
          // into itself, so a half-finished today is compared with half of that day.
          to: new Date(current.from.getTime() - length + elapsed),
          elapsed_ms: elapsed,
        };

  return { current, previous, interval: intervalFor(current.from, current.to), timezone, preset };
}

/** ClickHouse-friendly "YYYY-MM-DD HH:MM:SS.mmm" in UTC, which is how every timestamp is stored. */
export function chTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * The bucket expression for a series. The timezone argument is what makes a "day"
 * the reader's day rather than UTC's — without it a European morning's traffic lands
 * in the previous bucket and every daily chart is quietly shifted.
 */
export function bucketSql(col: string, interval: IntervalUnit, timezone: string): string {
  const fn = { hour: "toStartOfHour", day: "toStartOfDay", week: "toStartOfWeek", month: "toStartOfMonth" }[interval];
  // toStartOfWeek takes a mode before the timezone; 1 is Monday.
  const args = interval === "week" ? `${col}, 1, {tz:String}` : `${col}, {tz:String}`;
  return `toDateTime64(${fn}(${args}), 3, 'UTC')`;
}

/**
 * Shift a previous-period bucket forward so it lines up with the current period's
 * bucket at the same relative position, which is what lets one chart draw both.
 */
export function alignOffsetMs(range: ResolvedRange): number {
  return range.previous ? range.current.from.getTime() - range.previous.from.getTime() : 0;
}
