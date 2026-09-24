"use client";

import { useState } from "react";
import { CalendarDays, Check, Globe, Plus, SlidersHorizontal, Target, X } from "lucide-react";
// Subpath rather than the package root: the root re-exports geo, which needs Node's
// fs, and a client component importing it fails the browser build.
import { RANGE_PRESET_LABELS, RANGE_PRESETS } from "@fourierhq/core/periods";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSources } from "@/lib/api";
import { countryName } from "@/lib/format";
import { useWebFilterValues, type ScopeEcho } from "@/lib/web-api";
import { P, WEB_ROOT, useWebState } from "@/lib/web-state";

/**
 * The control bar every report shares.
 *
 *     Source · Date range · Comparison · Filters (conversion goal first)
 *
 * All of it is URL state, so the bar is a view onto the query string rather than
 * something that has to be kept in step with it.
 */

const ALL = "__all__";
/** Sentinel for "no goal named", which the URL represents by the parameter being absent. */
const ALL_GOALS = "__all_goals__";

/**
 * Which of the project's sources to report on — the marketing site, the web app, each
 * with its own write key.
 *
 * "Source" and not "site", because that is what the rest of Fourier already calls them:
 * the install page issues keys per source, the events table badges them, the API takes
 * `source=`. The campaign parameter that wants the same word is qualified instead, as
 * "campaign source", which is what it actually is — it exists only when a link was
 * tagged, which is why most traffic has none.
 */
