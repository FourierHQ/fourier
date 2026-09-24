"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { importAmplitudeDay, useEmptyTestEnvironment, useImportStatus, useSources, type AmplitudeDayResult } from "@/lib/api";
import { useEnvironment } from "@/lib/environment";
import { formatDate, formatNumber } from "@/lib/format";

/** A UTC day `n` days before today, as the date input wants it. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Every UTC day from `from` to `to`, inclusive, oldest first. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** A year is Amplitude's own ceiling for one export, and a sane one for a trial run. */
const MAX_DAYS = 366;

interface Run {
  days: string[];
  /** The day being imported, or the one that failed. */
  index: number;
  results: AmplitudeDayResult[];
  running: boolean;
  stopped: boolean;
  error: string | null;
}

/**
 * Import from Amplitude into the Test environment, and empty Test again.
 *
 * The browser walks the range one day per request, rather than handing the server a
 * range to churn through: progress is visible, Stop means something, a timeout or a
 * refusal from Amplitude costs one day rather than the run, and no single request
 * gets anywhere near a serverless time limit. Re-running is safe — the server skips
 * every event it already has — so "retry from the day that failed" is the whole
 * recovery story.
 */
export function ImportSettings() {
  return (
    <div className="space-y-6">
      <AmplitudeImportCard />
      <TestEnvironmentCard />
    </div>
  );
}

