/**
 * Test-environment guard. Integration tests DROP SCHEMA public CASCADE, so
 * they must only ever run against throwaway local clusters — never the real
 * Supabase / Pi database.
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const HOW_TO = `
Integration tests need throwaway local Postgres clusters (never production):

  TEST_DATABASE_URL=$(scripts/local-pg.sh pi 54330 start) \\
  TEST_STANDBY_DATABASE_URL=$(scripts/local-pg.sh standby 54331 start) \\
  npm run test:integration --workspace=server

(TEST_STANDBY_DATABASE_URL is only needed by the sync / failback tests.)`;

export function assertLocalDatabaseUrl(name: string, url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL.${HOW_TO}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `${name} points at "${host}". Integration tests wipe the database and may only run against localhost.${HOW_TO}`,
    );
  }
}

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error(`TEST_DATABASE_URL is not set.${HOW_TO}`);
  assertLocalDatabaseUrl("TEST_DATABASE_URL", url);
  return url;
}

export function requireStandbyDatabaseUrl(): string {
  const url = process.env.TEST_STANDBY_DATABASE_URL;
  if (!url) throw new Error(`TEST_STANDBY_DATABASE_URL is not set.${HOW_TO}`);
  assertLocalDatabaseUrl("TEST_STANDBY_DATABASE_URL", url);
  return url;
}
