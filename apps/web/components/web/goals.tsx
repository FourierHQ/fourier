"use client";

import { useCallback, useMemo, useState } from "react";
import { Combine, Plus, Split, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEventNames, useEventPropertyKeys } from "@/lib/api";
import { PROP_OPS, PropertyRow, type PropertyFilter } from "@/components/property-filter";
import {
  useDeleteDefinition,
  useSaveDefinition,
  useWebDefinitions,
  type CombineProposal,
  type GoalDefinition,
  type SplitGoalConfig,
} from "@/lib/web-api";
import { SplitEditor, splitValuesToSave, type SplitState } from "./split-editor";

/**
 * Defining what counts.
 *
 * The split between a primary goal and a supporting action is the important control on
 * this screen, and the copy around it is doing real work: a click on a button that
 * opens a booking page is a supporting action, and calling it a conversion overstates
 * the site's performance by however many people abandoned the booking form.
 */

type Match =
  | { match: "pageview"; path: { op: "exact" | "prefix" | "contains"; value: string } }
  | { match: "event"; event: string; properties?: PropertyFilter[] };

interface Step {
  name: string;
  match: Match;
}

const PATH_OPS = { exact: "is exactly", prefix: "starts with", contains: "contains" } as const;

const OP_LABEL: Record<PropertyFilter["op"], string> = { ...PROP_OPS, not_in: "is none of" };


/**
 * Narrowing an event to some of the times it fired.
 *
 * This is what keeps "Signup completed" and "Signup completed on a paid plan" as two
 * separate goals off one event, instead of asking whoever installed the tracking to
 * emit a second event name for every distinction the business later cares about.
 */
function PropertyFilters({ event, filters, onChange }: { event: string; filters: PropertyFilter[]; onChange: (f: PropertyFilter[]) => void }) {
  const keys = useEventPropertyKeys(event);
  const options = (keys.data ?? []).map((k) => k.key);

  if (!filters.length) {
    return (
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => onChange([{ key: "", op: "eq", value: "" }])}>
        <Plus className="size-3.5" /> Filter by property
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-2">
      <p className="text-xs text-muted-foreground">Only when the event carries all of:</p>
      {filters.map((f, i) => (
        <PropertyRow
          key={i}
          event={event}
          filter={f}
          keys={options}
          keysLoading={keys.isLoading}
          onChange={(next) => onChange(filters.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(filters.filter((_, j) => j !== i))}
        />
      ))}
      {filters.length < 10 && (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => onChange([...filters, { key: "", op: "eq", value: "" }])}>
          <Plus className="size-3.5" /> Add property filter
        </Button>
      )}
    </div>
  );
}

