import { defineConfig } from "@playwright/test";

// E2E runs against stacks that are ALREADY running (local previews, a Vercel
// preview, or the Pi) — see the header of each spec for the env it needs.
// It drives the installed Google Chrome so no browser download is required.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { channel: "chrome", headless: true, permissions: ["microphone"] },
});
