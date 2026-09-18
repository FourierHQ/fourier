"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Filter, Gauge, RefreshCw, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The several different kinds of nothing.
 *
 * A report with no rows can mean the site has no traffic, or that the filters match
 * none of it, or that no goal is configured, or that a measurement was never collected,
 * or that the query failed. They need different sentences and different next steps, and
 * showing "0" for all five is how a dashboard teaches people not to trust it.
 */

function Frame({ icon, title, body, action, className }: { icon: ReactNode; title: string; body: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      <div className="text-muted-foreground/60">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Nothing was recorded for this site in this range. */
export function NoTraffic({ rangeLabel }: { rangeLabel?: string }) {
  return (
    <Frame
      icon={<Gauge className="size-6" />}
      title="No traffic recorded"
      body={<>Nothing arrived for this site {rangeLabel ? <>in {rangeLabel.toLowerCase()}</> : "in the selected period"}. If you have just installed tracking, visits appear here within a few seconds.</>}
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href="/setup">Check your install</Link>
        </Button>
      }
    />
  );
}

/** There is traffic; these filters simply exclude all of it. */
export function NoMatches({ onClear }: { onClear?: () => void }) {
  return (
    <Frame
      icon={<Filter className="size-6" />}
      title="No results for these filters"
      body="This site had traffic in the selected period, but nothing matches the current filters."
      action={
        onClear && (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        )
      }
    />
  );
}

/**
 * No primary goal exists. Traffic reports stay usable around this; only the conversion
 * components are replaced, and they say what to do rather than showing zero.
 */
export function NeedsGoal({ action }: { action?: ReactNode }) {
  return (
    <Frame
      icon={<Target className="size-6" />}
      title="Choose a conversion goal"
      body="Name the thing this site exists to produce — a completed signup, a submitted enquiry, a confirmed booking — and every report here will measure against it, including the traffic you have already collected."
      // Conversions passes the dialog itself; everywhere else this links there. Without
      // the slot, the Conversions page ended up with a button beside a link to the page
      // it was already on.
      action={
        action ?? (
          <Button size="sm" asChild>
            <Link href="/web-analytics/conversions">Manage goals</Link>
          </Button>
        )
      }
    />
  );
}

/** A query failed. An error and a retry, never an empty chart that implies zero. */
export function QueryError({ message, onRetry, compact }: { message?: string; onRetry?: () => void; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3 px-6 py-4 text-sm">
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <AlertCircle className="size-4 shrink-0 text-destructive" />
          <span className="truncate">{message ?? "This part of the report could not be loaded."}</span>
        </span>
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <Frame
      icon={<AlertCircle className="size-6 text-destructive" />}
      title="Couldn't load this report"
      body={message ?? "The query did not complete. This is not a report of zero — nothing was measured."}
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        )
      }
    />
  );
}

/**
 * Wraps one card's worth of report. Whatever goes wrong inside stays inside: a failed
 * funnel query must not take the traffic chart above it off the page.
 */
export function Panel({
  error,
  empty,
  loading,
  skeleton,
  onRetry,
  children,
}: {
  error?: string;
  empty?: ReactNode;
  loading?: boolean;
  skeleton?: ReactNode;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (error) return <QueryError message={error} onRetry={onRetry} compact />;
  if (loading && skeleton) return <>{skeleton}</>;
  if (empty) return <>{empty}</>;
  return <>{children}</>;
}
