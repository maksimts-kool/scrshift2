// Builds the portable companion for non-dev users: a zip with node.exe, the
// realtime scripts and playwright inside, started by Start Companion.bat —
// download, unzip, double-click; no git/npm/Node install needed.
//
//   npm run package:companion   ->  dist-companion/SCR-Companion.zip
//
// The zip is published as a GitHub release asset; the site's real-time
// banner links to .../releases/latest/download/SCR-Companion.zip, so keep
// the file name stable when uploading new versions.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-companion");
const app = path.join(out, "SCR-Companion");
const companion = path.join(app, "companion");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(companion, { recursive: true });

// the running Node's own exe becomes the bundled runtime (official,
// Authenticode-signed, works standalone)
fs.copyFileSync(process.execPath, path.join(companion, "node.exe"));

for (const f of ["server.mjs", "api.mjs", "scr-session.mjs"]) {
  fs.copyFileSync(path.join(root, "scripts", "realtime", f), path.join(companion, f));
}

// playwright + playwright-core are the companion's only dependencies
for (const pkg of ["playwright", "playwright-core"]) {
  fs.cpSync(path.join(root, "node_modules", pkg), path.join(companion, "node_modules", pkg), {
    recursive: true,
    dereference: true,
  });
}

// batch files want CRLF; keep everything ASCII so cmd.exe reads it cleanly
const crlf = (s) => s.replaceAll("\n", "\r\n");

fs.writeFileSync(
  path.join(app, "Start Companion.bat"),
  crlf(`@echo off
title SCR real-time companion
echo Starting the SCR real-time companion...
echo (First run opens a browser window - sign in with YOUR Roblox account.)
echo.
"%~dp0companion\\node.exe" "%~dp0companion\\server.mjs"
echo.
pause
`),
);

fs.writeFileSync(
  path.join(app, "README.txt"),
  crlf(`SCR real-time companion (Windows)
=================================

A small local helper for https://scrshift2.vercel.app. It reads YOUR live
driving from the SCR Hub site (stepfordcountyrailway.co.uk) so the shift
generator can follow you in real time. It runs only on this PC, uses your
own Roblox login, and shares nothing with anyone.

How to use
1. Double-click "Start Companion.bat" and leave the window open.
   (If Windows shows a security warning: More info -> Run anyway.
   The included node.exe is the official Node.js runtime.)
2. Open https://scrshift2.vercel.app and switch "Real time" on.
   If the browser asks permission to reach local devices, allow it.
3. First time only: a browser window opens - sign in with your Roblox
   account. The login is saved for next time (on this PC only).

Change account: the "Change account" button on the site's green banner.
Stop: close the companion window.

Needs Google Chrome or Microsoft Edge (Edge comes with Windows).
Source code: https://github.com/maksimts-kool/scrshift2
`),
);

// Compress-Archive rather than tar: which tar.exe wins on PATH varies (GNU
// tar has no zip; bsdtar sometimes stores instead of deflating)
const zip = path.join(out, "SCR-Companion.zip");
const res = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    "Compress-Archive -Path 'SCR-Companion' -DestinationPath 'SCR-Companion.zip' -Force",
  ],
  { cwd: out, stdio: "inherit" },
);
if (res.status !== 0) {
  console.error("zip step failed (PowerShell Compress-Archive)");
  process.exit(1);
}

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`built ${zip} (${mb(zip)} MB)`);
