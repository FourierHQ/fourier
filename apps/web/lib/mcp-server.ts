import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  attributionReport,
  eventTimeseries,
  groupAttribution,
  listTouches,
  personAttribution,
  getGroup,
  getOverview,
  getUser,
  hiddenEventsFor,
  listEventNames,
  listEvents,
  listGroups,
  listProjects,
  listSources,
  listUsers,
  propertyKeys,
  propertyValues,
  runSql,
  schemaDoc,
  ENVIRONMENTS,
  parseEnvironment,
  scope as makeScope,
  type Scope,
} from "@fourierhq/core";
import { ready, resolveProject } from "./db";

const projectArg = z
  .string()
  .optional()
  .describe("Project id. Omit to use the default project.");
const sourceArg = z.string().optional().describe("Source id (one website / app / product in the project). See list_sources.");
const environmentArg = z
  .enum(ENVIRONMENTS)
  .optional()
  .describe(
    "Which environment to read: production, preview or development. Each is a separate database and they share no users, companies or events. Omit for production.",
  );

async function project(id?: string) {
  const { project } = await ready();
  if (!id) return project;
  const p = await resolveProject(id);
  if (!p) throw new Error(`Project not found: ${id}`);
  return p;
}

/**
 * Project, environment and hidden events for a read. Defaults to production, like the
 * dashboard — and, like the dashboard, leaves out the events the operator has hidden,
 * so an agent's answer and the screen the operator is looking at are the same answer.
 */
