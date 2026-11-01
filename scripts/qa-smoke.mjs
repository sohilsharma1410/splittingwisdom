#!/usr/bin/env node
// QA-1 smoke + core regression, dependency-free. Runs the same scenario against
// any deployment so results are comparable (QA-2 parity):
//
//   BASE_URL=http://localhost:4100 node scripts/qa-smoke.mjs
//   BASE_URL=https://<pi>.<tailnet>.ts.net node scripts/qa-smoke.mjs
//
// It registers throwaway users (qa-<random>@example.com). Against a real
// database those rows remain unless you clean them (see QA_CLEANUP below).
const BASE = (process.env.BASE_URL ?? "http://localhost:4100").replace(/\/$/, "");
const RUN = Math.random().toString(36).slice(2, 8);

let failures = 0;
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${detail}`}`);
  if (!cond) failures++;
}

class Client {
  constructor(label) { this.label = label; this.cookie = ""; }
  async req(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const pair = c.split(";")[0];
      if (pair.startsWith("connect.sid=")) this.cookie = pair;
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
  }
}

const email = (n) => `qa-${RUN}-${n}@example.com`;
const PASSWORD = "qa-password-123";

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.status).catch(() => 0);
  check("server reachable (/api/health 200)", health === 200, `status ${health}`);
  if (health !== 200) return;

  const A = new Client("A"), B = new Client("B"), C = new Client("C");

  // --- auth -----------------------------------------------------------------
  let r = await A.req("POST", "/api/auth/register", { email: email("a"), displayName: "QA Alice", password: PASSWORD });
  check("register A -> 201", r.status === 201, JSON.stringify(r));
  const aId = r.body?.data?.user?.id;
  r = await A.req("GET", "/api/auth/me");
  check("session persists: /me -> 200", r.status === 200 && r.body?.data?.user?.id === aId, JSON.stringify(r));

  r = await new Client("x").req("POST", "/api/auth/login", { email: email("a"), password: "wrong-password" });
  check("wrong password -> 401 clear message", r.status === 401 && /Incorrect email or password/.test(r.body?.error?.message ?? ""), JSON.stringify(r));
  r = await new Client("x").req("POST", "/api/auth/login", { email: email("a").toUpperCase(), password: PASSWORD });
  check("login is case-insensitive on email", r.status === 200, JSON.stringify(r));
  r = await new Client("x").req("GET", "/api/groups");
  check("unauthenticated /api/groups -> 401", r.status === 401, JSON.stringify(r));

  r = await B.req("POST", "/api/auth/register", { email: email("b"), displayName: "QA Bob", password: PASSWORD });
  const bId = r.body?.data?.user?.id;
  check("register B -> 201", r.status === 201, JSON.stringify(r));
  r = await C.req("POST", "/api/auth/register", { email: email("c"), displayName: "QA Carol", password: PASSWORD });
  check("register C (outsider) -> 201", r.status === 201, JSON.stringify(r));

  // --- group ---------------------------------------------------------------
  r = await A.req("POST", "/api/groups", { name: `QA group ${RUN}` });
  const groupId = r.body?.data?.group?.id;
  check("create group -> 201", r.status === 201 && groupId, JSON.stringify(r));
  r = await A.req("POST", `/api/groups/${groupId}/members`, { userId: bId });
  check("add B to group -> 201", r.status === 201, JSON.stringify(r));
  r = await A.req("GET", `/api/groups/${groupId}`);
  const members = r.body?.data?.group?.members ?? [];
  const mA = members.find((m) => m.userId === aId)?.id;
  const mB = members.find((m) => m.userId === bId)?.id;
  check("group has A and B as members", members.length === 2 && mA && mB, JSON.stringify(members));

  // --- authorization (non-member must not see the group) -------------------
  r = await C.req("GET", `/api/groups/${groupId}`);
  check("outsider cannot read group (403/404)", r.status === 403 || r.status === 404, `status ${r.status}`);
  r = await C.req("GET", `/api/groups/${groupId}/bills`);
  check("outsider cannot read group bills (403/404)", r.status === 403 || r.status === 404, `status ${r.status}`);

  // --- bill + money: 60000 + 10001 paise, equal split, remainder -> lowest member id
  const bill = {
    groupId,
    description: `QA dinner ${RUN}`,
    merchant: "QA Cafe",
    billDate: new Date().toISOString().slice(0, 10),
    subtotalAmount: 70001,
    taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0,
    paidByMemberId: mA,
    items: [
      { name: "Pizza", price: 60000, quantity: 1, assignments: [{ memberId: mA, splitType: "equal" }, { memberId: mB, splitType: "equal" }] },
      { name: "Fries", price: 10001, quantity: 1, assignments: [{ memberId: mA, splitType: "equal" }, { memberId: mB, splitType: "equal" }] },
    ],
  };
  r = await A.req("POST", "/api/bills", bill);
  const billId = r.body?.data?.bill?.id ?? r.body?.data?.id;
  check("create itemized bill -> 201", r.status === 201 && billId, JSON.stringify(r).slice(0, 300));

  r = await B.req("GET", "/api/balances");
  check("B net balance = -35000 paise (owes A)", r.body?.data?.netBalance === -35000, JSON.stringify(r.body?.data));
  r = await A.req("GET", "/api/balances");
  check("A net balance = +35000 paise", r.body?.data?.netBalance === 35000, JSON.stringify(r.body?.data));

  // invalid money must be rejected by the shared contract
  r = await A.req("POST", "/api/bills", { ...bill, items: [{ ...bill.items[0], price: 12.5 }] });
  check("non-integer price rejected (400)", r.status === 400, `status ${r.status}`);

  // --- settlements (added by D2; skipped cleanly if the route doesn't exist yet)
  r = await A.req("GET", `/api/settlements?groupId=${groupId}`);
  if (r.status !== 404) await settlementChecks({ A, B, C, groupId, aId, bId, mA, mB });
  else console.log("SKIP  settlements (route not present on this build)");

  // --- logout ---------------------------------------------------------------
  r = await A.req("POST", "/api/auth/logout");
  check("logout -> 200", r.status === 200, JSON.stringify(r));
  r = await A.req("GET", "/api/auth/me");
  check("after logout /me -> 401", r.status === 401, `status ${r.status}`);
}

// Filled in alongside the settlements feature.
async function settlementChecks() {}

await main().catch((e) => { console.error("FATAL", e); failures++; });
console.log(`\n${results.length - failures}/${results.length} checks passed against ${BASE}`);
process.exit(failures ? 1 : 0);