function MatchEditor({ value, onChange, events }: { value: Match; onChange: (m: Match) => void; events: string[] }) {
  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value.match}
          onValueChange={(v) => onChange(v === "pageview" ? { match: "pageview", path: { op: "exact", value: "/" } } : { match: "event", event: "" })}
        >
          <SelectTrigger size="sm" className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="event">An event fires</SelectItem>
            <SelectItem value="pageview">A page is viewed</SelectItem>
          </SelectContent>
        </Select>

        {value.match === "event" ? (
          <>
            <Input
              className="h-8 w-[220px] text-xs"
              list="fourier-event-names"
              placeholder="Signup Completed"
              value={value.event}
              onChange={(e) => onChange({ ...value, event: e.target.value })}
            />
            <datalist id="fourier-event-names">
              {events.map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
          </>
        ) : (
          <>
            <Select value={value.path.op} onValueChange={(v) => onChange({ match: "pageview", path: { ...value.path, op: v as keyof typeof PATH_OPS } })}>
              <SelectTrigger size="sm" className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PATH_OPS) as (keyof typeof PATH_OPS)[]).map((op) => (
                  <SelectItem key={op} value={op}>
                    {PATH_OPS[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-8 w-[200px] font-mono text-xs"
              placeholder="/thank-you"
              value={value.path.value}
              onChange={(e) => onChange({ match: "pageview", path: { ...value.path, value: e.target.value } })}
            />
          </>
        )}
      </div>

      {value.match === "event" && (
        <PropertyFilters event={value.event} filters={value.properties ?? []} onChange={(properties) => onChange({ ...value, properties })} />
      )}
    </div>
  );
}


/** Starting point for the editor that is not an existing goal: a combine proposal, say. */
interface Draft {
  name: string;
  config: GoalDefinition["config"];
}

function initialSplit(config: GoalDefinition["config"] | undefined): SplitState | null {
  if (config?.match !== "event_split") return null;
  return {
    key: config.split.key,
    label_key: config.split.label_key ?? null,
    label_chosen: true,
    values: config.split.values ?? {},
    absorbs: config.split.absorbs,
  };
}

function GoalEditor({ goal, draft, onDone }: { goal?: GoalDefinition; draft?: Draft; onDone: (saved?: GoalDefinition) => void }) {
  const names = useEventNames(90);
  const events = (names.data ?? []).filter((e) => !e.event.startsWith("$")).map((e) => e.event);
  const cfg = goal?.config ?? draft?.config;

  const [name, setName] = useState(goal?.name ?? draft?.name ?? "");
  const [type, setType] = useState<"primary" | "supporting">(cfg?.type ?? "primary");
  const [match, setMatch] = useState<Match>(
    cfg?.match === "pageview"
      ? { match: "pageview", path: cfg.path }
      : { match: "event", event: cfg?.event ?? "", properties: cfg?.properties },
  );
  const [split, setSplit] = useState<SplitState | null>(() => initialSplit(cfg));
  const [steps, setSteps] = useState<Step[]>((cfg?.funnel as Step[] | undefined) ?? []);
  const initialDefault = Boolean(goal?.is_default || goal?.inherits_default);
  const [isDefault, setIsDefault] = useState(initialDefault);
  const save = useSaveDefinition();

  const valid = (m: Match) => (m.match === "event" ? Boolean(m.event.trim()) : Boolean(m.path.value.trim()));

  /**
   * A half-written filter is dropped rather than saved. `key` is empty in a row the
   * author has only just added, and an empty `value` on `eq` would compile to "the
   * property is the empty string" — a rule that quietly matches nothing, which is the
   * worst way for a goal to be wrong.
   */
  const clean = (m: Match): Match => {
    if (m.match !== "event") return { ...m, path: { ...m.path, value: m.path.value.trim() } };
    const properties = (m.properties ?? [])
      .map((f) => (f.op === "not_in" ? f : { ...f, key: f.key.trim(), value: f.op === "exists" ? undefined : (f.value ?? "").trim() }))
      .filter((f) => f.key && (f.op === "exists" || f.op === "not_in" || f.value));
    return { match: "event", event: m.event.trim(), ...(properties.length ? { properties } : {}) };
  };

  const cleaned = clean(match);
  const baseProps = useMemo(() => (cleaned.match === "event" ? (cleaned.properties ?? []) : []), [JSON.stringify(cleaned)]); // eslint-disable-line react-hooks/exhaustive-deps
  const splitting = match.match === "event" && split !== null;
  const onSplitChange = useCallback((s: SplitState) => setSplit(s), []);

  const submit = () => {
    if (!name.trim()) return toast.error("Give the goal a name");
    if (!valid(match)) return toast.error("Say what completes this goal");
    if (splitting && !split?.key.trim()) return toast.error("Choose the property to split by");
    const funnel = steps.filter((s) => s.name.trim() && valid(s.match)).map((s) => ({ name: s.name.trim(), match: clean(s.match) }));
    const withFunnel = type === "primary" && funnel.length ? { funnel } : {};
    let config: unknown;
    if (splitting && split && cleaned.match === "event") {
      const values = splitValuesToSave(split);
      const splitConfig: SplitGoalConfig = {
        type,
        match: "event_split",
        event: cleaned.event,
        ...(cleaned.properties?.length ? { properties: cleaned.properties as SplitGoalConfig["properties"] } : {}),
        ...withFunnel,
        split: {
          key: split.key.trim(),
          ...(split.label_key ? { label_key: split.label_key } : {}),
          ...(Object.keys(values).length ? { values } : {}),
          ...(split.absorbs?.length ? { absorbs: split.absorbs } : {}),
        },
      };
      config = splitConfig;
    } else {
      config = { type, ...cleaned, ...withFunnel };
    }
    save.mutate(
      {
        kind: "goal",
        id: goal?.id,
        name: name.trim(),
        // Sent only when it changed. A split that inherits the default from a goal it
        // absorbed would otherwise write the flag onto itself on every save, which clears
        // it from the absorbed goal that an older deployment still reads.
        is_default: type !== "primary" ? (initialDefault ? false : undefined) : isDefault !== initialDefault ? isDefault : undefined,
        config,
      },
      {
        onSuccess: (r) => {
          const absorbed = split?.absorbs?.length ?? 0;
          toast.success(
            goal ? "Goal updated" : absorbed ? `Combined ${absorbed} goals into one` : "Goal created",
            absorbed && !goal ? { description: "The originals are kept, hidden. Delete this goal to bring them back." } : undefined,
          );
          onDone(r.definition as GoalDefinition);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <div className="space-y-4 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 flex-1 min-w-[200px]" placeholder="Signup completed" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
          <SelectTrigger size="sm" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="primary">Primary goal</SelectItem>
            <SelectItem value="supporting">Supporting action</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground">
        {type === "primary" ? (
          <>
            Something the site exists to produce. Only primary goals are counted in a conversion rate, so this should be a
            <strong className="font-medium"> confirmed</strong> outcome — a submission the server accepted, not a click on the
            submit button; a booking your system received, not a click through to the booking service.
          </>
        ) : (
          <>
            Evidence along the way — a CTA click, a form start, a download. Reported on its own and never added to a conversion
            total, because a click on a button is not the thing the button promises.
          </>
        )}
      </p>

      <div>
        <p className="mb-1.5 text-xs font-medium">Completed when</p>
        <MatchEditor value={match} onChange={setMatch} events={events} />
      </div>

      {match.match === "event" && match.event.trim() && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={split !== null}
              onChange={(e) => setSplit(e.target.checked ? (initialSplit(cfg) ?? { key: "", label_key: null, label_chosen: false, values: {} }) : null)}
            />
            <span>
              Split into one goal per value of a property
              <span className="block text-xs text-muted-foreground">
                For an event that stands for several things — one form event for every form, one purchase event for every
                product. Each value is reported on its own, and one that appears later is picked up without a new goal.
              </span>
            </span>
          </label>
          {split && cleaned.match === "event" && (
            <SplitEditor event={cleaned.event} properties={baseProps} type={type} value={split} onChange={onSplitChange} />
          )}
        </div>
      )}

      {type === "primary" && (
        <div>
          <p className="mb-1.5 text-xs font-medium">Funnel steps (optional)</p>
          <p className="mb-2 text-xs text-muted-foreground">
            An ordered path to this goal. A visit has to satisfy the steps in order, within one visit. Leave empty and the funnel
            is simply a visit, then the goal.{splitting && " On a split goal the same steps lead to every value."}
          </p>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <Input
                  className="h-8 w-[160px] text-xs"
                  placeholder="Step name"
                  value={s.name}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <MatchEditor value={s.match} onChange={(m) => setSteps(steps.map((x, j) => (j === i ? { ...x, match: m } : x)))} events={events} />
                <Button variant="ghost" size="icon" className="size-8" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            {steps.length < 8 && (
              <Button variant="ghost" size="sm" onClick={() => setSteps([...steps, { name: "", match: { match: "event", event: "" } }])}>
                <Plus className="size-3.5" /> Add step
              </Button>
            )}
          </div>
        </div>
      )}

      {type === "primary" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Use as the default goal for this site
        </label>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={save.isPending}>
          {goal ? "Save" : split?.absorbs?.length ? `Combine ${split.absorbs.length} goals` : "Create"}
        </Button>
      </div>
    </div>
  );
}

function describeFilter(f: PropertyFilter): string {
  if (f.op === "exists") return `${f.key} is set`;
  if (f.op === "not_in") return `${f.key} is none of ${(f.values ?? []).join(", ")}`;
  return `${f.key} ${OP_LABEL[f.op]} ${f.value ?? ""}`;
}

function describe(g: GoalDefinition): string {
  const c = g.config;
  if (c.match === "pageview") return `page ${PATH_OPS[c.path.op]} ${c.path.value}`;
  // The filters are part of what the goal counts, so a goal narrowed to one plan does
  // not read identically to the unnarrowed goal on the same event.
  const props = (c.properties ?? []).map(describeFilter);
  const base = `event "${c.event}"${props.length ? ` where ${props.join(" and ")}` : ""}`;
  if (c.match !== "event_split") return base;
  const decided = Object.values(c.split.values ?? {});
  const renamed = decided.filter((v) => v.name).length;
  return `${base}, one goal per ${c.split.key}${c.split.label_key ? `, named by ${c.split.label_key}` : ""}${renamed ? ` · ${renamed} named` : ""}`;
}

/**
 * Goals that are already one split, written out by hand — the same event, differing
 * only in one property's value. Offered rather than done: the operator reviews the
 * values, names carried over, before anything changes.
 */
function CombineCard({ proposal, onReview }: { proposal: CombineProposal; onReview: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-brand-mint/40 bg-brand-mint/5 p-3">
      <div className="flex items-start gap-3">
        <Combine className="mt-0.5 size-4 shrink-0 text-brand-mint-legible" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {proposal.goal_ids.length} goals count &ldquo;{proposal.event}&rdquo; and differ only by <code className="font-mono text-xs">{proposal.key}</code>
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Combine them into one goal split by <code className="font-mono">{proposal.key}</code>, and a new value — a form
            added next month — shows up on its own instead of going uncounted. Names and types carry over. The{" "}
            {proposal.goal_ids.length} goals are kept, hidden; delete the combined goal and they come back.
          </p>
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} the {proposal.goal_ids.length} goals
          </button>
          {open && <p className="text-xs text-muted-foreground">{proposal.goal_names.join(" · ")}</p>}
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={onReview}>
          Review and combine
        </Button>
      </div>
    </div>
  );
}

export function ManageGoalsDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [combining, setCombining] = useState<CombineProposal | null>(null);
  const defs = useWebDefinitions();
  const remove = useDeleteDefinition();
  // Goals a split has absorbed are not in force; the split that replaced them says so.
  const goals = (defs.data?.goals ?? []).filter((g) => !g.absorbed_by);
  const primary = goals.filter((g) => g.config.type === "primary");
  const supporting = goals.filter((g) => g.config.type === "supporting");
  const proposals = defs.data?.combinable ?? [];

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setEditing(null);
      setCreating(false);
      setCombining(null);
    }
  };

  const row = (g: GoalDefinition) =>
    editing === g.id ? (
      <GoalEditor key={g.id} goal={g} onDone={() => setEditing(null)} />
    ) : (
      <div key={g.id} className="flex items-center gap-2 rounded-md border p-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {g.name}
            {(g.is_default || g.inherits_default) && (
              <Badge variant="secondary" className="gap-1 font-normal">
                <Star className="size-3" /> Default
              </Badge>
            )}
            {g.config.match === "event_split" && (
              <Badge variant="outline" className="gap-1 font-normal">
                <Split className="size-3" /> Split by {g.config.split.key}
              </Badge>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{describe(g)}</p>
          {g.config.match === "event_split" && g.config.split.absorbs?.length ? (
            <p className="text-xs text-muted-foreground">Replaces {g.config.split.absorbs.length} goals, kept hidden until this one is deleted.</p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setEditing(g.id)}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Delete ${g.name}`}
          onClick={() =>
            remove.mutate(
              { kind: "goal", id: g.id },
              {
                onSuccess: () => {
                  const restored = g.config.match === "event_split" ? (g.config.split.absorbs?.length ?? 0) : 0;
                  toast.success("Goal deleted", restored ? { description: `The ${restored} goals it replaced are back.` } : undefined);
                },
              },
            )
          }
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>{trigger ?? <Button size="sm">Manage goals</Button>}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Goals and supporting actions</DialogTitle>
          <DialogDescription>
            These are evaluated when a report runs, not when events arrive — so a goal you define today measures the traffic you
            have already collected, and correcting one corrects its history too.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {combining ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Combine {combining.goal_ids.length} goals</h3>
              <GoalEditor draft={{ name: combining.name, config: combining.config }} onDone={() => setCombining(null)} />
            </section>
          ) : (
            proposals.map((p) => <CombineCard key={p.goal_ids.join()} proposal={p} onReview={() => setCombining(p)} />)
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Primary goals</h3>
            {primary.length ? primary.map(row) : <p className="text-sm text-muted-foreground">None yet. Conversion metrics stay empty until there is one.</p>}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Supporting actions</h3>
            {supporting.length ? supporting.map(row) : <p className="text-sm text-muted-foreground">None yet. These are reported separately and never counted as conversions.</p>}
          </section>

          {creating ? (
            <GoalEditor onDone={() => setCreating(false)} />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> New goal or action
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
