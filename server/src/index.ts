import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { sessionMiddleware } from "./session.js";
import authRouter from "./routes/auth.js";
import groupsRouter from "./routes/groups.js";

const app = express();
const PORT = process.env.PORT ?? 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

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
