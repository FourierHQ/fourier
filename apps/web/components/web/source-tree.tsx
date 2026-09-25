"use client";

import { Fragment, useState } from "react";
import { ChevronRight, ListFilter } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RateCell } from "@/components/web/metric";
import { formatDuration, formatNumber, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SourceNode } from "@/lib/web-api";

/** A node's place in the tree: the channel, and the referrer and campaign beneath it where it has them. */
export interface SourcePath {
  channel: string;
  referrer?: string;
  campaign?: string;
}

const idOf = (path: string[]) => path.join("\u001f");

/** What a node with no name is called, by what it is missing. */
function labelOf(n: SourceNode): string {
  if (n.rest) return "Everything else";
  if (n.key) return n.key;
  return n.level === "campaign" ? "(untagged)" : "(none)";
}

/**
 * Where the visits came from, as a tree that opens in place: channel, then the site or
 * app that sent them, then the campaign they were tagged with.
 *
 * Opening a row answers "which network?" without leaving the drawer, and every row
 * carries the drawer's own quality figures for its visits, so the question after that —
 * "and do they stay?" — is answered on the same line. The filter button on a row is for
 * the question after that one: it narrows the whole report to those visits, the way a
 * filter from the control bar would, so every section of the drawer follows.
 *
 * A single node at a level opens by itself, since there is nothing to choose between —
 * which is what a filtered drawer looks like, one channel with one referrer beneath it.
 */
export function SourceTree({
  nodes,
  basis,
  colorOf,
  loading,
  emptyLabel,
  active,
  onFilter,
}: {
  nodes: SourceNode[] | undefined;
  basis: "landing" | "viewers";
  /** The channel's band colour in the chart above, so the rows stand in for its legend. */
  colorOf: (channel: string) => string | undefined;
  loading?: boolean;
  emptyLabel: string;
  /** The filters in force, so the row they select can say so. */
  active: SourcePath | null;
  onFilter: (path: SourcePath) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (loading && !nodes) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (!nodes?.length) return <p className="px-4 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;

  const max = Math.max(...nodes.map((n) => n.visits), 1);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // The two figures beside the count follow the headline strip: bounce and time on the
  // landing basis, time and exit on every visit.
  const columns = basis === "landing" ? (["bounce", "time"] as const) : (["time", "exit"] as const);
  const heading = { bounce: "Bounce rate", time: "Time on page", exit: "Exit rate" };

  const rows = (list: SourceNode[], path: string[], depth: number) =>
    list.map((n) => {
      const id = idOf([...path, n.rest ? "\u0000rest" : n.key]);
      const expandable = n.children.length > 0;
      const expanded = expandable && (open.has(id) || list.length === 1);
      const nodePath: SourcePath | null =
        n.rest || !n.key || n.key === "(none)"
          ? null
          : n.level === "channel"
            ? { channel: n.key }
            : n.level === "referrer"
              ? { channel: path[0], referrer: n.key }
              : { channel: path[0], referrer: path[1], campaign: n.key };
      const selected =
        nodePath !== null &&
        active !== null &&
        active.channel === nodePath.channel &&
        (active.referrer ?? "") === (nodePath.referrer ?? "") &&
        (active.campaign ?? "") === (nodePath.campaign ?? "");
      const swatch = n.level === "channel" ? colorOf(n.key) : undefined;

      return (
        <Fragment key={id}>
          <div
            className={cn("group relative flex items-center gap-3 py-2 pr-3", expandable && "cursor-pointer hover:bg-muted/40")}
            style={{ paddingLeft: `${12 + depth * 20}px` }}
            onClick={expandable ? () => toggle(id) : undefined}
            onKeyDown={expandable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(id)) : undefined}
            role={expandable ? "button" : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? expanded : undefined}
          >
            {/* Every bar on one scale — the biggest channel — so a referrer's bar can be
                read against its channel's; started at the row's indent, so it sits
                under its own name. */}
            <div
              className="absolute inset-y-1 rounded-sm bg-primary/10"
              style={{
                left: `${4 + depth * 20}px`,
                width: `calc((100% - ${8 + depth * 20}px) * ${Math.max(n.visits / max, 0.01)})`,
                opacity: depth ? 0.6 : 1,
              }}
              aria-hidden
            />
            <div className="relative flex min-w-0 flex-1 items-center gap-1.5">
              <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90", !expandable && "invisible")} aria-hidden />
              {/* Outlined: the palette's darker greys are close to the dark background,
                  and a swatch that disappears cannot key a row to its band. */}
              {swatch && <span className="size-2 shrink-0 rounded-[2px] ring-1 ring-foreground/25" style={{ background: swatch }} aria-hidden />}
              <span className={cn("truncate text-sm", (n.rest || !n.key) && "text-muted-foreground")}>{labelOf(n)}</span>
              {nodePath && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "shrink-0 rounded-sm p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                        selected ? "text-foreground" : "opacity-60 sm:opacity-0 sm:group-hover:opacity-100",
                      )}
                      aria-label={`Show only visits from ${[nodePath.channel, nodePath.referrer, nodePath.campaign].filter(Boolean).join(" › ")}`}
                      aria-pressed={selected}
                      // Narrowing to a row is not a request to open it.
                      onClick={(e) => {
                        e.stopPropagation();
                        onFilter(nodePath);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <ListFilter className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{selected ? "Showing only these visits" : "Show only these visits"}</TooltipContent>
                </Tooltip>
              )}
            </div>
            <span className="relative w-20 shrink-0 text-right text-sm tabular-nums">
              {formatNumber(n.visits)}
              <span className="ml-1.5 text-[11px] text-muted-foreground">{formatRate(n.share)}</span>
            </span>
            {columns.map((c) => (
              <span key={c} className="relative hidden w-24 shrink-0 text-right text-sm sm:block">
                {c === "time" ? (
                  <span className="inline-flex flex-col items-end leading-tight">
                    <span className="tabular-nums">{formatDuration(n.avg_engagement_ms)}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">{n.measured_views ? `${formatNumber(n.measured_views)} measured` : "not measured"}</span>
                  </span>
                ) : (
                  <RateCell value={c === "bounce" ? n.bounce_rate : n.exit_rate} unit={c === "bounce" ? "finished" : "views"} />
                )}
              </span>
            ))}
          </div>
          {expanded && rows(n.children, [...path, n.key], depth + 1)}
        </Fragment>
      );
    });

  return (
    <div>
      <div className="flex items-center gap-3 border-b py-1.5 pr-3 pl-3 text-[11px] text-muted-foreground">
        <span className="flex-1">Channel › referrer › campaign</span>
        <span className="w-20 shrink-0 text-right">Visits</span>
        {columns.map((c) => (
          <span key={c} className="hidden w-24 shrink-0 text-right sm:block">
            {heading[c]}
          </span>
        ))}
      </div>
      <div className="divide-y">{rows(nodes, [], 0)}</div>
    </div>
  );
}
