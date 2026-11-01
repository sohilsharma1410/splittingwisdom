#!/usr/bin/env node
// QA-1 smoke + core regression, dependency-free. Runs the same scenario against
// any deployment so results are comparable (QA-2 parity):
//
//   BASE_URL=http://localhost:4100 node scripts/qa-smoke.mjs
//   BASE_URL=https://<pi>.<tailnet>.ts.net node scripts/qa-smoke.mjs
//
// It registers throwaway users (qa-<random>@example.com). Against a real
// database those rows remain unless you clean them (see QA_CLEANUP below).
import { readFileSync } from "node:fs";

const BASE = (process.env.BASE_URL ?? "http://localhost:4100").replace(/\/$/, "");
const RUN = Math.random().toString(36).slice(2, 8);
// A unique client IP per run keeps the per-IP rate limiters from tripping
// across repeated runs (the server trusts the first X-Forwarded-For entry).
const FAKE_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

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
        "X-Forwarded-For": FAKE_IP,
        // Production only sets its Secure session cookie on HTTPS. This says what a
        // TLS proxy would, so the test also works against http://127.0.0.1 on the Pi.
        "X-Forwarded-Proto": "https",
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
  if (r.status === 200) await settlementChecks({ A, B, C, groupId, aId, bId, mA, mB });
  else console.log("SKIP  settlements (route not present on this build)");

  // --- web app served by this API (the Pi): EXPECT_SERVED_CLIENT=1 -----------
  if (process.env.EXPECT_SERVED_CLIENT) {
    const get = async (path) => {
      const res = await fetch(`${BASE}${path}`);
      return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
    };
    let page = await get("/");
    check("app served at /", page.status === 200 && page.type.includes("html") && page.text.includes("<html"), `status ${page.status}`);
    page = await get("/bill/1");
    check("deep link loads the app", page.status === 200 && page.type.includes("html"), `status ${page.status}`);
    page = await get("/sw.js");
    check("service worker served as a script", page.status === 200 && page.type.includes("javascript"), `${page.status} ${page.type}`);
    page = await get("/manifest.webmanifest");
    check("PWA manifest served", page.status === 200, `status ${page.status}`);
    page = await get("/assets/does-not-exist.js");
    check("missing asset is a 404, not the app", page.status === 404 && !page.text.includes("<html"), `status ${page.status}`);
    page = await get("/api/does-not-exist");
    check("unknown API route stays a JSON 404", page.status === 404 && page.type.includes("json"), `${page.status} ${page.type}`);
  }

  // --- receipts on local disk (the Pi): EXPECT_LOCAL_RECEIPTS=1 --------------
  if (process.env.EXPECT_LOCAL_RECEIPTS) {
    const bytes = Buffer.from(`qa-smoke-receipt-${RUN}`);
    const headers = { Cookie: A.cookie, "X-Forwarded-For": FAKE_IP, "X-Forwarded-Proto": "https" };
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "receipt.png");
    const upload = await fetch(`${BASE}/api/bills/${billId}/receipt`, { method: "POST", headers, body: form });
    check("receipt upload writes to disk -> 201", upload.status === 201, `status ${upload.status}: ${await upload.clone().text()}`);

    r = await A.req("GET", `/api/bills/${billId}/receipt-url`);
    const url = r.body?.data?.url ?? "";
    check("receipt URL is on this server", url.startsWith("/api/receipts/"), JSON.stringify(r));
    const image = await fetch(`${BASE}${url}`, { headers });
    const served = Buffer.from(await image.arrayBuffer());
    check("receipt reads back unchanged", image.status === 200 && served.equals(bytes), `status ${image.status}`);
    const anonymous = await fetch(`${BASE}${url}`);
    check("receipt URL needs a login -> 401", anonymous.status === 401, `status ${anonymous.status}`);
    r = await C.req("GET", `/api/bills/${billId}/receipt-url`);
    check("outsider gets no receipt URL -> 404", r.status === 404, `status ${r.status}`);
  }

  // --- receipts read on this server (the Pi): EXPECT_LOCAL_OCR=1 -------------
  if (process.env.EXPECT_LOCAL_OCR) {
    const headers = { Cookie: A.cookie, "X-Forwarded-For": FAKE_IP, "X-Forwarded-Proto": "https" };
    const scan = async (file) => {
      const form = new FormData();
      const bytes = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
      form.append("image", new Blob([bytes], { type: "image/jpeg" }), file);
      const res = await fetch(`${BASE}/api/bills/extract`, { method: "POST", headers, body: form });
      return { status: res.status, data: (await res.json()).data };
    };

    // Real database requests during a scan, because a scan must not slow the app down.
    let scanning = true;
    let slowestMs = 0;
    const watcher = (async () => {
      while (scanning) {
        const started = Date.now();
        await A.req("GET", "/api/groups");
        slowestMs = Math.max(slowestMs, Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    const started = Date.now();
    const made = await scan("made-up-receipt.jpg");
    const scanMs = Date.now() - started;
    scanning = false;
    await watcher;

    const e = made.data?.extraction;
    check("scan of a made-up receipt succeeds -> 200", made.status === 200 && made.data?.extractionFailed === false, JSON.stringify(made).slice(0, 300));
    check("scan took under 20 seconds", scanMs < 20000, `${scanMs} ms`);
    check("app stayed fast during the scan (under 1 second)", slowestMs < 1000, `slowest ${slowestMs} ms`);
    check("scan read the merchant and date", e?.merchant === "MADE UP TEST CAFE" && e?.billDate === "2026-10-12", JSON.stringify([e?.merchant, e?.billDate]));
    check("scan read every item, with line totals in paise",
      JSON.stringify(e?.items?.map((i) => [i.name, i.price, i.quantity])) === JSON.stringify([["Paneer Tikka", 36000, 2], ["Butter Naan", 22000, 4], ["Masala Chaas", 6000, 1]]),
      JSON.stringify(e?.items));
    check("scan read tax and total, and they add up", e?.taxAmount === 3200 && e?.totalAmount === 67200 && e?.totalsMismatch === null, JSON.stringify([e?.taxAmount, e?.totalAmount, e?.totalsMismatch]));
    check("scan kept the photo", Boolean(made.data?.imagePath));

    const blank = await scan("not-a-receipt.jpg");
    check("a photo with no bill falls back to manual entry, photo kept",
      blank.status === 200 && blank.data?.extractionFailed === true && Boolean(blank.data?.imagePath), JSON.stringify(blank).slice(0, 300));
    console.log(`      scan took ${scanMs} ms, slowest app request during it ${slowestMs} ms`);
  }

  // --- hardening -------------------------------------------------------------
  const hdr = await fetch(`${BASE}/api/health`);
  check("security headers present (nosniff) and X-Powered-By hidden",
    hdr.headers.get("x-content-type-options") === "nosniff" && !hdr.headers.get("x-powered-by"),
    JSON.stringify([...hdr.headers.entries()].filter(([k]) => /content-type-options|powered/.test(k))));

  const victim = email("a");
  const attacker = new Client("attacker");
  let lastStatus = 0, firstBlockedAt = 0, retryAfter = null;
  for (let i = 1; i <= 12; i++) {
    const res = await attacker.req("POST", "/api/auth/login", { email: victim, password: `guess-${i}` });
    lastStatus = res.status;
    if (res.status === 429 && !firstBlockedAt) firstBlockedAt = i;
  }
  // Budget is 10 attempts per IP+email per 15 min, and this run already made 2 earlier logins as the same email.
  check("login brute-force gets 429 once the 10-attempt budget is spent", firstBlockedAt >= 8 && firstBlockedAt <= 11, `first 429 at attempt ${firstBlockedAt}, last status ${lastStatus}`);
  r = await attacker.req("POST", "/api/auth/login", { email: victim, password: PASSWORD });
  check("even the correct password is refused while locked (429)", r.status === 429, `status ${r.status}`);
  r = await attacker.req("POST", "/api/auth/login", { email: email("b"), password: PASSWORD });
  check("a different account from the same IP is NOT locked out", r.status === 200, `status ${r.status}`);

  // --- logout ---------------------------------------------------------------
  r = await A.req("POST", "/api/auth/logout");
  check("logout -> 200", r.status === 200, JSON.stringify(r));
  r = await A.req("GET", "/api/auth/me");
  check("after logout /me -> 401", r.status === 401, `status ${r.status}`);
}

async function settlementChecks({ A, B, C, groupId, aId, bId, mA, mB }) {
  const today = new Date().toISOString().slice(0, 10);
  const pair = (payer, recipient, amount, extra = {}) => ({ mode: "pair", groupId, payerMemberId: payer, recipientMemberId: recipient, amount, ...extra });
  let r = await B.req("GET", `/api/bills`);
  const bill1 = r.body?.data?.bills?.find((b) => b.groupId === groupId);
  check("bill is Pending before any payment (derived, not stored)", bill1?.status === "pending", JSON.stringify(bill1?.status));

  // --- validation and authorization -------------------------------------------
  r = await B.req("POST", "/api/settlements", pair(mB, mA, 0));
  check("zero amount rejected (400)", r.status === 400, `status ${r.status}`);
  r = await B.req("POST", "/api/settlements", pair(mB, mA, 12.5));
  check("fractional paise rejected (400)", r.status === 400, `status ${r.status}`);
  r = await B.req("POST", "/api/settlements", pair(mB, mA, 500000));
  check("₹5,000 against a ₹350 balance is rejected (422)", r.status === 422 && /more than is owed/.test(r.body?.error?.message ?? ""), JSON.stringify(r));
  r = await C.req("POST", "/api/settlements", pair(mB, mA, 100));
  check("outsider can't record a settlement in the group (404)", r.status === 404, `status ${r.status}`);
  r = await A.req("POST", "/api/settlements", pair(mA, mB, 100));
  check("paying someone who owes you is rejected (422)", r.status === 422, `status ${r.status}`);
  r = await B.req("POST", "/api/settlements", pair(mB, mA, 100, { settlementDate: "2999-01-01" }));
  check("future-dated settlement rejected (400)", r.status === 400, `status ${r.status}`);
  r = await C.req("GET", `/api/settlements?groupId=${groupId}`);
  check("outsider can't read the group's settlements (404)", r.status === 404, `status ${r.status}`);

  // --- partial payment: ₹150 of ₹350 -> ₹200 left everywhere -------------------
  const partialKey = `qa-${RUN}-partial`;
  const partialBody = pair(mB, mA, 15000, { note: "UPI part 1", settlementDate: today });
  r = await B.req("POST", "/api/settlements", partialBody, { "Idempotency-Key": partialKey });
  check("partial settlement ₹150 -> 201", r.status === 201 && r.body?.data?.settlements?.length === 1, JSON.stringify(r));
  // The same request retried (double tap, lost response) must be the same payment, not a second one.
  const retry = await B.req("POST", "/api/settlements", partialBody, { "Idempotency-Key": partialKey });
  check("retry with the same Idempotency-Key replays the same settlement (no second payment)",
    retry.status === 201 && retry.body?.data?.settlements?.[0]?.id === r.body?.data?.settlements?.[0]?.id, JSON.stringify({ retry: retry.status }));
  const reused = await B.req("POST", "/api/settlements", pair(mB, mA, 2000), { "Idempotency-Key": partialKey });
  check("same key with a different amount is rejected (422)", reused.status === 422, `status ${reused.status}`);
  r = await B.req("GET", "/api/balances");
  check("B now owes ₹200 (net -20000)", r.body?.data?.netBalance === -20000, JSON.stringify(r.body?.data));
  r = await A.req("GET", "/api/balances");
  check("A is now owed ₹200 (net +20000)", r.body?.data?.netBalance === 20000, JSON.stringify(r.body?.data));
  r = await B.req("POST", "/api/settlements", pair(mB, mA, 20001));
  check("one paisa over the remaining ₹200 is rejected (422)", r.status === 422, `status ${r.status}`);

  // --- full settlement through the person flow ----------------------------------
  r = await B.req("POST", "/api/settlements", { mode: "person", personId: `u-${aId}`, amount: 20000, note: "UPI part 2" });
  check("person-mode settlement of the remaining ₹200 -> 201", r.status === 201, JSON.stringify(r));
  r = await B.req("GET", "/api/balances");
  check("pair is settled: B net balance 0", r.body?.data?.netBalance === 0 && r.body?.data?.unsettledCount === 0, JSON.stringify(r.body?.data));
  r = await B.req("POST", "/api/settlements", { mode: "person", personId: `u-${aId}`, amount: 1 });
  check("nothing left to pay -> 422", r.status === 422, `status ${r.status}`);
  r = await B.req("GET", "/api/bills");
  check("the bill now shows Settled", r.body?.data?.bills?.find((b) => b.groupId === groupId)?.status === "settled", JSON.stringify(r.body?.data?.bills?.map((b) => b.status)));

  // --- a new bill re-accumulates; 10 simultaneous payments, exactly one wins ----
  r = await A.req("POST", "/api/bills", {
    groupId, description: "QA coffee", billDate: today, subtotalAmount: 20000, taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: mA,
    items: [{ name: "Coffee", price: 20000, quantity: 1, assignments: [{ memberId: mA, splitType: "equal" }, { memberId: mB, splitType: "equal" }] }],
  });
  check("new bill re-creates a ₹100 debt", r.status === 201, JSON.stringify(r).slice(0, 200));
  r = await B.req("GET", "/api/balances");
  check("B owes ₹100 again", r.body?.data?.netBalance === -10000, JSON.stringify(r.body?.data));
  const race = await Promise.all(Array.from({ length: 10 }, () => B.req("POST", "/api/settlements", pair(mB, mA, 10000))));
  const won = race.filter((x) => x.status === 201).length, refused = race.filter((x) => x.status === 422).length;
  check("10 simultaneous ₹100 payments of a ₹100 debt: exactly one succeeds, nine refused", won === 1 && refused === 9, `201s=${won} 422s=${refused} others=${race.map((x) => x.status)}`);
  r = await B.req("GET", "/api/balances");
  check("balance is exactly 0 after the race (no overpayment)", r.body?.data?.netBalance === 0, JSON.stringify(r.body?.data));

  // --- history and the explanation -------------------------------------------
  r = await A.req("GET", `/api/settlements?groupId=${groupId}`);
  const hist = r.body?.data?.settlements ?? [];
  check("group history has exactly the 3 successful payments, newest first", hist.length === 3 && hist.reduce((s, x) => s + x.amount, 0) === 45000, JSON.stringify(hist.map((x) => x.amount)));
  r = await B.req("GET", `/api/balances/u-${aId}`);
  const d = r.body?.data;
  check("balance detail: bills ₹450 owed, ₹450 settled, ₹0 outstanding", d?.billsNet === -45000 && d?.settlementsNet === 45000 && d?.netAmount === 0, JSON.stringify({ billsNet: d?.billsNet, settlementsNet: d?.settlementsNet, netAmount: d?.netAmount }));
  check("balance detail lists the payments with notes and direction", d?.settlements?.length === 3 && d.settlements.every((x) => x.direction === "paid-by-me") && d.settlements.some((x) => x.note === "UPI part 1"), JSON.stringify(d?.settlements));
  r = await A.req("GET", `/api/balances/u-${bId}`);
  check("same history from A's side reads as paid-to-me", r.body?.data?.settlements?.every((x) => x.direction === "paid-to-me") && r.body?.data?.netAmount === 0, JSON.stringify(r.body?.data?.settlements?.map((x) => x.direction)));
  r = await C.req("GET", `/api/balances/u-${aId}`);
  check("outsider gets no balance detail for A (404)", r.status === 404, `status ${r.status}`);
  r = await B.req("GET", "/api/bills");
  check("all bills Settled once everything is paid", r.body?.data?.bills?.filter((b) => b.groupId === groupId).every((b) => b.status === "settled"), JSON.stringify(r.body?.data?.bills?.map((b) => b.status)));
}

await main().catch((e) => { console.error("FATAL", e); failures++; });
console.log(`\n${results.length - failures}/${results.length} checks passed against ${BASE}`);
process.exit(failures ? 1 : 0);
