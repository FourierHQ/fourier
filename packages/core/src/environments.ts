/**
 * Environments.
 *
 * An environment is a hard boundary: production, preview and development each get
 * their own ClickHouse database, and nothing joins across them. That is deliberate.
 * Sources share a person graph by design — `identify("user_123")` on the marketing
 * site and in the app are the same human — so a preview deployment calling
 * `identify("user_123")` would merge test traits into a real person if environments
 * were only a column. They are not a column. They are a different database, and a
 * production query physically cannot see preview rows.
 *
 * Production keeps the base database name, so an install that predates environments
 * is already the production environment and needs no migration.
 */

export const ENVIRONMENTS = ["production", "preview", "development"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export const DEFAULT_ENVIRONMENT: Environment = "production";

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === "string" && (ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Read an environment off a query string / header / env var. Anything unrecognised
 * falls back to production rather than throwing: an unknown value must never be able
 * to route a write somewhere unexpected, and production is the one an operator is
 * looking at by default.
 */
export function parseEnvironment(value: unknown, fallback: Environment = DEFAULT_ENVIRONMENT): Environment {
  if (isEnvironment(value)) return value;
  return fallback;
}

/**
 * Map Vercel's VERCEL_ENV onto ours. The names already line up; this exists so the
 * mapping is stated in one place rather than assumed at each call site.
 */
export function environmentFromVercel(vercelEnv: unknown): Environment | null {
  return isEnvironment(vercelEnv) ? vercelEnv : null;
}

/**
 * Database name for an environment. Production is the base name itself — that is what
 * makes this change invisible to existing deployments — and the others are suffixed.
 */
export function databaseFor(base: string, environment: Environment): string {
  return environment === DEFAULT_ENVIRONMENT ? base : `${base}_${environment}`;
}

/** Short label for the dashboard switcher. */
export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  production: "Production",
  preview: "Preview",
  development: "Development",
};

/**
 * What every data query is scoped to. Carried as one object, and required, so that
 * adding a query cannot accidentally read production: there is no default to fall
 * back to and TypeScript refuses the call without it.
 */
export interface Scope {
  projectId: string;
  environment: Environment;
  /**
   * Event names the operator has hidden, excluded from every count, ranking, chart
   * and listing this scope produces. It travels with the scope rather than being a
   * per-query option for the same reason the environment does: a report that forgot
   * to pass it would quietly disagree with the one next to it.
   *
   * The rows are still stored, still ingested and still readable by raw SQL. Hiding
   * is a reading decision, reversible at any time, exactly like a goal definition.
   */
  hiddenEvents: readonly string[];
}

export function scope(projectId: string, environment: Environment = DEFAULT_ENVIRONMENT, hiddenEvents: readonly string[] = []): Scope {
  return { projectId, environment, hiddenEvents };
}
