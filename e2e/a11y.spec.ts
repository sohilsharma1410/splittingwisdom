/**
 * Automated accessibility sweep (axe-core) across the main screens in light
 * and dark themes, desktop and a 360px phone. Fails on serious/critical
 * violations — including colour contrast. Automated checks catch a good share
 * of problems, not all: keyboard and screen-reader passes stay manual (QA-10).
 *   E2E_PRIMARY_URL  app under test (default http://localhost:4173)
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4173";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const id = () => Math.random().toString(36).slice(2, 8);

async function call(ctx: APIRequestContext, method: "get" | "post", path: string, data?: unknown) {
  const res = await ctx[method](`${BASE}${path}`, { data, headers: { "X-Forwarded-For": ip() } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function seed(page: Page, playwright: { request: { newContext: () => Promise<APIRequestContext> } }) {
  const k = id();
  const other = await playwright.request.newContext();
  const me = await call(page.request, "post", "/api/auth/register", { email: `e2e-ax-${k}@example.com`, displayName: "Axe Tester", password: "e2e-password-1" });
  const them = await call(other, "post", "/api/auth/register", { email: `e2e-ay-${k}@example.com`, displayName: "Other Person", password: "e2e-password-1" });
  const g = await call(other, "post", "/api/groups", { name: `A11y ${k}` });
  const groupId = g.body.data.group.id as number;
  await call(other, "post", `/api/groups/${groupId}/members`, { userId: me.body.data.user.id });
  const members = (await call(other, "get", `/api/groups/${groupId}`)).body.data.group.members as { id: number; userId: number }[];
  const mMe = members.find((m) => m.userId === me.body.data.user.id)!.id;
  const mThem = members.find((m) => m.userId === them.body.data.user.id)!.id;
  const b = await call(other, "post", "/api/bills", {
    groupId, description: "Axe dinner", billDate: new Date().toISOString().slice(0, 10),
    subtotalAmount: 30000, taxAmount: 1500, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: mThem,
    items: [{ name: "Biryani", price: 30000, quantity: 1, assignments: [{ memberId: mMe, splitType: "equal" }, { memberId: mThem, splitType: "equal" }] }],
  });
  return { groupId, billId: b.body.data.bill.id as number, otherUserId: them.body.data.user.id as number };
}

// Collected across every screen so one run lists everything that's wrong,
// instead of stopping at the first screen with a problem.
async function scan(page: Page, label: string, found: string[]) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  for (const v of violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
    for (const node of v.nodes) {
      found.push(`${label} | ${v.id} (${v.impact}) | ${node.target.join(" ")} | ${(node.any[0]?.message ?? node.failureSummary ?? "").split("\n")[0].slice(0, 140)}`);
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone-360", { width: 360, height: 740 }]] as const) {
    test(`no serious a11y violations — ${theme}, ${device}`, async ({ browser, playwright }) => {
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce" });
      await context.addInitScript((t) => localStorage.setItem("splittingwisdom-theme", t), theme);
      const page = await context.newPage();
      const found: string[] = [];

      // logged-out screens
      for (const path of ["/login", "/register"]) {
        await page.goto(`${BASE}${path}`);
        await page.getByRole("heading").first().waitFor();
        await scan(page, `${path}`, found);
      }

      // brand-new user: onboarding
      const { groupId, billId, otherUserId } = await seed(page, playwright);
      await page.goto(`${BASE}/`);
      await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
      await scan(page, "dashboard", found);

      for (const [name, path] of [
        ["groups", "/groups"],
        ["group detail + settle up", `/group/${groupId}`],
        ["activity", "/activity"],
        ["balances", "/balances"],
        ["balance detail", `/balance/u-${otherUserId}`],
        ["bill detail", `/bill/${billId}`],
      ] as const) {
        await page.goto(`${BASE}${path}`);
        await page.getByRole("heading").first().waitFor();
        await page.waitForLoadState("networkidle");
        await scan(page, name, found);
      }

      // the settle dialog (contains the form, the cap error and focus trap)
      await page.goto(`${BASE}/balances`);
      await page.getByRole("button", { name: /Settle with Other Person/ }).click();
      await page.getByRole("dialog").getByLabel("Amount (₹)").fill("9999");
      await scan(page, "settle dialog with error", found);
      await context.close();
      expect(found, `${found.length} violation(s) — ${theme}, ${device}\n${found.join("\n")}`).toEqual([]);
    });
  }
}
