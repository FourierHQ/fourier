"use client";

import Link from "next/link";
import { ArrowUpRight, Building2, ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EventsTable } from "@/components/events-table";
import { Location } from "@/components/location";
import { RelativeTime } from "@/components/relative-time";
import { TouchBadge } from "@/components/attribution";
import { PersonLabel, UserAvatar } from "@/components/users-table";
import { CopyButton } from "@/components/copy-button";
import { CountChart } from "@/components/web/charts";
import { DetailSheetContent, DetailStat } from "@/components/web/detail-sheet";
import { GoalMark } from "@/components/web/goal-mark";
import { MetricLabel } from "@/components/web/metric";
import { QueryError } from "@/components/web/states";
import { useUser } from "@/lib/api";
import { displayName, formatNumber, formatRate, formatRatio, shortId, shortPath } from "@/lib/format";
import { ExploreLink } from "@/components/web/explore-link";
import { errorOf, unwrap, useWebGoalDetail, type Goal, type GoalConverterRow, type GoalSplit, type ScopeEcho } from "@/lib/web-api";

/**
 * Who completed a goal, in a sheet over the table it came from.
 *
 * The problem this replaces: the only way to see the people behind a conversion count
 * was the Events view, which knows nothing about the control bar. Following that link
 * from a report filtered to paid search on mobile handed back every completion from
 * everywhere, formatted identically — a longer list that looks like the same list. This
 * is counted off exactly the scope the row was, so the totals at the top of the drawer
 * reconcile with the row that opened it.
 *
 * Two pages, one drawer. The list, and then one person's own timeline, reached by
 * clicking them. A person is where a conversion investigation goes next — "who are
 * these forty signups" is immediately "and what did that one do before signing up" —
 * and pushing a route for it would take the reader off the report they are reading.
 * Back returns to the list, and closing returns to the table.
 */