function AmplitudeImportCard() {
  const sources = useSources();
  const status = useImportStatus();
  const qc = useQueryClient();
  const router = useRouter();
  const { setEnvironment } = useEnvironment();

  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(daysAgo(1));
  const [sourceId, setSourceId] = useState("");
  const [skipInstrumentation, setSkipInstrumentation] = useState(true);
  const [run, setRun] = useState<Run | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A source that is not "default" is almost always the site the Amplitude project was
  // tracking, so it is the better first guess when there is one.
  useEffect(() => {
    if (sourceId || !sources.data?.length) return;
    setSourceId((sources.data.find((s) => s.id !== "default") ?? sources.data[0]).id);
  }, [sources.data, sourceId]);

  // Stop a run that is still going if the tab navigates away from Settings.
  useEffect(() => () => abort.current?.abort(), []);

  const days = useMemo(() => (from && to && from <= to ? daysBetween(from, to) : []), [from, to]);
  const today = daysAgo(0);
  const rangeError = !from || !to ? "Pick both dates" : from > to ? "The start is after the end" : to > today ? "The end is in the future" : days.length > MAX_DAYS ? `At most ${MAX_DAYS} days per run` : null;
  const canStart = Boolean(apiKey.trim() && secretKey.trim() && sourceId && !rangeError && !run?.running);

  async function start(fromDay = from) {
    const list = daysBetween(fromDay, to);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRun({ days: list, index: 0, results: [], running: true, stopped: false, error: null });
    for (let i = 0; i < list.length; i++) {
      if (ctrl.signal.aborted) break;
      setRun((r) => r && { ...r, index: i });
      try {
        const result = await importAmplitudeDay(
          { apiKey: apiKey.trim(), secretKey: secretKey.trim(), region, day: list[i], sourceId, skipInstrumentation },
          ctrl.signal,
        );
        setRun((r) => r && { ...r, results: [...r.results, result] });
        void qc.invalidateQueries({ queryKey: ["import-status"] });
      } catch (err) {
        if (ctrl.signal.aborted) break;
        setRun((r) => r && { ...r, running: false, error: err instanceof Error ? err.message : String(err) });
        void qc.invalidateQueries();
        return;
      }
    }
    setRun((r) => r && { ...r, running: false, stopped: ctrl.signal.aborted });
    // Every Test report is stale now. Production's are not, but a blanket refresh is
    // cheaper to reason about than a list of the queries that happen to read Test.
    void qc.invalidateQueries();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (canStart) void start();
  }

  const totals = useMemo(() => {
    const t = { fetched: 0, imported: 0, existing: 0, skipped: {} as Record<string, number> };
    for (const r of run?.results ?? []) {
      t.fetched += r.fetched;
      t.imported += r.imported;
      t.existing += r.existing;
      for (const [k, v] of Object.entries(r.skipped)) t.skipped[k] = (t.skipped[k] ?? 0) + v;
    }
    return t;
  }, [run?.results]);
  const skippedTotal = Object.values(totals.skipped).reduce((a, b) => a + b, 0);
  const failedDay = run?.error ? run.days[run.index] : null;
  const done = run && !run.running && !run.error && run.results.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from Amplitude</CardTitle>
        <CardDescription>
          Copies raw events out of Amplitude&apos;s Export API into the <span className="font-medium text-foreground">Test</span> environment, one day at a time.
          Production is never touched. Importing a day twice is harmless: the second run skips everything already there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="API key" htmlFor="amp-api-key">
              <Input id="amp-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
            </Field>
            <Field label="Secret key" htmlFor="amp-secret-key">
              <Input id="amp-secret-key" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} autoComplete="off" className="font-mono" />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            In Amplitude: Settings → Organization settings → Projects → pick the project → General. Each project has its own pair, and the pair decides which project
            is imported. Keys go with each request and are never stored.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Data region" htmlFor="amp-region" hint="EU only if your Amplitude URL starts analytics.eu.amplitude.com.">
              <Select value={region} onValueChange={(v) => setRegion(v as "us" | "eu")}>
                <SelectTrigger id="amp-region" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="us">United States</SelectItem>
                  <SelectItem value="eu">European Union</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="File events under" htmlFor="amp-source" hint="The source a Fourier report filters these events by.">
              {sources.isLoading ? (
                <Skeleton className="h-9" />
              ) : (
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger id="amp-source" className="w-full">
                    <SelectValue placeholder="Pick a source" />
                  </SelectTrigger>
                  <SelectContent>
                    {(sources.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="amp-from">
              <Input id="amp-from" type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" htmlFor="amp-to" hint="Days are UTC. Amplitude makes events exportable about two hours after it receives them.">
              <Input id="amp-to" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={skipInstrumentation}
              onChange={(e) => setSkipInstrumentation(e.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              Skip Amplitude&apos;s own instrumentation
              <span className="block text-xs text-muted-foreground">
                {(status.data?.instrumentation ?? []).join(", ") || "Replay, network, web vitals and viewport events"}. They describe the page, not a person, and would
                inflate every event count. Amplitude&apos;s session_start and session_end markers are always skipped.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            {run?.running ? (
              <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button type="submit" disabled={!canStart}>
                Import {days.length > 0 && !rangeError ? `${days.length} ${days.length === 1 ? "day" : "days"}` : ""} into Test
              </Button>
            )}
            {rangeError && <span className="text-sm text-destructive">{rangeError}</span>}
          </div>
        </form>

        {run && (
          <div className="mt-6 space-y-4">
            <Progress run={run} />

            {run.error && failedDay && (
              <Alert variant="destructive">
                <AlertTitle>{failedDay} did not import</AlertTitle>
                <AlertDescription>
                  <p>{run.error}</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => void start(failedDay)} disabled={!canStart}>
                    Retry from {failedDay}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {run.results.length > 0 && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Day (UTC)</TableHead>
                      <TableHead className="text-right">In Amplitude</TableHead>
                      <TableHead className="text-right">Imported</TableHead>
                      <TableHead className="text-right">Already there</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {run.results.map((r) => (
                      <TableRow key={r.day}>
                        <TableCell className="font-mono text-xs">{r.day}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(r.fetched)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(r.imported)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(r.existing)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatNumber(Object.values(r.skipped).reduce((a, b) => a + b, 0))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {run.results.length > 1 && (
                    <TableFooter>
                      <TableRow>
                        <TableCell>Total</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(totals.fetched)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(totals.imported)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(totals.existing)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(skippedTotal)}</TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </div>
            )}

            {skippedTotal > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Skipped, by reason</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(totals.skipped)
                    .sort((a, b) => b[1] - a[1])
                    .map(([reason, n]) => (
                      <Badge key={reason} variant="outline" className="gap-1.5 font-normal">
                        <span className="font-mono text-xs">{reason}</span>
                        <span className="tabular-nums text-muted-foreground">{formatNumber(n)}</span>
                      </Badge>
                    ))}
                </div>
              </div>
            )}

            {done && (
              <Button
                variant="secondary"
                onClick={() => {
                  setEnvironment("test");
                  router.push("/");
                }}
              >
                Look at it in Test <ArrowRight className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Progress({ run }: { run: Run }) {
  const finished = run.results.length;
  const pct = Math.round((finished / run.days.length) * 100);
  const label = run.running
    ? `Importing ${run.days[run.index]} — day ${run.index + 1} of ${run.days.length}`
    : run.error
      ? `Stopped at ${run.days[run.index]} — ${finished} of ${run.days.length} days imported`
      : run.stopped
        ? `Stopped — ${finished} of ${run.days.length} days imported`
        : `Done — ${run.days.length} ${run.days.length === 1 ? "day" : "days"} imported`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        {run.running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <span>{label}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={run.error ? "h-full bg-destructive" : "h-full bg-primary transition-[width]"} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * What Test holds, and the button that empties it.
 *
 * Emptying is for every project because Test is one database; saying so beside the
 * button matters more than the confirmation does.
 */
function TestEnvironmentCard() {
  const status = useImportStatus();
  const empty = useEmptyTestEnvironment();
  const router = useRouter();
  const { setEnvironment } = useEnvironment();
  const [open, setOpen] = useState(false);
  const s = status.data?.status;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test environment</CardTitle>
        <CardDescription>
          A database of its own with no write key, so the only way in is an import. Switch to it from the environment menu at the top of the sidebar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading ? (
          <Skeleton className="h-5 w-72" />
        ) : status.error ? (
          <p className="text-sm text-destructive">{status.error.message}</p>
        ) : s && s.events > 0 ? (
          <p className="text-sm">
            Holds <span className="font-medium tabular-nums">{formatNumber(s.events)}</span> events for this project, from {formatDate(s.first)} to {formatDate(s.last)}
            {s.imported !== s.events && <span className="text-muted-foreground"> ({formatNumber(s.imported)} from Amplitude)</span>}.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Empty.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEnvironment("test");
              router.push("/");
            }}
          >
            Switch to Test
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={!s || s.events === 0}>
                <Trash2 className="size-3.5" /> Empty Test
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Empty the Test environment?</DialogTitle>
                <DialogDescription>
                  Deletes every event, user, company and session in Test, for every project. Production, preview and development are untouched, and you can import
                  again straight away.
                </DialogDescription>
              </DialogHeader>
              {empty.error && <p className="text-sm text-destructive">{empty.error.message}</p>}
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={empty.isPending}
                  onClick={() => empty.mutate(undefined, { onSuccess: () => setOpen(false) })}
                >
                  {empty.isPending && <Loader2 className="size-3.5 animate-spin" />} Empty Test
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}
