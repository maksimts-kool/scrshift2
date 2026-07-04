// The real-time companion's HTTP surface (/api/rt/*), shared between the Vite
// dev-server plugin (same origin, `npm run dev`) and the standalone companion
// server (server.mjs) that a deployed frontend calls cross-origin.
//
//   GET  /api/rt/status          -> { phase, user, trackedId, headed, error }
//   POST /api/rt/start           -> kicks the session off (idempotent)
//   POST /api/rt/stop            -> closes the browser
//   POST /api/rt/change-account  -> forgets the saved login and reopens
//                                   Chrome for a fresh Roblox sign-in
//   GET  /api/rt/activity[?player=] -> parsed live activity for the tracked
//                                   (or overridden) player

// Browsers only stop a disallowed origin from *reading* the response — the
// request itself still runs, and POSTs here open Chrome windows — so
// disallowed origins are rejected outright. Localhost (any port) is always
// allowed; *.vercel.app covers the deployed frontend unless an explicit
// allowOrigins list replaces it.
const LOCAL_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];
const VERCEL_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i;

export function createRtApi({ profileDir, allowOrigins }) {
  let session = null; // lazily created ScrSession (see scr-session.mjs)

  const originAllowed = (origin) =>
    LOCAL_ORIGINS.some((re) => re.test(origin)) ||
    (allowOrigins ? allowOrigins.includes(origin) : VERCEL_ORIGIN.test(origin));

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  return {
    /** Handles /api/rt/* requests; false = not ours (caller should 404/next). */
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/rt/")) return false;

      const origin = req.headers.origin;
      if (origin) {
        if (!originAllowed(origin)) {
          json(res, 403, { error: `origin ${origin} not allowed` });
          return true;
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        // CORS preflight; Chrome adds a private-network round when a public
        // (https) page calls a localhost companion
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          req.headers["access-control-request-headers"] ?? "Content-Type",
        );
        if (req.headers["access-control-request-private-network"] === "true") {
          res.setHeader("Access-Control-Allow-Private-Network", "true");
        }
        res.setHeader("Access-Control-Max-Age", "600");
        res.statusCode = 204;
        res.end();
        return true;
      }

      try {
        if (!session) {
          const { createScrSession } = await import("./scr-session.mjs");
          session = createScrSession({ profileDir });
        }
        if (url.pathname === "/api/rt/status" && req.method === "GET") {
          json(res, 200, session.getStatus());
        } else if (url.pathname === "/api/rt/start" && req.method === "POST") {
          void session.start(); // async boot; poll /status for progress
          json(res, 202, session.getStatus());
        } else if (url.pathname === "/api/rt/stop" && req.method === "POST") {
          await session.stop();
          json(res, 200, session.getStatus());
        } else if (url.pathname === "/api/rt/change-account" && req.method === "POST") {
          const { phase } = session.getStatus();
          if (phase === "launching" || phase === "authorizing" || phase === "booting") {
            json(res, 409, { error: `busy (${phase}) — try again in a moment` });
          } else {
            void session.changeAccount(); // async; poll /status for progress
            json(res, 202, session.getStatus());
          }
        } else if (url.pathname === "/api/rt/activity" && req.method === "GET") {
          const player = url.searchParams.get("player");
          const activity = await session.getActivity(player ? Number(player) : undefined);
          json(res, 200, { status: session.getStatus(), activity });
        } else if (url.pathname === "/api/rt/debug" && req.method === "GET") {
          json(res, 200, await session.getDebugHtml());
        } else {
          json(res, 404, { error: "unknown /api/rt endpoint" });
        }
      } catch (e) {
        json(res, 500, {
          error: e?.message ?? String(e),
          status: session?.getStatus() ?? null,
        });
      }
      return true;
    },

    async close() {
      await session?.stop();
    },
  };
}
