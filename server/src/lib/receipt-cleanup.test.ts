import { describe, expect, it } from "vitest";
import { MIN_AGE_MS, planCleanup, type ReceiptFile } from "./receipt-cleanup.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const old = (path: string): ReceiptFile => ({ path, createdAt: new Date(NOW - MIN_AGE_MS - 1000).toISOString() });
const recent = (path: string): ReceiptFile => ({ path, createdAt: new Date(NOW - 1000).toISOString() });
const many = (count: number, prefix = "o") => Array.from({ length: count }, (_, i) => old(`1/${prefix}${i}.jpg`));

describe("planCleanup", () => {
  it("finds old photos that no bill uses", () => {
    const plan = planCleanup({ files: [old("1/a.jpg"), old("1/b.jpg")], referencedPaths: ["1/a.jpg"], billCount: 1, now: NOW });
    expect(plan.orphans.map((f) => f.path)).toEqual(["1/b.jpg"]);
    expect(plan.refusal).toBeNull();
  });

  it("keeps a recent photo, because someone may still be on the review screen", () => {
    const plan = planCleanup({ files: [recent("1/a.jpg")], referencedPaths: [], billCount: 1, now: NOW });
    expect(plan.orphans).toEqual([]);
  });

  it("keeps a photo exactly at the age limit", () => {
    const file = { path: "1/a.jpg", createdAt: new Date(NOW - MIN_AGE_MS).toISOString() };
    expect(planCleanup({ files: [file], referencedPaths: [], billCount: 1, now: NOW }).orphans).toEqual([]);
  });

  it("keeps a photo whose date can't be read", () => {
    const file = { path: "1/a.jpg", createdAt: "not a date" };
    expect(planCleanup({ files: [file], referencedPaths: [], billCount: 1, now: NOW }).orphans).toEqual([]);
  });

  it("refuses when the database has no bills, even with --force", () => {
    for (const force of [false, true]) {
      const plan = planCleanup({ files: [old("1/a.jpg")], referencedPaths: [], billCount: 0, now: NOW, force });
      expect(plan.refusal).toContain("no bills");
    }
  });

  it("has nothing to refuse when an empty database has no old photos", () => {
    expect(planCleanup({ files: [recent("1/a.jpg")], referencedPaths: [], billCount: 0, now: NOW }).refusal).toBeNull();
  });

  it("refuses to delete most photos at once, unless forced", () => {
    const orphans = many(21);
    const used = many(5, "u");
    const input = { files: [...orphans, ...used], referencedPaths: used.map((f) => f.path), billCount: 5, now: NOW };
    expect(planCleanup(input).refusal).toContain("21 of 26");
    expect(planCleanup({ ...input, force: true }).refusal).toBeNull();
  });

  it("allows a large delete when it's a minority of the photos", () => {
    const orphans = many(21);
    const used = many(30, "u");
    const plan = planCleanup({ files: [...orphans, ...used], referencedPaths: used.map((f) => f.path), billCount: 30, now: NOW });
    expect(plan.refusal).toBeNull();
    expect(plan.orphans).toHaveLength(21);
  });

  it("allows a small delete even when it's every abandoned photo", () => {
    const plan = planCleanup({ files: many(20), referencedPaths: [], billCount: 1, now: NOW });
    expect(plan.refusal).toBeNull();
  });
});
