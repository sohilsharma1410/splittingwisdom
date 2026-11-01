import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server/{src,dist}/lib -> repo root -> client/dist
const DEFAULT_CLIENT_DIST = fileURLToPath(new URL("../../../client/dist", import.meta.url));
const API_PATH = /^\/api(\/|$)/;

/**
 * Serves the built client from this API (plan P3.3), so the Pi has one origin
 * for the PWA and /api. Off unless SERVE_CLIENT=true: Render stays API-only.
 *
 * Call before the session middleware, so loading the app's files never touches
 * the session store.
 */
export function installClientServing(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if ((env.SERVE_CLIENT ?? "").trim().toLowerCase() !== "true") return;

  const root = path.resolve(env.CLIENT_DIST_DIR || DEFAULT_CLIENT_DIST);
  if (!existsSync(path.join(root, "index.html"))) {
    throw new Error(`SERVE_CLIENT=true but there is no built client at ${root}. Run the client build first.`);
  }

  const files = express.static(root, {
    index: false,
    setHeaders: (res, filePath) => {
      // Vite content-hashes everything in assets/, so those can be kept forever.
      // The rest keep their names across deploys (index.html, sw.js, the manifest)
      // and must be revalidated, or a new version would never reach installed PWAs.
      const hashed = path.relative(root, filePath).startsWith(`assets${path.sep}`);
      res.setHeader("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });

  app.use((req, res, next) => {
    if (API_PATH.test(req.path)) {
      next();
      return;
    }
    files(req, res, next);
  });

  // SPA fallback: an app route like /bill/12 loads the app, which then routes it.
  // A missing file (anything with an extension) stays a real 404 rather than
  // answering with HTML under a script or image URL.
  app.use((req, res, next) => {
    const isPageRequest = req.method === "GET" || req.method === "HEAD";
    if (!isPageRequest || API_PATH.test(req.path) || path.extname(req.path)) {
      next();
      return;
    }
    res.sendFile("index.html", { root, headers: { "Cache-Control": "no-cache" } }, (err) => {
      if (err) next(err);
    });
  });
}
