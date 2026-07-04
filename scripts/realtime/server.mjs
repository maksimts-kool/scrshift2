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
//   RT_PROFILE       browser-profile directory holding the saved login
//
// It also ships as a portable zip for non-dev users (npm run package:companion):
// node.exe + these scripts + playwright, started by Start Companion.bat.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRtApi } from "./api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
// repo checkout keeps the profile in .scr-session/ as always; the portable
// build has no repo around it, so the profile goes to %LOCALAPPDATA%
const inRepo = fs.existsSync(path.join(projectRoot, "package.json"));
const defaultProfile = inRepo
  ? path.join(projectRoot, ".scr-session")
  : path.join(process.env.LOCALAPPDATA || here, "scrshift2-companion", "profile");

const port = Number(process.env.RT_PORT || 8788);
const host = process.env.RT_HOST || "127.0.0.1";
const allowOrigins = process.env.RT_ALLOW_ORIGIN
  ? process.env.RT_ALLOW_ORIGIN.split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  : undefined;

const api = createRtApi({
  profileDir: process.env.RT_PROFILE || defaultProfile,
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

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Port ${port} is already in use — the companion is probably running`);
    console.log("in another window already. This one can be closed.");
  } else {
    console.log(`Could not start: ${e.message ?? e}`);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`SCR real-time companion listening on http://${host}:${port}`);
  console.log(`Open the site and switch "Real time" on — it connects by itself.`);
  console.log("Keep this window open while you play. Closing it stops real time.");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void api.close().finally(() => process.exit(0));
  });
}