export function GoalDetailSheet({
  definition,
  person,
  scope,
  onSelectPerson,
  onBack,
  onClose,
}: {
  definition: string | null;
  person: string | null;
  scope: ScopeEcho | undefined;
  onSelectPerson: (personId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  // Kept loading behind the person page so Back is instant rather than a second wait.
  const report = useWebGoalDetail(definition);
  const detail = unwrap(report.data?.detail);
  // The rule as it compiles, for the Events link. From the report rather than the stored
  // definitions: a value of a split goal has no definition of its own.
  const config = detail ? { config: detail.match } : undefined;
  const split = detail?.split ?? null;
  const error = errorOf(report.data?.detail);
  const loading = report.isLoading;
  const isSupporting = detail?.type === "supporting";

  return (
    <Sheet open={Boolean(definition)} onOpenChange={(open) => !open && onClose()}>
      <DetailSheetContent>
        {person ? (
          <PersonPage personId={person} onBack={onBack} backLabel={detail?.name} />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-8 text-sm">
                <GoalMark type={detail?.type ?? "primary"} />
                <span className="truncate">{detail?.name ?? "Goal"}</span>
                {isSupporting && (
                  <Badge variant="outline" className="shrink-0 font-normal">
                    Supporting
                  </Badge>
                )}
              </SheetTitle>
              <SheetDescription>
                {isSupporting
                  ? "Who triggered this action, under the filters currently on screen"
                  : "Who converted, under the filters currently on screen"}
              </SheetDescription>
              {split && <SplitOrigin split={split} type={detail?.type ?? "primary"} />}
            </SheetHeader>

            <div className="space-y-6 p-4">
              {error ? (
                <QueryError message={error} onRetry={() => report.refetch()} />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <DetailStat label="People" value={detail?.people.current} loading={loading} />
                    <DetailStat
                      label={isSupporting ? "Visits" : "Converting visits"}
                      value={detail?.sessions.current}
                      loading={loading}
                    />
                    <DetailStat
                      label={<MetricLabel hint="Every completion, counting repeats — so it sits above the visit count whenever someone completed the goal more than once in one visit.">Completions</MetricLabel>}
                      value={detail?.completions.current}
                      loading={loading}
                    />
                    <DetailStat
                      label={isSupporting ? "Of all visits" : "Conversion rate"}
                      value={formatRate(detail?.rate.rate)}
                      sub={detail && formatRatio(detail.rate.numerator, detail.rate.denominator, "visits")}
                      loading={loading}
                    />
                  </div>

                  <section>
                    <h3 className="mb-2 text-sm font-medium">{isSupporting ? "Visits with this action" : "Conversions"} over time</h3>
                    <CountChart
                      data={detail?.trend}
                      label={isSupporting ? "Visits" : "Converting visits"}
                      interval={scope?.range.interval ?? "day"}
                      loading={loading}
                      className="h-[180px] w-full"
                    />
                  </section>

                  <section>
                    <div className="mb-2 flex items-end justify-between gap-2">
                      <h3 className="text-sm font-medium">People</h3>
                      {detail && detail.total_people > detail.converters.length && (
                        <span className="text-xs text-muted-foreground">
                          Most recent {formatNumber(detail.converters.length)} of {formatNumber(detail.total_people)}
                        </span>
                      )}
                    </div>
                    <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                      Ordered by when they last completed it. Anonymous browsing that later identified is one person here,
                      not two — these are resolved visitors, the same unit the reports count.
                    </p>
                    <div className="rounded-md border">
                      <ConvertersTable rows={detail?.converters} loading={loading} onSelect={onSelectPerson} />
                    </div>
                  </section>

                  <GoalFootnote goal={config} scope={scope} isSupporting={isSupporting} />
                </>
              )}
            </div>
          </>
        )}
      </DetailSheetContent>
    </Sheet>
  );
}

function ConvertersTable({
  rows,
  loading,
  onSelect,
}: {
  rows: GoalConverterRow[] | undefined;
  loading?: boolean;
  onSelect: (personId: string) => void;
}) {
  if (loading && !rows) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (!rows?.length) {
    return <p className="p-3 text-sm text-muted-foreground">Nobody completed this in the selected period under these filters.</p>;
  }
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="truncate">Person</TableHead>
          <TableHead className="hidden w-[22%] truncate sm:table-cell">Company</TableHead>
          <TableHead className="w-[76px] text-right">Times</TableHead>
          <TableHead className="w-[72px] text-right">Last</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const name = displayName(r.traits, r.person_id);
          const email = (r.traits.email as string) ?? "";
          return (
            <TableRow
              key={r.person_id}
              className="cursor-pointer"
              onClick={() => onSelect(r.person_id)}
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" ? onSelect(r.person_id) : undefined)}
            >
              <TableCell className="overflow-hidden">
                {/* Named the way the Events view names people, so the same person reads
                    the same in both places. */}
                <PersonLabel
                  label={name}
                  personId={r.person_id}
                  identified={r.is_identified}
                  country={r.country}
                  city={r.city}
                  mono={false}
                  className="text-sm font-medium"
                />
                <span className="mt-0.5 block truncate pl-[22px] text-xs text-muted-foreground">
                  {email && email !== name ? email : r.last_path ? shortPath(r.last_path, 32) : ""}
                </span>
              </TableCell>
              <TableCell className="hidden overflow-hidden text-ellipsis sm:table-cell">
                {r.group_id ? (
                  <Link
                    href={`/companies/${encodeURIComponent(r.group_id)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="truncate font-mono text-xs hover:underline"
                  >
                    {r.group_id}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              {/* Times, not visits: the drawer's job is the individual, and "converted
                  three times" is exactly what a person-level list is for. The visit
                  count is on the row above in the totals, where it reconciles. */}
              <TableCell className="text-right tabular-nums">{formatNumber(r.completions)}</TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                <RelativeTime value={r.last_at} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * One person, inside the drawer that listed them.
 *
 * Their whole timeline, not the selected period's slice of it: a reader arriving here
 * is asking what this person did, and the answer is routinely "read three articles in
 * March and signed up last week". The heading says so, because a timeline that quietly
 * stopped at the range boundary would read as the person having done nothing before.
 */
function PersonPage({ personId, onBack, backLabel }: { personId: string; onBack: () => void; backLabel?: string }) {
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

/**
 * Why this list and the Events view disagree, said once, at the point where someone is
 * about to click through to the second one and compare the two.
 */
const NAMED_FROM: Record<string, string> = {
  label: "its label property",
  page: "the title of the page it's completed on",
  raw: "nothing — the data has no name for it",
  unset: "",
};

/**
 * Where a value of a split goal comes from: the value itself, where its name was read
 * from, and when it first appeared — the drawer is where someone lands from a row they
 * do not recognise.
 */
function SplitOrigin({ split, type }: { split: GoalSplit; type: "primary" | "supporting" }) {
  if (split.role === "all") {
    return (
      <p className="text-xs text-muted-foreground">
        Every <code className="font-mono">{split.key}</code> of {split.definition_name} that counts as{" "}
        {type === "primary" ? "a conversion" : "a supporting action"}, as one number — visits, not the sum of its rows.
      </p>
    );
  }
  if (split.role === "other") {
    return (
      <p className="text-xs text-muted-foreground">
        Values of <code className="font-mono">{split.key}</code> without a row of their own — there were too many to list.
        Review {split.definition_name} to give one a name.
      </p>
    );
  }
  const from = split.name_source ? NAMED_FROM[split.name_source] : undefined;
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <span>One value of {split.definition_name}:</span>
        <code className="rounded bg-muted px-1 font-mono">
          {split.key} = {split.value === "" ? "(not set)" : split.value}
        </code>
        {split.value && <CopyButton value={split.value} />}
      </p>
      {from && (
        <p>
          Named from {from}
          {split.name_evidence && split.name_source === "page" ? ` (${split.name_evidence.replace(/^Title of /, "")})` : ""}. Rename it in Manage goals.
        </p>
      )}
      {split.first_seen && (
        <p>
          First completed <RelativeTime value={split.first_seen} />.
        </p>
      )}
    </div>
  );
}

function GoalFootnote({ goal, scope, isSupporting }: { goal: Pick<Goal, "config"> | undefined; scope: ScopeEcho | undefined; isSupporting: boolean }) {
  const thing = isSupporting ? "action" : "goal";
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Counted exactly as the table behind this drawer counts it: the control bar&apos;s filters apply, automated traffic
        is excluded, and a visit is dated by when it began rather than when the {thing} fired. The Events view applies
        none of the three, so the same {thing} listed there shows more rows. That is the filters working, not a
        discrepancy.
      </p>
      <ExploreLink goal={goal} scope={scope} className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" />
    </div>
  );
}
