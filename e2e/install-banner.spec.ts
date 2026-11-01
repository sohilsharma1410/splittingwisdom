/**
 * Install UX (plan D1.3): Android install button, iPhone "Add to Home Screen"
 * hint, dismissal that sticks.
 *   E2E_PRIMARY_URL  the app under test (default http://localhost:4173)
 *   E2E_SHOTS        optional dir; if set, screenshots are written there
 * Registers a throwaway user through the API (unique client IP per run so the
 * auth rate limiters never interfere).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4173";
const SHOTS = process.env.E2E_SHOTS;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

async function mobilePage(browser: Browser, userAgent?: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ...(userAgent ? { userAgent } : {}),
  });
  return { context, page: await context.newPage() };
}

async function signUp(page: Page) {
  const id = Math.random().toString(36).slice(2, 8);
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const res = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "X-Forwarded-For": ip },
    data: { email: `e2e-${id}@example.com`, displayName: "E2E Tester", password: "e2e-password-1" },
  });
  expect(res.status()).toBe(201);
}

test("iPhone: shows the Add to Home Screen hint once and remembers dismissal", async ({ browser }) => {
  const { context, page } = await mobilePage(browser, IPHONE_UA);
  await signUp(page);
  await page.goto(`${BASE}/`);
  const banner = page.getByRole("region", { name: "Install the app" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Add to Home Screen");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/install-ios.png` });

  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(banner).toBeHidden();
  await context.close();
});

test("Android: shows an Install button when Chrome offers installation, then hides it", async ({ browser }) => {
  const { context, page } = await mobilePage(browser);
  await signUp(page);
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  const banner = page.getByRole("region", { name: "Install the app" });
  await expect(banner).toBeHidden(); // nothing to offer until Chrome fires beforeinstallprompt

  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    e.prompt = async () => {};
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  await expect(banner).toContainText("Install SplittingWisdom");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/install-android.png` });
  await banner.getByRole("button", { name: "Install" }).click();
  await expect(banner).toBeHidden();
  await context.close();
});