async function scopeFor(projectId: string | undefined, environment: string | undefined): Promise<Scope> {
  const id = (await project(projectId)).id;
  return makeScope(id, parseEnvironment(environment), await hiddenEventsFor(id));
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Registers every Fourier tool. Shared by the HTTP route and the stdio binary. */
export function registerFourierTools(server: McpServer) {
  server.registerTool(
    "list_projects",
    { title: "List projects", description: "List analytics projects and their write keys.", inputSchema: z.object({}), annotations: readOnly },
    async () => {
      await ready();
      return text(await listProjects());
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "The websites / apps / products feeding a project, each with its own write key. Users and companies are shared across sources; events carry source_id so you can compare products or see which a person uses.",
      inputSchema: z.object({ project_id: projectArg }),
      annotations: readOnly,
    },
    async ({ project_id }) => text(await listSources((await project(project_id)).id)),
  );

  server.registerTool(
    "get_overview",
    {
      title: "Project overview",
      description: "Totals: events, users, identified users, companies, and last-24h activity.",
      inputSchema: z.object({ project_id: projectArg, environment: environmentArg }),
      annotations: readOnly,
    },
    async ({ project_id, environment }) => text(await getOverview(await scopeFor(project_id, environment))),
  );

  server.registerTool(
    "list_event_names",
    {
      title: "List event names",
      description: "Distinct event names with counts and unique users. Use before querying events so you know the exact names.",
      inputSchema: z.object({ project_id: projectArg, environment: environmentArg, source_id: sourceArg, days: z.number().int().positive().optional().describe("Only the last N days") }),
      annotations: readOnly,
    },
    async ({ project_id, environment, source_id, days }) => text(await listEventNames(await scopeFor(project_id, environment), { days, sourceId: source_id })),
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description: "Recent raw events, newest first, with full properties. Filter by event name, user, company, time window or free-text search.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        event: z.string().optional().describe("Exact event name, e.g. 'Signed Up'. Page views are '$page'."),
        type: z.enum(["track", "page", "screen", "identify", "group", "alias"]).optional(),
        source_id: sourceArg,
        distinct_id: z.string().optional().describe("User id or anonymous id"),
        group_id: z.string().optional().describe("Company / workspace id"),
        after: z.string().optional().describe("ISO timestamp lower bound"),
        before: z.string().optional().describe("ISO timestamp upper bound (use for pagination)"),
        q: z.string().optional().describe("Free text search across event name, properties and ids"),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, distinct_id, group_id, source_id, q, ...rest }) =>
      text(await listEvents(await scopeFor(project_id, environment), { ...rest, distinctId: distinct_id, groupId: group_id, sourceId: source_id, search: q })),
  );

  server.registerTool(
    "event_timeseries",
    {
      title: "Event time series",
      description: "Counts and unique users per hour/day/week/month, optionally for one event or one company.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        event: z.string().optional(),
        group_id: z.string().optional(),
        source_id: sourceArg,
        interval: z.enum(["hour", "day", "week", "month"]).optional(),
        from: z.string().optional().describe("ISO timestamp"),
        to: z.string().optional().describe("ISO timestamp"),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, group_id, source_id, ...rest }) => text(await eventTimeseries(await scopeFor(project_id, environment), { ...rest, groupId: group_id, sourceId: source_id })),
  );

  server.registerTool(
    "event_property_keys",
    {
      title: "Event property keys",
      description: "Which property keys an event carries (last 30 days), so you can write JSONExtract queries.",
      inputSchema: z.object({ project_id: projectArg, environment: environmentArg, event: z.string() }),
      annotations: readOnly,
    },
    async ({ project_id, environment, event }) => text(await propertyKeys(await scopeFor(project_id, environment), event)),
  );

  server.registerTool(
    "event_property_values",
    {
      title: "Event property values",
      description: "The values one property of an event takes (last 30 days), with how often each occurs. Use it to name a value exactly — in a filter, or when defining a goal narrowed to one of them.",
      inputSchema: z.object({ project_id: projectArg, environment: environmentArg, event: z.string(), key: z.string(), limit: z.number().int().min(1).max(1000).optional() }),
      annotations: readOnly,
    },
    async ({ project_id, environment, event, key, limit }) => text(await propertyValues(await scopeFor(project_id, environment), event, key, limit)),
  );

  server.registerTool(
    "list_users",
    {
      title: "List users",
      description: "Users with traits, first/last seen and event counts. Search matches ids and trait values.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        q: z.string().optional(),
        identified_only: z.boolean().optional(),
        group_id: z.string().optional().describe("Only users whose latest company is this id"),
        source_id: sourceArg,
        order_by: z.enum(["last_seen", "first_seen", "event_count"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, q, identified_only, group_id, source_id, order_by, ...rest }) =>
      text(await listUsers(await scopeFor(project_id, environment), { ...rest, search: q, identifiedOnly: identified_only, groupId: group_id, sourceId: source_id, orderBy: order_by })),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get user",
      description: "One person's profile: traits, linked anonymous ids, companies, top events, and a recent event timeline. Accepts a user id or an anonymous id; anonymous activity is attributed to the user it later identified as.",
      inputSchema: z.object({ project_id: projectArg, environment: environmentArg, distinct_id: z.string(), event_limit: z.number().int().min(0).max(500).optional() }),
      annotations: readOnly,
    },
    async ({ project_id, environment, distinct_id, event_limit }) => {
      const p = await scopeFor(project_id, environment);
      const user = await getUser(p, distinct_id);
      if (!user) throw new Error(`User not found: ${distinct_id}`);
      const [events, attribution] = await Promise.all([
        listEvents(p, { distinctId: user.distinct_id, limit: event_limit ?? 50 }),
        personAttribution(p, user.distinct_id),
      ]);
      return text({ user, attribution, events });
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List companies",
      description: "Companies / workspaces (analytics.js groups) with traits, user counts and activity.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        q: z.string().optional(),
        order_by: z.enum(["last_seen", "event_count", "user_count"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, q, order_by, ...rest }) => text(await listGroups(await scopeFor(project_id, environment), { ...rest, search: q, orderBy: order_by })),
  );

  server.registerTool(
    "get_group",
    {
      title: "Get company",
      description: "One company: traits, members, top events, attribution (first/last touch, how each member arrived) and recent events across all its users.",
      inputSchema: z.object({ project_id: projectArg, environment: environmentArg, group_id: z.string(), event_limit: z.number().int().min(0).max(500).optional() }),
      annotations: readOnly,
    },
    async ({ project_id, environment, group_id, event_limit }) => {
      const p = await scopeFor(project_id, environment);
      const [group, events, attribution] = await Promise.all([
        getGroup(p, group_id),
        listEvents(p, { groupId: group_id, limit: event_limit ?? 50 }),
        groupAttribution(p, group_id),
      ]);
      if (!group) throw new Error(`Group not found: ${group_id}`);
      return text({ group, attribution, events });
    },
  );

  server.registerTool(
    "list_touches",
    {
      title: "List attribution touches",
      description:
        "Every recorded arrival, newest first: session starts, anything carrying UTM parameters, and page views with an external referrer. kind is 'campaign', 'referral' or 'direct'. Filter by person or company. One row per arrival — the repeated messages of a single page load are collapsed — and every distinct arrival is kept, so first-touch, last-touch and multi-touch models are all derivable.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        person_id: z.string().optional().describe("User id or anonymous id"),
        group_id: z.string().optional().describe("Company id: touches of every member, including pre-signup arrivals"),
        source_id: sourceArg,
        kind: z.enum(["campaign", "referral", "direct"]).optional(),
        exclude_direct: z.boolean().optional(),
        after: z.string().optional().describe("ISO timestamp"),
        before: z.string().optional().describe("ISO timestamp, use for pagination"),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, person_id, group_id, source_id, exclude_direct, ...rest }) =>
      text(await listTouches(await scopeFor(project_id, environment), { ...rest, personId: person_id, groupId: group_id, sourceId: source_id, excludeDirect: exclude_direct })),
  );

  server.registerTool(
    "attribution_report",
    {
      title: "Attribution report",
      description:
        "People and companies grouped by a touch dimension (utm_source, utm_medium, utm_campaign, referrer_host, landing_path, kind) under a first-touch or last-touch model. Last-touch ignores direct arrivals when the person has any campaign or referral touch. Use identified_only to count sign-ups rather than visitors.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        model: z.enum(["first", "last"]).optional(),
        by: z.enum(["utm_source", "utm_medium", "utm_campaign", "referrer_host", "landing_path", "kind", "source_id"]).optional(),
        identified_only: z.boolean().optional(),
        group_id: z.string().optional().describe("Restrict to one company's members"),
        source_id: sourceArg,
        from: z.string().optional().describe("ISO timestamp"),
        to: z.string().optional().describe("ISO timestamp"),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, identified_only, group_id, source_id, ...rest }) =>
      text(await attributionReport(await scopeFor(project_id, environment), { ...rest, identifiedOnly: identified_only, groupId: group_id, sourceId: source_id })),
  );

  server.registerTool(
    "describe_schema",
    {
      title: "Describe schema",
      description: "The ClickHouse schema and query tips. Read this before using run_sql.",
      inputSchema: z.object({ project_id: projectArg }),
      annotations: readOnly,
    },
    // The hidden set is named here rather than only described, because run_sql is the
    // one route that cannot apply it: an agent writing its own SQL has to be told
    // which names to leave out if its numbers are to match the dashboard's.
    async ({ project_id }) => {
      const hidden = await hiddenEventsFor((await project(project_id)).id);
      const suffix = hidden.length
        ? `\n\nHidden in this project right now: ${hidden.join(", ")}. Every tool above already excludes these; run_sql does not.`
        : `\n\nNothing is hidden in this project right now.`;
      return { content: [{ type: "text" as const, text: schemaDoc + suffix }] };
    },
  );

  server.registerTool(
    "run_sql",
    {
      title: "Run read-only SQL",
      description:
        "Run a read-only ClickHouse SELECT against the analytics database. Always filter with project_id = {project_id} (the placeholder is bound server-side). Use sessions_resolved for anything per visit (sessions, visitors, channel, engagement, entry and exit pages), windowFunnel for funnels, JSONExtractString(properties, 'key') for properties. Max 10k rows.",
      inputSchema: z.object({
        project_id: projectArg, environment: environmentArg,
        sql: z.string().describe("A single SELECT statement. Use {project_id} as the project filter placeholder."),
        limit: z.number().int().min(1).max(10000).optional(),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, sql, limit }) => text(await runSql(await scopeFor(project_id, environment), sql, { limit })),
  );
}

export const serverInfo = { name: "fourier", version: "0.1.0" };
export const instructions = `Fourier is an open source product analytics store (ClickHouse). Start with list_event_names or get_overview to orient, then use list_events / get_user / get_group for detail, and run_sql (after describe_schema) for anything custom like funnels, retention or property breakdowns. Companies are analytics.js "groups": every event carries group_id when the user belongs to one. Sources: a project can have several sources (sites / apps / products), each with its own write key; users and companies are shared across them and every event has a source_id. Identity: anonymous activity is attributed to the user it later identified as; use person_id, never raw distinct_id, when counting people. Attribution: list_touches and attribution_report cover UTMs, referrers and direct arrivals; get_user and get_group include first and last touch.`;
