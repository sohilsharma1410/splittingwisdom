/**
 * Receipt scan -> review -> confirm (plan D3). Runs against an API whose OCR points at the fake
 * local vision model (scripts/fake-vision-model.mjs), so it needs no key and costs nothing.
 *   E2E_PRIMARY_URL  app under test (default http://localhost:4273)
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4273";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const uid = () => Math.random().toString(36).slice(2, 8);
const READABLE = Buffer.alloc(400, 7); // "a photo" the fake model can read
const UNREADABLE = Buffer.alloc(50, 7); // the fake model answers with prose

async function call(ctx: APIRequestContext, method: "get" | "post", path: string, data?: unknown) {
  const res = await ctx[method](`${BASE}${path}`, { data, headers: { "X-Forwarded-For": ip() } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Me (the page) + Pal in a group "Dinner crew". */
async function scene(page: Page, playwright: { request: { newContext: () => Promise<APIRequestContext> } }) {
  const id = uid();
  const pal = await playwright.request.newContext();
  const me = await call(page.request, "post", "/api/auth/register", { email: `e2e-sc-${id}@example.com`, displayName: "Scan Me", password: "e2e-password-1" });
  const other = await call(pal, "post", "/api/auth/register", { email: `e2e-sp-${id}@example.com`, displayName: "Scan Pal", password: "e2e-password-1" });
  const g = await call(page.request, "post", "/api/groups", { name: `Dinner crew ${id}` });
  const groupId = g.body.data.group.id as number;
  await call(page.request, "post", `/api/groups/${groupId}/members`, { userId: other.body.data.user.id });
  return { groupId, pal, myId: me.body.data.user.id as number };
}

const upload = (page: Page, buffer: Buffer, label = "Choose a receipt photo") =>
  page.getByLabel(label).setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer });

