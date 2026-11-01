import express from "express";
import request from "supertest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installClientServing } from "./serve-client.js";

let dist: string;

function appWithClient(env: NodeJS.ProcessEnv) {
  const app = express();
  installClientServing(app, env);
  app.get("/api/ping", (_req, res) => {
    res.json({ data: "pong" });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Not found." } });
  });
  return app;
}

describe("serving the built client", () => {
  beforeAll(async () => {
    dist = await mkdtemp(path.join(tmpdir(), "client-dist-"));
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "index.html"), "<html>app</html>");
    await writeFile(path.join(dist, "sw.js"), "// worker");
    await writeFile(path.join(dist, "manifest.webmanifest"), "{}");
    await writeFile(path.join(dist, "assets", "index-abc123.js"), "// bundle");
  });
  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  const enabled = () => appWithClient({ SERVE_CLIENT: "true", CLIENT_DIST_DIR: dist });

  it("does nothing unless SERVE_CLIENT=true, so Render stays API-only", async () => {
    const res = await request(appWithClient({})).get("/");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Not found.");
  });

  it("fails at startup when the client hasn't been built", () => {
    expect(() => appWithClient({ SERVE_CLIENT: "true", CLIENT_DIST_DIR: path.join(dist, "nope") })).toThrow(/no built client/);
  });

  it("serves the app at the root and on deep links", async () => {
    for (const url of ["/", "/bill/12", "/group/3/balances"]) {
      const res = await request(enabled()).get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain("app");
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("caches hashed assets forever, but never the service worker or manifest", async () => {
    const asset = await request(enabled()).get("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");

    for (const url of ["/sw.js", "/manifest.webmanifest"]) {
      const res = await request(enabled()).get(url);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("answers a missing file with 404, not with the app's HTML", async () => {
    const res = await request(enabled()).get("/assets/old-bundle.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<html>");
  });

  it("leaves /api alone, including unknown API routes", async () => {
    expect((await request(enabled()).get("/api/ping")).body.data).toBe("pong");
    for (const url of ["/api", "/api/does-not-exist"]) {
      const res = await request(enabled()).get(url);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe("Not found.");
    }
  });

  it("doesn't answer non-page methods with the app", async () => {
    const res = await request(enabled()).post("/bill/12");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<html>");
  });

  it("doesn't serve files outside the build folder", async () => {
    const res = await request(enabled()).get("/..%2f..%2fetc%2fpasswd");
    expect(res.status).not.toBe(200);
  });
});
