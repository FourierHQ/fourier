"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, Eye, Fingerprint, Building2, Link2, MousePointerClick, Smartphone } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { JsonPreview, JsonView } from "@/components/json-view";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/empty-state";
import { eventLabel, shortId } from "@/lib/format";
import type { EventRecord } from "@/lib/api";
import { cn } from "@/lib/utils";

const typeIcon: Record<string, typeof Eye> = {
  page: Eye,
  screen: Smartphone,
  identify: Fingerprint,
  group: Building2,
  alias: Link2,
  track: MousePointerClick,
};

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  const Icon = typeIcon[type] ?? MousePointerClick;
  return (
    <Badge variant={type === "track" ? "default" : "secondary"} className={cn("gap-1 font-mono text-[10px] uppercase", className)}>
      <Icon className="size-3" />
      {type}
    </Badge>
  );
}

export function EventsTable({
  events,
  loading,
  showUser = true,
  showCompany = true,
  emptyTitle = "No events yet",
  emptyDescription,
}: {
  events: EventRecord[] | undefined;
  loading?: boolean;
  showUser?: boolean;
  showCompany?: boolean;
  emptyTitle?: string;
  emptyDescription?: React.ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (loading && !events) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }
  if (!events || events.length === 0) {
    return <EmptyState className="m-4" icon={<MousePointerClick />} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead className="w-[30%]">Event</TableHead>
          <TableHead className="hidden md:table-cell">Properties</TableHead>
          {showUser && <TableHead className="w-[15%]">User</TableHead>}
          {showCompany && <TableHead className="w-[13%]">Company</TableHead>}
          <TableHead className="w-[96px] text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => {
          const isOpen = open.has(e.message_id);
          const cols = 4 + (showUser ? 1 : 0) + (showCompany ? 1 : 0);
          return (
            <Fragment key={e.message_id}>
              <TableRow onClick={() => toggle(e.message_id)} className="cursor-pointer" data-state={isOpen ? "selected" : undefined}>
                <TableCell className="px-2 text-muted-foreground">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                <TableCell className="overflow-hidden">
                  <div className="flex items-center gap-2">
                    <TypeBadge type={e.type} className="shrink-0" />
                    <span className="truncate font-medium">{eventLabel(e)}</span>
                  </div>
                  {e.type === "page" && e.path && <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{e.path}</div>}
                </TableCell>
                <TableCell className="hidden overflow-hidden md:table-cell">
                  <div className="flex min-w-0">
                    <JsonPreview data={e.type === "identify" || e.type === "group" ? e.traits : e.properties} />
                  </div>
                </TableCell>
                {showUser && (
                  <TableCell className="overflow-hidden text-ellipsis">
                    <Link href={`/users/${encodeURIComponent(e.person_id || e.distinct_id)}`} onClick={(ev) => ev.stopPropagation()} className="font-mono text-xs hover:underline">
                      {e.user_id ? e.user_id : e.person_id && e.person_id !== e.anonymous_id ? e.person_id : shortId(e.anonymous_id)}
                    </Link>
                    {!e.user_id && (
                      <span className="ml-1 text-[10px] text-muted-foreground">{e.person_id && e.person_id !== e.anonymous_id ? "pre-signup" : "anon"}</span>
                    )}
                  </TableCell>
                )}
                {showCompany && (
                  <TableCell className="overflow-hidden text-ellipsis">
                    {e.group_id ? (
                      <Link href={`/companies/${encodeURIComponent(e.group_id)}`} onClick={(ev) => ev.stopPropagation()} className="font-mono text-xs hover:underline">
                        {e.group_id}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-right text-xs text-muted-foreground">
                  <RelativeTime value={e.timestamp} />
                </TableCell>
              </TableRow>
              {isOpen && (
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={cols} className="p-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{e.type === "identify" || e.type === "group" ? "Traits" : "Properties"}</h4>
                        <JsonView data={e.type === "identify" || e.type === "group" ? e.traits : e.properties} />
                      </div>
                      <div>
                        <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Context</h4>
                        <JsonView
                          data={{
                            timestamp: e.timestamp,
                            received_at: e.received_at,
                            message_id: e.message_id,
                            user_id: e.user_id || null,
                            anonymous_id: e.anonymous_id || null,
                            group_id: e.group_id || null,
                            url: e.url || undefined,
                            referrer: e.referrer || undefined,
                            locale: e.locale || undefined,
                            library: e.library_name || undefined,
                            user_agent: e.user_agent || undefined,
                            ...e.context,
                          }}
                        />
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
