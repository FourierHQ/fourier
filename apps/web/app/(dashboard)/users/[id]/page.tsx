"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Building2, ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { EventsTable } from "@/components/events-table";
import { JsonView } from "@/components/json-view";
import { RelativeTime } from "@/components/relative-time";
import { UserAvatar } from "@/components/users-table";
import { CopyButton } from "@/components/copy-button";
import { AttributionCard } from "@/components/attribution";
import { useSourceName } from "@/components/source-badge";
import { Location } from "@/components/location";
import { useUser } from "@/lib/api";
import { displayName, eventLabel, formatNumber } from "@/lib/format";

export default function UserPage() {
  const { id } = useParams<{ id: string }>();
  const distinctId = decodeURIComponent(id);
  const { data, isLoading, isError, error } = useUser(distinctId);
  const user = data?.user;
  const name = user ? displayName(user.traits, user.distinct_id) : distinctId;
  const sourceName = useSourceName();

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" asChild>
              <Link href="/users">
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
              ) : isError || !user ? (
                <p className="text-sm text-muted-foreground">{error?.message ?? "User not found"}</p>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <UserAvatar name={name} className="size-12 text-sm" />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{name}</div>
                      <div className="truncate text-sm text-muted-foreground">{(user.traits.email as string) ?? (user.is_identified ? "" : "Anonymous visitor")}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <span className="truncate">{user.distinct_id}</span>
                    <CopyButton value={user.distinct_id} />
                    {!user.is_identified && <Badge variant="outline">anonymous</Badge>}
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Events</dt>
                      <dd className="font-medium tabular-nums">{formatNumber(user.event_count)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">First seen</dt>
                      <dd className="font-medium"><RelativeTime value={user.first_seen} /></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Last seen</dt>
                      <dd className="font-medium"><RelativeTime value={user.last_seen} /></dd>
                    </div>
                    {user.country && (
                      <div className="col-span-3">
                        <dt className="text-xs text-muted-foreground">Last seen in</dt>
                        <dd className="font-medium">
                          <Location country={user.country} city={user.city} text="full" />
                        </dd>
                      </div>
                    )}
                  </dl>
                  {user.sources.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-xs text-muted-foreground">Seen on</div>
                      <div className="space-y-1">
                        {user.sources.map((s) => (
                          <div key={s.source_id} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-medium">{sourceName(s.source_id)}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {formatNumber(s.event_count)} events · first <RelativeTime value={s.first_seen} />
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {user.groups.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-xs text-muted-foreground">Companies</div>
                      <div className="flex flex-wrap gap-1.5">
                        {user.groups.map((g) => (
                          <Button key={g.group_id} variant="outline" size="sm" asChild>
                            <Link href={`/companies/${encodeURIComponent(g.group_id)}`}>
                              <Building2 className="size-3.5" />
                              {(g.traits.name as string) ?? g.group_id}
                            </Link>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
          {user && (
            <>
              <AttributionCard attribution={data?.attribution} description="Where this person came from, including before they signed up" />
              <Card>
                <CardHeader>
                  <CardTitle>Traits</CardTitle>
                  <CardDescription>Merged from every identify() call</CardDescription>
                </CardHeader>
                <CardContent>
                  <JsonView data={user.traits} />
                </CardContent>
              </Card>
              {user.top_events.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Top events</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {user.top_events.map((e) => (
                      <div key={e.event} className="flex items-center justify-between text-sm">
                        <span className="truncate">{eventLabel({ type: e.event.startsWith("$") ? e.event.slice(1) : "track", event: e.event })}</span>
                        <span className="tabular-nums text-muted-foreground">{formatNumber(e.count)}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
              {user.anonymous_ids.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Linked anonymous ids</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 font-mono text-xs text-muted-foreground">
                    {user.anonymous_ids.map((a) => (
                      <div key={a} className="truncate">{a}</div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
        <Card className="overflow-hidden py-0 lg:col-span-2">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Timeline</h2>
            <p className="text-xs text-muted-foreground">Every event from this user, including pre-signup anonymous activity</p>
          </div>
          <EventsTable events={data?.events} loading={isLoading} showUser={false} />
        </Card>
      </div>
    </>
  );
}
