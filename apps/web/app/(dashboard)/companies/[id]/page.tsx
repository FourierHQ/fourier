"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Building2, ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { EventsTable } from "@/components/events-table";
import { UsersTable } from "@/components/users-table";
import { JsonView } from "@/components/json-view";
import { RelativeTime } from "@/components/relative-time";
import { CopyButton } from "@/components/copy-button";
import { TimeseriesChart } from "@/components/timeseries-chart";
import { AttributionCard } from "@/components/attribution";
import { useGroup, useTimeseries } from "@/lib/api";
import { eventLabel, formatNumber } from "@/lib/format";

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  const groupId = decodeURIComponent(id);
  const { data, isLoading, isError, error } = useGroup(groupId);
  const series = useTimeseries({ group_id: groupId, interval: "day" });
  const group = data?.group;
  const name = (group?.traits.name as string) ?? groupId;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" asChild>
              <Link href="/companies">
                <ChevronLeft />
              </Link>
            </Button>
            {name}
          </span>
        }
      />
      <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <Card>
            <CardContent className="space-y-4">
              {isLoading ? (
                <Skeleton className="h-24" />
              ) : isError || !group ? (
                <p className="text-sm text-muted-foreground">{error?.message ?? "Company not found"}</p>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Building2 className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{name}</div>
                      <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                        <span className="truncate">{group.group_id}</span>
                        <CopyButton value={group.group_id} />
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.traits.plan ? <Badge variant="secondary">{String(group.traits.plan)}</Badge> : null}
                    {group.traits.industry ? <Badge variant="outline">{String(group.traits.industry)}</Badge> : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Users</dt>
                      <dd className="font-medium tabular-nums">{formatNumber(group.user_count)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Events</dt>
                      <dd className="font-medium tabular-nums">{formatNumber(group.event_count)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">First seen</dt>
                      <dd className="font-medium"><RelativeTime value={group.first_seen} /></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Last active</dt>
                      <dd className="font-medium"><RelativeTime value={group.last_seen} /></dd>
                    </div>
                  </dl>
                </>
              )}
            </CardContent>
          </Card>
          {group && (
            <>
              <AttributionCard attribution={data?.attribution} description="Arrivals of every member, including before they signed up" showPerson />
              <Card>
                <CardHeader>
                  <CardTitle>Traits</CardTitle>
                  <CardDescription>Merged from every group() call</CardDescription>
                </CardHeader>
                <CardContent>
                  <JsonView data={group.traits} />
                </CardContent>
              </Card>
              {group.top_events.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Top events</CardTitle>
                    <CardDescription>Across every user in this company</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {group.top_events.map((e) => (
                      <div key={e.event} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{eventLabel({ type: e.event.startsWith("$") ? e.event.slice(1) : "track", event: e.event })}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {formatNumber(e.count)} <span className="text-xs">· {formatNumber(e.users)} users</span>
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
        <div className="space-y-6 lg:col-span-2">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <TimeseriesChart data={series.data} loading={series.isLoading} className="h-[160px] w-full" />
            </CardContent>
          </Card>
          <Tabs defaultValue="events">
            <TabsList>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="members">Members {group ? `(${group.members.length})` : ""}</TabsTrigger>
            </TabsList>
            <TabsContent value="events" className="pt-3">
              <Card className="overflow-hidden py-0">
                <EventsTable events={data?.events} loading={isLoading} showCompany={false} />
              </Card>
            </TabsContent>
            <TabsContent value="members" className="pt-3">
              <Card className="overflow-hidden py-0">
                <UsersTable users={group?.members} loading={isLoading} showCompany={false} />
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}
