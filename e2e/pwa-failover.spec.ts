/**
 * PWA + failover E2E (plan D1, S7, QA-6/QA-11 client side).
 *
 * Needs TWO copies of the same build running, built with
 *   VITE_PRIMARY_URL=<E2E_PRIMARY_URL> VITE_STANDBY_URL=<E2E_STANDBY_URL>
 * each with its own API, plus a way to stop/start the primary's API:
 *   E2E_PRIMARY_URL          e.g. http://localhost:4173
 *   E2E_STANDBY_URL          e.g. http://127.0.0.1:4174
 *   E2E_PRIMARY_API_PIDFILE  file holding the primary API's PID
 *   E2E_PRIMARY_API_START    shell command that (re)starts the primary API
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PRIMARY = process.env.E2E_PRIMARY_URL ?? "http://localhost:4173";
const STANDBY = process.env.E2E_STANDBY_URL ?? "http://127.0.0.1:4174";
const PIDFILE = process.env.E2E_PRIMARY_API_PIDFILE;
const START_CMD = process.env.E2E_PRIMARY_API_START;

function stopPrimaryApi() {
  const pid = Number(readFileSync(PIDFILE!, "utf8").trim());
  // `npx tsx` spawns children; kill the whole group rooted at the recorded PID.
  execSync(`pkill -P ${pid} || true; kill ${pid} 2>/dev/null || true`);
}

async function waitForHealth(url: string, up: boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false);
    if (ok === up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not become ${up ? "healthy" : "unreachable"} within ${timeoutMs}ms`);
}

async function swActive(page: Page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.state;
  });
}

test.describe("PWA basics", () => {
  test("manifest is installable-grade and the service worker activates", async ({ page }) => {
    await page.goto(`${PRIMARY}/login`);
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();
    const manifest = await (await page.request.get(new URL(manifestHref!, PRIMARY).toString())).json();
    expect(manifest).toMatchObject({ name: "SplittingWisdom", display: "standalone", start_url: "/", scope: "/" });
    const purposes = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
    expect(purposes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await swActive(page);
  });

  test("never caches /api responses (money data must stay live)", async ({ page }) => {
    await page.goto(`${PRIMARY}/login`);
    await swActive(page);
    await page.reload();
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
      }
      return urls;
    });
    expect(cached.some((p) => p.startsWith("/api/"))).toBe(false);
    expect(cached).toContain("/index.html");
  });

  test("app shell opens offline and says so instead of showing a browser error", async ({ page, context }) => {
    await page.goto(`${PRIMARY}/login`);
    await swActive(page);
    await page.reload(); // let the active worker take control
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: /Log in to SplittingWisdom/ })).toBeVisible();
    await expect(page.getByText(/You're offline/)).toBeVisible();
    // Offline is the phone's problem, not the server's: it must NOT redirect to the backup.
    expect(page.url()).toContain(new URL(PRIMARY).host);
    await context.setOffline(false);
  });
});

/** The failover logic is compiled into the client; check this build actually has it. */
async function buildHasFailoverConfig(): Promise<boolean> {
  const html = await fetch(`${PRIMARY}/index.html`).then((r) => r.text());
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (!script) return false;
  const js = await fetch(`${PRIMARY}${script}`).then((r) => r.text());
  return js.includes(new URL(STANDBY).origin);
}

test.describe("failover and failback", () => {
  test.skip(!PIDFILE || !START_CMD, "needs E2E_PRIMARY_API_PIDFILE and E2E_PRIMARY_API_START");

  // Whatever happens, never leave the primary stopped for the specs after this one.
  test.afterEach(async () => {
    const up = await fetch(`${PRIMARY}/api/health`).then((r) => r.ok).catch(() => false);
    if (!up) {
      execSync(START_CMD!, { stdio: "ignore" });
      await waitForHealth(PRIMARY, true, 45_000);
    }
  });

  test("primary down -> opens backup; back up -> returns; no ping-pong", async ({ page }) => {
    test.skip(!(await buildHasFailoverConfig()), `client build lacks VITE_PRIMARY_URL=${PRIMARY} / VITE_STANDBY_URL=${STANDBY}; rebuild with them (scripts/e2e-local.sh does)`);
    await waitForHealth(PRIMARY, true);
    await waitForHealth(STANDBY, true);

    // Installed copy has run before, so the shell is cached.
    await page.goto(`${PRIMARY}/login`);
    await swActive(page);
    await expect(page.getByText(/Backup mode/)).toHaveCount(0);

    // --- outage -------------------------------------------------------------
    stopPrimaryApi();
    await waitForHealth(PRIMARY, false);
    await page.evaluate(() => localStorage.removeItem("splittingwisdom-last-switch"));
    await page.reload();
    await expect(page.getByText(/Main server unreachable — opening the backup app/)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(`${STANDBY}/login`, { timeout: 15_000 });
    await expect(page.getByText(/Backup mode/)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Log in to SplittingWisdom/ })).toBeVisible();

    // --- recovery -----------------------------------------------------------
    execSync(START_CMD!, { stdio: "ignore" });
    await waitForHealth(PRIMARY, true, 45_000);

    // Just switched <5 min ago: a cold launch must NOT bounce straight back.
    await page.reload();
    await page.waitForTimeout(3000);
    expect(page.url()).toContain(new URL(STANDBY).host);

    // After the guard window (simulated), a cold launch returns to the main server.
    await page.evaluate(() => localStorage.removeItem("splittingwisdom-last-switch"));
    await page.reload();
    await expect(page.getByText(/Main server is back — switching/)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(`${PRIMARY}/login`, { timeout: 15_000 });
    await expect(page.getByText(/Backup mode/)).toHaveCount(0);
  });
});
