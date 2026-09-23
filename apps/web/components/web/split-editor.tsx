"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEventPropertyKeys } from "@/lib/api";
import { compactTime, formatDateTime, formatNumber } from "@/lib/format";
import { useSplitCandidates, useSplitCatalog, type SplitCatalogValue, type SplitValue } from "@/lib/web-api";
import { shortValue } from "@fourierhq/core/split-naming";

/**
 * Splitting a goal by a property, in the goal editor.
 *
 * The operator picks the property, and everything else is read off the data: which
 * properties are worth splitting by, which one names the values, and what each value
 * is called. What is left for them is the part only they know — whether a value is a
 * lead, a download or spam — and a name where the data has none worth using.
 *
 * Nothing here knows any site's property names. `form_id` and `form_name` are what one
 * site sends; the candidates and the label are chosen by how values behave.
 */

export interface SplitState {
  key: string;
  label_key: string | null;
  /** Whether the operator chose the label property, so a suggestion does not overwrite it. */
  label_chosen: boolean;
  values: Record<string, SplitValue>;
  absorbs?: string[];
}

type CountsAs = "inherit" | "primary" | "supporting" | "excluded";

const NAMED_FROM: Record<string, string> = {
  value: "the value itself",
  label: "its label property",
  page: "the page it's completed on",
  raw: "nothing — no name found",
  unset: "events that carried no value",
};

const INHERIT = "__inherit__";
const NO_LABEL = "__none__";
const CUSTOM = "__custom__";
const SHOW = 12;

