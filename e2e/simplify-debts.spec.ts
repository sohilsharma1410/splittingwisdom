/**
 * Debt simplification E2E (plan D2.4 / Phase 6 checklist: "following the
 * suggested payments actually settles everyone"). Builds a real chain —
 * Ann owes Bob ₹100, Bob owes Cat ₹100 — and walks the UI as Ann.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4173";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const uid = () => Math.random().toString(36).slice(2, 8);

async function call(ctx: APIRequestContext, method: "get" | "post", path: string, data?: unknown) {
  const res = await ctx[method](`${BASE}${path}`, { data, headers: { "X-Forwarded-For": ip() } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

test("simplified view cuts 2 debts to 1; paying it settles everyone overall", async ({ page, playwright }) => {
  const id = uid();
  const bob = await playwright.request.newContext();
  const cat = await playwright.request.newContext();
  const reg = (ctx: APIRequestContext, who: string) =>
    call(ctx, "post", "/api/auth/register", { email: `e2e-${who}-${id}@example.com`, displayName: `${who[0].toUpperCase()}${who.slice(1)} Person`, password: "e2e-password-1" });
  const ann = await reg(page.request, "ann");
  const b = await reg(bob, "bob");
  const c = await reg(cat, "cat");

  const g = await call(bob, "post", "/api/groups", { name: `Chain ${id}` });
  const groupId = g.body.data.group.id;
  await call(bob, "post", `/api/groups/${groupId}/members`, { userId: ann.body.data.user.id });
  await call(bob, "post", `/api/groups/${groupId}/members`, { userId: c.body.data.user.id });
  const members = (await call(bob, "get", `/api/groups/${groupId}`)).body.data.group.members as { id: number; userId: number }[];
  const m = (u: { body: { data: { user: { id: number } } } }) => members.find((x) => x.userId === u.body.data.user.id)!.id;
  const [mAnn, mBob, mCat] = [m(ann), m(b), m(c)];

  const billOf = (payer: number, who: number[], description: string, ctx: APIRequestContext) =>
    call(ctx, "post", "/api/bills", {
      groupId, description, billDate: new Date().toISOString().slice(0, 10),
      subtotalAmount: 20000, taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: payer,
      items: [{ name: "Shared", price: 20000, quantity: 1, assignments: who.map((memberId) => ({ memberId, splitType: "equal" })) }],
    });
  expect((await billOf(mBob, [mAnn, mBob], "Bob paid for Ann", bob)).status).toBe(201); // Ann owes Bob ₹100
  expect((await billOf(mCat, [mBob, mCat], "Cat paid for Bob", cat)).status).toBe(201); // Bob owes Cat ₹100

  // --- Balances page points at the group ---------------------------------------
  await page.goto(`${BASE}/balances`);
  const hint = page.getByRole("region", { name: "Fewer payments possible" });
  await expect(hint).toContainText(`Chain ${id}`);
  await expect(hint).toContainText("2 debts → 1 payment");
  await hint.getByRole("link").click();

  // --- group page: simplified view is selected on arrival; direct is the real ledger
  const section = page.locator("#settle-up");
  await expect(section.getByRole("button", { name: "Simplified" })).toHaveAttribute("aria-pressed", "true");
  await expect(section).toContainText("2 debts simplified to 1 payment");
  await expect(section.getByRole("listitem")).toHaveCount(1);
  await expect(section.getByRole("listitem")).toContainText("You pay Cat Person");
  await expect(section.getByRole("listitem")).toContainText("₹100.00");

  await section.getByRole("button", { name: "Direct" }).click();
  await expect(section.getByRole("listitem")).toHaveCount(2); // today's real pairs are untouched
  await expect(section).toContainText("You pay Bob Person");
  await expect(section).toContainText("Bob Person pays Cat Person");
  await expect(section.getByRole("button", { name: /Settle .* with Bob Person/ })).toBeVisible();
  // Bob→Cat doesn't involve Ann: she can see it but only the parties can record it.
  await expect(section.getByRole("listitem").filter({ hasText: "Bob Person pays Cat Person" }).getByRole("button")).toHaveCount(0);

  if (process.env.E2E_SHOTS) {
    await section.getByRole("button", { name: "Simplified" }).click();
    await section.screenshot({ path: `${process.env.E2E_SHOTS}/settle-up-simplified.png` });
  }

  // --- follow the suggestion ------------------------------------------------------
  await section.getByRole("button", { name: "Simplified" }).click();
  await section.getByRole("button", { name: /Settle .* with Cat Person/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("You are paying");
  await expect(dialog).toContainText("Cat Person");
  await expect(dialog.getByLabel("Amount (₹)")).toHaveValue("100.00");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden({ timeout: 5000 });

  // Nothing left to pay overall, and the page says so without a reload.
  await expect(section).toContainText("Everyone is settled overall");

  // Everyone's overall position is now exactly zero.
  for (const ctx of [page.request, bob, cat]) {
    const r = await call(ctx, "get", "/api/balances");
    expect(r.body.data.netBalance).toBe(0);
  }
  // The bills and ledger were never rewritten — only a payment was added.
  const hist = await call(bob, "get", `/api/settlements?groupId=${groupId}`);
  expect(hist.body.data.settlements).toHaveLength(1);
  expect(hist.body.data.settlements[0]).toMatchObject({ payerName: "Ann Person", recipientName: "Cat Person", amount: 10000 });
});
