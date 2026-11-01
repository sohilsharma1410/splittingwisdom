import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createShutdown } from "./graceful-shutdown.js";

let server: Server;

/** A server whose /slow answers only when `release` is called. */
async function startServer() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requestArrived = () => {};
  const arrived = new Promise<void>((resolve) => {
    requestArrived = resolve;
  });
  server = createServer(async (req, res) => {
    if (req.url === "/slow") {
      requestArrived();
      await held;
    }
    res.end("done");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, release: () => release(), arrived };
}

function fetchBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get({ port, path, host: "127.0.0.1" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

describe("graceful shutdown", () => {
  it("finishes the running request before cleaning up and exiting", async () => {
    const { port, release, arrived } = await startServer();
    const events: string[] = [];
    const shutdown = createShutdown({
      server,
      cleanup: [() => void events.push("cleanup")],
      exit: (code) => void events.push(`exit ${code}`),
    });

    const inFlight = fetchBody(port, "/slow");
    await arrived;
    const finished = shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([]);

    release();
    expect(await inFlight).toBe("done");
    await finished;
    expect(events).toEqual(["cleanup", "exit 0"]);
  });

  it("refuses new connections once shutdown has started", async () => {
    const { port, release, arrived } = await startServer();
    const shutdown = createShutdown({ server, cleanup: [], exit: () => {} });
    const inFlight = fetchBody(port, "/slow");
    await arrived;
    const finished = shutdown("SIGTERM");

    await expect(fetchBody(port, "/")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    release();
    await inFlight;
    await finished;
  });

  it("gives up on a stuck request after the timeout", async () => {
    const { port, arrived } = await startServer();
    const exits: number[] = [];
    const shutdown = createShutdown({ server, cleanup: [], timeoutMs: 50, exit: (code) => void exits.push(code) });
    const inFlight = fetchBody(port, "/slow").catch(() => "cut off");
    await arrived;
    await shutdown("SIGTERM");
    expect(await inFlight).toBe("cut off");
    expect(exits).toEqual([0]);
  });

  it("runs the remaining cleanup when one step fails, and exits non-zero", async () => {
    await startServer();
    const events: string[] = [];
    const shutdown = createShutdown({
      server,
      cleanup: [
        () => {
          throw new Error("pool already closed");
        },
        () => void events.push("second step"),
      ],
      exit: (code) => void events.push(`exit ${code}`),
    });
    await shutdown("SIGTERM");
    expect(events).toEqual(["second step", "exit 1"]);
  });

  it("acts only once when a second signal arrives", async () => {
    await startServer();
    const exits: number[] = [];
    const shutdown = createShutdown({ server, cleanup: [], exit: (code) => void exits.push(code) });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(exits).toEqual([0]);
  });
});
