"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/empty-state";
import { displayName, formatNumber, initials, shortId } from "@/lib/format";
import type { UserRecord } from "@/lib/api";

export function UserAvatar({ name, className = "size-7 text-[10px]" }: { name: string; className?: string }) {
  return <div className={`flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ${className}`}>{initials(name)}</div>;
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
          <TableHead className="w-[30%]">User</TableHead>
          <TableHead className="hidden md:table-cell">Email</TableHead>
          {showCompany && <TableHead className="w-[14%]">Company</TableHead>}
          <TableHead className="w-[72px] text-right">Events</TableHead>
          <TableHead className="w-[96px] text-right">First seen</TableHead>
          <TableHead className="w-[96px] text-right">Last seen</TableHead>
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
