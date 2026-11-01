import { describe, expect, it } from "vitest";
import { boxesToRows, findDate, parseMoney, parseReceipt, type OcrBox } from "./receipt-parser.js";

// All receipts here are made up. Real receipt photos and text never go in this repo.

/** Builds OCR boxes from rows of cells, spaced like a printed receipt. */
function receipt(rows: string[][], options: { tilt?: number; confidence?: number } = {}): OcrBox[] {
  const boxes: OcrBox[] = [];
  const tilt = options.tilt ?? 0;
  rows.forEach((row, rowIndex) => {
    row.forEach((text, cellIndex) => {
      const left = 50 + cellIndex * 260;
      const top = 40 + rowIndex * 40;
      const width = 240;
      const height = 26;
      const place = (x: number, y: number) => [x + y * -tilt, y + x * tilt];
      boxes.push({
        text,
        confidence: options.confidence ?? 0.97,
        box: [place(left, top), place(left + width, top), place(left + width, top + height), place(left, top + height)],
      });
    });
  });
  return boxes;
}

describe("parseMoney", () => {
  it.each([
    ["640.00", 64000],
    ["640", 64000],
    ["12.5", 1250],
    ["0.24", 24],
    ["1,234.56", 123456],
    ["1,23,456.00", 12345600],
    ["₹640.00", 64000],
    ["Rs.640", 64000],
    ["Rs640.50", 64050],
    ["INR 75.00", 7500],
    ["640/-", 64000],
    ["640.", 64000],
    ["-60.00", 6000],
    ["(60.00)", 6000],
    ["640,50", 64050],
    ["19.99", 1999],
    ["1.10", 110],
    ["1,000", 100000],
    ["1,00,000", 10000000],
  ])("reads %s exactly", (text, paise) => {
    expect(parseMoney(text)).toBe(paise);
  });

  it.each(["abc", "12a.00", "12.345", "1.2.3", "", "560001", "9876543210", "12/10/2026", "20:41"])(
    "refuses %s",
    (text) => {
      expect(parseMoney(text)).toBeNull();
    },
  );
});

describe("findDate", () => {
  it.each([
    ["Date: 12/10/2026", "2026-10-12"],
    ["Date:12-10-26", "2026-10-12"],
    ["31.12.2026 20:41", "2026-12-31"],
    ["2026-10-12", "2026-10-12"],
    ["12 Oct 2026", "2026-10-12"],
    ["12-Oct-26", "2026-10-12"],
    ["3 March 2026", "2026-03-03"],
  ])("reads %s", (text, expected) => {
    expect(findDate(text)).toBe(expected);
  });

  it.each(["31/02/2026", "45/13/2026", "Bill No 4821", "Table 7"])("finds no date in %s", (text) => {
    expect(findDate(text)).toBeNull();
  });
});

describe("boxesToRows", () => {
  it("keeps cells on their row, in reading order, on a tilted photo", () => {
    const rows = boxesToRows(receipt([["Tea", "2", "80.00"], ["Coffee", "1", "60.00"]], { tilt: 0.06 }));
    expect(rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ["Tea", "2", "80.00"],
      ["Coffee", "1", "60.00"],
    ]);
  });

  it("returns nothing for no text", () => {
    expect(boxesToRows([])).toEqual([]);
  });
});

const RESTAURANT = [
  ["SPICE GARDEN RESTAURANT"],
  ["MG Road, Bengaluru 560001"],
  ["GSTIN 29ABCDE1234F1Z5"],
  ["Date: 12/10/2026", "Time: 20:41"],
  ["Bill No: 4821", "Table: 7"],
  ["Item", "Qty", "Rate", "Amount"],
  ["Paneer Butter Masala", "2", "320.00", "640.00"],
  ["Butter Naan", "4", "55.00", "220.00"],
  ["Veg Biryani", "1", "280.00", "280.00"],
  ["Masala Chaas", "3", "60.00", "180.00"],
  ["Gulab Jamun", "2", "90.00", "180.00"],
  ["Sub Total", "1500.00"],
  ["Service Charge 5%", "75.00"],
  ["CGST 2.5%", "39.38"],
  ["SGST 2.5%", "39.38"],
  ["Round Off", "0.24"],
  ["GRAND TOTAL", "1654.00"],
  ["Paid by UPI", "1654.00"],
  ["Thank you! Visit again"],
];

