/**
 * drizzle-kit's CLI does `import("drizzle-orm/version")` to check
 * compatibility. That's a bare-specifier dynamic import, so Node resolves it
 * relative to drizzle-kit's own location (node_modules/drizzle-kit), which
 * only sees the repo root's node_modules — never server/ or shared/'s.
 *
 * npm won't hoist drizzle-orm to the root here: it's a direct dependency of
 * two workspaces (server, shared), and drizzle-orm's huge optional-peer list
 * (expo-sqlite, op-sqlite, etc., for React Native drivers we don't use)
 * makes a real root-level install conflict with our pinned React 18. So we
 * symlink it into place after every install instead.
 */
import { existsSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(rootDir, "node_modules", "drizzle-orm");
const source = path.join(rootDir, "server", "node_modules", "drizzle-orm");

if (!existsSync(target) && existsSync(source)) {
  symlinkSync(source, target, "dir");
  console.log("[link-drizzle-orm] symlinked node_modules/drizzle-orm -> server/node_modules/drizzle-orm");
}
