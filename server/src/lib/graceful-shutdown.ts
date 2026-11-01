import type { Server } from "node:http";
import { errorMessage, logEvent } from "../sync/log.js";

export interface ShutdownOptions {
  server: Server;
  /** Run in order once every request has finished. A failing step doesn't stop the rest. */
  cleanup: Array<() => void | Promise<void>>;
  /** Hard limit before giving up on slow requests. Keep below Docker's stop_grace_period. */
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/**
 * Plan P2.6: stop accepting connections, let running requests finish, close the
 * database pools, then exit, so `docker stop` never cuts off a write midway.
 * Returns the function to call on SIGTERM/SIGINT; only the first call acts.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { server, cleanup, timeoutMs = 20_000, exit = process.exit } = options;
  let started: Promise<void> | undefined;

  return (signal) => {
    if (started) return started;
    started = (async () => {
      logEvent("info", "shutdown_started", { signal });

      const forceTimer = setTimeout(() => {
        logEvent("warn", "shutdown_forced", { timeoutMs });
        server.closeAllConnections();
      }, timeoutMs);
      // A connection that finishes its request after close() stays open as
      // keep-alive, and the proxy in front of us would hold it for a long time.
      const idleSweep = setInterval(() => server.closeIdleConnections(), 250);

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      clearInterval(idleSweep);
      clearTimeout(forceTimer);

      let code = 0;
      for (const step of cleanup) {
        try {
          await step();
        } catch (err) {
          code = 1;
          logEvent("error", "shutdown_cleanup_failed", { error: errorMessage(err) });
        }
      }

      logEvent("info", "shutdown_complete", { code });
      exit(code);
    })();
    return started;
  };
}
