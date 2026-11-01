import type { Request, Response, NextFunction, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { fingerprintRequest, isValidIdempotencyKey } from "../lib/request-fingerprint.js";

/**
 * Idempotency-Key support for creating POSTs (plan S6.1).
 *
 * Why: a request can succeed on one node (Pi) while the response is lost,
 * and the user's retry lands on another node (standby) or just a second
 * time on the same one. Without this, that is a duplicate bill.
 *
 * Semantics (all scoped per authenticated user — user B can never see or
 * replay user A's key):
 *
 *   - No `Idempotency-Key` header         -> request behaves exactly as before.
 *   - New key                             -> the key is *claimed atomically*
 *                                            (INSERT ... ON CONFLICT, never
 *                                            check-then-insert), the handler
 *                                            runs, and a 2xx response is stored.
 *   - Same key + same fingerprint, done   -> the stored status/body is replayed
 *                                            with header `Idempotent-Replay: true`.
 *   - Same key + different fingerprint    -> 422. Fingerprint =
 *                                            sha256(method, path+query, canonical body).
 *   - Same key, original still running    -> SERIALIZED: the duplicate waits
 *                                            (polls, up to 10 s, env IDEMPOTENCY_WAIT_TIMEOUT_MS) for the
 *                                            original to finish and then replays its
 *                                            response. If it is still running after
 *                                            the timeout the duplicate gets 409 with
 *                                            `Retry-After: 1`. A duplicate never
 *                                            executes the handler a second time.
 *   - Non-2xx / thrown handler            -> the claim is released (nothing was
 *                                            created), so the client may retry with
 *                                            the same key — including after fixing a
 *                                            validation error. Only 2xx is cached.
 *   - Keys expire after 24 h. An expired row is atomically replaced by the next
 *     claim of that key and swept lazily (every ~50th claim) — no cron needed.
 *   - A claim left "in_progress" by a crashed process is taken over after
 *     STALE_IN_PROGRESS_SECONDS. (Residual risk: a crash in the few ms between
 *     the handler's commit and the response being stored can produce one duplicate
 *     on retry after that timeout; the claim cannot share the handler's transaction
 *     without threading it through every route.)
 *
 * Mount AFTER requireAuth / requireGroupMember so unauthenticated or
 * unauthorised callers can't create rows, e.g.
 *   router.post("/", idempotency(), handler)
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_HOURS = 24;
export const STALE_IN_PROGRESS_SECONDS = 120;
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
/** Read per request so tests can shorten it. */
const waitTimeoutMs = () => Number(process.env.IDEMPOTENCY_WAIT_TIMEOUT_MS) || DEFAULT_WAIT_TIMEOUT_MS;
const POLL_INTERVAL_MS = 40;
const SWEEP_PROBABILITY = 1 / 50;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type StoredRow = {
  fingerprint: string;
  status: "in_progress" | "completed";
  response_status: number | null;
  response_body: unknown;
};

/** Atomically takes ownership of (user, key). True iff this caller now owns it. */
async function claim(userId: number, key: string, fingerprint: string): Promise<boolean> {
  const rows = await db.execute(sql`
    INSERT INTO idempotency_keys (user_id, key, fingerprint, status, created_at)
    VALUES (${userId}, ${key}, ${fingerprint}, 'in_progress', now())
    ON CONFLICT (user_id, key) DO UPDATE
      SET fingerprint = EXCLUDED.fingerprint,
          status = 'in_progress',
          response_status = NULL,
          response_body = NULL,
          created_at = now(),
          completed_at = NULL
      WHERE idempotency_keys.created_at < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})
         OR (idempotency_keys.status = 'in_progress'
             AND idempotency_keys.created_at < now() - make_interval(secs => ${STALE_IN_PROGRESS_SECONDS}))
    RETURNING 1 AS claimed
  `);
  return rows.length > 0;
}

async function load(userId: number, key: string): Promise<StoredRow | undefined> {
  const rows = await db.execute<StoredRow>(sql`
    SELECT fingerprint, status, response_status, response_body
    FROM idempotency_keys WHERE user_id = ${userId} AND key = ${key}
  `);
  return rows[0];
}

async function complete(userId: number, key: string, status: number, body: unknown): Promise<void> {
  await db.execute(sql`
    UPDATE idempotency_keys
    SET status = 'completed', response_status = ${status},
        response_body = ${JSON.stringify(body ?? null)}::jsonb, completed_at = now()
    WHERE user_id = ${userId} AND key = ${key} AND status = 'in_progress'
  `);
}

async function release(userId: number, key: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM idempotency_keys
    WHERE user_id = ${userId} AND key = ${key} AND status = 'in_progress'
  `);
}

/** Deletes expired rows. Safe to call concurrently; failures are non-fatal. */
export async function sweepExpiredIdempotencyKeys(): Promise<number> {
  const rows = await db.execute(sql`
    DELETE FROM idempotency_keys
    WHERE created_at < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})
    RETURNING 1
  `);
  return rows.length;
}

function replay(res: Response, row: StoredRow) {
  res.set("Idempotent-Replay", "true");
  res.status(row.response_status ?? 200).json(row.response_body);
}

export function idempotency(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (key === undefined) {
      next();
      return;
    }
    if (!isValidIdempotencyKey(key)) {
      res.status(400).json({
        error: { message: "Idempotency-Key must be 1-255 printable characters with no spaces." },
      });
      return;
    }
    const userId = req.session.userId;
    if (!userId) {
      res.status(401).json({ error: { message: "You need to be logged in." } });
      return;
    }

    const fingerprint = fingerprintRequest(req.method, req.originalUrl, req.body);
    const deadline = Date.now() + waitTimeoutMs();

    if (Math.random() < SWEEP_PROBABILITY) {
      void sweepExpiredIdempotencyKeys().catch(() => undefined);
    }

    for (;;) {
      if (await claim(userId, key, fingerprint)) {
        runOwned(res, next, userId, key);
        return;
      }

      const row = await load(userId, key);
      if (!row) continue; // released between our claim and our read — try to claim again

      if (row.fingerprint !== fingerprint) {
        res.status(422).json({
          error: { message: "This Idempotency-Key was already used with a different request." },
        });
        return;
      }
      if (row.status === "completed") {
        replay(res, row);
        return;
      }
      if (Date.now() >= deadline) {
        res.set("Retry-After", "1");
        res.status(409).json({
          error: { message: "A request with this Idempotency-Key is still being processed. Retry shortly." },
        });
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };
}

/** We own the claim: run the handler and persist (or release) based on its answer. */
function runOwned(res: Response, next: NextFunction, userId: number, key: string) {
  let settled = false;
  const originalJson = res.json.bind(res);

  res.json = ((body?: unknown) => {
    if (settled) return originalJson(body);
    settled = true;
    const status = res.statusCode;
    const persist =
      status >= 200 && status < 300
        ? complete(userId, key, status, body).catch(() => release(userId, key))
        : release(userId, key);
    // Store before replying so a client that retries the instant it sees
    // the response always finds the completed row.
    persist.catch(() => undefined).finally(() => originalJson(body));
    return res;
  }) as Response["json"];

  // Handler answered without res.json (res.end/sendStatus...): nothing cached.
  res.on("finish", () => {
    if (settled) return;
    settled = true;
    void release(userId, key).catch(() => undefined);
  });

  next();
}