test("scan -> review -> confirm: everything read is editable, the total adds up, and it becomes a real bill", async ({ page, playwright }) => {
  const { groupId, pal } = await scene(page, playwright);
  await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
  await upload(page, READABLE);

  // Review screen: 16 items, charges, and the receipt's own total agrees with ours.
  await expect(page.getByRole("heading", { name: "Items" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("listitem").filter({ has: page.getByLabel(/Item \d+ name/) })).toHaveCount(16);
  await expect(page.getByLabel("Item 1 name")).toHaveValue("Vodka Prawns");
  await expect(page.getByLabel("Item 11 quantity")).toHaveValue("11"); // Appam ×11…
  await expect(page.getByLabel("Item 11 price")).toHaveValue("550.00"); // …₹550 is the line total
  await expect(page.getByLabel("Bill name")).toHaveValue("Ganbei Restaurant Pvt Ltd");
  await expect(page.getByLabel("Round-off (use − for a minus)")).toHaveValue("-0.18");
  await expect(page.getByTestId("scan-total")).toHaveText("₹8,147.00");
  await expect(page.getByRole("alert", { name: "Totals don't match" })).toHaveCount(0);
  await expect(page.getByText(/Read by fake-vision/)).toBeVisible();

  // The one line the model was unsure about is flagged with words and an icon, and summarised at the top.
  await expect(page.getByRole("region", { name: "Needs review" })).toContainText("Chicken Pal Curry");
  await expect(page.getByText("Please check this line")).toHaveCount(1);

  // Editing a price breaks the sum: the banner states the exact gap, and one tap reconciles it.
  await page.getByLabel("Item 1 price").fill("700");
  await expect(page.getByTestId("scan-total")).toHaveText("₹8,188.00");
  const banner = page.getByRole("alert", { name: "Totals don't match" });
  await expect(banner).toContainText("off by ₹41.00");
  await banner.getByRole("button", { name: "Treat the difference as round-off" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("scan-total")).toHaveText("₹8,147.00");
  await page.getByLabel("Item 1 price").fill("659"); // put it back; the round-off now over-corrects…
  await page.getByLabel("Round-off (use − for a minus)").fill("-0.18");
  await expect(page.getByTestId("scan-total")).toHaveText("₹8,147.00");

  // Confirm: lands on the bill, with the photo attached and the right money.
  await page.getByRole("button", { name: "Confirm bill" }).click();
  await page.waitForURL(/\/bill\/\d+$/);
  const billId = Number(page.url().split("/").pop());
  const bill = (await call(page.request, "get", `/api/bills/${billId}`)).body.data.bill;
  expect(bill.grandTotal).toBe(814700);
  expect(bill.items).toHaveLength(16);
  expect(bill.hasReceipt).toBe(true);
  expect(bill.items.find((i: { name: string }) => i.name.startsWith("Appam")).price).toBe(55000);
  // Split equally between both people: each owes half of the total, to the cent.
  const mine = bill.breakdown.map((b: { total: number }) => b.total).sort((a: number, b: number) => a - b);
  expect(mine.reduce((s: number, t: number) => s + t, 0)).toBe(814700);
  expect(Math.abs(mine[0] - mine[1])).toBeLessThanOrEqual(16); // rounding paise across 16 items
  // The photo is viewable by members and by no one else.
  expect((await call(page.request, "get", `/api/bills/${billId}/receipt-url`)).status).toBe(200);
  expect((await call(pal, "get", `/api/bills/${billId}/receipt-url`)).status).toBe(200); // the other member
  const stranger = await playwright.request.newContext();
  await call(stranger, "post", "/api/auth/register", { email: `e2e-st-${uid()}@example.com`, displayName: "Stranger", password: "e2e-password-1" });
  expect((await call(stranger, "get", `/api/bills/${billId}/receipt-url`)).status).toBe(404);
});

test("an unreadable photo falls back to manual entry, keeping the photo", async ({ page, playwright }) => {
  const { groupId } = await scene(page, playwright);
  await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
  await upload(page, UNREADABLE);

  await expect(page.getByRole("alert").filter({ hasText: "Couldn't read this receipt" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Item 1 name")).toHaveValue(""); // one blank row to start from

  // Confirm with nothing filled in says what's missing, in plain words.
  await page.getByRole("button", { name: "Confirm bill" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Give the bill a name" })).toBeVisible();

  await page.getByLabel("Bill name").fill("Chai stop");
  await page.getByLabel("Item 1 name").fill("Masala chai");
  await page.getByLabel("Item 1 price").fill("40");
  await page.getByRole("button", { name: "Confirm bill" }).click();
  await page.waitForURL(/\/bill\/\d+$/);
  const bill = (await call(page.request, "get", `/api/bills/${page.url().split("/").pop()}`)).body.data.bill;
  expect(bill.grandTotal).toBe(4000);
  expect(bill.hasReceipt).toBe(true);
});

test("the New Bill dialog offers 'Scan a receipt instead' and keeps the group you were in", async ({ page, playwright }) => {
  const { groupId } = await scene(page, playwright);
  await page.goto(`${BASE}/group/${groupId}`);
  await page.getByRole("button", { name: "Add Bill" }).first().click();
  await page.getByRole("button", { name: "Scan a receipt instead" }).click();
  await page.waitForURL(`${BASE}/bill/new/scan?group=${groupId}`);
  await expect(page.getByRole("heading", { name: "Scan a receipt" })).toBeVisible();
});

test("a stranger's photo path can't be attached to your bill", async ({ page, playwright }) => {
  const { groupId, myId } = await scene(page, playwright);
  const members = (await call(page.request, "get", `/api/groups/${groupId}`)).body.data.group.members as { id: number; userId: number }[];
  const me = members.find((m) => m.userId === myId)!.id;
  const base = {
    groupId, description: "x", billDate: new Date().toISOString().slice(0, 10), subtotalAmount: 1000, taxAmount: 0, tipAmount: 0,
    serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: me,
    items: [{ name: "x", price: 1000, quantity: 1, assignments: [{ memberId: me, splitType: "equal" }] }],
  };
  expect((await call(page.request, "post", "/api/bills", { ...base, receiptImageUrl: "999999/abcdefghijklmnop.jpg" })).status).toBe(400);
  expect((await call(page.request, "post", "/api/bills", { ...base, receiptImageUrl: "../../etc/passwd" })).status).toBe(400);
});

for (const theme of ["light", "dark"] as const) {
  test(`the review screen has no serious accessibility violations (${theme}, 360px)`, async ({ browser, playwright }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript((t) => localStorage.setItem("splittingwisdom-theme", t), theme);
    const page = await context.newPage();
    const { groupId } = await scene(page, playwright);
    await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
    await upload(page, READABLE);
    await page.getByRole("heading", { name: "Items" }).waitFor({ timeout: 15_000 });
    await page.getByLabel("Item 1 price").fill("700"); // also show the mismatch banner
    await expect(page.getByRole("alert", { name: "Totals don't match" })).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });
}
