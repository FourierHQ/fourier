"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDate, formatNumber, formatRate, formatRatio, parseDate } from "@/lib/format";
import type { FunnelStep, RatePoint, SeriesPoint } from "@/lib/web-api";

/**
 * Line charts for trends, columns for composition over time, horizontal bars for
 * rankings. No pie charts and no dual axes: a pie cannot be read at the precision these
 * decisions need, and a second axis can be made to show any relationship you like.
 */

type Interval = "hour" | "day" | "week" | "month";

function tickFormatter(interval: Interval) {
  return (t: number) =>
    interval === "hour"
      ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric" })
      : interval === "month"
        ? new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" })
        : formatDate(new Date(t));
}

export function TrendChart({
  data,
  label,
  interval = "day",
  loading,
  className = "h-[240px] w-full",
}: {
  data: SeriesPoint[] | undefined;
  label: string;
  interval?: Interval;
  loading?: boolean;
  className?: string;
}) {
  const rows = useMemo(
    () => (data ?? []).map((p) => ({ ...p, t: parseDate(p.bucket)?.getTime() ?? 0 })),
    [data],
  );
  const hasPrevious = rows.some((r) => r.previous !== null);
  const config = {
    value: { label, color: "var(--chart-1)" },
    previous: { label: "Previous period", color: "var(--muted-foreground)" },
  } satisfies ChartConfig;

  if (loading && !data) return <Skeleton className={className} />;
  const fmt = tickFormatter(interval);
  return (
    <ChartContainer config={config} className={className}>
      <LineChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={fmt} tickLine={false} axisLine={false} minTickGap={32} fontSize={11} />
        <YAxis tickFormatter={(v) => formatNumber(v)} tickLine={false} axisLine={false} width={40} fontSize={11} allowDecimals={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => fmt((p?.[0]?.payload as { t: number })?.t ?? 0)} indicator="line" />} />
        {/* The comparison period is dashed and grey. It is context for the line in
            front of it, and drawing it in a second colour makes them look like two
            equally important series. */}
        {hasPrevious && <Line dataKey="previous" type="monotone" stroke="var(--color-previous)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} opacity={0.65} />}
        <Line dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
        {hasPrevious && <ChartLegend content={<ChartLegendContent />} />}
      </LineChart>
    </ChartContainer>
  );
}

/**
 * Conversion rate over time, in its own aligned chart rather than on a second axis of
 * the traffic chart. The tooltip carries both counts, so a spike that is two visits out
 * of three is visibly that rather than a 67% success.
 */
export function ConversionRateChart({
  data,
  interval = "day",
  loading,
  className = "h-[200px] w-full",
}: {
  data: RatePoint[] | undefined;
  interval?: Interval;
  loading?: boolean;
  className?: string;
}) {
  const rows = useMemo(() => (data ?? []).map((p) => ({ ...p, t: parseDate(p.bucket)?.getTime() ?? 0 })), [data]);
  const config = { rate: { label: "Conversion rate", color: "var(--chart-2)" } } satisfies ChartConfig;
  if (loading && !data) return <Skeleton className={className} />;
  const fmt = tickFormatter(interval);
  return (
    <ChartContainer config={config} className={className}>
      <LineChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={fmt} tickLine={false} axisLine={false} minTickGap={32} fontSize={11} />
        <YAxis tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={44} fontSize={11} />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(_, p) => fmt((p?.[0]?.payload as { t: number })?.t ?? 0)}
              formatter={(_v, _n, item) => {
                const p = item?.payload as RatePoint | undefined;
                if (!p) return null;
                return (
                  <span className="flex flex-col">
                    <span className="font-medium">{formatRate(p.rate)}</span>
                    <span className="text-muted-foreground">{formatRatio(p.converting, p.sessions)}</span>
                  </span>
                );
              }}
            />
          }
        />
        {/* connectNulls is off: a bucket with no sessions has no rate, and joining
            across the gap would draw a line through a value that does not exist. */}
        <Line dataKey="rate" type="monotone" stroke="var(--color-rate)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * A count over time, as columns.
 *
 * Conversions are discrete things that happened, not a quantity that exists between
 * measurements. Drawn as a line, two conversions a week apart become a flat line at 1
 * across the days between them — a picture of five conversions that never happened.
 * Columns cannot make that claim: where there is nothing, there is nothing.
 *
 * Every bucket in the period arrives from the server whether or not it has a count, so
 * a gap is an explicit zero rather than a missing point. The two halves of the fix are
 * separate on purpose — dense buckets stop the data lying, columns stop the ink lying —
 * and a line chart over dense buckets would still invite reading the slope between two
 * days as a rate of change.
 *
 * The comparison period stays a line. As a second set of bars it would read as a thing
 * to compare bar-by-bar, which is not what it is: it is the shape of last month behind
 * the shape of this one.
 */
