// Real-time companion: owns a persistent Chrome profile logged into the SCR
// Hub site (stepfordcountyrailway.co.uk) and reads a player's CurrentActivity
// page. The page is Blazor WebAssembly — activity data is NOT in the initial
// HTML, it renders client-side and live-updates over the site's own SignalR
// push. So we keep ONE rendered page open per tracked player and read its DOM
// on demand instead of re-fetching (fresher, and gentler on their servers).
//
// Auth model (discovered by probing):
// - SCR session cookie is session-scoped: it dies when the browser closes.
// - The Roblox session in the profile is long-lived. Re-establishing the SCR
//   session is a silent two-click OAuth: "Continue" -> "Confirm and Give
//   Access" on authorize.roblox.com, which we click through headlessly.
// - Only when the Roblox session itself is dead do we need the user: we then
//   relaunch Chrome headed so they can log in once (profile keeps it).
import { chromium } from "playwright";

const SCR = "https://stepfordcountyrailway.co.uk";

/** @typedef {"stopped"|"launching"|"authorizing"|"need-login"|"booting"|"ready"|"error"} Phase */

export function createScrSession({ profileDir }) {
  /** @type {import("playwright").BrowserContext | null} */
  let ctx = null;
  /** @type {import("playwright").Page | null} */
  let page = null;
  let headed = false;
  /** @type {Phase} */
  let phase = "stopped";
  let error = null;
  let user = null; // { id, name, displayName }
  let trackedId = null;
  let starting = null; // in-flight start() promise
  let expectClose = false; // suppress the "window closed" error on our own close()
  let lastReloadAt = 0; // throttle self-healing reloads

  const activityUrl = (id) => `${SCR}/Players/${id}/CurrentActivity`;

  async function launch(headless) {
    ctx = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless,
      viewport: headless ? undefined : null,
    });
    headed = !headless;
    // keep loads light; the tracked page doesn't need images/fonts
    await ctx.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });
    ctx.on("close", () => {
      ctx = null;
      page = null;
      if (!expectClose && phase !== "stopped") {
        phase = "error";
        error = "Browser window was closed.";
      }
    });
    page = ctx.pages()[0] ?? (await ctx.newPage());
  }

  async function close() {
    const c = ctx;
    expectClose = true;
    ctx = null;
    page = null;
    if (c) await c.close().catch(() => {});
    expectClose = false;
  }

  /** Click through the silent OAuth steps; true when back on the SCR site. */
  async function clickThroughOAuth() {
    for (let i = 0; i < 6; i++) {
      // the redirect chain hops through roblox.com interstitials — let it
      // settle on either the SCR site or the authorize page before judging,
      // otherwise a mid-redirect URL reads as "needs real login"
      await page
        .waitForURL((u) => `${u}`.startsWith(SCR) || `${u}`.includes("authorize.roblox.com"), {
          timeout: 15_000,
        })
        .catch(() => {});
      const url = page.url();
      if (url.startsWith(SCR)) return true;
      if (!url.includes("authorize.roblox.com")) return false; // needs real login
      const btn = page
        .locator("button:visible")
        .filter({ hasText: /^continue$|confirm and give access/i })
        .first();
      try {
        await btn.waitFor({ state: "visible", timeout: 20_000 });
        await btn.click();
      } catch {
        // no button showed — the page may have auto-redirected meanwhile
        return page.url().startsWith(SCR);
      }
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    return page.url().startsWith(SCR);
  }

  /** Who is logged in to Roblox in this profile (works even if SCR session died). */
  async function whoami() {
    const res = await ctx.request.get(
      "https://users.roblox.com/v1/users/authenticated",
    );
    if (!res.ok()) return null;
    return await res.json(); // { id, name, displayName }
  }

  /** Navigate to the tracked player's activity page, re-authing as needed. */
  async function gotoActivity(id) {
    await page.goto(activityUrl(id), { waitUntil: "load", timeout: 60_000 });
    if (page.url().startsWith(SCR)) return true;
    phase = "authorizing";
    if (await clickThroughOAuth()) {
      if (!page.url().includes("/CurrentActivity")) {
        await page.goto(activityUrl(id), { waitUntil: "load", timeout: 60_000 });
      }
      return page.url().startsWith(SCR);
    }
    return false;
  }

  /**
   * Wait for the Blazor WASM component to render *completely*. Station and
   * operator names are separate reference-data lookups that hydrate a few
   * seconds AFTER the timeline itself, so waiting for the timeline text is
   * not enough — wait for a station link with actual text in it.
   */
  async function waitForComponent() {
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText;
          if (/Nothing to see here/i.test(t)) return true;
          const a = document.querySelector('.card a[href^="/Stations/"]');
          return !!a && (a.textContent ?? "").trim().length > 0;
        },
        { timeout: 45_000 },
      )
      .catch(() => {});
  }

  /** A parse that rendered before reference data arrived (or a dead page). */
  function isHollow(parsed) {
    if (parsed.state === "unknown") return true;
    if (parsed.state !== "driving") return false;
    const s = parsed.service;
    return (
      !s.origin ||
      !s.destination ||
      s.calls.length === 0 ||
      s.calls.some((c) => !c.station)
    );
  }

  async function doStart() {
    try {
      error = null;
      phase = "launching";
      if (!ctx) await launch(true);
      user = await whoami();
      if (!user) {
        // Roblox session is dead — need a visible window for a real login.
        phase = "need-login";
        await close();
        await launch(false);
        await page.goto(activityUrl(1), { waitUntil: "load", timeout: 60_000 });
        const deadline = Date.now() + 10 * 60_000;
        while (Date.now() < deadline) {
          if (!ctx) throw new Error("Browser window was closed during login.");
          if (page.url().startsWith(SCR)) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
        if (!page.url().startsWith(SCR)) {
          throw new Error("Timed out waiting for the Roblox login (10 min).");
        }
        user = await whoami();
        if (!user) throw new Error("Logged in, but Roblox whoami still fails.");
      }
      trackedId = user.id;
      phase = "authorizing";
      if (!(await gotoActivity(trackedId))) {
        throw new Error(`Could not open ${activityUrl(trackedId)} (stuck on ${page.url()}).`);
      }
      phase = "booting";
      await waitForComponent();
      phase = "ready";
    } catch (e) {
      phase = "error";
      error = e?.message ?? String(e);
      await close().catch(() => {});
    } finally {
      starting = null;
    }
  }

  return {
    getStatus() {
      return { phase, user, trackedId, headed, error };
    },

    /** Idempotent: kicks off the session if not already up. */
    start() {
      if (phase === "ready" && ctx) return Promise.resolve();
      if (!starting) starting = doStart();
      return starting;
    },

    async stop() {
      phase = "stopped";
      error = null;
      await close();
    },

    /**
     * Forget the saved Roblox + SCR sessions and restart. With the cookies
     * gone whoami() fails, so doStart() falls into its headed-login flow and
     * whoever signs in to Roblox next becomes the tracked account.
     */
    changeAccount() {
      if (starting) return starting; // a boot is in flight; let it finish
      starting = (async () => {
        phase = "launching";
        error = null;
        user = null;
        trackedId = null;
        await close();
        try {
          await launch(true);
          await ctx.clearCookies();
        } catch (e) {
          phase = "error";
          error = e?.message ?? String(e);
          await close().catch(() => {});
          return;
        }
        await close();
        await doStart();
      })();
      return starting;
    },

    /**
     * Read the tracked player's current activity from the live page DOM.
     * `playerId` (optional) switches tracking to another player.
     */
    async getActivity(playerId) {
      if (phase !== "ready" || !ctx) {
        throw new Error(`Session not ready (phase: ${phase}${error ? `, ${error}` : ""})`);
      }
      // default to the logged-in account; ?player= overrides are per-request
      // and must not change what the app follows afterwards
      const id = playerId ?? user?.id ?? trackedId;
      const wantUrl = activityUrl(id);
      if (!page.url().startsWith(wantUrl)) {
        // navigated away, session bounced, or tracking switched
        if (!(await gotoActivity(id))) {
          throw new Error(`Lost the SCR session (stuck on ${page.url()}).`);
        }
        trackedId = id;
        await waitForComponent();
      }
      let parsed = await page.evaluate(parseActivityDom);
      if (isHollow(parsed) && Date.now() - lastReloadAt > 20_000) {
        // reference data never hydrated (e.g. the page's push connection
        // died while idle) — a reload heals it
        lastReloadAt = Date.now();
        await page.reload({ waitUntil: "load", timeout: 60_000 }).catch(() => {});
        await waitForComponent();
        parsed = await page.evaluate(parseActivityDom);
      }
      return {
        ...parsed,
        playerId: id,
        capturedAt: new Date().toISOString(),
      };
    },

    /** Debug helper: raw DOM of the activity component as the page sees it. */
    async getDebugHtml() {
      if (!page) throw new Error("no page");
      return await page.evaluate(() => {
        const card = document.querySelector('.card[class*="border-"]');
        const table = document.querySelector("table.transport-timeline");
        return {
          url: location.href,
          card: card?.outerHTML ?? null,
          firstRows: table
            ? [...table.querySelectorAll("tr")].slice(0, 4).map((r) => r.outerHTML)
            : null,
        };
      });
    },
  };
}

