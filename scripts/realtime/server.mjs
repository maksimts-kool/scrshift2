#!/usr/bin/env node
// Standalone real-time companion for a deployed (static) frontend.
//
// Run it on the PC where you play:   npm run rt
// The deployed site knocks on http://127.0.0.1:8788 when "Real time" is
// switched on and connects to this process. First run opens Chrome for a
// Roblox login; afterwards the session lives in .scr-session/ and reconnects
// silently.
//
// Env:
//   RT_PORT          port to listen on (default 8788 — the frontend probes
//                    this exact port, so only change it together with
//                    VITE_RT_API_BASE)
//   RT_HOST          bind address (default 127.0.0.1; keep it loopback unless
//                    you really mean to expose your SCR activity)
//   RT_ALLOW_ORIGIN  comma-separated allowed origins; replaces the default
//                    https://*.vercel.app wildcard (localhost always works)
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRtApi } from "./api.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.RT_PORT || 8788);
const host = process.env.RT_HOST || "127.0.0.1";
const allowOrigins = process.env.RT_ALLOW_ORIGIN
  ? process.env.RT_ALLOW_ORIGIN.split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  : undefined;

const api = createRtApi({
  profileDir: path.join(projectRoot, ".scr-session"),
  allowOrigins,
});

const server = http.createServer((req, res) => {
  void api.handle(req, res).then(
    (handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("scrshift2 real-time companion — endpoints live under /api/rt/");
      }
    },
    (e) => {
      res.statusCode = 500;
      res.end(String(e?.message ?? e));
    },
  );
});

server.listen(port, host, () => {
  console.log(`SCR real-time companion listening on http://${host}:${port}`);
  console.log(`Open the site and switch "Real time" on — it connects by itself.`);
  console.log("Ctrl+C stops it (and closes the Chrome session).");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void api.close().finally(() => process.exit(0));
  });
}