export function CountChart({
  data,
  label,
  interval = "day",
  loading,
  className = "h-[240px] w-full",
}: {
  data: SeriesPoint[] | undefined;
  label: string;
  interval?: Interval;
  loading?: boolean;
  className?: string;
}) {
  const rows = useMemo(() => (data ?? []).map((p) => ({ ...p, t: parseDate(p.bucket)?.getTime() ?? 0 })), [data]);
  const hasPrevious = rows.some((r) => r.previous !== null);
  const config = {
    value: { label, color: "var(--chart-1)" },
    previous: { label: "Previous period", color: "var(--muted-foreground)" },
  } satisfies ChartConfig;

  if (loading && !data) return <Skeleton className={className} />;
  const fmt = tickFormatter(interval);
  return (
    <ChartContainer config={config} className={className}>
      <ComposedChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={fmt} tickLine={false} axisLine={false} minTickGap={32} fontSize={11} />
        {/* allowDecimals off: there is no such thing as 2.5 conversions, and on a chart
            topping out at 2 the default ticks are 0.5, 1, 1.5 — axis labels for values
            the series cannot take. */}
        <YAxis tickFormatter={(v) => formatNumber(v)} tickLine={false} axisLine={false} width={40} fontSize={11} allowDecimals={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => fmt((p?.[0]?.payload as { t: number })?.t ?? 0)} indicator="line" />} />
        {hasPrevious && <Line dataKey="previous" type="monotone" stroke="var(--color-previous)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} opacity={0.65} />}
        <Bar dataKey="value" fill="var(--color-value)" radius={2} maxBarSize={28} />
        {hasPrevious && <ChartLegend content={<ChartLegendContent />} />}
      </ComposedChart>
    </ChartContainer>
  );
}

const STACK_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--muted-foreground)"];

export function ChannelStack({
  channels,
  points,
  interval = "day",
  loading,
  className = "h-[260px] w-full",
}: {
  channels: string[] | undefined;
  points: { bucket: string; values: Record<string, number> }[] | undefined;
  interval?: Interval;
  loading?: boolean;
  className?: string;
}) {
  // The chart wrapper emits one `--color-<key>` custom property per config key, so the
  // keys have to be valid CSS identifiers. Channel names are not — "Paid Social" would
  // produce `--color-Paid Social`, which the browser discards, and every band would
  // render with no fill. Data keys are slugs; the human name rides along as the label.
  const series = useMemo(
    () => (channels ?? []).map((name, i) => ({ name, key: `ch${i}`, color: STACK_COLORS[i % STACK_COLORS.length] })),
    [channels],
  );
  const rows = useMemo(
    () => (points ?? []).map((p) => ({ t: parseDate(p.bucket)?.getTime() ?? 0, ...Object.fromEntries(series.map((s) => [s.key, p.values[s.name] ?? 0])) })),
    [points, series],
  );
  const config = useMemo(
    () => Object.fromEntries(series.map((s) => [s.key, { label: s.name, color: s.color }])) as ChartConfig,
    [series],
  );
  if (loading && !points) return <Skeleton className={className} />;
  const fmt = tickFormatter(interval);
  return (
    <ChartContainer config={config} className={className}>
      <BarChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={fmt} tickLine={false} axisLine={false} minTickGap={32} fontSize={11} />
        <YAxis tickFormatter={(v) => formatNumber(v)} tickLine={false} axisLine={false} width={40} fontSize={11} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => fmt((p?.[0]?.payload as { t: number })?.t ?? 0)} />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} stackId="c" fill={`var(--color-${s.key})`} radius={0} />
        ))}
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}

