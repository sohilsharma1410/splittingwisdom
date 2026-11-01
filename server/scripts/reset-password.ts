/**
 * Owner-run password reset (no email provider yet — see PLAN D0.5).
 *
 * Sets a random temporary password for one account, prints it once, and
 * signs that user out everywhere by deleting their stored sessions. Tell
 * them to log in and change it via "Change password".
 *
 * Run from server/: npx tsx scripts/reset-password.ts <email>
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db.js";
import { users } from "@splittingwisdom/shared";

const BCRYPT_ROUNDS = 12;
// Unambiguous characters only (no 0/O, 1/l/I) so it survives being read out or typed from WhatsApp.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function temporaryPassword(length = 12): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: npx tsx scripts/reset-password.ts <email>");
    process.exit(1);
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    console.error(`No account found for ${email}`);
    process.exit(1);
  }

  const password = temporaryPassword();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  const revoked = await db.execute(sql`delete from session where sess ->> 'userId' = ${String(user.id)}`);

  console.log(`Reset password for ${user.displayName} <${email}> (user #${user.id}).`);
  console.log(`Signed out ${revoked.count ?? 0} active session(s).`);
  console.log(`Temporary password (shown once): ${password}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
