import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { sessionMiddleware } from "./session.js";
import authRouter from "./routes/auth.js";
import groupsRouter from "./routes/groups.js";
import billsRouter from "./routes/bills.js";
import balancesRouter from "./routes/balances.js";

const app = express();
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

app.use("/api/auth", authRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/bills", billsRouter);
app.use("/api/balances", balancesRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { message: "Not found." } });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: { message: "Something went wrong. Please try again." } });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`SplittingWisdom API listening on port ${PORT}`);
});
