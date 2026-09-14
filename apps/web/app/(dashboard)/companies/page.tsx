"use client";

import Link from "next/link";
import { Building2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { CodeBlock } from "@/components/code-block";
import { useGroups } from "@/lib/api";
import { formatNumber } from "@/lib/format";

export default function CompaniesPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const groups = useGroups({ q: debounced || undefined, limit: 200 });

  return (
    <>
      <PageHeader
        title="Companies"
        description="Workspaces, organisations, accounts: anything you group() users into"
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies…" className="h-8 w-56 pl-7 text-xs" />
          </div>
        }
      />
      <div className="p-4 md:p-6">
        <Card className="overflow-hidden py-0">
          {groups.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : !groups.data?.length ? (
            <EmptyState
              className="m-4"
              icon={<Building2 />}
              title="No companies yet"
              description={
                <span>
                  Call <code className="font-mono text-xs">group()</code> after a user logs in to attach them to their company. Every later event carries the company id, so you can roll up usage per account.
                </span>
              }
              action={<CodeBlock code={`fourier.group("acme", { name: "Acme Inc", plan: "enterprise" });`} className="text-left" />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">First seen</TableHead>
                  <TableHead className="text-right">Last active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.data.map((g) => (
                  <TableRow key={g.group_id}>
                    <TableCell>
                      <Link href={`/companies/${encodeURIComponent(g.group_id)}`} className="flex items-center gap-2.5 hover:underline">
                        <div className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Building2 className="size-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{(g.traits.name as string) ?? g.group_id}</div>
                          {g.traits.name ? <div className="truncate font-mono text-xs text-muted-foreground">{g.group_id}</div> : null}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>{g.traits.plan ? <Badge variant="secondary">{String(g.traits.plan)}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(g.user_count)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(g.event_count)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground"><RelativeTime value={g.first_seen} /></TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground"><RelativeTime value={g.last_seen} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
