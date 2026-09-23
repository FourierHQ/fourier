"use client";

import { useCallback, useMemo } from "react";
import { Target } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWebDefinitions } from "@/lib/web-api";
import { eventMatches, splitEventMatch, type MatchableEvent } from "@fourierhq/core/goal-match";
import { cn } from "@/lib/utils";

/**
 * The mark that says "this is a thing you decided to count".
 *
 * A goal is configuration, not a property of the event, so nothing about a row of the
 * Events view tells a reader that `signup_completed` is the number on the Conversions
 * page and `signup_started` is not. That gap is where measurement bugs live: someone
 * looks at a stream of events, assumes the obviously-named one is the goal, and is
 * wrong because the rule narrows it by a property.
 *
 * Mint, because a conversion is the one genuinely good thing in a list of events and
 * the brand colour is the only place this product spends colour on meaning. Supporting
 * actions get the same shape in grey: they are counted, they are deliberately not
 * conversions, and the two must not look alike.
 */
export function GoalMark({
  type = "primary",
  name,
  hint,
  className,
}: {
  type?: "primary" | "supporting";
  name?: string;
  hint?: string;
  className?: string;
}) {
  const icon = (
    <Target
      className={cn("size-3.5 shrink-0", type === "primary" ? "text-brand-mint-legible" : "text-muted-foreground", className)}
      aria-hidden
    />
  );
  const label = name
    ? type === "primary"
      ? `Conversion goal: ${name}`
      : `Supporting action: ${name}`
    : type === "primary"
      ? "Conversion goal"
      : "Supporting action";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" aria-label={label}>
          {icon}
        </span>
      </TooltipTrigger>
      {/* One child, deliberately: TooltipContent is an inline-flex row, so a label and a
          hint passed as siblings sit side by side instead of stacking. */}
      <TooltipContent className="max-w-xs">
        <span className="block text-xs leading-relaxed">
          <span className="font-medium">{label}</span>
          {hint && <span className="mt-0.5 block text-background/70">{hint}</span>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The goal an event row completes, as the mark describes it. */
export interface EventGoal {
  name: string;
  type: "primary" | "supporting";
  /** The split goal it is one value of, when it is. */
  parent?: string;
}

/**
 * Which goal, if any, an event completes.
 *
 * Evaluated in the browser against the definitions the reports already load, rather
 * than asked of the server per row — the rule is small, the definitions are cached, and
 * a list of two hundred events would otherwise be two hundred questions. The predicate
 * itself lives in core beside the SQL that has to agree with it.
 *
 * First match wins, primaries before supporting actions, so an event covered by both a
 * goal and an action is marked as the stronger of the two rather than arbitrarily. A
 * split goal marks the row with the value it is — "Demo request", not "Form Submitted" —
 * and a value the operator excluded marks nothing, as it counts for nothing.
 */
export function useGoalForEvent(): (e: MatchableEvent) => EventGoal | null {
  const { data } = useWebDefinitions();
  const goals = data?.goals;
  // Ordered once for the whole list rather than inside the predicate, which runs per row.
  const ordered = useMemo(
    () =>
      [...(goals ?? [])]
        .filter((g) => !g.absorbed_by)
        .sort((a, b) => Number(b.config.type === "primary") - Number(a.config.type === "primary")),
    [goals],
  );
  return useCallback(
    (e: MatchableEvent) => {
      let fallback: EventGoal | null = null;
      for (const g of ordered) {
        const c = g.config;
        if (c.match === "event_split") {
          const hit = splitEventMatch(c, e);
          if (!hit) continue;
          const mark: EventGoal = { name: hit.name, type: hit.type, parent: g.name };
          // A value reclassified as supporting must not win over a primary goal further down.
          if (hit.type === "primary") return mark;
          fallback ??= mark;
        } else if (eventMatches(c, e)) {
          if (c.type === "primary") return { name: g.name, type: "primary" };
          fallback ??= { name: g.name, type: "supporting" };
        }
      }
      return fallback;
    },
    [ordered],
  );
}

/** The mark for one event row, or nothing when the event completes no goal. */
export function EventGoalMark({ goal, className }: { goal: EventGoal | null; className?: string }) {
  if (!goal) return null;
  const counted = goal.type === "primary" ? "Counted as a conversion on the Conversions report." : "Reported on its own, never added to conversions.";
  return (
    <GoalMark
      type={goal.type}
      name={goal.name}
      hint={goal.parent ? `One value of ${goal.parent}. ${counted}` : counted}
      className={className}
    />
  );
}
