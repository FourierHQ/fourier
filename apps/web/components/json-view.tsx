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

export function JsonView({ data, className, nested }: { data: Record<string, unknown>; className?: string; nested?: boolean }) {
  // A key set to undefined is a field this event does not have, not a field whose value is
  // the word "undefined" — callers write `x || undefined` meaning "leave it out".
  const entries = Object.entries(data ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return <span className={cn("text-xs text-muted-foreground", className)}>{"{}"}</span>;
  return (
    <div className={cn("font-mono text-xs leading-relaxed", !nested && "rounded-md bg-muted/40 p-3", className)}>
      {nested && "{"}
      <div className={cn(nested && "ml-4")}>
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-1.5">
            <span className="shrink-0 text-muted-foreground">{k}:</span>
            <span className="min-w-0 break-all">
              <Value v={v} />
            </span>
          </div>
        ))}
      </div>
      {nested && "}"}
    </div>
  );
}

/** Keys a preview leaves out: page context, shown in its own column or not at all. */
const PAGE_KEYS = ["url", "path", "title", "referrer", "search"];

/**
 * One property, plus a count of the rest — `plan: pro  +3`. Showing three at a time
 * meant each one truncated to nothing; one property that fits reads better than three
 * that don't, and the badge says how much more is behind the row.
 */
export function JsonPreview({ data, max = 1, omit = PAGE_KEYS, className }: { data: Record<string, unknown>; max?: number; omit?: string[]; className?: string }) {
  const entries = Object.entries(data ?? {}).filter(([k]) => !omit.includes(k));
  if (entries.length === 0) return null;
  const rest = entries.length - max;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground", className)}>
      <span className="truncate">
        {entries.slice(0, max).map(([k, v], i) => (
          <span key={k}>
            {i > 0 && <span className="mx-1.5 opacity-50">·</span>}
            {k}: <span className="text-foreground/80">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
          </span>
        ))}
      </span>
      {rest > 0 && (
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground/70" title={`${rest} more ${rest === 1 ? "property" : "properties"}`}>
          +{rest}
        </span>
      )}
    </span>
  );
}
