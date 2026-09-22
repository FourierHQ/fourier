"use client";

import { useCallback, useMemo } from "react";
import { Target } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWebDefinitions, type Goal } from "@/lib/web-api";
import { eventMatches, type MatchableEvent } from "@fourierhq/core/goal-match";
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

/**
 * Which goal, if any, an event completes.
 *
 * Evaluated in the browser against the definitions the reports already load, rather
 * than asked of the server per row — the rule is small, the definitions are cached, and
 * a list of two hundred events would otherwise be two hundred questions. The predicate
 * itself lives in core beside the SQL that has to agree with it.
 *
 * First match wins, primaries before supporting actions, so an event covered by both a
 * goal and an action is marked as the stronger of the two rather than arbitrarily.
 */
export function useGoalForEvent(): (e: MatchableEvent) => Goal | null {
  const { data } = useWebDefinitions();
  const goals = data?.goals;
  // Ordered once for the whole list rather than inside the predicate, which runs per row.
  const ordered = useMemo(
    () => [...(goals ?? [])].sort((a, b) => Number(b.config.type === "primary") - Number(a.config.type === "primary")),
    [goals],
  );
  return useCallback((e: MatchableEvent) => ordered.find((g) => eventMatches(g.config, e)) ?? null, [ordered]);
}

/** The mark for one event row, or nothing when the event completes no goal. */
export function EventGoalMark({ goal, className }: { goal: Goal | null; className?: string }) {
  if (!goal) return null;
  return (
    <GoalMark
      type={goal.config.type}
      name={goal.name}
      hint={goal.config.type === "primary" ? "Counted as a conversion on the Conversions report." : "Reported on its own, never added to conversions."}
      className={className}
    />
  );
}
