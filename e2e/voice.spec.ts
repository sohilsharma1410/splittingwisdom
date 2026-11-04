/**
 * Voice (plan D4.10-D4.12): speak a whole bill, assign items by voice on a scan, per item, and on
 * a saved bill. There is no microphone here (Chrome's fake audio device won't open in headless
 * runs), so each page gets a stand-in getUserMedia that serves a tone from the Web Audio API,
 * which MediaRecorder records like a real mic. The speech service is
 * scripts/fake-stt.mjs, which "hears" whatever the test writes to the file below.
 *   E2E_PRIMARY_URL  app under test (default http://localhost:4273)
 *   E2E_FAKE_STT_FILE  the file the stand-in reads (default .localdb/fake-stt.txt)
 */
import { writeFileSync, readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const BASE = process.env.E2E_PRIMARY_URL ?? "http://localhost:4273";
const STT_FILE = process.env.E2E_FAKE_STT_FILE ?? ".localdb/fake-stt.txt";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const uid = () => Math.random().toString(36).slice(2, 8);
const READABLE = Buffer.alloc(400, 7); // "a photo" the fake vision model can read

const say = (text: string) => writeFileSync(STT_FILE, text);

/** A microphone made of an oscillator: real MediaStream, real MediaRecorder, no hardware. */
async function giveMicrophone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const out = ctx.createMediaStreamDestination();
      osc.connect(out);
      osc.start();
      return out.stream;
    };
  });
}

