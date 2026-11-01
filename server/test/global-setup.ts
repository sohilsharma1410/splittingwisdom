import { requireTestDatabaseUrl } from "./helpers/env.js";
import { resetAndMigrate } from "./helpers/db.js";

// Runs once before the integration suite: wipe + migrate the primary test
// database (and the standby one when configured). Fails loudly and early,
// with instructions, if the clusters aren't there.
export default async function setup() {
  const primary = requireTestDatabaseUrl();
  await resetAndMigrate(primary);

  const standby = process.env.TEST_STANDBY_DATABASE_URL;
  if (standby) {
    const { assertLocalDatabaseUrl } = await import("./helpers/env.js");
    assertLocalDatabaseUrl("TEST_STANDBY_DATABASE_URL", standby);
    await resetAndMigrate(standby);
  }
}
