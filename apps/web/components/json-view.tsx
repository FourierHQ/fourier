"use client";

import { ListFilterPlus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function Value({ v }: { v: unknown }) {
  if (v === null) return <span className="text-muted-foreground">null</span>;
  if (typeof v === "string") return <span className="text-emerald-700 dark:text-emerald-400">&quot;{v}&quot;</span>;
  if (typeof v === "number") return <span className="text-sky-700 dark:text-sky-400">{v}</span>;
  if (typeof v === "boolean") return <span className="text-violet-700 dark:text-violet-400">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <span>
        [
        <div className="ml-4">
          {v.map((x, i) => (
            <div key={i}>
              <Value v={x} />
              {i < v.length - 1 && ","}
            </div>
          ))}
        </div>
        ]
      </span>
    );
  }
  if (typeof v === "object") return <JsonView data={v as Record<string, unknown>} nested />;
  return <span>{String(v)}</span>;
}

/**
 * A value as a property filter compares it, or null when it cannot be one. Filters read
 * a property as text — 42 as "42", true as "true" — so those offer themselves; an
 * object or array would have to be matched as its exact JSON, which nobody means, and
 * null reads the same as a property that was never sent.
 */
function filterable(v: unknown): string | null {
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export function JsonView({
  data,
  className,
  nested,
  onFilter,
}: {
  data: Record<string, unknown>;
  className?: string;
  nested?: boolean;
  /** Offer "only events like this" beside each top-level value that a filter can match. */
  onFilter?: (key: string, value: string) => void;
}) {
  // A key set to undefined is a field this event does not have, not a field whose value is
  // the word "undefined" — callers write `x || undefined` meaning "leave it out".
  const entries = Object.entries(data ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return <span className={cn("text-xs text-muted-foreground", className)}>{"{}"}</span>;
  return (
    <div className={cn("font-mono text-xs leading-relaxed", !nested && "rounded-md bg-muted/40 p-3", className)}>
      {nested && "{"}
      <div className={cn(nested && "ml-4")}>
        {entries.map(([k, v]) => {
          const value = onFilter ? filterable(v) : null;
          return (
            <div key={k} className="group/row flex gap-1.5">
              <span className="shrink-0 text-muted-foreground">{k}:</span>
              <span className="min-w-0 break-all">
                <Value v={v} />
              </span>
              {value !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Shown on hover and on focus, so it is findable without cluttering
                        every line of a payload someone is only trying to read. */}
                    <button
                      type="button"
                      onClick={() => onFilter!(k, value)}
                      className="shrink-0 self-start rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                      aria-label={`Only events where ${k} is ${value}`}
                    >
                      <ListFilterPlus className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Only events where {k} is this</TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
      {nested && "}"}
    </div>
  );
}

/** Keys a preview leaves out: page context, shown in its own column or not at all. */
const PAGE_KEYS = ["url", "path", "title", "referrer", "search"];

/** One property as a preview renders it: no quoting, objects collapsed to JSON. */
function preview(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/** How many rows a tooltip will show before it stops being readable at a glance. */
const TOOLTIP_ROWS = 12;

/**
 * The `+3` pill, with the three behind it on hover.
 *
 * A count of hidden things is a strange thing to show someone and then make them click
 * a row to see. Most of the time the question is "what else is on this event", and the
 * answer is four short key/value pairs that fit in a tooltip — so the badge answers it
 * where it is asked, and expanding the row stays for reading a payload properly.
 *
 * Exported on its own rather than living inside JsonPreview so anything showing a
 * truncated set of properties uses the same pill with the same behaviour.
 */
export function MoreProperties({ entries, className }: { entries: [string, unknown][]; className?: string }) {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, TOOLTIP_ROWS);
  const hidden = entries.length - shown.length;
  const label = `${entries.length} more ${entries.length === 1 ? "property" : "properties"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A button, not a span: this reveals content, so it has to be reachable by
            keyboard as well as by pointer. It deliberately does not stop the click from
            reaching the row — hovering shows the properties, clicking opens the row for
            a proper read, and both are what someone aiming at it means. */}
        <button
          type="button"
          className={cn(
            "shrink-0 cursor-default rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground/70 hover:bg-muted-foreground/20 hover:text-foreground",
            className,
          )}
          aria-label={label}
        >
          +{entries.length}
        </button>
      </TooltipTrigger>
      {/* One child: TooltipContent lays its children out in a row. */}
      <TooltipContent className="max-w-sm">
        <span className="block font-mono text-[11px] leading-relaxed">
          {shown.map(([k, v]) => (
            <span key={k} className="flex gap-1.5">
              <span className="shrink-0 text-background/60">{k}:</span>
              <span className="min-w-0 break-all">{preview(v)}</span>
            </span>
          ))}
          {hidden > 0 && <span className="block text-background/60">…and {hidden} more</span>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One property, plus a count of the rest — `plan: pro  +3`. Showing three at a time
 * meant each one truncated to nothing; one property that fits reads better than three
 * that don't, and the badge says how much more is behind the row.
 */
export function JsonPreview({ data, max = 1, omit = PAGE_KEYS, className }: { data: Record<string, unknown>; max?: number; omit?: string[]; className?: string }) {
  const entries = Object.entries(data ?? {}).filter(([k]) => !omit.includes(k));
  if (entries.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground", className)}>
      <span className="truncate">
        {entries.slice(0, max).map(([k, v], i) => (
          <span key={k}>
            {i > 0 && <span className="mx-1.5 opacity-50">·</span>}
            {k}: <span className="text-foreground/80">{preview(v)}</span>
          </span>
        ))}
      </span>
      <MoreProperties entries={entries.slice(max)} />
    </span>
  );
}