function SourceControl() {
  const sources = useSources();
  const { get, setSite } = useWebState();
  const current = get(P.source) ?? ALL;
  const list = sources.data ?? [];
  // One source is not a choice, and a select with a single option only wastes a click.
  if (list.length <= 1) return null;
  return (
    <Select value={current} onValueChange={(v) => setSite(v === ALL ? null : v)}>
      <SelectTrigger size="sm" className="w-[190px]" aria-label="Source">
        <Globe className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All sources</SelectItem>
        {list.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RangeControl({ scope }: { scope?: ScopeEcho }) {
  const { get, set } = useWebState();
  const [open, setOpen] = useState(false);
  const preset = get(P.range) ?? "30d";
  const isCustom = preset === "custom";

  return (
    <div className="flex items-center gap-1">
      <Select
        value={preset}
        onValueChange={(v) => {
          if (v === "custom") {
            setOpen(true);
            // Seed the custom inputs with the range currently on screen, so opening the
            // picker never blanks the report behind it.
            const from = scope?.range.from?.slice(0, 10);
            const to = scope?.range.to ? new Date(new Date(scope.range.to).getTime() - 1).toISOString().slice(0, 10) : undefined;
            set({ [P.range]: "custom", [P.from]: from ?? null, [P.to]: to ?? null });
          } else {
            setOpen(false);
            set({ [P.range]: v, [P.from]: null, [P.to]: null });
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[160px]" aria-label="Date range">
          <CalendarDays className="size-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((p) => (
            <SelectItem key={p} value={p}>
              {RANGE_PRESET_LABELS[p]}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom range…</SelectItem>
        </SelectContent>
      </Select>

      {isCustom && (open || get(P.from) || get(P.to)) && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            className="h-8 w-[140px] text-xs"
            aria-label="From"
            value={get(P.from) ?? ""}
            onChange={(e) => set({ [P.from]: e.target.value || null })}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            className="h-8 w-[140px] text-xs"
            aria-label="To"
            value={get(P.to) ?? ""}
            onChange={(e) => set({ [P.to]: e.target.value || null })}
          />
        </div>
      )}
    </div>
  );
}

function CompareControl({ scope }: { scope?: ScopeEcho }) {
  const { get, set } = useWebState();
  const on = get(P.compare) !== "0";
  const label = scope?.range.previous_from
    ? `${new Date(scope.range.previous_from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(
        new Date(scope.range.previous_to ?? scope.range.previous_from).getTime() - 1,
      ).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={on ? "secondary" : "outline"} size="sm" onClick={() => set({ [P.compare]: on ? "0" : null })} aria-pressed={on}>
          {on && <Check className="size-3.5" />}
          Compare
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">
        {on ? (
          <>
            Against the preceding period{label ? ` (${label})` : ""}. The comparison covers the same elapsed time as the current
            range, so a part-finished day is compared with the same part of an earlier one.
          </>
        ) : (
          <>Turn on to compare against the preceding equivalent period.</>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const FILTER_LABELS: Record<string, string> = {
  [P.channel]: "Channel",
  [P.utmSource]: "Campaign source",
  [P.utmMedium]: "Campaign medium",
  [P.utmCampaign]: "Campaign",
  [P.country]: "Country",
  [P.device]: "Device",
  [P.browser]: "Browser",
  [P.visitor]: "Visitor",
};

/**
 * Which conversions the report counts — all of them, or one — as the first section of
 * the Filters menu.
 *
 * It lives among the filters because that is where a reader looks for "narrow this
 * down", and a control of its own in the bar was one more thing to scan past on every
 * report. But it is not a filter, and everything around it says so. Every filter
 * narrows the visits under consideration, changing numerator and denominator together;
 * this changes only what the numerator counts, and the session total stays exactly
 * where it was. So its section says what it does, its chip reads "Conversions: Demo
 * requested" rather than "Goal: Demo requested" — the natural reading of the second
 * being a filter to the visits that requested one, and a conversion rate of 100% — and
 * it wears a target rather than looking like the chips beside it.
 */
/**
 * The goal the URL names, if it is still one. A link can outlive its goal — deleted,
 * or turned into a supporting action — and the server then counts all conversions, so
 * the menu must say "All conversions" too rather than show a chip, a count or a tick
 * for something the report is not doing.
 */
function selectedGoal(id: string | null, scope: ScopeEcho | undefined) {
  if (!id) return null;
  return scope?.goals.find((g) => g.id === id && g.type === "primary") ?? null;
}

function GoalSection({ scope }: { scope?: ScopeEcho }) {
  const { get, set, href } = useWebState();
  const primary = (scope?.goals ?? []).filter((g) => g.type === "primary");
  const selected = selectedGoal(get(P.goal), scope)?.id ?? ALL_GOALS;

  return (
    <>
      <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">Count conversions as</DropdownMenuLabel>
      {!primary.length ? (
        <DropdownMenuItem asChild>
          <a href={href(`${WEB_ROOT}/conversions`)}>
            <Plus className="size-3.5" /> Choose a conversion goal
          </a>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuRadioGroup value={selected} onValueChange={(v) => set({ [P.goal]: v === ALL_GOALS ? null : v })}>
          {/* First and default. A visit that completes two goals is one converting
              session here, not two — these are distinct visits, never a sum of the rows
              on the Conversions page. */}
          <DropdownMenuRadioItem value={ALL_GOALS}>All conversions</DropdownMenuRadioItem>
          {/* A split's values sit under its rollup. Selecting the rollup counts every value
              that counts, selecting one value counts that value alone. */}
          {primary.map((g) => {
            const child = g.split && g.split.role !== "all" && primary.some((p) => p.split?.role === "all" && p.split.definition_id === g.split?.definition_id);
            return (
              <DropdownMenuRadioItem key={g.id} value={g.id} className={child ? "pl-5" : undefined}>
                {child && <span className="text-muted-foreground">↳</span>}
                {g.name}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      )}
      <p className="px-1.5 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
        Changes what counts as a conversion, not which visits are shown.
      </p>
      <DropdownMenuSeparator />
    </>
  );
}

function FilterMenu({ scope }: { scope?: ScopeEcho }) {
  const { get, set, activeFilters } = useWebState();
  const values = useWebFilterValues();
  const v = values.data;
  // Everything the menu has set, so a closed menu still says it is doing something.
  const count = activeFilters.length + (selectedGoal(get(P.goal), scope) ? 1 : 0) + (get(P.bots) === "1" ? 1 : 0);

  const group = (key: string, label: string, options: readonly string[], render: (o: string) => string = (o) => o) => {
    if (!options.length) return null;
    const current = get(key);
    return (
      <>
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</DropdownMenuLabel>
        {options.slice(0, 30).map((o) => (
          <DropdownMenuCheckboxItem key={o} checked={current === o} onCheckedChange={(on) => set({ [key]: on ? o : null })}>
            {render(o)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
      </>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
          Filters
          {count > 0 && (
            <span className="ml-0.5 rounded-sm bg-muted px-1 text-[11px] tabular-nums text-muted-foreground" aria-label={`${count} active`}>
              {count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-60 overflow-y-auto">
        <GoalSection scope={scope} />
        {group(P.visitor, "Visitor", ["new", "returning"], (o) => (o === "new" ? "New" : "Returning"))}
        {group(P.channel, "Channel", v?.channels ?? [])}
        {group(P.utmSource, "Campaign source", v?.sources ?? [])}
        {group(P.utmMedium, "Campaign medium", v?.mediums ?? [])}
        {group(P.utmCampaign, "Campaign", v?.campaigns ?? [])}
        {group(P.device, "Device", v?.devices ?? [])}
        {group(P.browser, "Browser", v?.browsers ?? [])}
        {group(P.country, "Country", v?.countries ?? [], (c) => countryName(c) || c)}
        <DropdownMenuCheckboxItem checked={get(P.bots) === "1"} onCheckedChange={(on) => set({ [P.bots]: on ? "1" : null })}>
          Include bot traffic
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What is currently narrowing the report, and a way out of each of them. */
export function ActiveFilters({ scope }: { scope?: ScopeEcho }) {
  const { activeFilters, set, get } = useWebState();
  const bots = get(P.bots) === "1";
  // Named from the goal list rather than the report's echo, which trails the URL by a
  // request: the chip should change the moment the menu does.
  const goalName = selectedGoal(get(P.goal), scope)?.name ?? null;
  if (!activeFilters.length && !bots && !goalName) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {goalName && (
        <Badge variant="outline" className="gap-1 pr-1 font-normal" title="Changes what counts as a conversion, not which visits are shown">
          <Target className="size-3 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Conversions:</span>
          {goalName}
          <button type="button" onClick={() => set({ [P.goal]: null })} className="rounded-sm p-0.5 hover:bg-muted" aria-label="Count all conversions">
            <X className="size-3" />
          </button>
        </Badge>
      )}
      {activeFilters.map((f) => (
        <Badge key={f.key} variant="secondary" className="gap-1 pr-1 font-normal">
          <span className="text-muted-foreground">{FILTER_LABELS[f.key] ?? f.key}:</span>
          {f.key === P.country ? countryName(f.value) || f.value : f.key === P.visitor ? (f.value === "new" ? "New" : "Returning") : f.value}
          <button type="button" onClick={() => set({ [f.key]: null })} className="rounded-sm p-0.5 hover:bg-muted" aria-label={`Remove ${FILTER_LABELS[f.key] ?? f.key} filter`}>
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {bots && (
        <Badge variant="outline" className="gap-1 pr-1 font-normal">
          Bots included
          <button type="button" onClick={() => set({ [P.bots]: null })} className="rounded-sm p-0.5 hover:bg-muted" aria-label="Exclude bot traffic">
            <X className="size-3" />
          </button>
        </Badge>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-muted-foreground"
        onClick={() => set(Object.fromEntries([...activeFilters.map((f) => [f.key, null]), [P.bots, null], [P.goal, null]]))}
      >
        Clear all
      </Button>
    </div>
  );
}

export function WebControls({ scope }: { scope?: ScopeEcho }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SourceControl />
        <RangeControl scope={scope} />
        <CompareControl scope={scope} />
        <div className="ml-auto flex items-center gap-2">
          <FilterMenu scope={scope} />
        </div>
      </div>
      <ActiveFilters scope={scope} />
    </div>
  );
}

/** Clearing every filter, for the "no results" state to offer. */
export function useClearFilters() {
  const { activeFilters, set } = useWebState();
  return () => set(Object.fromEntries([...activeFilters.map((f) => [f.key, null]), [P.bots, null]]));
}
