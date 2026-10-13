"use client";

import Link from "next/link";
import { ArrowUpRight, Building2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { TouchBadge } from "@/components/attribution";
import { CopyButton } from "@/components/copy-button";
import { EventsTable } from "@/components/events-table";
import { Location } from "@/components/location";
import { RelativeTime } from "@/components/relative-time";
import { PersonLabel, UserAvatar } from "@/components/users-table";
import { MetricLabel } from "@/components/web/metric";
import { QueryError } from "@/components/web/states";
import { useUser } from "@/lib/api";
import { displayName, formatNumber, shortId } from "@/lib/format";

/**
 * One person, inside the drawer that listed them.
 *
 * Every drawer that lists people opens them the same way: the drawer turns the page to
 * them, says what it came from, and Back turns it back. That is the drill-down all the
 * way to the bottom — from a rate, to the rows behind it, to the one person behind a row —
 * without ever leaving the report the reader started on.
 *
 * Their whole timeline, not the selected period's slice of it: a reader arriving here
 * is asking what this person did, and the answer is routinely "read three articles in
 * March and signed up last week". The heading says so, because a timeline that quietly
 * stopped at the range boundary would read as the person having done nothing before.
 */
export function PersonPage({ personId, onBack, backLabel }: { personId: string; onBack: () => void; backLabel?: string }) {
  const { data, isLoading, isError, error } = useUser(personId);
  const user = data?.user;
  const attribution = data?.attribution;
  const name = user ? displayName(user.traits, user.distinct_id) : personId;
  const email = (user?.traits.email as string) ?? "";

  return (
    <>
      <SheetHeader className="pb-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-7 w-fit text-muted-foreground">
          <ChevronLeft className="size-3.5" />
          {backLabel ? `Back to ${backLabel}` : "Back"}
        </Button>
        <SheetTitle className="flex items-center gap-2 pr-8 text-sm">
          {user?.is_identified ? (
            <>
              <UserAvatar name={name} />
              <span className="truncate">{name}</span>
            </>
          ) : (
            <PersonLabel label={name} personId={personId} identified={false} country={user?.country} city={user?.city} className="text-sm" />
          )}
        </SheetTitle>
        <SheetDescription>{email || "Everything Fourier has recorded for this person"}</SheetDescription>
      </SheetHeader>

      <div className="space-y-5 p-4">
        {isError ? (
          <QueryError message={error?.message} />
        ) : (
          <>
            {isLoading && !user ? (
              <Skeleton className="h-14" />
            ) : (
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Events</dt>
                  <dd className="font-medium tabular-nums">{formatNumber(user?.event_count)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">First seen</dt>
                  <dd className="font-medium">{user && <RelativeTime value={user.first_seen} />}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Last seen</dt>
                  <dd className="font-medium">{user && <RelativeTime value={user.last_seen} />}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Company</dt>
                  <dd className="truncate font-medium">
                    {user?.group_id ? (
                      <Link href={`/companies/${encodeURIComponent(user.group_id)}`} className="inline-flex items-center gap-1 font-mono text-xs hover:underline">
                        <Building2 className="size-3" />
                        {shortId(user.group_id, 14)}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
              </dl>
            )}

            {user && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                  <span className="truncate">{user.distinct_id}</span>
                  <CopyButton value={user.distinct_id} />
                </span>
                <Location country={user.country} city={user.city} text="full" />
                <Button variant="outline" size="sm" asChild className="ml-auto h-7">
                  <Link href={`/users/${encodeURIComponent(user.distinct_id)}`}>
                    Full profile <ArrowUpRight className="size-3" />
                  </Link>
                </Button>
              </div>
            )}

            {/* How they got here, which is the question a conversion drilldown asks
                next: this person converted — what found them, and what brought them
                back. Derived over all their history, not the selected period, because
                the touch that found them is usually older than the report. */}
            {attribution && attribution.touch_count > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">How they arrived</h3>
                <dl className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <dt className="mb-1 text-xs text-muted-foreground">First touch</dt>
                    <dd className="flex min-w-0 flex-col items-start gap-0.5">
                      {attribution.first_touch ? (
                        <>
                          <TouchBadge touch={attribution.first_touch} className="max-w-full" />
                          <RelativeTime value={attribution.first_touch.timestamp} className="text-[11px] text-muted-foreground" />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="mb-1 text-xs text-muted-foreground">
                      <MetricLabel hint="The last arrival that was not direct, when they have one. Someone who returns by typing the address has not been found again by anything, and crediting that to “direct” would bury whatever actually brought them back.">
                        Last touch
                      </MetricLabel>
                    </dt>
                    <dd className="flex min-w-0 flex-col items-start gap-0.5">
                      {attribution.last_touch ? (
                        <>
                          <TouchBadge touch={attribution.last_touch} className="max-w-full" />
                          <RelativeTime value={attribution.last_touch.timestamp} className="text-[11px] text-muted-foreground" />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </dd>
                  </div>
                </dl>
                {attribution.touch_count > 1 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatNumber(attribution.touch_count)} arrivals recorded in total.
                  </p>
                )}
              </section>
            )}

            <section>
              <h3 className="mb-1 text-sm font-medium">Timeline</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Every event from this person, including activity outside the selected period and before they identified.
              </p>
              <div className="overflow-hidden rounded-md border">
                <EventsTable events={data?.events} loading={isLoading} showUser={false} showCompany={false} />
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