describe("parseReceipt: a restaurant bill", () => {
  const result = parseReceipt(receipt(RESTAURANT))!;

  it("reads the merchant and date", () => {
    expect(result.merchant).toBe("SPICE GARDEN RESTAURANT");
    expect(result.billDate).toBe("2026-10-12");
  });

  it("stores each item's price as the line total, because balances never multiply by quantity", () => {
    expect(result.items).toEqual([
      { name: "Paneer Butter Masala", price: 64000, quantity: 2, confidence: "high" },
      { name: "Butter Naan", price: 22000, quantity: 4, confidence: "high" },
      { name: "Veg Biryani", price: 28000, quantity: 1, confidence: "high" },
      { name: "Masala Chaas", price: 18000, quantity: 3, confidence: "high" },
      { name: "Gulab Jamun", price: 18000, quantity: 2, confidence: "high" },
    ]);
  });

  it("adds both GST lines, and keeps the round-off separate with its direction", () => {
    expect(result.taxAmount).toBe(3938 + 3938);
    expect(result.roundOffAmount).toBe(24);
    expect(result.serviceFeeAmount).toBe(7500);
    expect(result.subtotalAmount).toBe(150000);
    expect(result.totalAmount).toBe(165400);
  });

  it("adds up exactly to the printed total", () => {
    const sum = result.items.reduce((total, item) => total + item.price, 0);
    expect(sum + result.taxAmount! + result.serviceFeeAmount! + result.roundOffAmount!).toBe(result.totalAmount);
    expect(result.totalsMismatch).toBeNull();
    expect(result.overallConfidence).toBe("high");
  });

  it("reads the same on a tilted photo", () => {
    const tilted = parseReceipt(receipt(RESTAURANT, { tilt: 0.05 }))!;
    expect(tilted.items).toEqual(result.items);
    expect(tilted.totalAmount).toBe(result.totalAmount);
  });
});

describe("parseReceipt: other layouts", () => {
  it("handles a bill with no header and only line totals", () => {
    const result = parseReceipt(
      receipt([["Cafe Mocha House"], ["Cold Coffee", "150.00"], ["Sandwich", "120.00"], ["Total", "270.00"]]),
    )!;
    expect(result.items.map((item) => [item.name, item.price, item.quantity])).toEqual([
      ["Cold Coffee", 15000, 1],
      ["Sandwich", 12000, 1],
    ]);
    expect(result.totalsMismatch).toBeNull();
  });

  it("reads a quantity and a line total, keeping the printed line total", () => {
    const [item] = parseReceipt(receipt([["Item", "Qty", "Amount"], ["Tea", "3", "100.00"], ["Total", "100.00"]]))!.items;
    expect(item).toEqual({ name: "Tea", price: 10000, quantity: 3, confidence: "high" });
  });

  it("works out quantity from a rate and a line total", () => {
    const [item] = parseReceipt(receipt([["Item", "Rate", "Amount"], ["Naan", "55.00", "220.00"], ["Total", "220.00"]]))!.items;
    expect(item).toEqual({ name: "Naan", price: 22000, quantity: 4, confidence: "high" });
  });

  it("reads a whole line held in one cell", () => {
    const [item] = parseReceipt(receipt([["Paneer Tikka 2 x 180.00 360.00"], ["Total 360.00"]]))!.items;
    expect(item).toEqual({ name: "Paneer Tikka", price: 36000, quantity: 2, confidence: "high" });
  });

  it("drops serial numbers, and keeps numbers that belong to a name", () => {
    const [item] = parseReceipt(
      receipt([["S.No", "Item", "Qty", "Rate", "Amount"], ["1", "Soap 75G", "2", "40.00", "80.00"], ["Total", "80.00"]]),
    )!.items;
    expect(item).toEqual({ name: "Soap 75G", price: 8000, quantity: 2, confidence: "high" });
  });

  it("keeps a plain number inside the name cell", () => {
    const [item] = parseReceipt(receipt([["Item", "Qty", "Amount"], ["Pepsi 500", "2", "90.00"], ["Total", "90.00"]]))!.items;
    expect(item.name).toBe("Pepsi 500");
    expect(item.quantity).toBe(2);
  });

  it("reads a leading quantity", () => {
    const [item] = parseReceipt(receipt([["2 Masala Dosa", "240.00"], ["Total", "240.00"]]))!.items;
    expect(item).toEqual({ name: "Masala Dosa", price: 24000, quantity: 2, confidence: "high" });
  });

  it("joins a name printed above its numbers", () => {
    const [item] = parseReceipt(
      receipt([["Item", "Qty", "Rate", "Amount"], ["Hyderabadi Chicken Biryani"], ["2", "300.00", "600.00"], ["Total", "600.00"]]),
    )!.items;
    expect(item).toEqual({ name: "Hyderabadi Chicken Biryani", price: 60000, quantity: 2, confidence: "high" });
  });

  it("reads an amount printed on the row after its label", () => {
    expect(parseReceipt(receipt([["Tea", "80.00"], ["GRAND TOTAL"], ["80.00"]]))!.totalAmount).toBe(8000);
  });

  it("understands labels that lost their spaces", () => {
    const result = parseReceipt(
      receipt([["Tea", "100.00"], ["SubTotal", "100.00"], ["ServiceCharge", "5.00"], ["GRANDTOTAL", "105.00"]]),
    )!;
    expect(result.subtotalAmount).toBe(10000);
    expect(result.serviceFeeAmount).toBe(500);
    expect(result.totalAmount).toBe(10500);
  });

  it("uses Indian digit grouping and rupee marks", () => {
    const result = parseReceipt(receipt([["Party Platter", "₹1,25,000.50"], ["Grand Total", "Rs.1,25,000.50"]]))!;
    expect(result.items[0].price).toBe(12500050);
    expect(result.totalAmount).toBe(12500050);
  });
});

