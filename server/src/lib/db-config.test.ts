import { describe, expect, it } from "vitest";
import { databaseSslEnabled, databaseUsesPooler, postgresJsOptions } from "./db-config.js";

describe("database connection settings", () => {
  it("defaults to the Supabase pooler behaviour, so Render needs no new env vars", () => {
    expect(databaseSslEnabled({})).toBe(true);
    expect(databaseUsesPooler({})).toBe(true);
    expect(postgresJsOptions({})).toEqual({ prepare: false, ssl: { rejectUnauthorized: false } });
  });

  it("uses plain connections and prepared statements on the Pi", () => {
    const options = postgresJsOptions({ DATABASE_SSL: "off", DATABASE_POOLER: "false" });
    expect(options).toEqual({ prepare: true, connection: { TimeZone: "UTC" } }); // sessions write UTC even if the server runs in local time
  });

  it("leaves the startup parameter off behind Supabase's pooler, which already runs in UTC", () => {
    expect(postgresJsOptions({ DATABASE_POOLER: "true" })).not.toHaveProperty("connection");
  });

  it("treats an empty value as unset", () => {
    expect(databaseSslEnabled({ DATABASE_SSL: " " })).toBe(true);
  });

  it("rejects a typo instead of silently picking a mode", () => {
    expect(() => databaseSslEnabled({ DATABASE_SSL: "offf" })).toThrow(/DATABASE_SSL/);
    expect(() => databaseUsesPooler({ DATABASE_POOLER: "maybe" })).toThrow(/DATABASE_POOLER/);
  });
});
