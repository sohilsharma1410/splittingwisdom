// Test sentences for reading a whole bill from speech, written the way the speech recogniser
// punctuates real speech. Used by speech-bill.test.ts (the rules) and by
// server/scripts/speech-llm-eval.ts (the language model).
//
// DEV sentences were used to tune the rules, the first one taken from a real recording on the
// Pi. HELD_OUT sentences must not be used for tuning: they show how a reader does on phrasing
// it wasn't built around. Everything except the first DEV sentence is made up.

import { billAssignments, type SpokenBill } from "./speech-bill.js";

/** Pi is the person speaking. */
export const BILL_MEMBERS = [
  { id: 1, name: "Pi", isSpeaker: true },
  { id: 2, name: "Sohil" },
  { id: 3, name: "Pytester 1" },
  { id: 4, name: "Pytester 2" },
];
const ALL = [1, 2, 3, 4];

export interface BillCase {
  text: string;
  /** [a word the item's name must contain, quantity, line total in paise, member ids who had it]. */
  items: [string, number, number, number[]][];
  merchant?: string | null;
  tax?: number | null;
  service?: number | null;
  discount?: number | null;
  total?: number | null;
}

export const BILL_DEV_CASES: BillCase[] = [
  {
    text: "2 watermelon juice, 150 each, shared by me and Sohil. 1 coconut pudding, 500 rupees, shared by Pytester 2 and Pytester 1. 1 guitar avocado toast, 2 25 rupees, had by Sohil.",
    items: [["watermelon", 2, 30000, [1, 2]], ["pudding", 1, 50000, [3, 4]], ["toast", 1, 22500, [2]]],
  },
  { text: "Coconut pudding 500 split by pi tester 1 and Sohil", items: [["pudding", 1, 50000, [2, 3]]] },
  {
    text: "We ate at Ganbei. Two naan 80 each, paneer tikka 300 split by pi tester one and Sohil, GST 5 percent, total 487",
    merchant: "Ganbei",
    items: [["naan", 2, 16000, []], ["paneer", 1, 30000, [2, 3]]],
    tax: 2300,
    total: 48700,
  },
  {
    text: "So we were at Toit, and we got one pitcher of beer for 900 that everyone shared, a pizza for 650 which Sohil and I split, and fries 250 just for pytester 2. Service charge 10 percent.",
    merchant: "Toit",
    items: [["beer", 1, 90000, ALL], ["pizza", 1, 65000, [1, 2]], ["fries", 1, 25000, [4]]],
    service: 18000,
  },
  {
    text: "Okay, the bill from Truffles. Three burgers at 280 each, I had one, Sohil had one and pi tester 2 had one. Two cold coffees 180 each for Sohil and me. Total 1200.",
    merchant: "Truffles",
    items: [["burger", 3, 84000, [1, 2, 4]], ["coffee", 2, 36000, [1, 2]]],
    total: 120000,
  },
  {
    text: "Biryani 350, everyone. Raita 60, me. Two lime sodas, 90 each, Sohil and Pytester 1. Discount 50.",
    items: [["biryani", 1, 35000, ALL], ["raita", 1, 6000, [1]], ["soda", 2, 18000, [2, 3]]],
    discount: 5000,
  },
  {
    text: "Chicken lollipop 250, paneer chilli 220, and 4 rotis for 120. All shared equally. GST 5%.",
    items: [["lollipop", 1, 25000, []], ["chilli", 1, 22000, []], ["roti", 4, 12000, []]],
    tax: 2950,
  },
  {
    text: "Restaurant name is Meghana Foods. Chicken biryani 2, 320 each, Sohil and me. Pepper chicken 280 for pytester one.",
    merchant: "Meghana Foods",
    items: [["biryani", 2, 64000, [1, 2]], ["pepper", 1, 28000, [3]]],
  },
];

export const BILL_HELD_OUT_CASES: BillCase[] = [
  {
    text: "Alright so tonight's dinner was at Smoke House Deli. I got the pasta which was 420. Sohil got a burger for 380. And we all shared nachos, 260. Plus a 10% service charge.",
    merchant: "Smoke House Deli",
    items: [["pasta", 1, 42000, [1]], ["burger", 1, 38000, [2]], ["nachos", 1, 26000, ALL]],
    service: 10600,
  },
  {
    text: "Three masala chai at 30 each, one for each of us except Pytester 2. Samosa plate 80, Sohil.",
    items: [["chai", 3, 9000, [1, 2, 3]], ["samosa", 1, 8000, [2]]],
  },
  {
    text: "Pizza 599. Garlic bread 199. Coke 2 at 60. Pizza and garlic bread shared by everyone, coke for me and Sohil.",
    items: [["pizza", 1, 59900, ALL], ["garlic", 1, 19900, ALL], ["coke", 2, 12000, [1, 2]]],
  },
  {
    text: "Sohil had the chicken biryani which was 340 and I had the veg biryani for 280, total 620.",
    items: [["chicken biryani", 1, 34000, [2]], ["veg biryani", 1, 28000, [1]]],
    total: 62000,
  },
  {
    text: "From Dominos. Two medium pizzas, 450 each, everyone. Garlic breadsticks 130, Pytester 1 and Pytester 2. Tip 50.",
    merchant: "Dominos",
    items: [["pizza", 2, 90000, ALL], ["breadsticks", 1, 13000, [3, 4]]],
  },
  {
    text: "Ok um the bill is, idli 60, vada 50, both mine, and a filter coffee for 40 for Sohil.",
    items: [["idli", 1, 6000, [1]], ["vada", 1, 5000, [1]], ["coffee", 1, 4000, [2]]],
  },
];

/** What a reading got wrong against a case: empty when it's all right. */
export function gradeBill(bill: SpokenBill, want: BillCase): string[] {
  const wrong: string[] = [];
  const shares = billAssignments({ ...bill, doubts: [...bill.doubts] }, BILL_MEMBERS);
  if (bill.items.length !== want.items.length) wrong.push(`${bill.items.length} items, not ${want.items.length}`);
  want.items.forEach(([word, quantity, price, people], index) => {
    const item = bill.items[index];
    if (!item) return;
    if (!item.name.toLowerCase().includes(word)) wrong.push(`item ${index + 1} is "${item.name}"`);
    if (item.quantity !== quantity) wrong.push(`${word}: quantity ${item.quantity}`);
    if (item.price !== price) wrong.push(`${word}: ₹${item.price / 100}`);
    const got = (shares.find((s) => s.itemIndex === index)?.shares ?? []).map((s) => s.memberId).sort().join(",");
    const expected = [...people].sort().join(",");
    // With nobody named for an item, nobody or everyone are both right: everyone is the default.
    if (got !== expected && !(people.length === 0 && (got === "" || got === ALL.join(",")))) wrong.push(`${word}: people [${got}], not [${expected}] (heard "${item.who}")`);
  });
  if (want.merchant !== undefined && bill.merchant !== want.merchant) wrong.push(`restaurant ${bill.merchant}`);
  if (want.tax !== undefined && bill.taxAmount !== want.tax) wrong.push(`tax ${bill.taxAmount}`);
  if (want.service !== undefined && bill.serviceFeeAmount !== want.service) wrong.push(`service ${bill.serviceFeeAmount}`);
  if (want.discount !== undefined && bill.discountAmount !== want.discount) wrong.push(`discount ${bill.discountAmount}`);
  if (want.total !== undefined && bill.totalAmount !== want.total) wrong.push(`total ${bill.totalAmount}`);
  return wrong;
}