describe("parseReceipt: charges", () => {
  it("takes a discount off the total", () => {
    const result = parseReceipt(receipt([["Thali", "500.00"], ["Discount 10%", "-50.00"], ["Net Amount", "450.00"]]))!;
    expect(result.discountAmount).toBe(5000);
    expect(result.totalsMismatch).toBeNull();
  });

  it("keeps a negative round-off's sign", () => {
    const result = parseReceipt(receipt([["Thali", "500.50"], ["Round Off", "-0.50"], ["Grand Total", "500.00"]]))!;
    expect(result.roundOffAmount).toBe(-50);
    expect(result.discountAmount).toBeNull();
    expect(result.taxAmount).toBeNull();
    expect(result.totalsMismatch).toBeNull();
  });

  it("works out an unsigned round-off's direction from the total", () => {
    const result = parseReceipt(receipt([["Thali", "500.50"], ["Round Off", "0.50"], ["Grand Total", "500.00"]]))!;
    expect(result.roundOffAmount).toBe(-50);
    expect(result.totalsMismatch).toBeNull();
  });

  it("uses a tax total rather than adding it to its parts", () => {
    const result = parseReceipt(
      receipt([["Thali", "100.00"], ["CGST", "2.50"], ["SGST", "2.50"], ["Total Tax", "5.00"], ["Grand Total", "105.00"]]),
    )!;
    expect(result.taxAmount).toBe(500);
    expect(result.totalsMismatch).toBeNull();
  });

  it("doesn't add tax that the prices already include", () => {
    const result = parseReceipt(receipt([["Shirt", "1050.00"], ["GST included", "50.00"], ["Grand Total", "1050.00"]]))!;
    expect(result.taxAmount).toBeNull();
    expect(result.taxIncludedAmount).toBe(5000);
    expect(result.totalsMismatch).toBeNull();
  });

  it("handles a total that says it includes tax, with CGST and SGST listed", () => {
    const result = parseReceipt(
      receipt([["Toast", "1160.00"], ["CGST", "27.62"], ["SGST", "27.62"], ["TOTAL INCL. OF ALL TAX", "1160.00"]]),
    )!;
    expect(result.totalAmount).toBe(116000);
    expect(result.taxAmount).toBeNull();
    expect(result.taxIncludedAmount).toBe(5524);
    expect(result.totalsMismatch).toBeNull();
  });

  it("reads tax written as \"Incl. GST\" as tax, not as an item", () => {
    const result = parseReceipt(receipt([["Shirt", "1050.00"], ["Incl. GST", "50.00"], ["Grand Total", "1050.00"]]))!;
    expect(result.items.map((item) => item.name)).toEqual(["Shirt"]);
    expect(result.taxIncludedAmount).toBe(5000);
    expect(result.totalsMismatch).toBeNull();
  });

  it("still ignores a GST number, with or without a space", () => {
    for (const label of ["GSTIN: 29ABCDE1234F1Z5", "GSTIN29ABCDE1234F1Z5"]) {
      const result = parseReceipt(receipt([[label], ["Thali", "100.00"], ["Total", "100.00"]]))!;
      expect(result.items.map((item) => item.name)).toEqual(["Thali"]);
      expect(result.taxAmount).toBeNull();
    }
  });

  it("reports no included tax on an ordinary bill", () => {
    const result = parseReceipt(receipt([["Thali", "100.00"], ["GST", "5.00"], ["Grand Total", "105.00"]]))!;
    expect(result.taxAmount).toBe(500);
    expect(result.taxIncludedAmount).toBeNull();
  });

  it("uses the final total, not the pre-tax one", () => {
    const result = parseReceipt(receipt([["Thali", "100.00"], ["Total", "100.00"], ["GST", "5.00"], ["Grand Total", "105.00"]]))!;
    expect(result.totalAmount).toBe(10500);
    expect(result.subtotalAmount).toBe(10000);
  });

  it("reads tips", () => {
    const result = parseReceipt(receipt([["Thali", "100.00"], ["Tip", "20.00"], ["Total", "120.00"]]))!;
    expect(result.tipAmount).toBe(2000);
    expect(result.totalsMismatch).toBeNull();
  });
});

