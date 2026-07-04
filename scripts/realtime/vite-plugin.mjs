// Vite dev-server plugin: exposes the real-time SCR companion on /api/rt/*.
// Only exists on the dev server — a static production deployment has no
// backend, so the app feature-detects these endpoints and hides the switch.
//
//   GET  /api/rt/status            -> { phase, user, trackedId, headed, error }
//   POST /api/rt/start             -> kicks the session off (idempotent)
//   POST /api/rt/stop              -> closes the browser
//   GET  /api/rt/activity[?player=]-> parsed live activity for the tracked
//                                     (or overridden) player
import path from "node:path";

export function scrRealtimePlugin() {
  let session = null; // lazily created ScrSession (see scr-session.mjs)

  return {
    name: "scr-realtime",
    apply: "serve",
    configureServer(server) {
      const profileDir = path.resolve(server.config.root, ".scr-session");

      const json = (res, status, body) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };

      server.middlewares.use("/api/rt", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          if (!session) {
            const { createScrSession } = await import("./scr-session.mjs");
            session = createScrSession({ profileDir });
          }
          if (url.pathname === "/status" && req.method === "GET") {
            return json(res, 200, session.getStatus());
          }
          if (url.pathname === "/start" && req.method === "POST") {
            void session.start(); // async boot; poll /status for progress
            return json(res, 202, session.getStatus());
          }
          if (url.pathname === "/stop" && req.method === "POST") {
            await session.stop();
            return json(res, 200, session.getStatus());
          }
          if (url.pathname === "/activity" && req.method === "GET") {
            const player = url.searchParams.get("player");
            const activity = await session.getActivity(
              player ? Number(player) : undefined,
            );
            return json(res, 200, { status: session.getStatus(), activity });
          }
          if (url.pathname === "/debug" && req.method === "GET") {
            return json(res, 200, await session.getDebugHtml());
          }
          return json(res, 404, { error: "unknown /api/rt endpoint" });
        } catch (e) {
          return json(res, 500, {
            error: e?.message ?? String(e),
            status: session?.getStatus() ?? null,
          });
        }
      });

      server.httpServer?.on("close", () => {
        void session?.stop();
      });
    },
  };
}
