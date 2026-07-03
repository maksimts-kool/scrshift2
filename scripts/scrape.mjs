// Scrapes route data from the SCR unofficial wiki (scr.fandom.com) into src/data/routes.json.
// Re-run with `npm run scrape` whenever the game gets new routes.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://scr.fandom.com/api.php";
const UA = "SCRShiftGenerator/1.0 (route data scraper for a fan-made shift planner)";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "routes.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWikitext(title, attempt = 1) {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = json?.parse?.wikitext?.["*"];
    if (!text) throw new Error(json?.error?.info ?? "no wikitext in response");
    const redirect = text.match(/^#REDIRECT \[\[(.+?)\]\]/i);
    if (redirect) return fetchWikitext(redirect[1], attempt);
    return text;
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return fetchWikitext(title, attempt + 1);
    }
    throw new Error(`${title}: ${err.message}`);
  }
}

// Station identity comes from the link TARGET, not the display text, so that
// "[[Stepford United Football Club|Stepford UFC]]" and "[[Stepford United
// Football Club]]" resolve to the same name across pages.
// "[[Benton Bridge (Station)|Benton Bridge]]" -> "Benton Bridge"
function linkText(link) {
  const m = link.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (!m) return null;
  return m[1].replace(/\s*\((S|s)tation\)\s*$/, "").replace(/_/g, " ").trim();
}

function parseRouteList(wikitext) {
  const sections = [
    ...wikitext.matchAll(/^==\s*\{\{Op\|\w\}\}\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\] routes\s*==/gm),
  ];
  const routes = [];
  for (let i = 0; i < sections.length; i++) {
    const operator = sections[i][1].trim();
    const start = sections[i].index;
    const end = wikitext.indexOf("\n==", start + 2); // next section of any level
    const body = wikitext.slice(start, end === -1 ? undefined : end);
    for (const row of body.split(/\n\|-/)) {
      if (!row.includes("{{Colourbox|C|")) continue; // only currently-available routes
      const cells = row.split(/\n\|/).filter((c) => c !== "");
      const ci = cells.findIndex((c) => c.includes("{{Colourbox|C|"));
      if (ci === -1 || cells.length < ci + 8) continue;
      const code = linkText(cells[ci + 1]);
      // strip "<br>''alt name''" and "(via [[X]])" so the last link is the real terminus
      const odCell = cells[ci + 2].split("<br>")[0].replace(/\(via\s[^)]*\)/gi, "");
      const links = [...odCell.matchAll(/\[\[[^\]]+\]\]/g)].map((m) => linkText(m[0]));
      const time = cells[ci + 3].match(/(\d+)(?:\s*-\s*(\d+))?/);
      if (!code || links.length < 2 || !time) {
        console.warn(`  ! skipped row in ${operator}: ${row.slice(0, 80).replace(/\n/g, " ")}`);
        continue;
      }
      routes.push({
        code,
        operator,
        origin: links[0],
        destination: links[links.length - 1],
        timeMin: Number(time[1]),
        timeMax: Number(time[2] ?? time[1]),
        cost: cells[ci + 4].replace(/<[^>]+>/g, "").trim(),
        points: Number(cells[ci + 5]) || 0,
        xp: Number(cells[ci + 7]) || 0,
      });
    }
  }
  return routes;
}

// Parse the ==Route== section wikitable: one row per station with cumulative
// travel times from each end. Returns [{name, fromOrigin, fromDestination}].
function parseCallsFromRouteTable(wikitext) {
  const section = wikitext.match(/==\s*Route\s*==([\s\S]*?)(\n==[^=]|$)/);
  if (!section) return null;
  const table = section[1].match(/\{\|[\s\S]*?\n\|\}/);
  if (!table) return null;
  const calls = [];
  // strip the closing "|}" so it doesn't become a bogus trailing cell of the last row
  const tableText = table[0].replace(/\n\|\}\s*$/, "");
  for (const row of tableText.split(/\n\|-/)) {
    const cells = row.split(/\n\|/).slice(1);
    if (cells.length < 3) continue;
    const first = cells[0]
      .replace(/^\s*style="[^"]*"\s*\|\s*/, "")
      .replace(/<\/?center>/g, "")
      .trim();
    if (!first.startsWith("[[")) continue;
    const name = linkText(first);
    if (!name) continue;
    const timeOf = (cell) => {
      if (!cell) return null;
      if (/starting point/i.test(cell)) return 0;
      const m = cell.match(/(\d+)\s*(?:-\s*\d+\s*)?min/i) ?? cell.match(/(\d+)/);
      return m ? Number(m[1]) : null;
    };
    calls.push({
      name,
      fromOrigin: timeOf(cells[cells.length - 2]),
      fromDestination: timeOf(cells[cells.length - 1]),
    });
  }
  return calls.length >= 2 ? calls : null;
}

