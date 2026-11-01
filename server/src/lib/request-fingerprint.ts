import { createHash } from "node:crypto";

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces

/** JSON with object keys sorted recursively, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

export function fingerprintRequest(method: string, url: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()}\n${url}\n${canonicalJson(body)}`)
    .digest("hex");
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}
