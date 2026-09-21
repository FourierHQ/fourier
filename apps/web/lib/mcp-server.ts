import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  attributionReport,
  availability,
  countingLabel,
  defaultGoal,
  deleteDefinition,
  eventTimeseries,
  funnel,
  goalSummary,
  groupAttribution,
  headline,
  listTouches,
  personAttribution,
  getGroup,
  getOverview,
  getUser,
  hiddenEventsFor,
  listEventNames,
  listEvents,
  listGoals,
  listGroups,
  listPageGroups,
  listProjects,
  listSources,
  listUsers,
  propertyKeys,
  propertyValues,
  resolveGoal,
  resolveRange,
  runSql,
  schemaDoc,
  supportingActions,
  upsertDefinition,
  ENVIRONMENTS,
  RANGE_PRESETS,
  parseEnvironment,
  scope as makeScope,
  type Goal,
  type GoalConfig,
  type GoalMatch,
  type GoalType,
  type PropertyFilter,
  type Scope,
  type WebScope,
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

// ---------- goals ----------

/**
 * Goals over MCP.
 *
 * A goal is a definition, not data: it lives in the control database, it is shared by
 * every environment, and it is applied when a report runs rather than at ingest. So
 * these tools take no `environment` — a goal defined once is the same goal in
 * production and in preview — and writing one changes what the history you already
 * have says, not only what happens from now on. That is also why creating a goal is a
 * reasonable thing for an agent to do: it is a reading of events that already exist,
 * and it is reversible.
 *
 * The match is flattened here rather than nested as the tagged union core stores. A
 * union of object shapes is what MCP clients render worst, and a rule an agent cannot
 * express in the schema is a rule it will go and write as raw SQL instead — where
 * nobody looking at the dashboard will ever see it.
 */

const propertyFilterArg = z.object({
  key: z.string().min(1).max(200).describe("Property name, e.g. 'plan'. See event_property_keys."),
  op: z.enum(["eq", "neq", "contains", "exists"]).describe("eq / neq / contains compare the value; exists only asks whether the event carried the key at all."),
  value: z.string().max(1000).optional().describe("Required for eq, neq and contains. Omitted for exists."),
});

/**
 * Either half of a match, in one flat object. Which half applies is inferred from
 * whichever of `event` and `path` was given, so the common cases need no `match` at all.
 */
const matchShape = {
  match: z.enum(["pageview", "event"]).optional().describe("What completes it. Inferred when omitted: 'event' if you give event, 'pageview' if you give path."),
  event: z.string().min(1).max(500).optional().describe("Exact event name, from list_event_names."),
  properties: z
    .array(propertyFilterArg)
    .max(10)
    .optional()
    .describe(
      "Narrow an event goal to events carrying these properties; every filter must hold. This is what keeps 'Signup completed' distinct from 'Signup completed on the paid plan'. Use event_property_values to spell a value exactly — a typo here defines a goal that simply never fires. Pass [] to clear them.",
    ),
  path: z.string().max(1000).optional().describe("Page path for a page-view goal, e.g. '/thanks'. Query strings never take part, and a trailing slash is normalised away."),
  path_op: z
    .enum(["exact", "prefix", "contains"])
    .optional()
    .describe("How the path matches. Default exact. prefix is what a trailing '/*' means: '/blog' matches '/blog' and everything under it, but not '/blogroll'."),
};

const funnelStepArg = z.object({
  name: z.string().min(1).max(200).describe("What this step is called in the report, e.g. 'Pricing viewed'."),
  ...matchShape,
});

const goalTypeArg = z
  .enum(["primary", "supporting"])
  .describe(
    "primary: something the site exists to produce, and the only kind a conversion rate counts. supporting: evidence along the way — a CTA click, a form start — reported on its own and never added to a conversion total.",
  );

type MatchInput = {
  match?: "pageview" | "event";
  event?: string;
  properties?: { key: string; op: PropertyFilter["op"]; value?: string }[];
  path?: string;
  path_op?: "exact" | "prefix" | "contains";
};

type StepInput = MatchInput & { name: string };

