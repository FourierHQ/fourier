"use client";

import { EyeOff, Plus } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEventNames, useHiddenEvents, useSetEventHidden, type EventName } from "@/lib/api";
import { formatNumber } from "@/lib/format";

/**
 * How the events Fourier collects are read, rather than how they are collected.
 *
 * Two sections, because they are two different statements. Fourier saying "this
 * message is my own plumbing" is not the same as an operator saying "this event of
 * mine is not activity", and the first comes with an explanation the second cannot
 * have. Both end up in the same exclusion, and both are reversible.
 */
export function EventSettings() {
  const hidden = useHiddenEvents();
  // Both sections need the names the rest of the app is refusing to show — one to
  // describe them, the other to offer them — so the picker asks for everything.
  const names = useEventNames(30, undefined, true);
  const [error, setError] = useState<string | null>(null);

  const state = {
    hiddenSet: useMemo(() => new Set(hidden.data?.hidden ?? []), [hidden.data]),
    system: hidden.data?.system ?? [],
    counts: useMemo(() => new Map((names.data ?? []).map((e) => [e.event, e])), [names.data]),
    loading: hidden.isLoading,
    countsLoading: names.isLoading,
    error,
    setError,
  };

  return (
    <div className="space-y-6">
      {hidden.error && <p className="text-sm text-destructive">{hidden.error.message}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <SystemEventsCard {...state} />
      <HiddenEventsCard {...state} available={names.data ?? []} />
    </div>
  );
}

interface Shared {
  hiddenSet: Set<string>;
  system: string[];
  counts: Map<string, EventName>;
  loading: boolean;
  countsLoading: boolean;
  setError: (e: string | null) => void;
}

/** What the 30-day name list can say about an event, or nothing when it has not arrived. */
function Received({ event, counts, loading }: { event: string; counts: Map<string, EventName>; loading: boolean }) {
  const seen = counts.get(event);
  return <span className="tabular-nums text-muted-foreground">{loading ? "" : seen ? `${formatNumber(seen.count)} in 30d` : "—"}</span>;
}

/**
 * What each system event is for, and what still depends on it while it is hidden.
 *
 * Worth the words: an operator who reads "hidden" as "thrown away" would reasonably
 * conclude that engagement time had been switched off with it, and either turn this
 * back on to protect a number that was never at risk, or stop trusting the number.
 */
const SYSTEM_EVENTS: Record<string, { what: string; used_for: string }> = {
  $page_leave: {
    what: "Sent when a page goes away, carrying the foreground time it held — the SDK's engagement timer, which stops for a hidden or idle tab.",
    used_for: "Engagement time, engaged sessions and the engagement rate in Web Analytics are all computed from these, whether or not they are shown here.",
  },
};

/**
 * Fourier's own messages. Hiding one takes it out of the activity views and nothing
 * else: the measurement it carries is read from the stored row either way, at write
 * time into the sessions rollup and at read time by the per-page engagement report,
 * neither of which this setting reaches.
 */
function SystemEventsCard({ hiddenSet, system, counts, loading, countsLoading, setError }: Shared) {
  const set = useSetEventHidden();

  return (
    <Card>
      <CardHeader>
        <CardTitle>System events</CardTitle>
        <CardDescription>
          Messages the Fourier SDK sends to make the product work, rather than things a person did. They are kept out of the activity views — the events feed, top
          events, and the event counts on the overview, users and companies — because one row per page view is not a second page view. The data they carry is
          still read: showing one here changes what you see, never what is measured.
        </CardDescription>
      </CardHeader>
      {/* Not a table: each of these is a name and a paragraph explaining what still
          depends on it, which a row of cells makes unreadable. */}
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-16" />
        ) : (
          system.map((event) => {
            const isHidden = hiddenSet.has(event);
            const doc = SYSTEM_EVENTS[event];
            return (
              <div key={event} className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{event}</span>
                    <Badge variant={isHidden ? "secondary" : "outline"}>{isHidden ? "Hidden" : "Shown"}</Badge>
                    <span className="text-xs text-muted-foreground">
                      <Received event={event} counts={counts} loading={countsLoading} />
                    </span>
                  </div>
                  {doc && (
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      {doc.what} <span className="text-foreground/80">{doc.used_for}</span>
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ event, hidden: !isHidden }, { onError: (e) => setError(e.message) })}
                >
                  {isHidden ? "Show" : "Hide"}
                </Button>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

const CUSTOM = "__custom__";

/**
 * Events of your own that you have decided are not activity.
 *
 * Nothing here deletes anything. The rows stay in ClickHouse, ingest keeps accepting
 * them, and raw SQL still sees them — hiding is a statement about what counts,
 * applied when a report runs, so it can be taken back the moment it turns out that
 * the event mattered after all.
 */
function HiddenEventsCard({ hiddenSet, system, counts, loading, countsLoading, setError, available }: Shared & { available: EventName[] }) {
  const set = useSetEventHidden();
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");

  // System events have their own row above, with the explanation that belongs to them.
  const systemSet = useMemo(() => new Set(system), [system]);
  const rows = [...hiddenSet].filter((e) => !systemSet.has(e)).sort();
  const selectable = available.filter((e) => !hiddenSet.has(e.event) && !systemSet.has(e.event));

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const name = (choice === CUSTOM ? custom : choice).trim();
    if (!name) return;
    setError(null);
    set.mutate({ event: name, hidden: true }, { onError: (err) => setError(err.message) });
    setChoice("");
    setCustom("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hidden events</CardTitle>
        <CardDescription>
          Your own events that should not count as activity. A hidden event leaves every count, chart, ranking and feed — the overview totals, the events list,
          and each person&apos;s and company&apos;s event count. Nothing is deleted: the rows stay, and showing an event again brings back its whole history,
          including the part recorded while it was hidden.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-9" />
        ) : rows.length === 0 ? (
          <EmptyState icon={<EyeOff />} title="Nothing hidden" description="Every event you send is being counted as activity." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="w-28 text-right">Received</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <TableRow key={event}>
                  <TableCell className="font-mono text-xs">{event}</TableCell>
                  <TableCell className="text-right">
                    <Received event={event} counts={counts} loading={countsLoading} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" disabled={set.isPending} onClick={() => set.mutate({ event, hidden: false }, { onError: (e) => setError(e.message) })}>
                      Show
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <form onSubmit={onAdd} className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger size="sm" className="w-64 text-xs">
              <SelectValue placeholder="Choose an event to hide" />
            </SelectTrigger>
            <SelectContent>
              {selectable.map((e) => (
                <SelectItem key={e.event} value={e.event}>
                  {e.event} · {formatNumber(e.count)}
                </SelectItem>
              ))}
              {/* An event you have stopped sending, or have not shipped yet, never
                  appears in the list above — so the name can always be typed. */}
              <SelectItem value={CUSTOM}>Type a name…</SelectItem>
            </SelectContent>
          </Select>
          {choice === CUSTOM && <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="event_name" className="h-8 w-56 font-mono text-xs" autoFocus />}
          <Button type="submit" size="sm" disabled={set.isPending || !(choice === CUSTOM ? custom.trim() : choice)}>
            <Plus className="size-3.5" /> Hide event
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

