// The real-time companion's HTTP surface (/api/rt/*), shared between the Vite
// dev-server plugin (same origin, `npm run dev`) and the standalone companion
// server (server.mjs) that a deployed frontend calls cross-origin.
//
//   GET  /api/rt/status          -> { phase, user, trackedId, headed, error }
//   POST /api/rt/start           -> kicks the session off (idempotent)
//   POST /api/rt/stop            -> closes the browser
//   POST /api/rt/change-account  -> forgets the saved login and reopens
//                                   Chrome for a fresh Roblox sign-in
//   GET  /api/rt/activity[?username=] -> parsed live activity for that player

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

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

export function createRtApi({ profileDir, allowOrigins, mode = "local" }) {
  let session = null; // lazily created ScrSession (see scr-session.mjs)
  const hosted = mode === "hosted";
  const userCache = new Map();
  const rateBuckets = new Map();

  const originAllowed = (origin) =>
    LOCAL_ORIGINS.some((re) => re.test(origin)) ||
    (allowOrigins ? allowOrigins.includes(origin) : VERCEL_ORIGIN.test(origin));

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };

  const publicStatus = (status) => ({
    ...status,
    mode,
    // The hosted service account is an implementation detail, not the player
    // selected in the frontend, and must not be exposed publicly.
    ...(hosted ? { user: null, trackedId: null, headed: false } : {}),
  });

  const getSession = async () => {
    if (!session) {
      const { createScrSession } = await import("./scr-session.mjs");
      session = createScrSession({
        profileDir,
        multiPlayer: hosted,
        robloxSecurity: hosted ? process.env.RT_ROBLOSECURITY : undefined,
      });
    }
    return session;
  };

  const checkRate = (req) => {
    if (!hosted) return true;
    const forwardedParts = `${req.headers["x-forwarded-for"] ?? ""}`
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // Proxies append their hops to the right; the first entry is the original
    // client address used for the public hosted-service rate limit.
    const forwarded = forwardedParts.at(0);
    const key = forwarded || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    if (rateBuckets.size > 5000) {
      for (const [candidate, value] of rateBuckets) {
        if (now - value.since >= 60_000) rateBuckets.delete(candidate);
      }
    }
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.since >= 60_000) {
      rateBuckets.set(key, { since: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= 60;
  };

  const resolveUsername = async (raw) => {
    const username = raw.trim();
    if (!USERNAME.test(username)) {
      const e = new Error("Enter a valid Roblox username (3–20 letters, numbers, or underscores).");
      e.statusCode = 400;
      throw e;
    }
    const key = username.toLowerCase();
    if (userCache.size > 5000) {
      for (const [candidate, value] of userCache) {
        if (value.expires <= Date.now()) userCache.delete(candidate);
      }
    }
    const cached = userCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.user;
    const response = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Roblox user lookup failed (${response.status}).`);
    const user = (await response.json()).data?.[0];
    if (!user) {
      const e = new Error(`Roblox user “${username}” was not found.`);
      e.statusCode = 404;
      throw e;
    }
    userCache.set(key, { user, expires: Date.now() + 60 * 60_000 });
    return user;
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

      if (!checkRate(req)) {
        res.setHeader("Retry-After", "60");
        json(res, 429, { error: "Too many real-time requests. Try again in a minute." });
        return true;
      }

      try {
        if (url.pathname === "/api/rt/health" && req.method === "GET") {
          // Liveness must not create a browser session: container platforms
          // call this frequently and should not restart us for a Hub outage.
          json(res, 200, { ok: true, mode });
          return true;
        }
        if (
          hosted &&
          ((url.pathname === "/api/rt/stop" && req.method === "POST") ||
            (url.pathname === "/api/rt/change-account" && req.method === "POST"))
        ) {
          json(res, 403, { error: "Hosted session controls are disabled." });
          return true;
        }
        if (hosted && url.pathname === "/api/rt/debug") {
          json(res, 404, { error: "unknown /api/rt endpoint" });
          return true;
        }
        let requestedUser = null;
        if (hosted && url.pathname === "/api/rt/activity" && req.method === "GET") {
          const username = url.searchParams.get("username");
          if (!username) {
            json(res, 400, { error: "A Roblox username is required." });
            return true;
          }
          requestedUser = await resolveUsername(username);
        }
        const current = await getSession();
        if (hosted && current.getStatus().phase === "stopped") void current.start();
        if (url.pathname === "/api/rt/status" && req.method === "GET") {
          json(res, 200, publicStatus(current.getStatus()));
        } else if (url.pathname === "/api/rt/start" && req.method === "POST") {
          if (!hosted) void current.start(); // hosted service owns its lifecycle
          json(res, 202, publicStatus(current.getStatus()));
        } else if (url.pathname === "/api/rt/stop" && req.method === "POST") {
          await current.stop();
          json(res, 200, publicStatus(current.getStatus()));
        } else if (url.pathname === "/api/rt/change-account" && req.method === "POST") {
          const { phase } = current.getStatus();
          if (phase === "launching" || phase === "authorizing" || phase === "booting") {
            json(res, 409, { error: `busy (${phase}) — try again in a moment` });
          } else {
            void current.changeAccount(); // async; poll /status for progress
            json(res, 202, publicStatus(current.getStatus()));
          }
        } else if (url.pathname === "/api/rt/activity" && req.method === "GET") {
          const username = url.searchParams.get("username");
          const user = requestedUser ?? (username ? await resolveUsername(username) : null);
          const player = url.searchParams.get("player");
          const playerId = user?.id ?? (player ? Number(player) : undefined);
          const activity = await current.getActivity(playerId);
          json(res, 200, { status: publicStatus(current.getStatus()), activity });
        } else if (url.pathname === "/api/rt/debug" && req.method === "GET") {
          json(res, 200, await current.getDebugHtml());
        } else {
          json(res, 404, { error: "unknown /api/rt endpoint" });
        }
      } catch (e) {
        json(res, e?.statusCode ?? 500, {
          error: e?.message ?? String(e),
          status: session ? publicStatus(session.getStatus()) : null,
        });
      }
      return true;
    },

    async close() {
      await session?.stop();
    },

    async start() {
      const current = await getSession();
      void current.start();
    },
  };
}