function SplitKeyPicker({ event, properties, value, onChange }: { event: string; properties: SplitProps["properties"]; value: string; onChange: (key: string) => void }) {
  const candidates = useSplitCandidates(event, properties);
  const [free, setFree] = useState(false);
  const list = candidates.data ?? [];
  // Pick the best candidate the moment there is one, so turning the split on shows
  // values straight away rather than an empty picker.
  useEffect(() => {
    if (!value && list.length && list[0].suitable) onChange(list[0].key);
  }, [value, list, onChange]);

  if (free || (!candidates.isLoading && !list.length)) {
    return (
      <Input className="h-8 w-[220px] font-mono text-xs" placeholder="property" aria-label="Split by property" value={value} onChange={(e) => onChange(e.target.value)} />
    );
  }
  const known = list.some((c) => c.key === value);
  return (
    <Select value={value || undefined} onValueChange={(v) => (v === CUSTOM ? setFree(true) : onChange(v))}>
      <SelectTrigger size="sm" className="w-[220px] font-mono text-xs" aria-label="Split by property">
        {/* The key alone once chosen; the reason under it belongs to the open list. */}
        <SelectValue placeholder={candidates.isLoading ? "Reading properties…" : "Choose a property"}>{value || undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-[320px]">
        {!known && value && (
          <SelectItem value={value} className="font-mono text-xs">
            {value}
          </SelectItem>
        )}
        {list.map((c) => (
          <SelectItem key={c.key} value={c.key} disabled={!c.suitable}>
            <span className="flex flex-col">
              <span className="font-mono text-xs">{c.key}</span>
              <span className="text-[11px] text-muted-foreground">{c.reason}</span>
            </span>
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={CUSTOM}>Type a property…</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface SplitProps {
  event: string;
  properties: { key: string; op: "eq" | "neq" | "contains" | "exists" | "not_in"; value?: string; values?: string[] }[];
  type: "primary" | "supporting";
  value: SplitState;
  onChange: (s: SplitState) => void;
  /** Values that were reviewed when the editor opened. Anything else is new. */
  reviewed: Set<string>;
}

export function SplitEditor({ event, properties, type, value, onChange, reviewed }: SplitProps) {
  const keys = useEventPropertyKeys(event);
  const catalog = useSplitCatalog(value.key ? { event, properties, key: value.key, label_key: value.label_key, type } : null);
  const [showAll, setShowAll] = useState(false);
  const data = catalog.data;
  const set = (patch: Partial<SplitState>) => onChange({ ...value, ...patch });

  // The suggested label property, adopted until the operator makes a choice of their own.
  // Remembered per split key: once adopted, the server stops suggesting what is already set.
  const remembered = useRef<{ key: string; label: string } | null>(null);
  if (data?.suggested_label_key && data.key === value.key) remembered.current = { key: value.key, label: data.suggested_label_key };
  const suggested = remembered.current?.key === value.key ? remembered.current.label : null;
  useEffect(() => {
    if (!value.label_chosen && suggested && value.label_key !== suggested && data?.key === value.key) onChange({ ...value, label_key: suggested });
  }, [suggested, value, data?.key, onChange]);

  const rows = useMemo(() => {
    const seen = data?.key === value.key ? (data?.values ?? []) : [];
    const listed = new Set(seen.map((v) => v.value));
    // Values decided about but not in the data any more still appear, at zero, so a
    // decision is never lost from view because its form went quiet.
    const ghosts: SplitCatalogValue[] = Object.keys(value.values)
      .filter((v) => !listed.has(v))
      .map((v) => ({
        value: v,
        count: 0,
        total: 0,
        first_seen: null,
        last_seen: null,
        name: value.values[v]?.name ?? shortValue(v),
        name_source: "raw",
        inferred_name: shortValue(v),
        override: value.values[v],
        reviewed: true,
        type: value.values[v]?.type ?? type,
      }));
    return [...seen, ...ghosts];
  }, [data, value.key, value.values, type]);

  const fresh = rows.filter((r) => !reviewed.has(r.value));
  const shown = showAll ? rows : rows.slice(0, SHOW);
  const labelOptions = (keys.data ?? []).map((k) => k.key).filter((k) => k !== value.key);

  const patchValue = (v: string, patch: { name?: string; type?: CountsAs }) => {
    const prior = value.values[v] ?? {};
    const name = patch.name !== undefined ? patch.name : prior.name;
    const t = patch.type !== undefined ? (patch.type === "inherit" ? undefined : patch.type) : prior.type;
    set({ values: { ...value.values, [v]: { ...(name?.trim() ? { name } : {}), ...(t ? { type: t } : {}) } } });
  };

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">One goal for each value of</span>
        <SplitKeyPicker event={event} properties={properties} value={value.key} onChange={(key) => set({ key, values: key === value.key ? value.values : {}, label_chosen: false, label_key: null })} />
        <span className="text-muted-foreground">named by</span>
        <Select
          value={value.label_key ?? NO_LABEL}
          onValueChange={(v) => set({ label_key: v === NO_LABEL ? null : v, label_chosen: true })}
        >
          <SelectTrigger size="sm" className="w-[210px] font-mono text-xs" aria-label="Name values by property">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-[300px]">
            <SelectItem value={NO_LABEL} className="text-xs">
              no property — the value, or its page
            </SelectItem>
            {value.label_key && !labelOptions.includes(value.label_key) && (
              <SelectItem value={value.label_key} className="font-mono text-xs">
                {value.label_key}
              </SelectItem>
            )}
            {labelOptions.map((k) => (
              <SelectItem key={k} value={k} className="font-mono text-xs">
                {k}
                {k === suggested && <span className="ml-1 font-sans text-[11px] text-muted-foreground">suggested</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        A value that appears later is counted as {type === "primary" ? "a conversion" : "a supporting action"} from its first
        completion and marked <strong className="font-medium text-foreground">New</strong> until someone reviews it here. Saving
        marks every value listed below as reviewed. Names come from the data; type one to use your own.
      </p>

      {value.key && (
        <div className="rounded-md border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
            <span>
              {catalog.isLoading ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> Reading values…
                </span>
              ) : (
                <>
                  {formatNumber(rows.length)} value{rows.length === 1 ? "" : "s"}
                  {fresh.length > 0 && reviewed.size > 0 && <> · {formatNumber(fresh.length)} new</>} · completions in the last 90 days
                </>
              )}
            </span>
            {data?.truncated && <span>Showing the busiest {formatNumber(data.values.length)}</span>}
          </div>
          {catalog.isError ? (
            <p className="px-3 py-3 text-xs text-destructive">{catalog.error.message}</p>
          ) : !rows.length && !catalog.isLoading ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">No events carry {value.key} yet. The goal will pick values up as they arrive.</p>
          ) : (
            <ul className="divide-y">
              {shown.map((r) => {
                const decided = value.values[r.value];
                const isNew = !reviewed.has(r.value);
                const counts: CountsAs = decided?.type ?? "inherit";
                return (
                  <li key={r.value} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <div className="min-w-[220px] flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-7 text-xs"
                          aria-label={`Name for ${r.value || "no value"}`}
                          placeholder={r.inferred_name}
                          value={decided?.name ?? ""}
                          onChange={(e) => patchValue(r.value, { name: e.target.value })}
                        />
                        {isNew && reviewed.size > 0 && (
                          <Badge variant="secondary" className="shrink-0 font-normal">
                            New
                          </Badge>
                        )}
                      </div>
                      <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <span className="truncate font-mono" title={r.value}>
                          {r.value === "" ? "(not set)" : shortValue(r.value)}
                        </span>
                        {!decided?.name && r.name_source !== "raw" && r.name_source !== "value" && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex shrink-0 items-center gap-0.5">
                                <Sparkles className="size-3" /> from {NAMED_FROM[r.name_source] ?? r.name_source}
                              </span>
                            </TooltipTrigger>
                            {r.name_evidence && <TooltipContent>{r.name_evidence}</TooltipContent>}
                          </Tooltip>
                        )}
                      </p>
                    </div>
                    <span className="w-[88px] text-right text-xs tabular-nums text-muted-foreground" title={r.first_seen ? `First completed ${formatDateTime(r.first_seen)}` : undefined}>
                      {formatNumber(r.count)}
                      {r.first_seen && <span className="block whitespace-nowrap text-[11px]">first {compactTime(r.first_seen)}</span>}
                    </span>
                    <Select value={counts === "inherit" ? INHERIT : counts} onValueChange={(v) => patchValue(r.value, { type: v === INHERIT ? "inherit" : (v as CountsAs) })}>
                      <SelectTrigger size="sm" className="w-[170px] text-xs" aria-label={`How ${r.name} counts`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>As the goal ({type === "primary" ? "primary" : "supporting"})</SelectItem>
                        {type !== "primary" && <SelectItem value="primary">Primary goal</SelectItem>}
                        {type !== "supporting" && <SelectItem value="supporting">Supporting action</SelectItem>}
                        <SelectItem value="excluded">Not counted</SelectItem>
                      </SelectContent>
                    </Select>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > SHOW && (
            <div className="border-t px-3 py-1.5">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show fewer" : `Show all ${formatNumber(rows.length)}`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What gets stored: every value on screen marked reviewed, with only the decisions that
 * differ from the defaults written into it. A value off screen keeps whatever it had.
 */
export function splitValuesToSave(state: SplitState, listed: string[]): Record<string, SplitValue> {
  const out: Record<string, SplitValue> = {};
  for (const v of new Set([...Object.keys(state.values), ...listed])) {
    const d = state.values[v] ?? {};
    const name = d.name?.trim();
    out[v] = { ...(name ? { name } : {}), ...(d.type ? { type: d.type } : {}) };
  }
  return out;
}