// Fallback: station entries in the infobox BS-map diagram (BHF/HST icons are
// stations; DST/BST are depots and sidings).
function parseCallsFromDiagram(wikitext) {
  const calls = [];
  for (const line of wikitext.split("\n")) {
    const m = line.match(/^\{\{BS\d?\|([^|]*(?:\|[^|[]*)*?)\|*\[\[([^\]]+)\]\]/);
    if (!m) continue;
    const icons = line.slice(0, line.indexOf("[[")); // template params before the label
    if (!/(BHF|HST)/.test(icons)) continue;
    if (/(DST|BST)/.test(icons)) continue;
    const name = linkText(`[[${m[2]}]]`);
    if (name && !calls.some((c) => c.name === name)) {
      calls.push({ name, fromOrigin: null, fromDestination: null });
    }
  }
  return calls.length >= 2 ? calls : null;
}

function parseInfoboxColor(wikitext) {
  const m = wikitext.match(/\|title_background\s*=\s*(#?[0-9A-Fa-f]{6})/);
  return m ? (m[1].startsWith("#") ? m[1] : `#${m[1]}`) : null;
}

const listText = await fetchWikitext("List of Routes");
const routes = parseRouteList(listText);
console.log(`Parsed ${routes.length} active routes from List of Routes`);

const colorVotes = {}; // operator -> {color: count}
let tableHits = 0, diagramHits = 0, misses = 0;

for (const route of routes) {
  await sleep(150);
  try {
    const text = await fetchWikitext(route.code);
    const color = parseInfoboxColor(text);
    if (color) {
      (colorVotes[route.operator] ??= {})[color] =
        (colorVotes[route.operator]?.[color] ?? 0) + 1;
    }
    let calls = parseCallsFromRouteTable(text);
    if (calls) tableHits++;
    else {
      calls = parseCallsFromDiagram(text);
      if (calls) diagramHits++;
    }
    if (!calls) {
      misses++;
      console.warn(`  ! no calls parsed for ${route.code} (${route.origin} <> ${route.destination})`);
      calls = [
        { name: route.origin, fromOrigin: 0, fromDestination: route.timeMin },
        { name: route.destination, fromOrigin: route.timeMin, fromDestination: 0 },
      ];
    }
    // The table/diagram is written origin-top; make sure it matches the list's origin.
    if (
      calls[0].name !== route.origin &&
      calls[calls.length - 1].name === route.origin
    ) {
      calls.reverse();
      for (const c of calls) [c.fromOrigin, c.fromDestination] = [c.fromDestination, c.fromOrigin];
    }
    route.calls = calls;
    console.log(`  ${route.code}: ${calls.length} calls`);
  } catch (err) {
    misses++;
    console.warn(`  ! ${err.message}`);
    route.calls = [
      { name: route.origin, fromOrigin: 0, fromDestination: route.timeMin },
      { name: route.destination, fromOrigin: route.timeMin, fromDestination: 0 },
    ];
  }
}

const operators = [...new Set(routes.map((r) => r.operator))].map((name) => {
  const votes = Object.entries(colorVotes[name] ?? {});
  votes.sort((a, b) => b[1] - a[1]);
  return { name, color: votes[0]?.[0] ?? "#888888" };
});

const data = {
  scrapedAt: new Date().toISOString(),
  source: "https://scr.fandom.com/wiki/List_of_Routes",
  operators,
  routes,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(
  `\nWrote ${routes.length} routes to ${OUT}\n` +
    `calls from Route table: ${tableHits}, from diagram: ${diagramHits}, termini-only fallback: ${misses}`
);
console.log("operators:", operators.map((o) => `${o.name} ${o.color}`).join(", "));
