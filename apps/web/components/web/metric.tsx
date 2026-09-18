"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Info, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatChange, formatNumber, formatRate, formatRatio } from "@/lib/format";
import type { Delta, RateDelta, RateValue, SeriesPoint } from "@/lib/web-api";

/**
 * A period-over-period change.
 *
 * Deliberately colourless by default. Traffic going up is not automatically good — a
 * bot wave, a Hacker News morning and a broken canonical tag all look like growth — and
 * a green arrow is an editorial claim the data does not support. `sentiment` turns
 * colour on only where direction genuinely has a meaning, and nothing in this section
 * currently asks for it.
 */
export function DeltaBadge({ delta, className, sentiment = false }: { delta: Delta | null | undefined; className?: string; sentiment?: boolean }) {
  if (!delta || delta.previous === null) return null;
  const { change, is_new } = delta;
  const dir = is_new ? 1 : change == null ? 0 : change > 0 ? 1 : change < 0 ? -1 : 0;
  const Icon = dir > 0 ? ArrowUp : dir < 0 ? ArrowDown : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs tabular-nums",
        sentiment && dir > 0 && "text-emerald-600 dark:text-emerald-400",
        sentiment && dir < 0 && "text-rose-600 dark:text-rose-400",
        !sentiment && "text-muted-foreground",
        className,
      )}
      title={`Previous period: ${formatNumber(delta.previous)}`}
    >
      {!is_new && <Icon className="size-3" aria-hidden />}
      {formatChange(change, is_new)}
    </span>
  );
}

/**
 * A rate and the counts behind it, together. "2.5% — 12 of 480 sessions" rather than a
 * bare percentage: a reader can tell at a glance whether it is a result or a rounding
 * artefact of eleven visits, which is the difference between acting on it and not.
 */
export function RateCell({ value, unit = "sessions", className }: { value: RateValue | null | undefined; unit?: string; className?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex flex-col items-end leading-tight", className)}>
      <span className="tabular-nums">{formatRate(value.rate)}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums">{formatRatio(value.numerator, value.denominator, unit)}</span>
    </span>
  );
}

/** A label with a definition behind it, for the metrics where the wording alone is ambiguous. */
export function MetricLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="text-muted-foreground/70 hover:text-foreground" aria-label="What this measures">
            <Info className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">{hint}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** Twelve-point shape of the period. No axes, no tooltip — it is a glance, not a chart. */
function Sparkline({ points }: { points: SeriesPoint[] }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const w = 120;
  const h = 28;
  const step = w / (values.length - 1);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-full text-primary/60" preserveAspectRatio="none" aria-hidden focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function MetricCard({
  title,
  hint,
  value,
  delta,
  sparkline,
  footer,
  loading,
  unavailable,
}: {
  title: ReactNode;
  hint?: ReactNode;
  value: ReactNode;
  delta?: Delta | null;
  sparkline?: SeriesPoint[];
  footer?: ReactNode;
  loading?: boolean;
  /** Shown instead of a value when the metric cannot be computed — never a zero. */
  unavailable?: ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground">
          <MetricLabel hint={hint}>{title}</MetricLabel>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : unavailable ? (
          <div className="text-sm text-muted-foreground">{unavailable}</div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{value}</span>
            <DeltaBadge delta={delta} />
          </div>
        )}
        {footer && <p className="mt-1 text-xs text-muted-foreground">{footer}</p>}
        {sparkline && sparkline.length > 1 && !loading && !unavailable && (
          <div className="mt-2">
            <Sparkline points={sparkline} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The conversion cards, which have to name the goal they are counting. */
export function ConversionCard({
  title,
  goalName,
  value,
  delta,
  rate,
  sparkline,
  loading,
  onConfigure,
}: {
  title: string;
  goalName: string | null;
  value: ReactNode;
  delta?: Delta | null;
  rate?: RateDelta | null;
  sparkline?: SeriesPoint[];
  loading?: boolean;
  onConfigure?: ReactNode;
}) {
  // No goal means no conversion metric exists to show. A zero here would be a claim
  // that nobody converted, which is not what an absent goal tells us.
  if (!goalName && !loading) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Choose a conversion goal</p>
          {onConfigure && <div className="mt-2">{onConfigure}</div>}
        </CardContent>
      </Card>
    );
  }
  return (
    <MetricCard
      title={title}
      value={value}
      delta={delta}
      sparkline={sparkline}
      loading={loading}
      footer={
        rate
          ? formatRatio(rate.numerator, rate.denominator)
          : goalName
            ? goalName
            : undefined
      }
      hint={goalName ? `Counting "${goalName}". A visit that completes the goal more than once is counted as one converting session.` : undefined}
    />
  );
}
