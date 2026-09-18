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
import { useEventNames, useHiddenEvents, useSetEventHidden } from "@/lib/api";
import { formatNumber } from "@/lib/format";

/** How the events Fourier collects are read, rather than how they are collected. */
export function EventSettings() {
  return <HiddenEventsCard />;
}

const CUSTOM = "__custom__";

/**
 * Hidden events.
 *
 * Nothing here deletes anything. The rows stay in ClickHouse, ingest keeps accepting
 * them, and raw SQL still sees them — hiding is a statement about what counts as
 * activity, applied when a report runs, so it can be taken back the moment it turns
 * out that the event mattered after all.
 */
function HiddenEventsCard() {
  const hidden = useHiddenEvents();
  // The picker needs the names the rest of the app is refusing to show, so it asks for
  // everything; counts come from the full 30-day window rather than a filtered one.
  const names = useEventNames(30, undefined, true);
  const set = useSetEventHidden();
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hiddenSet = useMemo(() => new Set(hidden.data?.hidden ?? []), [hidden.data]);
  const system = useMemo(() => new Set(hidden.data?.system ?? []), [hidden.data]);
  const counts = useMemo(() => new Map((names.data ?? []).map((e) => [e.event, e])), [names.data]);
  const selectable = (names.data ?? []).filter((e) => !hiddenSet.has(e.event));

  const submit = (event: string) => {
    const name = event.trim();
    if (!name) return;
    setError(null);
    set.mutate({ event: name, hidden: true }, { onError: (e) => setError(e.message) });
    setChoice("");
    setCustom("");
  };

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    submit(choice === CUSTOM ? custom : choice);
  };

  const rows = [...hiddenSet].sort();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hidden events</CardTitle>
        <CardDescription>
          Events that are instrumentation rather than activity. A hidden event is left out of every count, chart, ranking and feed — the overview totals, the
          events list, and each person&apos;s and company&apos;s event count. Nothing is deleted: the rows stay, and showing an event again brings back its whole
          history.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hidden.error && <p className="text-sm text-destructive">{hidden.error.message}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {hidden.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<EyeOff />} title="Nothing is hidden" description="Every event this project receives is being counted." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => {
                const seen = counts.get(event);
                return (
                  <TableRow key={event}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{event}</span>
                        {system.has(event) && <Badge variant="secondary">System</Badge>}
                      </div>
                      {system.has(event) && (
                        <p className="mt-1 text-xs text-muted-foreground">Sent by the Fourier SDK to measure how long a page held attention. It is reported as engagement time instead.</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {names.isLoading ? "" : seen ? `${formatNumber(seen.count)} in 30d` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" disabled={set.isPending} onClick={() => set.mutate({ event, hidden: false }, { onError: (e) => setError(e.message) })}>
                        Show
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
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
          {choice === CUSTOM && (
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="event_name" className="h-8 w-56 font-mono text-xs" autoFocus />
          )}
          <Button type="submit" size="sm" disabled={set.isPending || !(choice === CUSTOM ? custom.trim() : choice)}>
            <Plus className="size-3.5" /> Hide event
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
