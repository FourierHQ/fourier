"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * How wide a drilldown drawer is, in one place.
 *
 * Both drawers are the same surface — a detail of the table behind them — and a reader
 * who opens one after the other should not find the panel jumping width. The size is
 * set by what has to fit: the goal drawer carries a list of people with a company and a
 * timestamp on each row, plus a person's event timeline, and the page drawer a table of
 * onward navigation. Still short of half a laptop screen, so the rows that produced the
 * drawer stay visible beside it.
 *
 * The `data-[side=right]:` prefix is not decoration. SheetContent's own base class is
 * `data-[side=right]:sm:max-w-sm`, and tailwind-merge only collapses classes whose
 * variants match — a plain `sm:max-w-xl` passed in does not replace it, it loses to it.
 * That is why the Pages drawer was 384px wide for its whole life while its class said
 * 576px. Same prefix, same specificity, last one wins.
 */
export const DETAIL_SHEET = "w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-3xl";

/** One number in a drawer's header strip, with its own loading state. */
export function DetailStat({
  label,
  value,
  sub,
  loading,
  className,
}: {
  label: ReactNode;
  value: number | string | null | undefined;
  sub?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-6 w-16" />
      ) : (
        <p className={cn("text-xl font-semibold tabular-nums")}>{typeof value === "string" ? value : formatNumber(value)}</p>
      )}
      {sub && !loading && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
