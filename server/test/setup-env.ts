import { requireTestDatabaseUrl } from "./helpers/env.js";

// Runs in every test worker BEFORE any test file imports the app, because
// server/src/db.ts and session.ts read these at import time.
process.env.DATABASE_URL = requireTestDatabaseUrl();
process.env.SESSION_SECRET = "integration-test-session-secret";
process.env.NODE_ENV = "test";
// Never let dotenv pull a real server/.env (production secrets) into tests.
process.env.DOTENV_CONFIG_PATH = "/nonexistent/.env.never";
process.env.IDEMPOTENCY_WAIT_TIMEOUT_MS = "1500";