describe("parseReceipt: things that must not become items or totals", () => {
  const rows = [
    ["Spice Garden"],
    ["Bengaluru 560001"],
    ["Ph: 9876543210"],
    ["GSTIN: 29ABCDE1234F1Z5"],
    ["FSSAI 11223344556677"],
    ["Bill No 4821"],
    ["Table 7"],
    ["Pax 4"],
    ["Tea", "80.00"],
    ["Total Qty", "2"],
    ["Total Items", "1"],
    ["Total", "80.00"],
    ["Cash", "100.00"],
    ["Change", "20.00"],
  ];

  it("ignores contact details, IDs, counts and payments", () => {
    const result = parseReceipt(receipt(rows))!;
    expect(result.items.map((item) => item.name)).toEqual(["Tea"]);
    expect(result.totalAmount).toBe(8000);
    expect(result.taxAmount).toBeNull();
  });

  it("ignores everything after the final total, including a GST summary", () => {
    const result = parseReceipt(
      receipt([["Tea", "100.00"], ["GST", "5.00"], ["Grand Total", "105.00"], ["CGST", "2.50"], ["SGST", "2.50"], ["Extra Line", "999.00"]]),
    )!;
    expect(result.items).toHaveLength(1);
    expect(result.taxAmount).toBe(500);
  });

  it("reads a long plain total, not a count printed beside it", () => {
    const result = parseReceipt(receipt([["Banquet", "123585.00"], ["4 Total", "123585"]]))!;
    expect(result.totalAmount).toBe(12358500);
    expect(result.totalsMismatch).toBeNull();
  });

  it("doesn't let payment lines replace the total", () => {
    const result = parseReceipt(receipt([["Tea", "80.00"], ["Total", "80.00"], ["Total Paid", "100.00"], ["Total Saved", "5.00"]]))!;
    expect(result.totalAmount).toBe(8000);
  });

  it("ignores a count row, even misread", () => {
    const result = parseReceipt(receipt([["Tea", "80.00"], ["Total", "80.00"], ["TOTAL OTY", "2 ITEM", "2 PCS"]]))!;
    expect(result.totalAmount).toBe(8000);
  });

  it("ignores a quantity row written with decimals", () => {
    const result = parseReceipt(receipt([["Tea", "80.00"], ["Total Qty", "5.00"], ["Total", "80.00"]]))!;
    expect(result.totalAmount).toBe(8000);
  });

  it("accepts a total that mentions its item count", () => {
    const result = parseReceipt(receipt([["Tea", "1200.00"], ["Total (2 items)", "1200.00"]]))!;
    expect(result.totalAmount).toBe(120000);
  });

  it("still refuses a PIN code as an item's price", () => {
    const result = parseReceipt(receipt([["Bengaluru", "560001"], ["Tea", "80.00"], ["Total", "80.00"]]))!;
    expect(result.items.map((item) => item.name)).toEqual(["Tea"]);
  });

  it("skips free items", () => {
    const result = parseReceipt(receipt([["Tea", "100.00"], ["Free Water", "0.00"], ["Total", "100.00"]]))!;
    expect(result.items.map((item) => item.name)).toEqual(["Tea"]);
  });

  it("returns null when the photo isn't a bill", () => {
    expect(parseReceipt([])).toBeNull();
    expect(parseReceipt(receipt([["Hello world"], ["No prices here"]]))).toBeNull();
  });
});

