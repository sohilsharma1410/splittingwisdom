#!/usr/bin/env node
// A stand-in for the speech container (deploy/pi/stt) for tests and demos: no model, no network.
// Answers GET /health, and POST /transcribe with whatever is in the file named by FAKE_STT_FILE
// (default .localdb/fake-stt.txt), read fresh each time, so a test can "say" something by writing it.
// It also echoes the prompt it was given into <file>.prompt so tests can check what the app told it.
//   node scripts/fake-stt.mjs [port]      (default 4291)
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const port = Number(process.argv[2]) || 4291;
const file = process.env.FAKE_STT_FILE || ".localdb/fake-stt.txt";

createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") return json(200, { ok: true });
  if (req.method === "POST" && req.url === "/transcribe") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      writeFileSync(`${file}.prompt`, decodeURIComponent(req.headers["x-prompt"] ?? ""));
      writeFileSync(`${file}.bytes`, String(Buffer.concat(chunks).length));
      json(200, { text: existsSync(file) ? readFileSync(file, "utf8").trim() : "" });
    });
    return;
  }
  json(404, { error: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`fake speech service on ${port}`));
