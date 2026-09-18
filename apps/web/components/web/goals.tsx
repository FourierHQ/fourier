"use client";

import { useState } from "react";
import { Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEventNames } from "@/lib/api";
import { useDeleteDefinition, useSaveDefinition, useWebDefinitions, type Goal } from "@/lib/web-api";

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
  | { match: "event"; event: string };

interface Step {
  name: string;
  match: Match;
}

const PATH_OPS = { exact: "is exactly", prefix: "starts with", contains: "contains" } as const;

function MatchEditor({ value, onChange, events }: { value: Match; onChange: (m: Match) => void; events: string[] }) {
  return (
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
            onChange={(e) => onChange({ match: "event", event: e.target.value })}
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
  );
}

function GoalEditor({ goal, onDone }: { goal?: Goal; onDone: () => void }) {
  const names = useEventNames(90);
  const events = (names.data ?? []).filter((e) => !e.event.startsWith("$")).map((e) => e.event);
  const cfg = goal?.config;

  const [name, setName] = useState(goal?.name ?? "");
  const [type, setType] = useState<"primary" | "supporting">(cfg?.type ?? "primary");
  const [match, setMatch] = useState<Match>(
    cfg?.match === "pageview" ? { match: "pageview", path: cfg.path } : { match: "event", event: cfg?.match === "event" ? cfg.event : "" },
  );
  const [steps, setSteps] = useState<Step[]>((cfg?.funnel as Step[] | undefined) ?? []);
  const [isDefault, setIsDefault] = useState(goal?.is_default ?? false);
  const save = useSaveDefinition();

  const valid = (m: Match) => (m.match === "event" ? Boolean(m.event.trim()) : Boolean(m.path.value.trim()));

  const submit = () => {
    if (!name.trim()) return toast.error("Give the goal a name");
    if (!valid(match)) return toast.error("Say what completes this goal");
    const funnel = steps.filter((s) => s.name.trim() && valid(s.match));
    save.mutate(
      {
        kind: "goal",
        id: goal?.id,
        name: name.trim(),
        is_default: type === "primary" ? isDefault : false,
        config: { type, ...match, ...(type === "primary" && funnel.length ? { funnel } : {}) },
      },
      {
        onSuccess: () => {
          toast.success(goal ? "Goal updated" : "Goal created");
          onDone();
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

      {type === "primary" && (
        <div>
          <p className="mb-1.5 text-xs font-medium">Funnel steps (optional)</p>
          <p className="mb-2 text-xs text-muted-foreground">
            An ordered path to this goal. A visit has to satisfy the steps in order, within one visit. Leave empty and the funnel
            is simply a visit, then the goal.
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
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={save.isPending}>
          {goal ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}

function describe(g: Goal): string {
  const c = g.config;
  if (c.match === "pageview") return `page ${PATH_OPS[c.path.op]} ${c.path.value}`;
  return `event "${c.event}"`;
}

export function ManageGoalsDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const defs = useWebDefinitions();
  const remove = useDeleteDefinition();
  const goals = defs.data?.goals ?? [];
  const primary = goals.filter((g) => g.config.type === "primary");
  const supporting = goals.filter((g) => g.config.type === "supporting");

  const row = (g: Goal) =>
    editing === g.id ? (
      <GoalEditor key={g.id} goal={g} onDone={() => setEditing(null)} />
    ) : (
      <div key={g.id} className="flex items-center gap-2 rounded-md border p-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {g.name}
            {g.is_default && (
              <Badge variant="secondary" className="gap-1 font-normal">
                <Star className="size-3" /> Default
              </Badge>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{describe(g)}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setEditing(g.id)}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Delete ${g.name}`}
          onClick={() => remove.mutate({ kind: "goal", id: g.id }, { onSuccess: () => toast.success("Goal deleted") })}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
