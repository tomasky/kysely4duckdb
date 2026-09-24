/**
 * Keywords that make a statement return a result set.
 *
 * DuckDB reports affected rows for DML as a single generated `Count` column,
 * which by shape alone is indistinguishable from `SELECT count(*) AS count`.
 * Both drivers therefore prefer Kysely's parsed node kind and only fall back to
 * this check when the statement is raw SQL and the node kind is `RawNode`.
 */
const ROWS_RETURNING_KEYWORDS = [
  "select",
  "with",
  "from",
  "values",
  "table",
  "pragma",
  "show",
  "describe",
  "summarize",
  "explain",
] as const;

export function isRowsReturningStatement(sql: string): boolean {
  const statement = sql.trimStart().toLowerCase();
  return ROWS_RETURNING_KEYWORDS.some((keyword) => statement.startsWith(keyword));
}
