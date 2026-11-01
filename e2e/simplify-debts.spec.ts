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

  // Paying "Ann pays Cat" is recorded as the chain it stands for (Ann→Bob and Bob→Cat), so the
  // Direct view is clean too: no leftover "Cat pays Ann"-style offsetting entries.
  await expect(section).toHaveCount(0);
  const direct = await call(bob, "get", `/api/groups/${groupId}`);
  expect(direct.body.data.group.debts).toEqual([]);

  // Everyone's overall position is now exactly zero.
  for (const ctx of [page.request, bob, cat]) {
    const r = await call(ctx, "get", "/api/balances");
    expect(r.body.data.netBalance).toBe(0);
    expect(r.body.data.unsettledCount).toBe(0);
  }
  // Two real settlements, each explaining itself; the bills were never rewritten.
  const hist = await call(bob, "get", `/api/settlements?groupId=${groupId}`);
  const rows = hist.body.data.settlements as { payerName: string; recipientName: string; amount: number; note: string }[];
  expect(rows.map((r) => `${r.payerName}>${r.recipientName}:${r.amount}`).sort()).toEqual(["Ann Person>Bob Person:10000", "Bob Person>Cat Person:10000"]);
  expect(rows.every((r) => r.note.includes("Simplified payment: Ann Person paid Cat Person"))).toBe(true);
  const bills = await call(bob, "get", "/api/bills");
  expect(bills.body.data.bills.every((b: { status: string }) => b.status === "settled")).toBe(true);
});

test("a long chain (Ann→Bob→Cat→Dan) paid in one simplified payment leaves the Direct tab empty", async ({ page, playwright }) => {
  const id = uid();
  const ctxs = { bob: await playwright.request.newContext(), cat: await playwright.request.newContext(), dan: await playwright.request.newContext() };
  const reg = (ctx: APIRequestContext, who: string) =>
    call(ctx, "post", "/api/auth/register", { email: `e2e-${who}-${id}@example.com`, displayName: `${who[0].toUpperCase()}${who.slice(1)} Person`, password: "e2e-password-1" });
  const ann = await reg(page.request, "ann");
  const u = { bob: await reg(ctxs.bob, "bob"), cat: await reg(ctxs.cat, "cat"), dan: await reg(ctxs.dan, "dan") };
  const groupId = (await call(ctxs.bob, "post", "/api/groups", { name: `Long ${id}` })).body.data.group.id;
  for (const w of [ann, u.cat, u.dan]) await call(ctxs.bob, "post", `/api/groups/${groupId}/members`, { userId: w.body.data.user.id });
  const members = (await call(ctxs.bob, "get", `/api/groups/${groupId}`)).body.data.group.members as { id: number; userId: number }[];
  const m = (x: { body: { data: { user: { id: number } } } }) => members.find((y) => y.userId === x.body.data.user.id)!.id;
  const bill = (ctx: APIRequestContext, payer: number, who: number[]) =>
    call(ctx, "post", "/api/bills", {
      groupId, description: "chain", billDate: new Date().toISOString().slice(0, 10),
      subtotalAmount: 20000, taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: payer,
      items: [{ name: "Shared", price: 20000, quantity: 1, assignments: who.map((memberId) => ({ memberId, splitType: "equal" })) }],
    });
  await bill(ctxs.bob, m(u.bob), [m(ann), m(u.bob)]); // Ann owes Bob 100
  await bill(ctxs.cat, m(u.cat), [m(u.bob), m(u.cat)]); // Bob owes Cat 100
  await bill(ctxs.dan, m(u.dan), [m(u.cat), m(u.dan)]); // Cat owes Dan 100

  await page.goto(`${BASE}/group/${groupId}`);
  const section = page.locator("#settle-up");
  await section.getByRole("button", { name: "Simplified" }).click();
  await expect(section).toContainText("3 debts simplified to 1 payment");
  await section.getByRole("button", { name: /Settle .* with Dan Person/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5000 });

  // The reported bug: the Direct tab used to still show "You pay Bob ₹100" and "Dan pays you ₹100".
  await expect(section).toHaveCount(0);
  const g = await call(page.request, "get", `/api/groups/${groupId}`);
  expect(g.body.data.group.debts).toEqual([]);
  expect((await call(page.request, "get", "/api/balances")).body.data.netBalance).toBe(0);
  for (const ctx of Object.values(ctxs)) expect((await call(ctx, "get", "/api/balances")).body.data.netBalance).toBe(0);
});
