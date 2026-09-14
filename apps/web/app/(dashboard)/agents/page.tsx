"use client";

import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { CodeBlock } from "@/components/code-block";
import { useHost } from "@/components/setup-guide";
import { runSql, type SqlResult } from "@/lib/api";

const EXAMPLE_SQL = `-- Signup → first report funnel, last 30 days.
-- events_resolved adds person_id, so anonymous pre-signup steps count for the user they became.
SELECT
  countIf(step >= 1) AS signed_up,
  countIf(step >= 2) AS created_report,
  round(countIf(step >= 2) / countIf(step >= 1) * 100, 1) AS conversion_pct
FROM (
  SELECT person_id,
    windowFunnel(7 * 86400)(toDateTime(timestamp), event = 'Signed Up', event = 'Report Created') AS step
  FROM events_resolved
  WHERE project_id = {project_id} AND timestamp > now() - INTERVAL 30 DAY
  GROUP BY person_id
)`;

const endpoints: [string, string, string][] = [
  ["GET", "/api/health", "ClickHouse connectivity and default project"],
  ["GET", "/api/projects", "List projects (id, name, write_key)"],
  ["GET", "/api/projects/default/overview", "Totals and last-24h activity"],
  ["GET", "/api/projects/default/events/names?days=30", "Distinct event names with counts and unique users"],
  ["GET", "/api/projects/default/events?event=&distinct_id=&group_id=&q=&before=&limit=", "Raw events, newest first, cursor via before="],
  ["GET", "/api/projects/default/timeseries?event=&group_id=&interval=hour|day|week|month", "Counts and unique users per bucket"],
  ["GET", "/api/projects/default/properties?event=", "Property keys an event carries"],
  ["GET", "/api/projects/default/users?q=&identified=true&group_id=&order_by=&limit=&offset=", "Users with traits and stats"],
  ["GET", "/api/projects/default/users/:distinctId", "Profile, companies, linked ids, attribution, timeline; accepts an anonymous id"],
  ["GET", "/api/projects/default/groups?q=&order_by=&limit=", "Companies with traits, user and event counts"],
  ["GET", "/api/projects/default/groups/:groupId", "Company profile, members, top events, attribution, timeline"],
  ["GET", "/api/projects/default/touches?person_id=&group_id=&kind=&exclude_direct=&limit=", "Attribution touches: sessions starts, UTM and referrer arrivals"],
  ["GET", "/api/projects/default/attribution?model=first|last&by=utm_source|referrer_host|utm_campaign|landing_path|kind&identified=true", "People and companies by first or last touch"],
  ["POST", "/api/projects/default/query", "{ sql, limit } read-only ClickHouse SQL; {project_id} is bound server-side"],
  ["GET", "/api/projects/default/schema", "Schema description for query authors"],
  ["POST", "/v1/batch · /v1/track · /v1/identify · /v1/page · /v1/group · /v1/alias", "Ingest, Segment HTTP API compatible"],
];

export default function AgentsPage() {
  const host = useHost();
  const [sql, setSql] = useState(EXAMPLE_SQL);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      setResult(await runSql(sql, 200));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const mcpJson = JSON.stringify({ mcpServers: { fourier: { type: "http", url: `${host}/api/mcp` } } }, null, 2);

  return (
    <>
      <PageHeader title="API & MCP" description="Everything in the dashboard is queryable by agents" />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle>MCP server</CardTitle>
            <CardDescription>
              Streamable HTTP at <code className="font-mono text-xs">{host}/api/mcp</code>. Tools: list_event_names, list_events, event_timeseries, list_users, get_user, list_groups, get_group, list_touches, attribution_report, describe_schema, run_sql and more. Read-only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="claude-code">
              <TabsList>
                <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
                <TabsTrigger value="json">JSON config</TabsTrigger>
                <TabsTrigger value="stdio">stdio</TabsTrigger>
              </TabsList>
              <TabsContent value="claude-code" className="pt-3">
                <CodeBlock code={`claude mcp add --transport http fourier ${host}/api/mcp`} />
              </TabsContent>
              <TabsContent value="json" className="pt-3">
                <CodeBlock title="Claude Desktop, Cursor, Windsurf…" code={mcpJson} />
              </TabsContent>
              <TabsContent value="stdio" className="space-y-2 pt-3">
                <p className="text-sm text-muted-foreground">For clients without HTTP support, run the same tools over stdio from the repo:</p>
                <CodeBlock code={`pnpm --filter @fourier/web mcp`} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SQL playground</CardTitle>
            <CardDescription>
              Read-only ClickHouse. The same endpoint agents use via <code className="font-mono text-xs">run_sql</code>. Use <code className="font-mono text-xs">{"{project_id}"}</code> as the project filter.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              className="min-h-[180px] w-full resize-y rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={run} disabled={running}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run
              </Button>
              {result && (
                <span className="text-xs text-muted-foreground">
                  {result.row_count} rows · {result.elapsed_ms} ms
                </span>
              )}
              {err && <span className="text-xs text-destructive">{err}</span>}
            </div>
            {result && result.columns.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {result.columns.map((c) => (
                        <TableHead key={c.name}>
                          {c.name} <span className="font-mono text-[10px] font-normal text-muted-foreground">{c.type}</span>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((r, i) => (
                      <TableRow key={i}>
                        {result.columns.map((c) => (
                          <TableCell key={c.name} className="font-mono text-xs">
                            {typeof r[c.name] === "object" ? JSON.stringify(r[c.name]) : String(r[c.name])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>REST API</CardTitle>
            <CardDescription>No authentication in v1. JSON everywhere, CORS open. <code className="font-mono text-xs">default</code> resolves to the first project.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {endpoints.map(([method, path, desc]) => (
                  <TableRow key={path}>
                    <TableCell className="w-16 font-mono text-xs font-semibold">{method}</TableCell>
                    <TableCell className="font-mono text-xs">{path}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{desc}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
