"use client";

import { ListFilterPlus, Plus, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/page-header";
import { EventsTable } from "@/components/events-table";
import { PropertyRow, type PropertyFilter } from "@/components/property-filter";
import { TimeseriesChart } from "@/components/timeseries-chart";
import { useEventNames, useEventPropertyKeys, useEventTotals, useEvents, useSources, useTimeseries, type EventTotals } from "@/lib/api";
import { eventLabel, formatNumber } from "@/lib/format";

const ALL = "__all__";

/** As many as a goal takes, and as many as the API accepts. */
const MAX_FILTERS = 10;

const OPS = new Set<PropertyFilter["op"]>(["eq", "neq", "contains", "exists"]);

/**
 * The filters in the URL, which is where they live so that a filtered feed is a link
 * someone can send. Anything unreadable is dropped rather than fatal: a hand-edited or
 * truncated link should open the page, not an error.
 */
function readFilters(raw: string | null): PropertyFilter[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f): f is PropertyFilter => typeof f?.key === "string" && OPS.has(f?.op) && (f.value === undefined || typeof f.value === "string"))
      .map((f) => (f.op === "exists" ? { key: f.key, op: f.op } : { key: f.key, op: f.op, value: f.value ?? "" }))
      .slice(0, MAX_FILTERS);
  } catch {
    return [];
  }
}

/**
 * A row being edited is not a filter yet. Applying it half-typed would flash the feed
 * to "nothing matches" on every keystroke, and "is" with no value would ask for events
 * without the property — a real question, but never the one someone is halfway through.
 */
function isComplete(f: PropertyFilter): boolean {
  return f.key.trim() !== "" && (f.op === "exists" || (f.value ?? "") !== "");
}

