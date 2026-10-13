"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { SheetContent } from "@/components/ui/sheet";
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
const DETAIL_SHEET = cn(
  "w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-3xl",
  // The close button stays put while a page scrolls beneath it (DetailSheetPages), so it
  // sits above the pages on the panel's own colour rather than over whatever row is
  // passing. Not while hovered, where the ghost button's own hover colour belongs.
  "[&>[data-slot=sheet-close]]:z-10 [&>[data-slot=sheet-close]:not(:hover)]:bg-popover",
);

/**
 * The panel both drilldowns open in.
 *
 * A component rather than a className, because the width is not the only thing the two
 * have to agree on and a shared string cannot carry the rest.
 *
 * What it carries besides the width: a dialog moves focus to the first focusable thing
 * inside it when it opens, and Radix tooltips open on focus — so a drawer whose first
 * control happened to be a little "what this measures" button greeted every reader with
 * a tooltip they had not asked for, over the numbers they had. Focus goes to the panel
 * itself instead. That is not merely suppressing the symptom: focus belongs on a panel
 * of numbers, not on the first help icon that happens to appear in it, and keeping it
 * inside the content preserves the focus trap, Escape, and the screen-reader
 * announcement that a dialog opened.
 */
export function DetailSheetContent({ className, children, ...props }: ComponentProps<typeof SheetContent>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <SheetContent
      ref={ref}
      side="right"
      tabIndex={-1}
      className={cn(DETAIL_SHEET, className)}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        ref.current?.focus();
      }}
      {...props}
    >
      {children}
    </SheetContent>
  );
}

/**
 * A drawer that turns to another page — one person, from a list of them — and back.
 *
 * The page it turned from is kept, not rebuilt. It stays mounted underneath, invisible
 * and inert, in a scroll area of its own, so Back returns to it exactly as it was left:
 * scrolled to the row that was clicked, on the tab that was chosen, with its charts not
 * drawing themselves in again. Rebuilding it put the reader back at the top of a long
 * drawer every time they looked at one person, which is the step drilling down repeats
 * most.
 *
 * The page on top is keyed, so turning to a second person starts at the top of them
 * rather than at the first one's scroll position. Focus goes to it when it opens and
 * comes back to whatever opened it — the row — when it closes, so a keyboard reader is
 * returned to their place too.
 */
export function DetailSheetPages({ over, overKey, children }: { over: ReactNode | null; overKey?: string | null; children: ReactNode }) {
  const top = useRef<HTMLDivElement>(null);
  // The last thing focused on the page underneath — the row that opened the page on top.
  // Tracked as it happens rather than read when the page opens, because making the page
  // underneath inert takes focus away from that row before an effect could ask.
  const opener = useRef<HTMLElement | null>(null);
  const open = over != null;
  const wasOpen = useRef(open);

  useEffect(() => {
    if (open) top.current?.focus({ preventScroll: true });
    else if (wasOpen.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open, overKey]);

  return (
    // Fills the panel. Each page scrolls itself, and the panel does not.
    <div className="relative min-h-0 flex-1">
      <div
        className={cn("absolute inset-0 overflow-y-auto", open && "invisible")}
        inert={open}
        aria-hidden={open || undefined}
        onFocus={(e) => (opener.current = e.target as HTMLElement)}
      >
        {children}
      </div>
      {open && (
        <div key={overKey ?? undefined} ref={top} tabIndex={-1} className="absolute inset-0 overflow-y-auto outline-none">
          {over}
        </div>
      )}
    </div>
  );
}

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
