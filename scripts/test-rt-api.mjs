// HTTP-contract tests for the hosted real-time API. The session is not started:
// validation, CORS, and protected control routes all respond before activity IO.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRtApi } from "./realtime/api.mjs";

process.env.RT_ROBLOSECURITY = "test-cookie-not-used";
const allowedOrigin = "https://scrshift2.vercel.app";
const api = createRtApi({
  profileDir: ".test-rt-profile",
  allowOrigins: [allowedOrigin],
  mode: "hosted",
});
const server = createServer((req, res) => void api.handle(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}/api/rt`;

try {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200, "serves a container health check without browser IO");
  assert.deepEqual(await health.json(), { ok: true, mode: "hosted" });

  const rejected = await fetch(`${base}/status`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(rejected.status, 403, "rejects unknown browser origins");

  const preflight = await fetch(`${base}/activity`, {
    method: "OPTIONS",
    headers: { Origin: allowedOrigin },
  });
  assert.equal(preflight.status, 204, "accepts configured CORS preflight");
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);

  const stop = await fetch(`${base}/stop`, {
    method: "POST",
    headers: { Origin: allowedOrigin },
  });
  assert.equal(stop.status, 403, "public clients cannot stop the hosted browser");

  const change = await fetch(`${base}/change-account`, {
    method: "POST",
    headers: { Origin: allowedOrigin },
  });
  assert.equal(change.status, 403, "public clients cannot change the service account");

  const invalidUser = await fetch(`${base}/activity?username=no%20spaces`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(invalidUser.status, 400, "rejects malformed usernames before session IO");

  console.log("test-rt-api: all assertions passed");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await api.close();
}
