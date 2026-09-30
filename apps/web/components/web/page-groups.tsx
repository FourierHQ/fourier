"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDeleteDefinition, useSaveDefinition, useWebDefinitions, type PageGroup } from "@/lib/web-api";

/**
 * Page groups: named buckets of URL paths, defined here rather than in a settings page
 * of their own. They only mean anything next to the table they reshape.
 *
 * A path is matched against the groups in order and the first one wins, so the mapping
 * is a function rather than something that depends on evaluation order. Anything
 * matching nothing lands in Ungrouped, which is shown rather than dropped.
 */

interface Rule {
  op: "exact" | "prefix" | "contains";
  value: string;
}

const OP_LABEL: Record<Rule["op"], string> = {
  prefix: "starts with",
  exact: "is exactly",
  contains: "contains",
};

/** A group's rules as one line: "starts with /blog · is exactly /pricing". */
export function describeRules(rules: Rule[]): string {
  return rules.map((r) => `${OP_LABEL[r.op]} ${r.value}`).join(" · ");
}

function GroupEditor({ group, onDone }: { group?: PageGroup; onDone: () => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [rules, setRules] = useState<Rule[]>(group?.config.rules ?? [{ op: "prefix", value: "/" }]);
  const save = useSaveDefinition();

  const submit = () => {
    const cleaned = rules.map((r) => ({ ...r, value: r.value.trim() })).filter((r) => r.value);
    if (!name.trim()) return toast.error("Give the group a name");
    if (!cleaned.length) return toast.error("Add at least one path rule");
    save.mutate(
      { kind: "page_group", id: group?.id, name: name.trim(), config: { rules: cleaned }, position: group?.position },
      {
        onSuccess: () => {
          toast.success(group ? "Group updated" : "Group created");
          onDone();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <Input placeholder="Group name, e.g. Blog" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select value={r.op} onValueChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, op: v as Rule["op"] } : x)))}>
              <SelectTrigger size="sm" className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(OP_LABEL) as Rule["op"][]).map((op) => (
                  <SelectItem key={op} value={op}>
                    {OP_LABEL[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-8 flex-1 font-mono text-xs"
              placeholder="/blog"
              value={r.value}
              onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            {rules.length > 1 && (
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Remove rule">
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setRules([...rules, { op: "prefix", value: "" }])}>
          <Plus className="size-3.5" /> Add rule
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        &ldquo;Starts with&rdquo; matches the path and everything beneath it, so <code className="font-mono">/blog</code> covers{" "}
        <code className="font-mono">/blog/a-post</code> but not <code className="font-mono">/blogroll</code>. Query strings are never
        part of the match, so campaign parameters cannot split one page in two.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={save.isPending}>
          {group ? "Save" : "Create group"}
        </Button>
      </div>
    </div>
  );
}

export function PageGroupsDialog() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const defs = useWebDefinitions();
  const remove = useDeleteDefinition();
  const save = useSaveDefinition();
  const groups = defs.data?.page_groups ?? [];

  /**
   * Order is a rule here, not a preference: the first group whose paths match a page
   * wins it. So moving a group has to be possible, and it has to be obvious that it
   * changes the answer — hence the numbers beside the names.
   */
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= groups.length) return;
    const reordered = [...groups];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    reordered.forEach((g, i) => {
      if (g.position !== i) save.mutate({ kind: "page_group", id: g.id, name: g.name, config: g.config, position: i });
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Manage groups
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Page groups</DialogTitle>
          <DialogDescription>
            Report on sections of the site rather than individual URLs. A path is matched against these in order and the first
            match wins; anything left over is reported as Ungrouped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {groups.map((g, i) =>
            editing === g.id ? (
              <GroupEditor key={g.id} group={g} onDone={() => setEditing(null)} />
            ) : (
              <div key={g.id} className="flex items-center gap-2 rounded-md border p-3">
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    className="text-muted-foreground/60 hover:text-foreground disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={`Move ${g.name} earlier`}
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground/60 hover:text-foreground disabled:opacity-30"
                    disabled={i === groups.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={`Move ${g.name} later`}
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    <span className="mr-2 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                    {g.name}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {describeRules(g.config.rules)}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(g.id)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Delete ${g.name}`}
                  onClick={() => remove.mutate({ kind: "page_group", id: g.id }, { onSuccess: () => toast.success("Group deleted") })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ),
          )}

          {creating ? (
            <GroupEditor onDone={() => setCreating(false)} />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> New group
            </Button>
          )}

          {!groups.length && !creating && (
            <p className="text-sm text-muted-foreground">
              No groups yet. A typical set is Product, Pricing, Blog and Docs — enough to see which part of the site is working
              without reading a hundred URLs.
            </p>
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
