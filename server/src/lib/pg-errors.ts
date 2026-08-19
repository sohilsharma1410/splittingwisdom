/**
 * drizzle-orm wraps the underlying postgres.js error in its own
 * DrizzleQueryError, with the real Postgres error (and its SQLSTATE `code`)
 * nested under `.cause` rather than on the thrown error itself. Unwrap
 * `.cause` recursively so this keeps working regardless of how many layers
 * of wrapping the driver/ORM adds.
 */
function extractPgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  if ("cause" in record) return extractPgErrorCode(record.cause);
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return extractPgErrorCode(err) === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return extractPgErrorCode(err) === "23503";
}
