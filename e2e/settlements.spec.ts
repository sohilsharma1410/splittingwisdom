/**
 * Settlements UI E2E (plan D2 / Phase 6 checklist).
 *   E2E_PRIMARY_URL  app under test (default http://localhost:4173)
 * Creates throwaway users/groups through the API (unique client IP per run so
 * the auth rate limiters never interfere), then drives the UI as the debtor.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4173";

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const uid = () => Math.random().toString(36).slice(2, 8);

async function call(ctx: APIRequestContext, method: "get" | "post", path: string, data?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx[method](`${BASE}${path}`, { data, headers: { "X-Forwarded-For": ip(), ...headers } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Alice paid ₹700.00 for two; Bob (the page's user) owes her ₹350.00. */
async function scenario(page: Page, playwright: { request: { newContext: () => Promise<APIRequestContext> } }) {
  const id = uid();
  const alice = await playwright.request.newContext();
  const a = await call(alice, "post", "/api/auth/register", { email: `e2e-a-${id}@example.com`, displayName: "Alice Payer", password: "e2e-password-1" });
  const b = await call(page.request, "post", "/api/auth/register", { email: `e2e-b-${id}@example.com`, displayName: "Bob Debtor", password: "e2e-password-1" });
  const g = await call(alice, "post", "/api/groups", { name: `E2E ${id}` });
  const groupId = g.body.data.group.id;
  await call(alice, "post", `/api/groups/${groupId}/members`, { userId: b.body.data.user.id });
  const detail = await call(alice, "get", `/api/groups/${groupId}`);
  const members = detail.body.data.group.members as { id: number; userId: number }[];
  const mA = members.find((m) => m.userId === a.body.data.user.id)!.id;
  const mB = members.find((m) => m.userId === b.body.data.user.id)!.id;
  await call(alice, "post", "/api/bills", {
    groupId, description: "E2E dinner", billDate: new Date().toISOString().slice(0, 10),
    subtotalAmount: 70000, taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: mA,
    items: [{ name: "Thali", price: 70000, quantity: 1, assignments: [{ memberId: mA, splitType: "equal" }, { memberId: mB, splitType: "equal" }] }],
  });
  return { alice, groupId, aliceId: a.body.data.user.id as number };
}

test("settle part of a balance from the list: cap, partial payment, instant refresh, history", async ({ page, playwright }) => {
  const { alice, groupId, aliceId } = await scenario(page, playwright);
  await page.goto(`${BASE}/balances`);

  const row = page.getByRole("link", { name: /View balance with Alice Payer/ }).locator("..");
  await expect(row).toContainText("₹350.00");
  await row.getByRole("button", { name: /Pay Alice Payer/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("You are paying");
  await expect(dialog).toContainText("Alice Payer");
  await expect(dialog.getByLabel("Amount (₹)")).toHaveValue("350.00"); // pre-filled with the full outstanding

  // Hard cap: more than owed is blocked in the UI before it ever reaches the server.
  await dialog.getByLabel("Amount (₹)").fill("400");
  await expect(dialog.getByRole("alert")).toContainText("more than is owed");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await dialog.getByLabel("Amount (₹)").fill("0");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();

  // Partial: ₹150 of ₹350.
  await dialog.getByLabel("Amount (₹)").fill("150");
  await expect(dialog).toContainText("₹200.00 will still be outstanding");
  await dialog.getByLabel("Note (optional)").fill("UPI part 1");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByText("Payment recorded")).toBeVisible();
  await expect(dialog).toBeHidden({ timeout: 5000 }); // auto-closes

  // Every surface refreshed with no manual reload.
  await expect(row).toContainText("₹200.00");
  await expect(row).not.toContainText("₹350.00");

  // Balance detail: math line and history.
  await row.getByRole("link", { name: /View balance/ }).click();
  await expect(page.getByTestId("balance-math")).toContainText("Bills ₹350.00 you owe − settled ₹150.00 → outstanding ₹200.00");
  const history = page.getByRole("listitem").filter({ hasText: "You paid Alice Payer" });
  await expect(history).toContainText("₹150.00");
  await expect(history).toContainText("“UPI part 1”");

  // Settle the rest from here → pair is settled.
  await page.getByRole("button", { name: /Pay Alice Payer/ }).click();
  await expect(page.getByRole("dialog").getByLabel("Amount (₹)")).toHaveValue("200.00");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Settled up").first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("balance-math")).toContainText("settled up");

  const hist = await call(alice, "get", `/api/settlements?groupId=${groupId}`);
  expect(hist.body.data.settlements.map((s: { amount: number }) => s.amount).sort()).toEqual([15000, 20000]);
  const bills = await call(alice, "get", "/api/bills");
  expect(bills.body.data.bills[0].status).toBe("settled");
  expect(aliceId).toBeGreaterThan(0);
});

test("double-tapping Confirm records exactly one payment", async ({ page, playwright }) => {
  const { alice, groupId } = await scenario(page, playwright);
  await page.goto(`${BASE}/balances`);
  await page.getByRole("button", { name: /Pay Alice Payer/ }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: "Confirm" });
  await confirm.dblclick();
  await page.getByRole("dialog").getByText("Payment recorded").waitFor();
  const hist = await call(alice, "get", `/api/settlements?groupId=${groupId}`);
  expect(hist.body.data.settlements).toHaveLength(1);
  expect(hist.body.data.settlements[0].amount).toBe(35000);
});

test("dashboard offers Settle too, and a settled person disappears from the outstanding list", async ({ page, playwright }) => {
  await scenario(page, playwright);
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: /Pay Alice Payer/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5000 });
  await expect(page.getByRole("button", { name: /Pay Alice Payer/ })).toHaveCount(0);
  await expect(page.getByText("All settled up")).toBeVisible();
});

test("balances list has no horizontal overflow at 360px", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await scenario(page, { request: { newContext: () => context.browser()!.newContext().then((c) => c.request) } });
  await page.goto(`${BASE}/balances`);
  await expect(page.getByRole("button", { name: /Pay Alice Payer/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/balances-360.png` });
  await context.close();
});
