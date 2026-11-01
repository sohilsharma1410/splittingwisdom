import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// DB-backed tests (supertest against the Express app, trigger/sync/failback
// drills across two Postgres clusters). Needs throwaway local clusters —
// see server/test/helpers/env.ts for the error message
// and `scripts/local-pg.sh`:
//
//   TEST_DATABASE_URL=$(scripts/local-pg.sh pi 54330 start) \
//   TEST_STANDBY_DATABASE_URL=$(scripts/local-pg.sh standby 54331 start) \
//   npm run test:integration --workspace=server
//
// Files run strictly one at a time: they share the same two databases.
export default defineConfig({
  resolve: {
    alias: {
      "@splittingwisdom/shared": fileURLToPath(new URL("../shared/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
