"use client";

import { Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { EventsTable } from "@/components/events-table";
import { TimeseriesChart } from "@/components/timeseries-chart";
import { useEventNames, useEvents, useTimeseries } from "@/lib/api";
import { eventLabel, formatNumber } from "@/lib/format";

const ALL = "__all__";

function EventsView() {
  const params = useSearchParams();
  const router = useRouter();
  const event = params.get("event") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const names = useEventNames();
  const events = useEvents({ event: event || undefined, q: debounced || undefined, limit });
  const series = useTimeseries({ event: event || undefined, interval: "hour" });

  const setEvent = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v && v !== ALL) next.set("event", v);
    else next.delete("event");
    router.replace(`/events${next.toString() ? `?${next}` : ""}`);
  };

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
          </>
        }
      />
      <div className="space-y-4 p-4 md:p-6">
        <Card size="sm">
          <CardContent>
            <TimeseriesChart data={series.data} loading={series.isLoading} interval="hour" className="h-[140px] w-full" />
          </CardContent>
        </Card>
        <Card className="overflow-hidden py-0">
          <EventsTable events={events.data?.events} loading={events.isLoading} emptyTitle={event || q ? "No matching events" : "No events yet"} emptyDescription={event || q ? "Try a different filter." : "Install the snippet to start receiving events."} />
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