/**
 * Runs INSIDE the browser page. Parses the rendered PlayerCurrentRoleTask
 * component. DOM reference (captured 2026-07): service card is
 * `div.card.border-drivers` with a `.fs-5` route line, icon-tagged spans
 * (compass=operator+code, train-front=stock, hash=unit, speedometer=speed) and
 * `.fs-4` status. Timeline is `table.transport-timeline`; passed rows use
 * `text-success`, the current stop carries a train icon in `td.divider`, and
 * an "En-route to X" row precedes the next stop while moving.
 */
function parseActivityDom() {
  const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const TIME = /\d{1,2}:\d{2}(?::\d{2})?/;

  const bodyText = document.body.innerText;
  const ukClock = clean(
    document.querySelector("nav .font-monospace")?.textContent,
  ).match(TIME)?.[0] ?? null;

  /** strip the rank badge ("GD", "TD", ...) glued in front of player names */
  const playerName = (el) => {
    if (!el) return null;
    const rank = el.querySelector(".rank-sign")?.textContent ?? "";
    const t = clean(el.textContent);
    return rank && t.startsWith(rank) ? clean(t.slice(rank.length)) : t;
  };
  const player = playerName(document.querySelector(".h2 .ms-2")) ?? null;

  const base = { player, ukClock };
  if (/Nothing to see here/i.test(bodyText)) return { ...base, state: "offline" };

  const card = document.querySelector('.card[class*="border-"]');
  const cardBody = card?.querySelector(".card-body");
  if (!card || !cardBody) return { ...base, state: "unknown" };

  const cls = card.className;
  if (!/border-drivers/.test(cls)) {
    const role = /border-dispatchers/.test(cls)
      ? "dispatching"
      : /border-guards/.test(cls)
        ? "guarding"
        : /border-signallers/.test(cls)
          ? "signalling"
          : "other";
    return {
      ...base,
      state: "other-role",
      role,
      description: clean(cardBody.querySelector(".fs-4, .fs-5")?.textContent),
    };
  }

  // ---- driving: service card ----
  const routeLine = cardBody.querySelector(".fs-5");
  const ends = [...(routeLine?.querySelectorAll('a[href^="/Stations/"]') ?? [])].map(
    (a) => clean(a.textContent),
  );
  const spanWith = (icon) =>
    [...cardBody.querySelectorAll("span")].find((s) =>
      s.querySelector(`.bi-${icon}`),
    );
  const opSpan = spanWith("compass");
  const operator = clean(opSpan?.querySelector("span")?.textContent) || null;
  let routeCode = null;
  if (opSpan) {
    const t = clean(opSpan.textContent);
    routeCode = clean(operator ? t.replace(operator, "") : t) || null;
  }
  const statusEl = cardBody.querySelector(".fs-4");

  const service = {
    headcode: clean(routeLine?.querySelector(".badge")?.textContent) || null,
    operator,
    routeCode,
    origin: ends[0] ?? null,
    destination: ends[1] ?? null,
    train: clean(spanWith("train-front")?.textContent) || null,
    unit: clean(spanWith("hash")?.textContent).replace(/^Unit\s*/i, "") || null,
    speedMph:
      Number.parseInt(clean(spanWith("speedometer")?.textContent), 10) || null,
    status: clean(statusEl?.textContent) || null,
    nextStation:
      clean(statusEl?.querySelector('a[href^="/Stations/"]')?.textContent) || null,
    notices: /** @type {string[]} */ ([]),
    enRouteTo: null,
    calls: /** @type {any[]} */ ([]),
  };

  // ---- timeline ----
  for (const tr of document.querySelectorAll("table.transport-timeline tr")) {
    const detail = tr.querySelector("td.detail");
    if (!detail) continue;
    const detailText = clean(detail.textContent);

    const nameSpan = detail.querySelector(":scope > span.fw-bold");
    const stationA = nameSpan?.querySelector('a[href^="/Stations/"]');
    if (!stationA) {
      if (/^En-route to/i.test(detailText)) {
        service.enRouteTo =
          clean(detail.querySelector('a[href^="/Stations/"]')?.textContent) ||
          clean(detailText.replace(/^En-route to/i, ""));
      } else if (detailText) {
        service.notices.push(detailText); // e.g. "This service is running 1 minute late."
      }
      continue;
    }

    const timeTd = tr.querySelector("td.time");
    const timeRaw = clean(timeTd?.textContent);
    const struck = clean(
      timeTd?.querySelector("s, del, [style*='line-through'], .text-decoration-line-through")
        ?.textContent,
    ).match(TIME)?.[0] ?? null;
    const est = timeRaw.match(/Est\.?\s*(\d{1,2}:\d{2})/i)?.[1] ?? null;
    const allTimes = timeRaw.match(new RegExp(TIME.source, "g")) ?? [];
    const scheduled = struck ?? allTimes.find((t) => t !== est) ?? null;

    const passed =
      !!timeTd?.querySelector(".text-success") ||
      nameSpan.className.includes("text-success");
    const atStation = !!tr.querySelector("td.divider .bi-train-front");

    const call = {
      station: clean(stationA.textContent),
      platform:
        clean(detail.querySelector(":scope > span.ms-2")?.textContent).replace(
          /^Platform\s*/i,
          "",
        ) || null,
      scheduled,
      estimated: est,
      arrived: null,
      departed: null,
      delayMin: 0,
      dispatcher: null,
      notes: /** @type {string[]} */ ([]),
      state: atStation ? "current" : passed ? "passed" : "future",
    };

    for (const li of detail.querySelectorAll("li")) {
      const t = clean(li.textContent);
      const arr = t.match(/Arrived at (\d{1,2}:\d{2}(?::\d{2})?)/i);
      const dep = t.match(/Departed at (\d{1,2}:\d{2}(?::\d{2})?)/i);
      const delay = t.match(/Delay:\s*(\d+)\s*minute/i);
      if (arr) call.arrived = arr[1];
      if (dep) call.departed = dep[1];
      if (delay) call.delayMin = Math.max(call.delayMin, Number(delay[1]));
      if (/Dispatcher:/i.test(t)) {
        const a = li.querySelector("a");
        if (a) {
          const rank = a.querySelector(".rank-sign")?.textContent ?? "";
          const n = clean(a.textContent);
          call.dispatcher = rank && n.startsWith(rank) ? clean(n.slice(rank.length)) : n;
        }
      } else if (li.className.includes("text-warning") && !delay && !arr && !dep) {
        call.notes.push(t);
      }
    }
    // arrived but not yet departed = sitting at the platform right now
    if (call.state === "passed" && call.arrived && !call.departed) {
      call.state = "current";
    }
    service.calls.push(call);
  }

  return { ...base, state: "driving", service };
}
