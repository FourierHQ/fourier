"use client";

import { useState } from "react";
import { CalendarDays, Check, Globe, Plus, Target, X } from "lucide-react";
// Subpath rather than the package root: the root re-exports geo, which needs Node's
// fs, and a client component importing it fails the browser build.
import { RANGE_PRESET_LABELS, RANGE_PRESETS } from "@fourierhq/core/periods";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSources } from "@/lib/api";
import { countryName } from "@/lib/format";
import { useWebFilterValues, type ScopeEcho } from "@/lib/web-api";
import { P, useWebState } from "@/lib/web-state";

/**
 * The control bar every report shares.
 *
 *     Source · Date range · Comparison · Conversion goal · Filters
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

/**
 * Which conversions the report counts — all of them, or one.
 *
 * It sits beside Source, Date range and Comparison rather than inside Filters, because it
 * is not one. Every filter narrows the visits under consideration, changing the
 * numerator and the denominator together; this changes only what the numerator counts,
 * and the session total stays exactly where it was. Putting it among the filter chips
 * would say otherwise, and the natural reading of "Goal: Demo requested" as a filter is
 * a conversion rate of 100%.
 */
function GoalControl({ scope }: { scope?: ScopeEcho }) {
  const { get, set } = useWebState();
  const primary = (scope?.goals ?? []).filter((g) => g.type === "primary");
  const selected = get(P.goal) ?? scope?.goal?.id ?? ALL_GOALS;

  if (!primary.length) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href="/web-analytics/conversions">
          <Plus className="size-3.5" /> Choose a conversion goal
        </a>
      </Button>
    );
  }
  return (
    <Select value={selected} onValueChange={(v) => set({ [P.goal]: v === ALL_GOALS ? null : v })}>
      <SelectTrigger size="sm" className="w-[190px]" aria-label="Conversions counted">
        <Target className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* First and default. A visit that completes two goals is one converting
            session here, not two — these are distinct visits, never a sum of the rows
            on the Conversions page. */}
        <SelectItem value={ALL_GOALS}>All conversions</SelectItem>
        {primary.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            {g.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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

function FilterMenu() {
  const { get, set } = useWebState();
  const values = useWebFilterValues();
  const v = values.data;

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
          Filters
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-60 overflow-y-auto">
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
export function ActiveFilters() {
  const { activeFilters, set, get } = useWebState();
  const bots = get(P.bots) === "1";
  if (!activeFilters.length && !bots) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
        onClick={() => set(Object.fromEntries([...activeFilters.map((f) => [f.key, null]), [P.bots, null]]))}
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
          <GoalControl scope={scope} />
          <FilterMenu />
        </div>
      </div>
      <ActiveFilters />
    </div>
  );
}

/** Clearing every filter, for the "no results" state to offer. */
export function useClearFilters() {
  const { activeFilters, set } = useWebState();
  return () => set(Object.fromEntries([...activeFilters.map((f) => [f.key, null]), [P.bots, null]]));
}
