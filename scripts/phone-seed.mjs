#!/usr/bin/env node
// Seeds a throwaway database with three demo people and a small trip so a
// phone tester has something to settle. Only ever point this at a local /
// throwaway stack (scripts/phone-test.sh does).
//
//   BASE_URL=http://localhost:4100 node scripts/phone-seed.mjs
const BASE = (process.env.BASE_URL ?? "http://localhost:4100").replace(/\/$/, "");
const PASSWORD = "demo-pass-123";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip(), ...(cookie.v ? { Cookie: cookie.v } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith("connect.sid=")) cookie.v = c.split(";")[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

const people = {};
for (const [key, name] of [["ann", "Ann"], ["bob", "Bob"], ["cat", "Cat"]]) {
  const cookie = {};
  const email = `demo-${key}@example.com`;
  let r = await call(cookie, "POST", "/api/auth/register", { email, displayName: name, password: PASSWORD });
  if (r.status === 409) r = await call(cookie, "POST", "/api/auth/login", { email, password: PASSWORD });
  people[key] = { cookie, id: r.body.data.user.id, email, name };
}

const g = await call(people.bob.cookie, "POST", "/api/groups", { name: "Goa trip (demo)" });
const groupId = g.body.data.group.id;
for (const k of ["ann", "cat"]) await call(people.bob.cookie, "POST", `/api/groups/${groupId}/members`, { userId: people[k].id });
const members = (await call(people.bob.cookie, "GET", `/api/groups/${groupId}`)).body.data.group.members;
const m = (k) => members.find((x) => x.userId === people[k].id).id;
const today = new Date().toISOString().slice(0, 10);
const bill = (who, description, items) =>
  call(people[who].cookie, "POST", "/api/bills", {
    groupId, description, billDate: today,
    subtotalAmount: items.reduce((s, i) => s + i.price, 0), taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0,
    paidByMemberId: m(who),
    items: items.map((i) => ({ name: i.name, price: i.price, quantity: 1, assignments: i.who.map((w) => ({ memberId: m(w), splitType: "equal" })) })),
  });

// A clean chain so "Simplify debts" visibly helps: Ann owes Bob ₹100.00, Bob owes Cat ₹100.00,
// so 2 direct debts simplify to ONE payment (Ann pays Cat ₹100.00) and everyone nets to zero.
await bill("bob", "Beach shack lunch", [
  { name: "Fish thali", price: 14000, who: ["ann", "bob"] },
  { name: "Fresh lime soda", price: 6000, who: ["ann", "bob"] },
]); // Bob paid ₹200.00 for him and Ann: Ann owes ₹100.00
await bill("cat", "Scooter rental", [{ name: "Scooter (2 days)", price: 20000, who: ["bob", "cat"] }]); // Cat paid ₹200.00: Bob owes ₹100.00

console.log(`Seeded group "Goa trip (demo)" with 3 people. Log in with any of these (password: ${PASSWORD}):`);
for (const p of Object.values(people)) console.log(`  ${p.name.padEnd(4)} ${p.email}`);
