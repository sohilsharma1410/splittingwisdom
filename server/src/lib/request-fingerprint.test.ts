import { describe, it, expect } from "vitest";
import { canonicalJson, fingerprintRequest, isValidIdempotencyKey } from "./request-fingerprint.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,2]},"b":1}');
  });

  it("ignores undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("handles scalars and undefined bodies", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(5)).toBe("5");
  });
});

describe("fingerprintRequest", () => {
  it("is stable under key reordering", () => {
    expect(fingerprintRequest("POST", "/api/bills", { a: 1, b: 2 })).toBe(
      fingerprintRequest("POST", "/api/bills", { b: 2, a: 1 }),
    );
  });

  it("changes with method, path or any body value", () => {
    const base = fingerprintRequest("POST", "/api/bills", { a: 1 });
    expect(fingerprintRequest("PUT", "/api/bills", { a: 1 })).not.toBe(base);
    expect(fingerprintRequest("POST", "/api/groups", { a: 1 })).not.toBe(base);
    expect(fingerprintRequest("POST", "/api/bills", { a: 2 })).not.toBe(base);
  });

  it("is case-insensitive on method only", () => {
    expect(fingerprintRequest("post", "/x", {})).toBe(fingerprintRequest("POST", "/x", {}));
    expect(fingerprintRequest("POST", "/X", {})).not.toBe(fingerprintRequest("POST", "/x", {}));
  });
});

describe("isValidIdempotencyKey", () => {
  it("accepts printable ASCII without spaces up to 255 chars", () => {
    expect(isValidIdempotencyKey("3f1c9a52-7d4e-4b8a-9c11-0a5e2d6f7b33")).toBe(true);
    expect(isValidIdempotencyKey("a".repeat(255))).toBe(true);
  });

  it("rejects empty, too long, spaces and control/non-ASCII characters", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("a".repeat(256))).toBe(false);
    expect(isValidIdempotencyKey("a b")).toBe(false);
    expect(isValidIdempotencyKey("a\nb")).toBe(false);
    expect(isValidIdempotencyKey("kéy")).toBe(false);
  });
});
