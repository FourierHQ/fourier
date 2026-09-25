"use client";

import { useState } from "react";
import { Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEventPropertyValues } from "@/lib/api";

/**
 * Narrowing events by their properties — `plan is pro`, `form_name is set`.
 *
 * Shared by the goal editor, where it narrows the event a goal counts, and the Events
 * page, where it narrows the feed. They compile to the same SQL, so they are the same
 * control: a filter someone learns on one screen reads the same on the other.
 */

export type PropertyFilter = { key: string; op: "eq" | "neq" | "contains" | "exists" | "not_in"; value?: string; values?: string[] };

/**
 * `exists` deliberately reads as "is set" rather than "exists": the question an operator
 * is asking is whether the event carried the property at all, which is the one filter
 * that takes no value.
 */
export const PROP_OPS = { eq: "is", neq: "is not", contains: "contains", exists: "is set" } as const;

/** Sentinel for "the value I want is not in this list", which switches the field to free text. */
const CUSTOM = "__custom__";

/**
 * A dropdown of what the data actually contains, which can always be overridden by hand.
 *
 * Both halves matter. The list is what makes `plan = free` a choice rather than a guess
 * at the spelling — a filter with a typo in it matches nothing and reports a goal that
 * simply never happens. But the list only describes the last 30 days of one environment,
 * while a goal is a rule about all of history, so a property you are about to start
 * sending, or one that went quiet last month, has to remain typeable.
 */
function Suggest({
  value,
  onChange,
  options,
  loading,
  placeholder,
  label,
  className = "w-[170px]",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  loading?: boolean;
  placeholder: string;
  label: string;
  className?: string;
}) {
  const [free, setFree] = useState(false);
  // Nothing to choose from is not a dead end — it is the same field without the list.
  const listed = options.length > 0;

  if (free || !listed) {
    return (
      <div className="flex items-center gap-1">
        <Input
          className={`h-8 font-mono text-xs ${className}`}
          aria-label={label}
          placeholder={loading && !listed ? "Loading…" : placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {listed && (
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setFree(false)} aria-label={`Choose ${label} from the list`}>
            <Undo2 className="size-3.5" />
          </Button>
        )}
      </div>
    );
  }

  // A value typed earlier, or one that has not been seen in 30 days, still has to be
  // displayable — a Select shows nothing for a value that is not one of its items.
  const items = options.includes(value) || !value ? options : [value, ...options];
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        if (v === CUSTOM) return setFree(true);
        onChange(v);
      }}
    >
      <SelectTrigger size="sm" className={className} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-[300px]">
        {items.map((o) => (
          <SelectItem key={o} value={o} className="font-mono text-xs">
            {o}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={CUSTOM}>Type a {label.toLowerCase()}…</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * One property filter: property, condition, value. `event` scopes the suggestions to the
 * values that event carries; `anyEvent` lets a row with no event suggest every event's,
 * which is what a filter over a whole feed wants and a goal on one event does not.
 */
export function PropertyRow({
  event,
  anyEvent,
  filter,
  onChange,
  onRemove,
  keys,
  keysLoading,
}: {
  event: string | undefined;
  anyEvent?: boolean;
  filter: PropertyFilter;
  onChange: (f: PropertyFilter) => void;
  onRemove: () => void;
  keys: string[];
  keysLoading: boolean;
}) {
  const values = useEventPropertyValues(event, filter.key, { anyEvent });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Suggest
        label="Property"
        placeholder="Property"
        value={filter.key}
        // Values belong to the property that was asked for, so changing the property
        // drops a value chosen for the previous one rather than carrying it across.
        onChange={(key) => onChange({ ...filter, key, value: "" })}
        options={keys}
        loading={keysLoading}
      />
      <Select value={filter.op === "not_in" ? undefined : filter.op} onValueChange={(v) => onChange({ ...filter, op: v as PropertyFilter["op"] })}>
        <SelectTrigger size="sm" className="w-[110px]" aria-label="Condition">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(PROP_OPS) as (keyof typeof PROP_OPS)[]).map((op) => (
            <SelectItem key={op} value={op}>
              {PROP_OPS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filter.op !== "exists" && (
        <Suggest
          label="Value"
          placeholder={filter.key ? "Value" : "Pick a property first"}
          value={filter.value ?? ""}
          onChange={(value) => onChange({ ...filter, value })}
          // `contains` asks for a fragment of a value, which is by definition not one of
          // the whole values on offer, so that list would only be in the way.
          options={filter.op === "contains" ? [] : (values.data ?? []).map((v) => v.value)}
          loading={values.isLoading}
          className="w-[190px]"
        />
      )}
      <Button variant="ghost" size="icon" className="size-8" onClick={onRemove} aria-label="Remove property filter">
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
