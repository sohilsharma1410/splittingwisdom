/**
 * Onboarding (SPEC §6) and motion (SPEC §19) E2E.
 *   E2E_PRIMARY_URL  app under test (default http://localhost:4173)
 */
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4173";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function newUser(page: Page) {
  const id = Math.random().toString(36).slice(2, 8);
  const res = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "X-Forwarded-For": ip() },
    data: { email: `e2e-ob-${id}@example.com`, displayName: "Onboard Tester", password: "e2e-password-1" },
  });
  expect(res.status()).toBe(201);
}

test.describe("onboarding", () => {
  test("a brand-new user sees the three steps with both CTAs", async ({ page }) => {
    await newUser(page);
    await page.goto(`${BASE}/`);
    const card = page.getByRole("region", { name: "Welcome to SplittingWisdom" });
    await expect(card).toBeVisible();
    const steps = card.getByRole("listitem");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("Add a bill");
    await expect(steps.nth(1)).toContainText("Assign items");
    await expect(steps.nth(2)).toContainText("Track and settle");
    await expect(card.getByRole("button", { name: "Add your first bill" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Create a group" })).toBeVisible();
  });

  test("CTAs open the bill form and the create-group dialog", async ({ page }) => {
    await newUser(page);
    await page.goto(`${BASE}/`);
    const card = page.getByRole("region", { name: "Welcome to SplittingWisdom" });
    await card.getByRole("button", { name: "Create a group" }).click();
    await expect(page.getByRole("dialog")).toContainText(/group/i);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await card.getByRole("button", { name: "Add your first bill" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("Skip is remembered: the card never comes back, the plain empty state stays", async ({ page }) => {
    await newUser(page);
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("region", { name: "Welcome to SplittingWisdom" })).toBeHidden();
    await expect(page.getByText("Your dashboard is empty for now")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Your dashboard is empty for now")).toBeVisible();
    await expect(page.getByRole("region", { name: "Welcome to SplittingWisdom" })).toHaveCount(0);
  });

  test("people who already have a group never see it", async ({ page }) => {
    await newUser(page);
    const g = await page.request.post(`${BASE}/api/groups`, { headers: { "X-Forwarded-For": ip() }, data: { name: "Existing" } });
    expect(g.status()).toBe(201);
    await page.goto(`${BASE}/`);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Welcome to SplittingWisdom" })).toHaveCount(0);
  });
});

test.describe("motion", () => {
  const animationOf = (page: Page) =>
    page.evaluate(() => {
      const el = document.querySelector('[role="dialog"]')!;
      const cs = getComputedStyle(el);
      return { name: cs.animationName, ms: parseFloat(cs.animationDuration) * 1000 };
    });

  test("dialogs slide up on mobile and fade/scale on desktop", async ({ browser }) => {
    for (const [label, size, expected] of [["mobile", { width: 390, height: 844 }, "sheet-up"], ["desktop", { width: 1280, height: 800 }, "pop-in"]] as const) {
      const context = await browser.newContext({ viewport: size });
      const page = await context.newPage();
      await newUser(page);
      await page.goto(`${BASE}/`);
      await page.getByRole("button", { name: "Create a group" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const anim = await animationOf(page);
      expect(anim.name, label).toContain(expected);
      expect(anim.ms, label).toBeGreaterThan(50);
      await context.close();
    }
  });

  test("reduced motion removes the animation but dialogs still open and close", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await newUser(page);
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: "Create a group" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect((await animationOf(page)).ms).toBeLessThan(5);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await context.close();
  });

  test("cards lift on hover and the page content fades in", async ({ page }) => {
    await newUser(page);
    const g = await page.request.post(`${BASE}/api/groups`, { headers: { "X-Forwarded-For": ip() }, data: { name: "Lift me" } });
    expect(g.status()).toBe(201);
    await page.goto(`${BASE}/groups`);
    const main = page.locator("main");
    expect(await main.evaluate((el) => getComputedStyle(el).animationName)).toContain("page-in");
    const card = page.getByRole("link", { name: /Lift me/ });
    await card.hover();
    await expect.poll(() => card.evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
  });
});

test.describe("theme", () => {
  test("dark mode paints dark from the first frame (no flash of the light theme)", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    // Normal motion on purpose: the flash was a colour *transition* from light to dark.
    for (const path of ["/login", "/register"]) {
      await page.goto(`${BASE}${path}`);
      await page.getByRole("heading").first().waitFor();
      const colors = await page.evaluate(() => ({
        text: getComputedStyle(document.querySelector("h1")!).color,
        page: getComputedStyle(document.body).backgroundColor,
        cls: document.documentElement.className,
      }));
      expect(colors, path).toEqual({ text: "rgb(236, 240, 243)", page: "rgb(19, 28, 36)", cls: "dark" });
    }
    await context.close();
  });

  test("an explicit light choice beats a dark OS, and an explicit dark choice beats a light OS", async ({ browser }) => {
    for (const [os, stored, expectDark] of [["dark", "light", false], ["light", "dark", true]] as const) {
      const context = await browser.newContext({ colorScheme: os });
      await context.addInitScript((t) => localStorage.setItem("splittingwisdom-theme", t), stored);
      const page = await context.newPage();
      await page.goto(`${BASE}/login`);
      await page.getByRole("heading").first().waitFor();
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark")), `${os} OS, stored ${stored}`).toBe(expectDark);
      await context.close();
    }
  });
});
