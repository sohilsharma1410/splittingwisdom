import type postgres from "postgres";
import type { Sql } from "./client.js";

/**
 * Mirrors the express-session table (created at runtime by connect-pg-simple,
 * so it is not in the Drizzle migrations and has no outbox triggers: it is
 * written on almost every request). Snapshot-style: copy every unexpired
 * session that changed, and drop target sessions that no longer exist (or
 * expired) on the source. Tolerates the table not existing yet on either side.
 *
 * Sessions only flow primary -> standby. A user logs in separately on the
 * standby origin anyway (plan §3.4 #3), so there is no reverse direction.
 */

async function hasSessionTable(db: Sql): Promise<boolean> {
  const [row] = await db<{ ok: boolean }[]>`SELECT to_regclass('public.session') IS NOT NULL AS ok`;
  return row.ok;
}

export async function syncSessions(source: Sql, target: Sql): Promise<{ copied: number; removed: number } | null> {
  if (!(await hasSessionTable(source)) || !(await hasSessionTable(target))) return null;

  const [snapshot] = await source<{ rows: unknown }[]>`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('sid', sid, 'sess', sess, 'expire', expire)), '[]'::jsonb) AS rows
    FROM session WHERE expire > now()`;
  const payload = snapshot.rows as postgres.JSONValue;

  return target.begin(async (tx) => {
    const upserted = await tx.unsafe(
      `INSERT INTO session (sid, sess, expire)
       SELECT e->>'sid', (e->'sess')::json, (e->>'expire')::timestamp
       FROM jsonb_array_elements($1::jsonb) AS e
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire
       WHERE session.sess::jsonb IS DISTINCT FROM EXCLUDED.sess::jsonb
          OR session.expire IS DISTINCT FROM EXCLUDED.expire
       RETURNING 1`,
      [tx.json(payload)],
    );
    const removed = await tx.unsafe(
      `DELETE FROM session
       WHERE sid NOT IN (SELECT e->>'sid' FROM jsonb_array_elements($1::jsonb) AS e)
       RETURNING 1`,
      [tx.json(payload)],
    );
    return { copied: upserted.length, removed: removed.length };
  });
}
