"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Goal, ScopeEcho } from "@/lib/web-api";

/**
 * "Open in Explore", offered only where it tells the truth.
 *
 * Fourier's exploration surface is the Events view, which lists individual events over
 * a time range. A goal and a supporting action are events, so the link carries the event
 * name and the selected dates and shows the completions themselves.
 *
 * It shows the completions, not the count beside it, and the label says so. The two are
 * deliberately different numbers: a converting session is counted once however often
 * the goal fires inside it, it is dated by when the visit began rather than when the
 * event landed, and bot traffic is excluded. Someone who follows this link and finds
 * more rows than conversions has found all three rules working, not a discrepancy.
 *
 * It is absent everywhere else. Sessions, landing pages, channels and engagement are
 * session-level aggregates with no event-level equivalent, and a link that silently
 * answers a different question is worse than no link at all. A goal defined by a URL
 * rule gets none either, because the Events view cannot filter by path.
 */
export function ExploreLink({ goal, scope, className }: { goal: Pick<Goal, "config"> | null | undefined; scope: ScopeEcho | undefined; className?: string }) {
  if (!goal || goal.config.match !== "event" || !scope) return null;
  const params = new URLSearchParams({
    event: goal.config.event,
    after: scope.range.from,
    before: scope.range.to,
  });
  return (
    <Link
      href={`/events?${params}`}
      className={className ?? "inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"}
      onClick={(e) => e.stopPropagation()}
      title={`Every "${goal.config.event}" event in this period. More rows than converting sessions is expected: a visit counts once however many times it fires.`}
    >
      Events <ArrowUpRight className="size-3" />
    </Link>
  );
}
