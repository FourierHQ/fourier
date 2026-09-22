"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/empty-state";
import { Location } from "@/components/location";
import { displayName, formatNumber, initials, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { UserRecord } from "@/lib/api";

export function UserAvatar({ name, className = "size-7 text-[10px]" }: { name: string; className?: string }) {
  return <div className={`flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ${className}`}>{initials(name)}</div>;
}

/**
 * How a person is named in a list: where they were, then who they are — or, when nobody
 * has identified them, the word Anon and enough of their id to tell two of them apart.
 *
 * One component rather than the same three spans written wherever people are listed.
 * The anonymous rendering is the load-bearing half: a bare truncated uuid reads as a
 * name that happens to be ugly, and a row of them reads as a list of different-looking
 * strangers rather than a list of people nothing is known about yet. "Anon" says the
 * state, and the id fragment after it is there to distinguish, not to be read.
 */
export function PersonLabel({
  label,
  personId,
  identified,
  country,
  city,
  mono = true,
  className,
}: {
  /** What to show when they are identified: a user id, or a name off their traits. */
  label: string;
  personId: string;
  identified: boolean;
  country?: string;
  city?: string;
  /** Off where `label` is a human name, which should not be set in a monospace face. */
  mono?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <Location country={country ?? ""} city={city} className="shrink-0" />
      <span className="flex min-w-0 items-baseline gap-1">
        {identified ? (
          <span className={cn("truncate", mono && "font-mono")}>{label}</span>
        ) : (
          <>
            <span className="text-muted-foreground">Anon</span>
            <span className="truncate font-mono text-[10px] text-muted-foreground/60">{personId.slice(0, 8)}</span>
          </>
        )}
      </span>
    </span>
  );
}

export function UsersTable({ users, loading, showCompany = true, emptyDescription }: { users: UserRecord[] | undefined; loading?: boolean; showCompany?: boolean; emptyDescription?: React.ReactNode }) {
  if (loading && !users) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }
  if (!users || users.length === 0) return <EmptyState className="m-4" icon={<Users />} title="No users yet" description={emptyDescription} />;
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[30%] truncate">User</TableHead>
          <TableHead className="hidden truncate md:table-cell">Email</TableHead>
          {showCompany && <TableHead className="w-[14%] truncate">Company</TableHead>}
          <TableHead className="w-[72px] text-right">Events</TableHead>
          <TableHead className="w-[72px] text-right">First seen</TableHead>
          <TableHead className="w-[72px] text-right">Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => {
          const name = displayName(u.traits, u.is_identified ? u.distinct_id : shortId(u.distinct_id, 12));
          return (
            <TableRow key={u.distinct_id}>
              <TableCell className="overflow-hidden">
                <Link href={`/users/${encodeURIComponent(u.distinct_id)}`} className="flex min-w-0 items-center gap-2.5 hover:underline">
                  <UserAvatar name={name} />
                  <span className="truncate font-medium">{name}</span>
                  {!u.is_identified && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      anonymous
                    </Badge>
                  )}
                </Link>
                <Location country={u.country} city={u.city} text="city" prefix="Last seen in " className="mt-0.5 ml-[38px] text-xs text-muted-foreground" />
              </TableCell>
              <TableCell className="hidden overflow-hidden text-ellipsis text-muted-foreground md:table-cell">{(u.traits.email as string) ?? "—"}</TableCell>
              {showCompany && (
                <TableCell className="overflow-hidden text-ellipsis">
                  {u.group_id ? (
                    <Link href={`/companies/${encodeURIComponent(u.group_id)}`} className="font-mono text-xs hover:underline">
                      {u.group_id}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">{formatNumber(u.event_count)}</TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                <RelativeTime value={u.first_seen} />
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                <RelativeTime value={u.last_seen} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
