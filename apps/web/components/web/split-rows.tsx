"use client";

import { ChevronRight, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/relative-time";
import { GoalMark } from "@/components/web/goal-mark";
import { cn } from "@/lib/utils";
import type { GoalSplit } from "@/lib/web-api";

/**
 * A split goal in a table: its rollup, and its values under it.
 *
 * The rollup is a row of its own and not a sum of the rows beneath it — a visit that
 * submits two forms is one converting visit — so it reads as a parent, never as a total
 * line at the bottom that invites adding up.
 */

export interface SplitRowMeta {
  depth: 0 | 1;
  /** On a rollup: how many value rows sit under it. */
  children?: number;
  /** On a rollup: how many of them are new. */
  fresh?: number;
  collapsed?: boolean;
  /** A value shown without its rollup (a supporting value of a primary split). */
  orphan?: boolean;
}

type Row = { id: string; split: GoalSplit | null };

/**
 * Rows in display order: each rollup followed by its values, busiest first, with "not
 * set" and "Other" last because they are about the instrumentation rather than about
 * any one value. Values whose rollup is not in the table stand on their own.
 */
export function groupSplitRows<T extends Row>(rows: T[], collapsed: Set<string>, metric: (r: T) => number): (T & { meta: SplitRowMeta })[] {
  const out: (T & { meta: SplitRowMeta })[] = [];
  const rollups = new Set(rows.filter((r) => r.split?.role === "all").map((r) => r.split!.definition_id));
  const rank = (r: T) => (r.split?.role === "other" ? 2 : r.split?.value === "" ? 1 : 0);
  for (const r of rows) {
    const s = r.split;
    if (!s) {
      out.push({ ...r, meta: { depth: 0 } });
      continue;
    }
    if (s.role !== "all") {
      if (!rollups.has(s.definition_id)) out.push({ ...r, meta: { depth: 0, orphan: true } });
      continue;
    }
    const kids = rows
      .filter((k) => k.split?.definition_id === s.definition_id && k.split.role !== "all")
      .sort((a, b) => rank(a) - rank(b) || metric(b) - metric(a));
    const isCollapsed = collapsed.has(s.definition_id);
    out.push({ ...r, meta: { depth: 0, children: kids.length, fresh: kids.filter((k) => k.split?.is_new).length, collapsed: isCollapsed } });
    if (!isCollapsed) for (const k of kids) out.push({ ...k, meta: { depth: 1 } });
  }
  return out;
}

const NAMED_FROM: Record<string, string> = {
  label: "Named from its label property",
  page: "Named from the page it's completed on",
  raw: "The data has no name for this value",
};

export function NewBadge({ split }: { split: GoalSplit }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="shrink-0 cursor-default font-normal">
          New
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="block text-xs leading-relaxed">
          {split.first_seen ? (
            <>
              First completed <RelativeTime value={split.first_seen} />.{" "}
            </>
          ) : null}
          Nobody has reviewed it, so it counts the way {split.definition_name} does. Review it in Manage goals to rename it or
          change how it counts.
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The label cell for a goal row, split-aware. */
export function GoalNameCell({
  name,
  type,
  split,
  meta,
  onToggle,
}: {
  name: string;
  type: "primary" | "supporting";
  split: GoalSplit | null;
  meta: SplitRowMeta;
  onToggle?: (definitionId: string) => void;
}) {
  if (!split) {
    return (
      <span className="flex items-center gap-2">
        <GoalMark type={type} name={name} />
        <span className="font-medium">{name}</span>
      </span>
    );
  }
  if (split.role === "all") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-1 size-6 shrink-0"
          aria-label={meta.collapsed ? `Show the values of ${name}` : `Hide the values of ${name}`}
          aria-expanded={!meta.collapsed}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.(split.definition_id);
          }}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", !meta.collapsed && "rotate-90")} />
        </Button>
        <GoalMark type={type} name={name} />
        <span className="truncate font-medium">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {meta.children} {split.key} value{meta.children === 1 ? "" : "s"}
        </span>
        {meta.collapsed && (meta.fresh ?? 0) > 0 && (
          <Badge variant="secondary" className="shrink-0 font-normal">
            {meta.fresh} new
          </Badge>
        )}
      </span>
    );
  }
  const inferred = split.name_source && NAMED_FROM[split.name_source];
  return (
    <span className={cn("flex min-w-0 items-center gap-2", meta.depth === 1 && "pl-7")}>
      {meta.depth === 1 ? <span className="h-3 w-2 shrink-0 border-b border-l border-border" aria-hidden /> : <GoalMark type={type} name={name} />}
      <span className={cn("truncate", meta.depth === 0 && "font-medium", split.role === "other" && "text-muted-foreground")}>{name}</span>
      {meta.orphan && <span className="shrink-0 truncate text-xs text-muted-foreground">· {split.definition_name}</span>}
      {inferred && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Sparkles className="size-3 shrink-0 text-muted-foreground" aria-label={inferred} />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <span className="block text-xs">
              {inferred}
              {split.name_evidence ? ` — ${split.name_evidence}` : ""}. Rename it in Manage goals.
            </span>
          </TooltipContent>
        </Tooltip>
      )}
      {split.is_new && split.role === "value" && <NewBadge split={split} />}
    </span>
  );
}

/**
 * The prompt this whole feature exists for: values that are being counted, and that
 * nobody has looked at. Shown until someone reviews them, and never blocking anything —
 * the numbers already include them.
 */
export function NewValuesNotice({
  rows,
  onReview,
}: {
  rows: { name: string; type: "primary" | "supporting"; split: GoalSplit | null }[];
  onReview: (definitionId: string) => void;
}) {
  const fresh = rows.filter((r) => r.split?.role === "value" && r.split.is_new);
  if (!fresh.length) return null;
  const byDef = new Map<string, { name: string; key: string; values: typeof fresh }>();
  for (const r of fresh) {
    const s = r.split!;
    if (!byDef.has(s.definition_id)) byDef.set(s.definition_id, { name: s.definition_name, key: s.key, values: [] });
    byDef.get(s.definition_id)!.values.push(r);
  }
  return (
    <div className="space-y-2 border-b bg-brand-mint/5 px-4 py-3">
      {[...byDef.entries()].map(([id, d]) => {
        const shown = d.values.slice(0, 3);
        const counted = d.values.every((v) => v.type === "primary") ? "as conversions" : "the way the goal counts";
        return (
          <div key={id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-sm">
              <span className="font-medium">
                {d.values.length} new {d.key} value{d.values.length === 1 ? "" : "s"}
              </span>{" "}
              <span className="text-muted-foreground">
                in {d.name}, already counted {counted}: {shown.map((v) => v.name).join(", ")}
                {d.values.length > shown.length ? ` and ${d.values.length - shown.length} more` : ""}.
              </span>
            </p>
            <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => onReview(id)}>
              Review
            </Button>
          </div>
        );
      })}
    </div>
  );
}
