"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber, formatRate, formatRatio } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WentOn } from "@/lib/web-api";

/**
 * Did the people who reached a page go on to convert — then, or by coming back?
 *
 * The two halves share their colours with "On that first visit" and "Came back to
 * convert" on the Conversions page, because they are the same distinction seen from
 * the page's side rather than the channel's, and a reader who has learned one should
 * not have to learn the other.
 */
const SAME = "var(--chart-1)";
const LATER = "var(--chart-3)";

export const WENT_ON_PARTS = [
  { key: "same_visit", label: "In the same visit", color: SAME },
  { key: "later_visit", label: "Came back later", color: LATER },
] as const;

const converted = (v: WentOn) => v.same_visit + v.later_visit;

function splitSentence(v: WentOn): string {
  const parts = [
    v.same_visit > 0 && `${formatNumber(v.same_visit)} in the same visit`,
    v.later_visit > 0 && `${formatNumber(v.later_visit)} came back later`,
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * The table cell: the rate and its working, with a small bar saying how the converters
 * split between converting then and coming back. The bar is the composition of the
 * numerator only — it is always full — because at a few percent a bar of the rate
 * itself would be a sliver on every row and say nothing.
 */
export function WentOnCell({ value }: { value: WentOn | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const n = converted(value);
  const cell = (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className="inline-flex items-center gap-1.5">
        {n > 0 && (
          <span className="flex h-1.5 w-10 gap-[2px]" aria-hidden>
            {WENT_ON_PARTS.map((p) =>
              value[p.key] > 0 ? (
                <span key={p.key} className="h-full rounded-[2px]" style={{ flexGrow: value[p.key], background: p.color }} />
              ) : null,
            )}
          </span>
        )}
        <span className="tabular-nums">{formatRate(value.rate.rate)}</span>
      </span>
      <span className="text-[11px] text-muted-foreground tabular-nums">{formatRatio(n, value.people, "people")}</span>
      {n > 0 && <span className="sr-only">{splitSentence(value)}</span>}
    </span>
  );
  if (n === 0) return cell;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{cell}</TooltipTrigger>
      <TooltipContent className="text-xs">
        <WentOnLegend value={value} />
      </TooltipContent>
    </Tooltip>
  );
}

function WentOnLegend({ value, className }: { value: WentOn; className?: string }) {
  return (
    <span className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>
      {WENT_ON_PARTS.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: p.color }} aria-hidden />
          {p.label} <span className="tabular-nums">{formatNumber(value[p.key])}</span>
        </span>
      ))}
    </span>
  );
}

/** One row of the drawer's comparison: a label, a bar on the shared scale, the numbers. */
function Row({
  label,
  value,
  scale,
  segments,
}: {
  label: ReactNode;
  value: WentOn;
  scale: number;
  /** No colour means the reference row: drawn as a dashed outline, so it cannot be mistaken for either half. */
  segments: { key: string; label: string; n: number; color?: string }[];
}) {
  const width = value.rate.rate != null && scale > 0 ? (value.rate.rate / scale) * 100 : 0;
  const n = converted(value);
  return (
    <div className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-3">
      <span className="truncate text-sm">{label}</span>
      <div className="h-3 rounded-sm bg-muted/50">
        <div className="flex h-full gap-[2px]" style={{ width: `${Math.max(width, n > 0 ? 1 : 0)}%` }}>
          {segments
            .filter((s) => s.n > 0)
            .map((s) => (
              <Tooltip key={s.key}>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      "h-full rounded-[3px] transition-opacity hover:opacity-80",
                      !s.color && "border-[1.5px] border-dashed border-muted-foreground",
                    )}
                    style={{ flexGrow: s.n, background: s.color }}
                    aria-label={`${s.label}: ${formatNumber(s.n)} people`}
                  />
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  {s.label}: {formatRatio(s.n, value.people, "people")}
                </TooltipContent>
              </Tooltip>
            ))}
        </div>
      </div>
      <span className="text-right text-sm tabular-nums">
        {formatRate(value.rate.rate)}
        <span className="ml-2 text-[11px] text-muted-foreground">{formatRatio(n, value.people, "people")}</span>
      </span>
    </div>
  );
}

/**
 * The drawer's answer, set against every visitor in the report.
 *
 * A page's rate on its own is unreadable: 4% is remarkable on a site where 1% of
 * visitors ever convert and poor on one where 10% do. So it is drawn beside the
 * site-wide figure on one scale. The site-wide bar is an unfilled outline rather than
 * either half's colour, and unsplit, because its split would not be comparable: for the
 * site as a whole every visit in the period is a "reach", so only a return after the
 * period could count as later.
 */
export function WentOnPanel({
  value,
  baseline,
  subject,
  loading,
}: {
  value: WentOn | null | undefined;
  baseline: WentOn | null | undefined;
  /** Who the page's row is about, for the sentence: "people who landed here". */
  subject: string;
  loading?: boolean;
}) {
  if (loading && !value) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-5" />
        <Skeleton className="h-5" />
      </div>
    );
  }
  if (!value) return null;
  if (value.people === 0) return <p className="p-4 text-sm text-muted-foreground">Nobody reached this page this way in the selected period.</p>;

  const scale = Math.max(value.rate.rate ?? 0, baseline?.rate.rate ?? 0);
  const n = converted(value);
  const ratio = baseline?.rate.rate && value.rate.rate != null ? value.rate.rate / baseline.rate.rate : null;

  return (
    <div className="space-y-3 p-4">
      <Row
        label="This page"
        value={value}
        scale={scale}
        segments={WENT_ON_PARTS.map((p) => ({ key: p.key, label: p.label, n: value[p.key], color: p.color }))}
      />
      {baseline && baseline.people > 0 && (
        <Row
          label="Every visitor"
          value={baseline}
          scale={scale}
          segments={[{ key: "all", label: "Every visitor who went on to convert", n: converted(baseline) }]}
        />
      )}
      <WentOnLegend value={value} className="pt-1 text-xs text-muted-foreground" />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {n === 0 ? (
          <>None of the {subject} have converted since, in that visit or a later one.</>
        ) : (
          <>
            Of the {subject}, {splitSentence(value)}.
            {ratio != null && (
              <>
                {" "}
                That is {ratio.toFixed(1)}× the rate across every visitor in the period
                {n < 5 ? " — from few enough people that one or two either way would move it a long way" : ""}.
              </>
            )}
          </>
        )}{" "}
        An association, not a cause: people already on their way to converting read the pages that sit on the way.
      </p>
    </div>
  );
}

/** The column header's definition, shared by both tabs so the two cannot drift. */
export const WENT_ON_HINT = (
  <>
    People, not visits: of everyone whose visit reached this page, how many converted afterwards — in that same visit, or
    by coming back another time. The small bar splits the two; hover for the numbers. Conversions before they reached it do
    not count, and later ones are counted up to today, so a page read yesterday has had less time than one read last
    month. An association, not a cause.
  </>
);
