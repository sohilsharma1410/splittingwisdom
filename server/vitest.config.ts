import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Fast unit tests: no database, no network. `npm run test --workspace=server`.
// DB-backed tests live in test/ and use vitest.integration.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@splittingwisdom/shared": fileURLToPath(new URL("../shared/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
