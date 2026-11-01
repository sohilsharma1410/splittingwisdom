import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { sql } from "drizzle-orm";
import { sessionMiddleware } from "./session.js";
import { db } from "./db.js";
import authRouter from "./routes/auth.js";
import groupsRouter from "./routes/groups.js";
import billsRouter from "./routes/bills.js";
import balancesRouter from "./routes/balances.js";
import usersRouter from "./routes/users.js";
import { installRoleFencing } from "./roles/install.js";

export const app = express();
const PORT = process.env.PORT ?? 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

// Render (and most PaaS platforms) terminate TLS at a reverse proxy and
// forward plain HTTP internally. Without this, Express can't tell the
// original request was HTTPS, which breaks `secure: true` session cookies
// (required for SameSite=None, which cross-origin client<->API needs).
app.set("trust proxy", 1);

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());
app.use(sessionMiddleware);

app.get("/api/health", (_req, res) => {
  res.json({ data: { status: "ok" } });
});

// Unlike /api/health above, this actually touches Postgres — it exists so
// an external cron (see .github/workflows/keep-database-alive.yml) can hit
// it periodically and stop Supabase's free tier from auto-pausing the
// project after ~7 days with no database activity. A plain HTTP ping to
// this server doesn't count as DB activity on its own: express-session
// only reads/writes the session store for requests that carry a session
// cookie, and every other route requires auth first.
app.get("/api/health/db", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ data: { status: "ok" } });
  } catch (err) {
    console.error("Database keep-alive ping failed:", err);
    res.status(503).json({ error: { message: "Database unreachable." } });
  }
});

// Roles & fencing (plan S3): GET /api/health/role, 503 on mutating /api routes
// while this node isn't the active primary. No-op unless APP_ROLE is set.
installRoleFencing(app);

app.use("/api/auth", authRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/bills", billsRouter);
app.use("/api/balances", balancesRouter);
app.use("/api/users", usersRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { message: "Not found." } });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: { message: "Something went wrong. Please try again." } });
};
app.use(errorHandler);

// Integration tests (vitest sets VITEST) import `app` and drive it with
// supertest on an ephemeral port instead of binding PORT.
if (!process.env.VITEST) {
  app.listen(PORT, () => {
    console.log(`SplittingWisdom API listening on port ${PORT}`);
  });
}
