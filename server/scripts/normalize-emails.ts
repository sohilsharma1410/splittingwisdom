/**
 * One-off fix for accounts registered before login/register normalized
 * email casing (trim + lowercase) at the schema level. Before that change,
 * two rows the user considers "the same email" — e.g. "Jane@Gmail.com"
 * from registration vs "jane@gmail.com" typed at login — never matched in
 * the case-sensitive `eq(users.email, ...)` lookup, producing a false
 * "Incorrect email or password." This updates existing rows to match what
 * every new register/login now writes and compares against.
 *
 * Run once, from server/: npx tsx scripts/normalize-emails.ts
 *
 * Each row is updated individually (not one bulk UPDATE) so a single
 * collision — two existing accounts that normalize to the same email,
 * which a real bug elsewhere would have to have allowed — is reported and
 * skipped instead of rolling back the fix for every other account too.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db.js";
import { users } from "@splittingwisdom/shared";
import { isUniqueViolation } from "../src/lib/pg-errors.js";

async function main() {
  const allUsers = await db.query.users.findMany({ columns: { id: true, email: true } });

  const needsUpdate = allUsers.filter((u) => u.email !== u.email.trim().toLowerCase());
  if (needsUpdate.length === 0) {
    console.log(`Checked ${allUsers.length} user(s) — all emails already normalized.`);
    return;
  }

  console.log(`Normalizing ${needsUpdate.length} of ${allUsers.length} user(s):`);
  for (const u of needsUpdate) {
    const normalized = u.email.trim().toLowerCase();
    try {
      await db.update(users).set({ email: normalized }).where(eq(users.id, u.id));
      console.log(`  updated #${u.id}: "${u.email}" -> "${normalized}"`);
    } catch (err) {
      if (isUniqueViolation(err)) {
        console.error(
          `  SKIPPED #${u.id}: "${u.email}" -> "${normalized}" collides with an existing account. Resolve manually.`,
        );
        continue;
      }
      throw err;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