describe("parseReceipt: dishes that look like labels", () => {
  it.each([
    "Paneer Tikka",
    "Cashew Curry",
    "Cardamom Tea",
    "Phulka",
    "Vatana Usal",
    "Date Shake",
    "Table Water",
    "Tipsy Cola",
    "Lessi Sweet",
    "Disco Fries",
    "Changezi Chicken",
    "Orderly Thali",
    "Timepass Chaat",
    "Taxi Special",
  ])("keeps %s as an item", (name) => {
    const result = parseReceipt(receipt([["Item", "Amount"], [name, "120.00"], ["Total", "120.00"]]))!;
    expect(result.items).toEqual([{ name, price: 12000, quantity: 1, confidence: "high" }]);
    expect(result.totalsMismatch).toBeNull();
  });
});

describe("parseReceipt: never hiding doubt", () => {
  it("uses the shared rule that a gap under 50 paise is rounding noise", () => {
    expect(parseReceipt(receipt([["Thali", "500.30"], ["Grand Total", "500.00"]]))!.totalsMismatch).toBeNull();
    expect(parseReceipt(receipt([["Thali", "500.50"], ["Grand Total", "500.00"]]))!.totalsMismatch?.delta).toBe(50);
  });

  it("flags a totals mismatch with the exact difference", () => {
    const result = parseReceipt(receipt([["Thali", "500.00"], ["Grand Total", "550.00"]]))!;
    expect(result.totalsMismatch).toEqual({ itemsSum: 50000, extractedTotal: 55000, delta: -5000 });
    expect(result.overallConfidence).toBe("low");
  });

  it("marks hard-to-read text as low confidence", () => {
    const result = parseReceipt(receipt([["Thali", "500.00"], ["Total", "500.00"]], { confidence: 0.6 }))!;
    expect(result.items[0].confidence).toBe("low");
    expect(result.overallConfidence).toBe("low");
  });

  it("marks numbers that don't multiply out as low confidence", () => {
    const [item] = parseReceipt(receipt([["Item", "Qty", "Rate", "Amount"], ["Tea", "2", "50.00", "130.00"], ["Total", "130.00"]]))!.items;
    expect(item.confidence).toBe("low");
    expect(item.price).toBe(13000);
    expect(item.quantity).toBe(2);
  });

  it("is low confidence with no total, and leaves the total empty", () => {
    const result = parseReceipt(receipt([["Thali", "500.00"]]))!;
    expect(result.totalAmount).toBeNull();
    expect(result.totalsMismatch).toBeNull();
    expect(result.overallConfidence).toBe("low");
  });

  it("doesn't correct a misread digit", () => {
    const result = parseReceipt(receipt([["Thali", "5OO.00"], ["Total", "500.00"]]))!;
    expect(result.items).toEqual([]);
    expect(result.totalAmount).toBe(50000);
    expect(result.overallConfidence).toBe("low");
  });

  it("only ever returns whole paise", () => {
    const result = parseReceipt(receipt(RESTAURANT))!;
    const amounts = [...result.items.map((item) => item.price), result.taxAmount!, result.totalAmount!];
    expect(amounts.every(Number.isInteger)).toBe(true);
  });
});