async function call(ctx: APIRequestContext, method: "get" | "post", path: string, data?: unknown) {
  const res = await ctx[method](`${BASE}${path}`, { data, headers: { "X-Forwarded-For": ip() } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Me ("Vee Me") + Pal ("Priya Pal") in a group. */
async function scene(page: Page, playwright: { request: { newContext: () => Promise<APIRequestContext> } }) {
  await giveMicrophone(page);
  const id = uid();
  const pal = await playwright.request.newContext();
  const me = await call(page.request, "post", "/api/auth/register", { email: `e2e-vm-${id}@example.com`, displayName: "Vee Me", password: "e2e-password-1" });
  const other = await call(pal, "post", "/api/auth/register", { email: `e2e-vp-${id}@example.com`, displayName: "Priya Pal", password: "e2e-password-1" });
  const g = await call(page.request, "post", "/api/groups", { name: `Voice crew ${id}` });
  const groupId = g.body.data.group.id as number;
  await call(page.request, "post", `/api/groups/${groupId}/members`, { userId: other.body.data.user.id });
  const detail = (await call(page.request, "get", `/api/groups/${groupId}`)).body.data.group.members as { id: number; userId: number }[];
  return {
    groupId,
    myMember: detail.find((m) => m.userId === me.body.data.user.id)!.id,
    palMember: detail.find((m) => m.userId === other.body.data.user.id)!.id,
  };
}

/** Taps through the dialog: the fake mic records for a moment, then Done sends it. */
async function speak(page: Page, words: string) {
  say(words);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("voice-clock")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200); // enough audio for the stand-in to get something non-empty
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog.getByLabel("What we heard (fix it if it's wrong)")).toHaveValue(words, { timeout: 15_000 });
}

test("speak the whole bill: items, quantity, tax and total fill the review screen, and it saves with the right money", async ({ page, playwright }) => {
  const { groupId, myMember } = await scene(page, playwright);
  await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
  await page.getByRole("button", { name: "Speak the bill" }).click();
  await speak(page, "Two paneer tikka 250 each, naan 80, GST 5 percent, total 630");

  const understood = page.getByRole("region", { name: "What we understood" });
  await expect(understood).toContainText("2 × Paneer Tikka — ₹500.00");
  await expect(understood).toContainText("Naan — ₹80.00");
  await expect(understood).toContainText("Tax — ₹29.00");
  await page.getByRole("button", { name: "Use this bill" }).click();

  // The review screen is the same one a photo goes through; the spoken words stand where the photo would be.
  await expect(page.getByTestId("spoken-text")).toContainText("paneer tikka");
  await expect(page.getByLabel("Item 1 name")).toHaveValue("Paneer Tikka");
  await expect(page.getByLabel("Item 1 quantity")).toHaveValue("2");
  await expect(page.getByLabel("Item 1 cost each")).toHaveValue("250.00");
  await expect(page.getByLabel("Item 1 price")).toHaveValue("500.00");
  await expect(page.getByTestId("scan-total")).toHaveText("₹609.00"); // 580 + 5% of 580
  // They said ₹630, so the screen says we're off by ₹21.00 rather than quietly accepting it.
  await expect(page.getByRole("alert", { name: "Totals don't match" })).toContainText("off by ₹21.00");
  await page.getByLabel("Bill name").fill("Spoken dinner");
  await page.getByRole("button", { name: "Confirm bill" }).click();
  await page.waitForURL(/\/bill\/\d+$/);

  const id = Number(page.url().split("/").pop());
  const bill = (await call(page.request, "get", `/api/bills/${id}`)).body.data.bill;
  expect(bill.items.map((i: { name: string; price: number; quantity: number }) => [i.name, i.quantity, i.price])).toEqual([["Paneer Tikka", 2, 50000], ["Naan", 1, 8000]]);
  expect(bill.taxAmount).toBe(2900);
  expect(bill.receiptImageUrl ?? null).toBeNull();
  void myMember;
});

test("speak the bill with who had what: the rows come filled in, and it saves that way", async ({ page, playwright }) => {
  const { groupId, myMember, palMember } = await scene(page, playwright);
  await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
  await page.getByRole("button", { name: "Speak the bill" }).click();
  await speak(page, "Thali non veg 140 priya. Curd shared by me 50. Naan 80 shared by everyone, total 270");
  const understood = page.getByRole("region", { name: "What we understood" });
  await expect(understood).toContainText("Curd — ₹50.00");
  await expect(understood).not.toContainText("Shared By");
  await page.getByRole("button", { name: "Use this bill" }).click();

  await expect(page.getByLabel("Item 2 name")).toHaveValue("Curd"); // not "Curd Shared By Me"
  await expect(page.getByTestId("assignees-1")).toContainText("Priya Pal");
  await expect(page.getByTestId("assignees-2")).toContainText("Vee Me");
  await expect(page.getByTestId("assignees-2")).not.toContainText("Priya Pal");
  await expect(page.getByTestId("assignees-3")).toContainText("Vee Me, Priya Pal");
  await page.getByLabel("Bill name").fill("Spoken split");
  await page.getByRole("button", { name: "Confirm bill" }).click();
  await page.waitForURL(/\/bill\/\d+$/);

  const id = Number(page.url().split("/").pop());
  const items = (await call(page.request, "get", `/api/bills/${id}`)).body.data.bill.items as { name: string; assignments: { memberId: number }[] }[];
  expect(items.map((i) => [i.name, i.assignments.map((a) => a.memberId).sort()])).toEqual([
    ["Thali Non Veg", [palMember]],
    ["Curd", [myMember]],
    ["Naan", [myMember, palMember].sort()],
  ]);
});

test("assign by voice after a scan: names are told to the model, misspellings still land on the right person", async ({ page, playwright }) => {
  const { groupId, palMember } = await scene(page, playwright);
  await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
  await page.getByLabel("Choose a receipt photo").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: READABLE });
  await expect(page.getByRole("heading", { name: "Items" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Assign by voice" }).click();
  await speak(page, "pria had the vodka prawns and priya and i shared the veg stew");
  const prompt = readFileSync(`${STT_FILE}.prompt`, "utf8");
  expect(prompt).toContain("Priya Pal"); // the model was given the group's people
  expect(prompt).toContain("Vodka Prawns"); // and the scanned items
  const understood = page.getByRole("region", { name: "What we understood" });
  await expect(understood).toContainText("Vodka Prawns → Priya Pal");
  await expect(understood).toContainText("Veg Stew → Vee Me, Priya Pal");
  await page.getByRole("button", { name: "Assign", exact: true }).click();

  await expect(page.getByTestId("assignees-1")).toContainText("Priya Pal");
  await page.getByRole("button", { name: "Confirm bill" }).click();
  await page.waitForURL(/\/bill\/\d+$/);

  const id = Number(page.url().split("/").pop());
  const items = (await call(page.request, "get", `/api/bills/${id}`)).body.data.bill.items as { name: string; assignments: { memberId: number }[] }[];
  expect(items.find((i) => i.name === "Vodka Prawns")!.assignments.map((a) => a.memberId)).toEqual([palMember]);
  expect(items.find((i) => i.name === "Veg Stew")!.assignments).toHaveLength(2);
  // Everything nobody was assigned goes to everyone, as before.
  expect(items.find((i) => i.name === "Mac N Cheese Bites")!.assignments).toHaveLength(2);
});

test("per-item mic hears only people", async ({ page, playwright }) => {
  const { groupId, palMember } = await scene(page, playwright);
  await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
  await page.getByLabel("Choose a receipt photo").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: READABLE });
  await expect(page.getByRole("heading", { name: "Items" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Say who had Harissa Chicken Wings" }).click();
  await speak(page, "priya");
  await expect(page.getByRole("region", { name: "What we understood" })).toContainText("Harissa Chicken Wings → Priya Pal");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByTestId("assignees-4")).toContainText("Priya Pal");
  await page.getByRole("button", { name: /Clear who had Harissa/ }).click();
  await expect(page.getByTestId("assignees-4")).toHaveCount(0);
  void palMember;
});

test("assign by voice on a saved bill, and a sentence it can't read assigns nothing", async ({ page, playwright }) => {
  const { groupId, myMember, palMember } = await scene(page, playwright);
  const created = await call(page.request, "post", "/api/bills", {
    groupId, description: "Saved dinner", billDate: new Date().toISOString().slice(0, 10),
    subtotalAmount: 30000, taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0, paidByMemberId: myMember,
    items: [
      { name: "Butter Naan", price: 10000, quantity: 1, assignments: [] },
      { name: "Veg Biryani", price: 20000, quantity: 1, assignments: [] },
    ],
  });
  expect(created.status).toBe(201);
  await page.goto(`${BASE}/bill/${created.body.data.bill.id}`);

  await page.getByRole("button", { name: "Assign by voice" }).click();
  await speak(page, "hmm maybe ravi had the naan");
  await expect(page.getByRole("region", { name: "What we understood" })).toContainText("Nothing could be filled in");
  await expect(page.getByRole("button", { name: "Assign", exact: true })).toBeDisabled();

  // Fix the sentence in the box: editing re-checks it without recording again.
  await page.getByLabel("What we heard (fix it if it's wrong)").fill("priya had the biryani and me and priya shared the naan");
  await page.getByRole("button", { name: "Check this" }).click();
  await expect(page.getByRole("region", { name: "What we understood" })).toContainText("Veg Biryani → Priya Pal");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Assigned 2 items")).toBeVisible();

  const items = (await call(page.request, "get", `/api/bills/${created.body.data.bill.id}`)).body.data.bill.items as { name: string; assignments: { memberId: number }[] }[];
  expect(items.find((i) => i.name === "Veg Biryani")!.assignments.map((a) => a.memberId)).toEqual([palMember]);
  expect(items.find((i) => i.name === "Butter Naan")!.assignments.map((a) => a.memberId).sort()).toEqual([myMember, palMember].sort());
});

for (const theme of ["light", "dark"] as const) {
  test(`the voice dialog has no serious accessibility violations (${theme}, 360px)`, async ({ browser, playwright }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: theme });
    const page = await context.newPage();
    const { groupId } = await scene(page, playwright);
    await page.goto(`${BASE}/bill/new/scan?group=${groupId}`);
    await page.getByRole("button", { name: "Speak the bill" }).click();
    await speak(page, "naan 80, tax 4");
    await expect(page.getByRole("region", { name: "What we understood" })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });
}