function Totals({ totals, loading }: { totals: EventTotals | undefined; loading: boolean }) {
  const n = (v: number | undefined) => <span className="font-medium tabular-nums text-foreground">{v === undefined ? "–" : formatNumber(v)}</span>;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-2.5 text-xs text-muted-foreground" aria-busy={loading}>
      <span>
        {n(totals?.events)} {totals?.events === 1 ? "event" : "events"}
      </span>
      {/* Server-side messages belong to no visit, so a feed of only those has no
          sessions to count — saying "0 sessions" would read as a fault. */}
      {(totals?.sessions !== 0 || !totals?.events) && (
        <span>
          {n(totals?.sessions)} {totals?.sessions === 1 ? "session" : "sessions"}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default underline decoration-dotted underline-offset-2">
            {n(totals?.people)} {totals?.people === 1 ? "person" : "people"}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Counted by identity. Someone who never identifies is one person per browser, so the same person on a phone and a laptop counts twice.
        </TooltipContent>
      </Tooltip>
      <span className="ml-auto">all time</span>
    </div>
  );
}

function EventsView() {
  const params = useSearchParams();
  const router = useRouter();
  const event = params.get("event") ?? "";
  const source = params.get("source") ?? "";
  const sources = useSources();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // What the rows on screen say, including ones still being typed. The URL holds only the
  // finished ones, and every query reads the URL.
  const rawFilters = params.get("properties");
  const properties = useMemo(() => readFilters(rawFilters), [rawFilters]);
  const [draft, setDraft] = useState<PropertyFilter[]>(properties);
  const applied = useMemo(() => draft.filter(isComplete), [draft]);
  // The last value this page put in the URL, to tell its own writes from a link or the
  // sidebar changing it — which has to win over what is on screen, or the rows would
  // write themselves straight back.
  const written = useRef(rawFilters ?? "");
  useEffect(() => {
    if ((rawFilters ?? "") === written.current) return;
    written.current = rawFilters ?? "";
    setDraft(readFilters(rawFilters));
  }, [rawFilters]);
  useEffect(() => {
    const next = applied.length ? JSON.stringify(applied) : "";
    if (next === (rawFilters ?? "")) return;
    const t = setTimeout(() => {
      const url = new URLSearchParams(params.toString());
      if (next) url.set("properties", next);
      else url.delete("properties");
      written.current = next;
      router.replace(`/events${url.toString() ? `?${url}` : ""}`);
    }, 300);
    return () => clearTimeout(t);
  }, [applied, rawFilters, params, router]);

  const filters = properties.length ? properties : undefined;
  const names = useEventNames(undefined, source || undefined);
  const keys = useEventPropertyKeys(event || undefined, { anyEvent: true });
  const events = useEvents({ event: event || undefined, source: source || undefined, q: debounced || undefined, properties: filters, limit });
  const totals = useEventTotals({ event: event || undefined, source: source || undefined, q: debounced || undefined, properties: filters });
  const series = useTimeseries({ event: event || undefined, source: source || undefined, q: debounced || undefined, properties: filters, interval: "hour" });

  const setParam = (key: string) => (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v && v !== ALL) next.set(key, v);
    else next.delete(key);
    router.replace(`/events${next.toString() ? `?${next}` : ""}`);
  };
  const setEvent = setParam("event");
  const setSource = setParam("source");

  const addFilter = (f: PropertyFilter = { key: "", op: "eq", value: "" }) =>
    setDraft((d) => {
      // Clicking the same value twice asks for it once.
      if (isComplete(f) && d.some((x) => x.key === f.key && x.op === f.op && x.value === f.value)) return d;
      return d.length < MAX_FILTERS ? [...d, f] : d;
    });
  const keyOptions = (keys.data ?? []).map((k) => k.key);
  const filtered = Boolean(event || q || source || filters);

  return (
    <>
      <PageHeader
        title="Events"
        description="Live, newest first"
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search properties, ids…" className="h-8 w-56 pl-7 text-xs" />
              {q && (
                <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {(sources.data?.length ?? 0) > 1 && (
              <Select value={source || ALL} onValueChange={setSource}>
                <SelectTrigger size="sm" className="w-40 text-xs">
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All sources</SelectItem>
                  {sources.data!.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={event || ALL} onValueChange={setEvent}>
              <SelectTrigger size="sm" className="w-52 text-xs">
                <SelectValue placeholder="All events" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All events</SelectItem>
                {(names.data ?? []).map((n) => (
                  <SelectItem key={n.event} value={n.event}>
                    <span className="flex w-full items-center justify-between gap-3">
                      {eventLabel(n)} <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(n.count)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => addFilter()} disabled={draft.length >= MAX_FILTERS}>
              <ListFilterPlus className="size-3.5" /> Filter
            </Button>
          </>
        }
      />
      <div className="space-y-4 p-4 md:p-6">
        {draft.length > 0 && (
          <Card size="sm">
            <CardContent className="space-y-2">
              {draft.map((f, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="w-10 shrink-0 pt-2 text-right text-xs text-muted-foreground">{i === 0 ? "where" : "and"}</span>
                  <PropertyRow
                    event={event || undefined}
                    anyEvent
                    filter={f}
                    keys={keyOptions}
                    keysLoading={keys.isLoading}
                    onChange={(next) => setDraft((d) => d.map((x, j) => (j === i ? next : x)))}
                    onRemove={() => setDraft((d) => d.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
              <div className="flex items-center gap-1 pl-12">
                {draft.length < MAX_FILTERS && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => addFilter()}>
                    <Plus className="size-3.5" /> Add filter
                  </Button>
                )}
                {draft.length > 1 && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setDraft([])}>
                    Clear all
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
        <Card size="sm">
          <CardContent>
            <TimeseriesChart data={series.data} loading={series.isLoading} interval="hour" className="h-[140px] w-full" />
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <Totals totals={totals.data} loading={totals.isFetching} />
          <EventsTable
            events={events.data?.events}
            loading={events.isLoading}
            emptyTitle={filtered ? "No matching events" : "No events yet"}
            emptyDescription={filtered ? "Try a different filter." : "Install the snippet to start receiving events."}
            onFilterProperty={(key, value) => addFilter({ key, op: "eq", value })}
          />
          {(events.data?.events.length ?? 0) >= limit && (
            <div className="border-t p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => setLimit((l) => Math.min(l + 200, 1000))}>
                Load more
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export default function EventsPage() {
  return (
    <Suspense>
      <EventsView />
    </Suspense>
  );
}