function propertyFilter(f: { key: string; op: PropertyFilter["op"]; value?: string }, where: string): PropertyFilter {
  const key = f.key.trim();
  if (!key) throw new Error(`${where}: a property filter needs a key.`);
  if (f.op === "exists") return { key, op: "exists" };
  const value = f.value?.trim();
  // A missing value is almost always a filter the caller forgot to finish, and it
  // compiles to a comparison against the empty string — a rule that quietly matches
  // every event with no such property rather than none. Refusing is the cheaper failure.
  if (!value) throw new Error(`${where}: the '${f.op}' filter on '${key}' needs a value. Use op 'exists' to ask only whether the property is set.`);
  return { key, op: f.op, value };
}

/** The flat arguments as core stores them. `base` supplies whatever an update left out. */
function toMatch(input: MatchInput, where: string, base?: GoalMatch): GoalMatch {
  const kind = input.match ?? (input.event !== undefined ? "event" : input.path !== undefined ? "pageview" : base?.match);
  if (!kind) throw new Error(`${where}: give an event name, or a path for a page-view goal.`);
  if (kind === "pageview") {
    const prior = base?.match === "pageview" ? base.path : undefined;
    const value = (input.path ?? prior?.value ?? "").trim();
    if (!value) throw new Error(`${where}: path is required for a page-view goal.`);
    return { match: "pageview", path: { op: input.path_op ?? prior?.op ?? "exact", value } };
  }
  const prior = base?.match === "event" ? base : undefined;
  const event = (input.event ?? prior?.event ?? "").trim();
  if (!event) throw new Error(`${where}: event is required for an event goal.`);
  const filters = (input.properties ?? prior?.properties ?? []).map((f, i) => propertyFilter(f, `${where}, property filter ${i + 1}`));
  return { match: "event", event, ...(filters.length ? { properties: filters } : {}) };
}

function toFunnel(steps: StepInput[]): { name: string; match: GoalMatch }[] {
  return steps.map((s, i) => {
    const name = s.name.trim();
    if (!name) throw new Error(`Funnel step ${i + 1} needs a name.`);
    return { name, match: toMatch(s, `funnel step ${i + 1}`) };
  });
}

/**
 * The two rules the editor enforces, restated as errors rather than as silent
 * corrections: an agent that is told why gets it right next time, where one whose input
 * was quietly rewritten will keep sending the same thing.
 */
function guardSupporting(type: GoalType, isDefault: boolean | undefined, steps: unknown[] | undefined): void {
  if (type !== "supporting") return;
  if (isDefault) throw new Error("Only a primary goal can be the project default: a supporting action is never counted as a conversion.");
  if (steps?.length) throw new Error("A funnel belongs to a primary goal — supporting actions are reported on their own, with no path drawn to them. Pass funnel: [] to drop it, or make this goal primary.");
}

function matchFields(m: GoalMatch) {
  return m.match === "pageview"
    ? { match: "pageview" as const, path: m.path.value, path_op: m.path.op }
    : { match: "event" as const, event: m.event, ...(m.properties?.length ? { properties: m.properties } : {}) };
}