/** A ranking. Bars are proportional to the largest row, and every bar carries its number. */
export function HorizontalBars({
  rows,
  loading,
  emptyLabel = "Nothing to rank yet.",
  onSelect,
  formatValue = formatNumber,
}: {
  rows: { key: string; value: number; label?: string; sub?: string }[] | undefined;
  loading?: boolean;
  emptyLabel?: string;
  onSelect?: (key: string) => void;
  /** How the number reads. Counts by default; rates pass a percentage formatter. */
  formatValue?: (n: number) => string;
}) {
  if (loading && !rows) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-7" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return <p className="px-6 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="divide-y">
      {rows.map((r) => (
        <div
          key={r.key}
          className={cn("relative px-4 py-2", onSelect && "cursor-pointer hover:bg-muted/40")}
          onClick={onSelect ? () => onSelect(r.key) : undefined}
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onKeyDown={onSelect ? (e) => (e.key === "Enter" || e.key === " ") && onSelect(r.key) : undefined}
        >
          <div className="absolute inset-y-1 left-1 rounded-sm bg-primary/10" style={{ width: `${Math.max((r.value / max) * 100, 1)}%` }} aria-hidden />
          <div className="relative flex items-center justify-between gap-3">
            <span className="truncate text-sm">{r.label ?? r.key}</span>
            <span className="shrink-0 text-right text-sm tabular-nums">
              {formatValue(r.value)}
              {r.sub && <span className="ml-2 text-[11px] text-muted-foreground">{r.sub}</span>}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The funnel, as horizontal steps. Every bar is the same unit — distinct sessions — and
 * each step after the first shows how many did not continue, because the drop is the
 * part anyone is actually looking for.
 */
export function FunnelSteps({ steps, loading }: { steps: FunnelStep[] | undefined; loading?: boolean }) {
  if (loading && !steps) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }
  if (!steps?.length) return null;
  const top = Math.max(...steps.map((s) => s.sessions), 1);
  return (
    <div className="space-y-3 p-4">
      {steps.map((s, i) => (
        <div key={`${s.name}-${i}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">
              <span className="mr-2 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              {s.name}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatNumber(s.sessions)}
              <span className="ml-1 text-xs text-muted-foreground">sessions</span>
            </span>
          </div>
          <div className="h-7 w-full overflow-hidden rounded-sm bg-muted/50">
            <div className="h-full rounded-sm bg-primary/70" style={{ width: `${Math.max((s.sessions / top) * 100, 0.5)}%` }} />
          </div>
          {s.step_rate !== null && (
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {formatRate(s.step_rate)} continued from the step before
              {s.dropped > 0 && <> · {formatNumber(s.dropped)} dropped off{s.drop_rate !== null && <> ({formatRate(s.drop_rate)})</>}</>}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * New against returning, as one bar. A stacked bar rather than a donut: the question is
 * a ratio between two parts of a whole, and a straight bar can be read precisely while
 * a circle cannot.
 */
export function VisitorMixBar({
  newVisitors,
  returningVisitors,
  onSelect,
}: {
  newVisitors: number;
  returningVisitors: number;
  onSelect?: (which: "new" | "returning") => void;
}) {
  const total = newVisitors + returningVisitors;
  if (total === 0) return <p className="text-sm text-muted-foreground">No visitors in this period.</p>;
  const pct = (n: number) => (n / total) * 100;
  // Both halves get the same number of decimals. formatRate's default drops them above
  // 10%, which would render a 99.5/0.5 split as "100%" beside "0.5%" — two numbers that
  // visibly do not add up, describing a split that does.
  const share = (n: number) => `${pct(n).toFixed(1)}%`;
  const seg = (which: "new" | "returning", n: number, className: string) => (
    <button
      type="button"
      className={cn("h-full transition-opacity hover:opacity-80", className, !onSelect && "cursor-default")}
      style={{ width: `${pct(n)}%` }}
      onClick={onSelect ? () => onSelect(which) : undefined}
      aria-label={`${which === "new" ? "New" : "Returning"} visitors: ${formatNumber(n)}, ${share(n)}`}
      disabled={!onSelect}
    />
  );
  return (
    <div className="space-y-2">
      <div className="flex h-8 w-full overflow-hidden rounded-md bg-muted">
        {seg("new", newVisitors, "bg-[var(--chart-1)]")}
        {seg("returning", returningVisitors, "bg-[var(--chart-3)]")}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-[2px] bg-[var(--chart-1)]" aria-hidden />
          New <span className="tabular-nums">{formatNumber(newVisitors)}</span>
          <span className="text-muted-foreground tabular-nums">{share(newVisitors)}</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-[2px] bg-[var(--chart-3)]" aria-hidden />
          Returning <span className="tabular-nums">{formatNumber(returningVisitors)}</span>
          <span className="text-muted-foreground tabular-nums">{share(returningVisitors)}</span>
        </span>
      </div>
    </div>
  );
}

/**
 * One total per row, split into its parts.
 *
 * Deliberately a single bar rather than two: two bars side by side read as a comparison,
 * and a reader will try to work out how the smaller relates to the larger. Here the
 * parts add to the whole, and the bar shows that directly — the segments are the number
 * beside them, and the row's total is the bar.
 */
export function SplitBars({
  rows,
  parts,
  loading,
  emptyLabel = "Nothing to show yet.",
  onSelect,
}: {
  rows: { key: string; total: number; values: number[] }[] | undefined;
  parts: { label: string; color: string }[];
  loading?: boolean;
  emptyLabel?: string;
  onSelect?: (key: string) => void;
}) {
  if (loading && !rows) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return <p className="px-6 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...rows.map((r) => r.total), 1);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 px-4 pb-2 text-[11px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: p.color }} aria-hidden /> {p.label}
          </span>
        ))}
      </div>
      <div className="divide-y">
        {rows.map((r) => (
          <div
            key={r.key}
            className={cn("px-4 py-2.5", onSelect && "cursor-pointer hover:bg-muted/40")}
            onClick={onSelect ? () => onSelect(r.key) : undefined}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onKeyDown={onSelect ? (e) => (e.key === "Enter" || e.key === " ") && onSelect(r.key) : undefined}
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium">{r.key}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {r.values
                  .map((v, i) => (v > 0 ? `${formatNumber(v)} ${parts[i].label.toLowerCase()}` : null))
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 flex-1 overflow-hidden rounded-sm bg-muted/50">
                <div className="flex h-full" style={{ width: `${(r.total / max) * 100}%` }}>
                  {r.values.map((v, i) => (
                    <div
                      key={parts[i].label}
                      style={{ width: `${r.total > 0 ? (v / r.total) * 100 : 0}%`, background: parts[i].color }}
                      aria-label={`${parts[i].label}: ${v}`}
                    />
                  ))}
                </div>
              </div>
              <span className="w-8 shrink-0 text-right text-sm tabular-nums">{formatNumber(r.total)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Two measures of the same categories, as paired bars on one row.
 *
 * A table of two numeric columns makes the reader subtract across the row to find what
 * the report is actually about. Drawing both bars against one scale puts the difference
 * where it can be seen rather than computed, and the numbers stay beside them for anyone
 * who needs the exact figure.
 */
export function PairedBars({
  rows,
  leftLabel,
  rightLabel,
  shiftLabel,
  loading,
  emptyLabel = "Nothing to compare yet.",
  onSelect,
}: {
  rows: { key: string; left: number; right: number }[] | undefined;
  leftLabel: string;
  rightLabel: string;
  /** How to say the difference in words. Given the size and which way it leans. */
  shiftLabel: (n: number, leans: "left" | "right") => string;
  loading?: boolean;
  emptyLabel?: string;
  onSelect?: (key: string) => void;
}) {
  if (loading && !rows) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return <p className="px-6 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...rows.flatMap((r) => [r.left, r.right]), 1);

  return (
    <div>
      <div className="flex items-center justify-end gap-4 px-4 pb-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-[var(--chart-1)]" aria-hidden /> {leftLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-[var(--chart-3)]" aria-hidden /> {rightLabel}
        </span>
      </div>
      <div className="divide-y">
        {rows.map((r) => {
          const shift = r.left - r.right;
          return (
            <div
              key={r.key}
              className={cn("px-4 py-2.5", onSelect && "cursor-pointer hover:bg-muted/40")}
              onClick={onSelect ? () => onSelect(r.key) : undefined}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onKeyDown={onSelect ? (e) => (e.key === "Enter" || e.key === " ") && onSelect(r.key) : undefined}
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium">{r.key}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {/* The difference, in words. It is the reason the two bars are here,
                      and a reader should not have to subtract to find it. */}
                  {shift === 0 ? "even" : shiftLabel(Math.abs(shift), shift > 0 ? "left" : "right")}
                </span>
              </div>
              {([
                { value: r.left, color: "var(--chart-1)", label: leftLabel },
                { value: r.right, color: "var(--chart-3)", label: rightLabel },
              ] as const).map((bar) => (
                <div key={bar.label} className="flex items-center gap-2">
                  <div className="h-2.5 flex-1 overflow-hidden rounded-sm bg-muted/50">
                    <div className="h-full rounded-sm" style={{ width: `${(bar.value / max) * 100}%`, background: bar.color }} />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums" aria-label={`${bar.label}: ${bar.value}`}>
                    {formatNumber(bar.value)}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
