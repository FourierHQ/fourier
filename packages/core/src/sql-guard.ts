/**
 * Guard for agent-supplied SQL. ClickHouse `readonly=1` is the real enforcement;
 * this gives a friendlier error before we hit the database.
 */
const FORBIDDEN =
  /\b(insert|alter|drop|truncate|create|rename|attach|detach|optimize|system|grant|revoke|kill|exchange|move|delete|update|settings)\b/i;

/** Remove comments and string literals so keywords inside them don't trip the guard. */
function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

export function assertReadOnlySql(sql: string): string {
  const stripped = stripNoise(sql).trim().replace(/;+\s*$/, "");
  if (!stripped) throw new Error("Empty SQL");
  if (stripped.includes(";")) throw new Error("Only a single statement is allowed");
  if (!/^\s*(select|with|show|describe|desc|explain)\b/i.test(stripped)) {
    throw new Error("Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN statements are allowed");
  }
  if (FORBIDDEN.test(stripped)) throw new Error("Statement contains a forbidden keyword");
  // Return the original (comments intact, ClickHouse handles them) minus trailing semicolons.
  return sql.trim().replace(/;+\s*$/, "");
}