/** A goal in the same flat shape the write tools take, so a read can be edited and sent back. */
function describeGoal(g: Goal) {
  return {
    id: g.id,
    name: g.name,
    type: g.config.type,
    is_default: g.is_default,
    position: g.position,
    ...matchFields(g.config),
    ...(g.config.funnel?.length ? { funnel: g.config.funnel.map((s) => ({ name: s.name, ...matchFields(s.match) })) } : {}),
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
}

/**
 * Read the goal back rather than echoing what was sent. An upsert can move the project
 * default off another goal, and the stored row — not the request — is what every report
 * will compile.
 */
async function savedGoal(projectId: string, id: string) {
  const goal = (await listGoals(projectId)).find((g) => g.id === id);
  if (!goal) throw new Error(`Goal ${id} was written but could not be read back.`);
  return describeGoal(goal);
}

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

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

  // ---------- goals: read, define, report ----------

  server.registerTool(
    "list_goals",
    {
      title: "List goals",
      description:
        "Conversion goals and supporting actions, each with the rule it matches on: the event or page path, any property filters, and the funnel steps leading to it. Primary goals are the only things a conversion rate counts; supporting actions are reported separately and never added into a conversion total. Goals are shared by every environment, so there is no environment argument.",
      inputSchema: z.object({ project_id: projectArg }),
      annotations: readOnly,
    },
    async ({ project_id }) => {
      const goals = await listGoals((await project(project_id)).id);
      return text({
        goals: goals.map(describeGoal),
        // Which goal a report reaches for when it needs exactly one — a funnel cannot be
        // drawn to "any of three things" — and the reader has not named one.
        default_goal_id: defaultGoal(goals)?.id ?? null,
      });
    },
  );

  server.registerTool(
    "create_goal",
    {
      title: "Create goal",
      description:
        "Define what counts as a conversion, or a supporting action on the way to one. Matched at query time, so a goal created today reports the history you already have. Check the rule against the data first — list_event_names for the event, event_property_values for a property value — because a goal whose rule matches nothing reports zero rather than an error.",
      inputSchema: z.object({
        project_id: projectArg,
        name: z.string().min(1).max(200).describe("What this is called in the reports, e.g. 'Signed up'."),
        type: goalTypeArg.optional().describe("Defaults to primary."),
        ...matchShape,
        funnel: z
          .array(funnelStepArg)
          .max(8)
          .optional()
          .describe("Ordered steps a single visit must pass through, in order, to reach this goal. Omit for the honest default: a visit, and then the goal. Primary goals only."),
        is_default: z.boolean().optional().describe("Make this the goal a funnel falls back to. At most one per project; setting it clears the previous one."),
        position: z.number().int().min(0).optional().describe("Sort order in the reports."),
      }),
      annotations: write,
    },
    async ({ project_id, name, type, funnel: steps, is_default, position, ...m }) => {
      const pid = (await project(project_id)).id;
      const kind = type ?? "primary";
      guardSupporting(kind, is_default, steps);
      const built = steps ? toFunnel(steps) : [];
      const config: GoalConfig = { type: kind, ...toMatch(m, "goal"), ...(built.length ? { funnel: built } : {}) };
      const saved = await upsertDefinition(pid, "goal", { name, config, position, is_default });
      return text({ goal: await savedGoal(pid, saved.id) });
    },
  );

  server.registerTool(
    "update_goal",
    {
      title: "Update goal",
      description:
        "Change a goal's name, type, rule, property filters, funnel or default flag. Everything omitted is left as it is, so adding one property filter does not mean restating the event. Because goals are evaluated when a report runs, fixing a rule fixes the history it was always meant to describe. Pass properties: [] or funnel: [] to clear them.",
      inputSchema: z.object({
        project_id: projectArg,
        goal_id: z.string().describe("From list_goals."),
        name: z.string().min(1).max(200).optional(),
        type: goalTypeArg.optional(),
        ...matchShape,
        funnel: z.array(funnelStepArg).max(8).optional().describe("Replaces the existing steps. [] drops the funnel and returns the goal to a visit, then the goal."),
        is_default: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ project_id, goal_id, name, type, funnel: steps, is_default, position, ...m }) => {
      const pid = (await project(project_id)).id;
      const existing = (await listGoals(pid)).find((g) => g.id === goal_id);
      if (!existing) throw new Error(`No goal with id ${goal_id}. Use list_goals to see them.`);
      const kind = type ?? existing.config.type;
      const nextDefault = is_default ?? existing.is_default;
      const built = steps ? toFunnel(steps) : (existing.config.funnel ?? []);
      guardSupporting(kind, nextDefault, built);
      const config: GoalConfig = { type: kind, ...toMatch(m, "goal", existing.config), ...(built.length ? { funnel: built } : {}) };
      await upsertDefinition(pid, "goal", { id: goal_id, name: name ?? existing.name, config, position, is_default: nextDefault });
      return text({ goal: await savedGoal(pid, goal_id) });
    },
  );

  server.registerTool(
    "delete_goal",
    {
      title: "Delete goal",
      description: "Remove a goal or supporting action. The events it matched are untouched — a goal is only ever a reading of them — so the same rule can be defined again and will report the same history.",
      inputSchema: z.object({ project_id: projectArg, goal_id: z.string() }),
      annotations: { ...write, destructiveHint: true, idempotentHint: true },
    },
    async ({ project_id, goal_id }) => {
      const pid = (await project(project_id)).id;
      if (!(await deleteDefinition(pid, "goal", goal_id))) throw new Error(`No goal with id ${goal_id}. Use list_goals to see them.`);
      return text({ deleted: goal_id, goals: (await listGoals(pid)).map(describeGoal) });
    },
  );

  server.registerTool(
    "goal_report",
    {
      title: "Goal performance",
      description:
        "How the goals are actually doing: conversions and conversion rate for every primary goal against the same denominator, the funnel to the selected goal, and supporting actions — each against the preceding equivalent period. Counted in sessions, excluding bots. Read `availability` before reporting a zero: no primary goal configured, or no traffic at all, is a setup state rather than nobody converting.",
      inputSchema: z.object({
        project_id: projectArg,
        environment: environmentArg,
        goal_id: z
          .string()
          .optional()
          .describe("Narrow to one primary goal. Omit to count visits that completed any of them — and note the funnel only follows a goal's configured steps when you name that goal, since a path cannot lead to three destinations at once."),
        source_id: sourceArg,
        range: z.enum(RANGE_PRESETS).optional().describe("Named window. Default 30d."),
        from: z.string().optional().describe("ISO date or timestamp. Give from/to instead of range for a custom window."),
        to: z.string().optional().describe("ISO date or timestamp, exclusive."),
        timezone: z.string().optional().describe("IANA zone the days are cut on, e.g. 'Europe/London'. Default UTC."),
        compare: z.boolean().optional().describe("Compare against the preceding equivalent period. On by default."),
        include_bots: z.boolean().optional().describe("Off by default, like the dashboard."),
      }),
      annotations: readOnly,
    },
    async ({ project_id, environment, goal_id, source_id, range, from, to, timezone, compare, include_bots }) => {
      const pid = (await project(project_id)).id;
      const [scope, goals, pageGroups] = await Promise.all([scopeFor(project_id, environment), listGoals(pid), listPageGroups(pid)]);
      const selected = resolveGoal(goals, goal_id);
      // Naming a goal that is not a primary goal would otherwise report every goal under
      // a heading that says one, which is the wrong number silently.
      if (goal_id && !selected) throw new Error(`${goal_id} is not a primary goal in this project. list_goals shows which are; supporting actions cannot be selected, they appear in the supporting table.`);
      const w: WebScope = {
        scope,
        range: resolveRange({ preset: range, from, to, compare: compare !== false, timezone }),
        filters: { sourceId: source_id ?? null, includeBots: include_bots ?? false },
        goal: selected,
        goals,
        pageGroups,
      };
      const [head, summary, path, supporting, avail] = await Promise.all([
        headline(w),
        goalSummary(w),
        funnel(w),
        supportingActions(w),
        availability(w),
      ]);
      return text({
        range: {
          preset: w.range.preset,
          from: w.range.current.from.toISOString(),
          to: w.range.current.to.toISOString(),
          previous_from: w.range.previous?.from.toISOString() ?? null,
          previous_to: w.range.previous?.to.toISOString() ?? null,
          timezone: w.range.timezone,
        },
        counting: countingLabel(w),
        selected_goal: selected ? { id: selected.id, name: selected.name } : null,
        headline: head,
        goals: summary,
        funnel: path,
        supporting,
        availability: avail,
      });
    },
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
        "Run a read-only ClickHouse SELECT against the analytics database. Always filter with project_id = {project_id} (the placeholder is bound server-side). Use windowFunnel for funnels, JSONExtractString(properties, 'key') for properties. Max 10k rows.",
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
export const instructions = `Fourier is an open source product analytics store (ClickHouse). Start with list_event_names or get_overview to orient, then use list_events / get_user / get_group for detail, and run_sql (after describe_schema) for anything custom like funnels, retention or property breakdowns. Companies are analytics.js "groups": every event carries group_id when the user belongs to one. Sources: a project can have several sources (sites / apps / products), each with its own write key; users and companies are shared across them and every event has a source_id. Identity: anonymous activity is attributed to the user it later identified as; use person_id, never raw distinct_id, when counting people. Attribution: list_touches and attribution_report cover UTMs, referrers and direct arrivals; get_user and get_group include first and last touch. Goals: list_goals, create_goal, update_goal and delete_goal define what counts as a conversion — an event (optionally narrowed by its properties) or a page view — and goal_report says how those goals are doing. Goals are matched when a report runs, so one created today reports the history that is already there; check the rule against list_event_names and event_property_values first, because a rule that matches nothing reports zero rather than an error.`;
