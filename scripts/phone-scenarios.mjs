#!/usr/bin/env node
// Adds one fresh group per simplify-debts scenario to a running phone lab, each
// with a KNOWN expected result written in its name. Idempotent per run: it
// creates new groups every time. Throwaway DB only.
//   BASE_URL=http://localhost:4100 node scripts/phone-scenarios.mjs
const BASE = (process.env.BASE_URL ?? "http://localhost:4100").replace(/\/$/, "");
const PASSWORD = "demo-pass-123";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(c, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip(), ...(c.v ? { Cookie: c.v } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const s of res.headers.getSetCookie?.() ?? []) if (s.startsWith("connect.sid=")) c.v = s.split(";")[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const P = {};
for (const [k, name] of [["ann", "Ann"], ["bob", "Bob"], ["cat", "Cat"], ["dan", "Dan"]]) {
  const c = {}; const email = `demo-${k}@example.com`;
  let r = await call(c, "POST", "/api/auth/register", { email, displayName: name, password: PASSWORD });
  if (r.status === 409) r = await call(c, "POST", "/api/auth/login", { email, password: PASSWORD });
  P[k] = { c, id: r.body.data.user.id };
}
const today = new Date().toISOString().slice(0, 10);

// debts: [debtor, creditor, rupees]. Each is made by the CREDITOR paying a bill the debtor shares half of
// (creditor pays 2x, debtor owes x), so the direct debt is exactly the stated amount.
async function scenario(title, debts) {
  const g = (await call(P.bob.c, "POST", "/api/groups", { name: title })).body.data.group.id;
  for (const k of ["ann", "cat", "dan"]) await call(P.bob.c, "POST", `/api/groups/${g}/members`, { userId: P[k].id });
  const members = (await call(P.bob.c, "GET", `/api/groups/${g}`)).body.data.group.members;
  const m = (k) => members.find((x) => x.userId === P[k].id).id;
  for (const [debtor, creditor, rupees] of debts) {
    const price = rupees * 200;
    const r = await call(P[creditor].c, "POST", "/api/bills", {
      groupId: g, description: `${creditor} paid, ${debtor} owes ₹${rupees}`, billDate: today, subtotalAmount: price,
      taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: m(creditor),
      items: [{ name: "Shared", price, quantity: 1, assignments: [m(debtor), m(creditor)].map((memberId) => ({ memberId, splitType: "equal" })) }],
    });
    if (r.status !== 201) throw new Error(`${title}: ${JSON.stringify(r.body)}`);
  }
  console.log(`  ✓ ${title}`);
}
console.log("Created scenario groups (log in as Ann, Bob, Cat or Dan; password demo-pass-123):");
await scenario("SIM-1 Chain: direct 2 → simplified 1", [["ann", "bob", 100], ["bob", "cat", 100]]);
await scenario("SIM-2 Cycle: direct 3 → simplified 0", [["ann", "bob", 100], ["bob", "cat", 100], ["cat", "ann", 100]]);
await scenario("SIM-3 One debt: no toggle at all", [["ann", "bob", 100]]);
await scenario("SIM-4 Two owe one: direct 2 → simplified 2 (already fewest)", [["ann", "bob", 100], ["cat", "bob", 100]]);
await scenario("SIM-5 Long chain: direct 3 → simplified 1", [["ann", "bob", 100], ["bob", "cat", 100], ["cat", "dan", 100]]);
await scenario("SIM-6 Uneven: direct 3 → simplified 2", [["ann", "bob", 500], ["ann", "cat", 200], ["bob", "cat", 300]]);
