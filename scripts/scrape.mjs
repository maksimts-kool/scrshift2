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

// ---- Rolling stock ----------------------------------------------------------
// Each route's infobox has a free-text `rolling_stock` field listing which
// trains may run it ("All Stepford Connect trains except ...", "[[Class 345]]",
// "Diesel [[Waterline]] trains", ...). We turn that into an explicit set of
// allowed train ids so the generator can pick ONE train legal on every leg.
// The wiki's own train categories are the source of truth for operator + traction.

const OPERATORS = ["Stepford Connect", "Metro", "Waterline", "AirLink", "Stepford Express"];

async function categoryMembers(cat) {
  const url = `${API}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(
    "Category:" + cat,
  )}&cmlimit=500&cmtype=page&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for category ${cat}`);
  const json = await res.json();
  return (json.query?.categorymembers ?? []).map((x) => x.title);
}

// Drivable classes look like "Class 350"; drop families (Aventra, Desiro…),
// coaches, scenery locos (08, 66) and the 80x umbrella page.
const isClass = (n) => /^Class \d/.test(n) && !/^Class (08|66|80x)$/.test(n);
// "Class 350/1" and the category's "Class 350" are the same train for our
// purposes, so normalize the "/N" subclass suffix away for a stable identity.
const normClass = (raw) => "Class " + raw.replace(/^Class /, "").replace(/\/.*$/, "").trim();

function classesIn(chunk) {
  const out = [];
  for (const m of chunk.matchAll(/\[\[Class ([^\]|]+)(?:\|Class ([^\]]+))?\]\]/g)) {
    out.push(normClass(m[2] ?? m[1]));
  }
  return out;
}

// A class that comes in single and double formations splits into two ids so a
// route can exclude just the (double) — the game does this for platform length.
function idsForClass(cls, doubles, form) {
  if (!doubles.has(cls)) return [cls];
  if (form === "single") return [`${cls} (single)`];
  if (form === "double") return [`${cls} (double)`];
  return [`${cls} (single)`, `${cls} (double)`];
}

// Which classes have an excludable double variant, learned from the text itself.
function learnDoubleClasses(rawList) {
  const doubles = new Set();
  for (const rs of rawList) {
    const dv = rs.search(/double variants? of/i);
    if (dv !== -1) for (const c of classesIn(rs.slice(dv))) doubles.add(c);
    for (const m of rs.matchAll(/double\s+\[\[Class[^\]]*\]\]/gi))
      for (const c of classesIn(m[0])) doubles.add(c);
    for (const seg of rs.split(/,|&|<br\s*\/?>/i))
      if (/\((single|double)\)/i.test(seg)) for (const c of classesIn(seg)) doubles.add(c);
  }
  return doubles;
}

async function buildRoster() {
  const opMembers = {};
  for (const op of OPERATORS) {
    opMembers[op] = (await categoryMembers(`${op} Trains`)).filter(isClass);
    await sleep(150);
  }
  const diesel = new Set((await categoryMembers("Diesel Trains")).filter(isClass));
  await sleep(150);
  const bimode = new Set((await categoryMembers("Bi-Mode Trains")).filter(isClass));
  const roster = new Map(); // class -> { operators:Set, traction }
  for (const op of OPERATORS)
    for (const c of opMembers[op]) {
      if (!roster.has(c))
        roster.set(c, {
          operators: new Set(),
          traction: bimode.has(c) ? "bimode" : diesel.has(c) ? "diesel" : "electric",
        });
      roster.get(c).operators.add(op);
    }
  return roster;
}

function extractRollingStock(wikitext) {
  const m = wikitext.match(/\|\s*rolling_stock\s*=\s*([^\n]*(?:\n(?!\s*\|)[^\n]*)*)/i);
  if (!m) return "";
  return m[1]
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Turn one `rolling_stock` string into the list of allowed train ids.
function parseAllowedTrains(raw, roster, doubles) {
  const t = raw.replace(/\|origin=[\s\S]*$/i, "").trim(); // R063 trailed infobox junk
  const opInText = OPERATORS.find((op) => t.includes(`[[${op}]]`));
  const [basePart, exceptPart = ""] = /except/i.test(t) ? t.split(/except/i) : [t];
  const explicit = /^\s*\[\[Class/i.test(basePart.trim());
  const allowed = new Set();

  if (!explicit && (/^all\b/i.test(t.trim()) || opInText)) {
    // fleet: "All <Op> trains" / "Diesel <Op> trains" / "Diesel & bi-mode <Op> trains"
    const wantDiesel = /diesel/i.test(basePart);
    const wantBimode = /bi-?mode/i.test(basePart);
    for (const [c, info] of roster) {
      if (!info.operators.has(opInText)) continue;
      if (
        (wantDiesel || wantBimode) &&
        !((wantDiesel && info.traction === "diesel") || (wantBimode && info.traction === "bimode"))
      )
        continue;
      for (const id of idsForClass(c, doubles, "any")) allowed.add(id);
    }
  } else {
    // explicit list, e.g. "[[Class 220]] (single)<br>[[Class 221]] (single)..."
    for (const seg of basePart.split(/,|&|<br\s*\/?>/i)) {
      const cs = classesIn(seg);
      if (cs.length === 0) continue;
      const form = /\(single\)/i.test(seg) ? "single" : /\(double\)/i.test(seg) ? "double" : "any";
      for (const c of cs) for (const id of idsForClass(c, doubles, form)) allowed.add(id);
    }
  }

  if (exceptPart) {
    // classes in a "double" context lose only their (double); others go entirely.
    let rest = exceptPart;
    let doubleRegion = "";
    const dvIdx = rest.search(/double variants? of/i);
    if (dvIdx !== -1) {
      doubleRegion += " " + rest.slice(dvIdx);
      rest = rest.slice(0, dvIdx);
    }
    for (const m of rest.matchAll(/double\s+\[\[Class[^\]]*\]\]/gi)) doubleRegion += " " + m[0];
    rest = rest.replace(/double\s+\[\[Class[^\]]*\]\]/gi, " ");
    for (const c of classesIn(doubleRegion)) allowed.delete(`${c} (double)`);
    for (const c of classesIn(rest)) for (const id of idsForClass(c, doubles, "any")) allowed.delete(id);
    if (/HST/i.test(exceptPart))
      for (const id of [...allowed]) if (/^Class 43/.test(id)) allowed.delete(id);
  }
  return [...allowed];
}

// Readable version of the raw wiki text, for display in the app.
function cleanRollingStock(raw) {
  return raw
    .replace(/\|origin=[\s\S]*$/i, "")
    .replace(/\[\[:?[^\]|]*\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
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
    route._rollingStockRaw = extractRollingStock(text);
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

// Build the train roster from the wiki's categories, then resolve each route's
// rolling_stock text into the concrete train ids allowed on it.
console.log("\nFetching train roster from categories...");
const roster = await buildRoster();
const doubleClasses = learnDoubleClasses(routes.map((r) => r._rollingStockRaw ?? ""));

const trains = [];
for (const [cls, info] of roster) {
  const forms = doubleClasses.has(cls)
    ? [[`${cls} (single)`, "single"], [`${cls} (double)`, "double"]]
    : [[cls, null]];
  for (const [name, variant] of forms)
    trains.push({ name, class: cls, variant, operators: [...info.operators], traction: info.traction });
}
trains.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

let stockMisses = 0;
for (const route of routes) {
  const raw = route._rollingStockRaw ?? "";
  let allowed = raw ? parseAllowedTrains(raw, roster, doubleClasses) : [];
  if (allowed.length === 0) {
    // Unparseable/absent — fall back to the whole operator fleet so the route
    // stays usable rather than blocking every chain through it.
    if (raw) stockMisses++;
    allowed = trains.filter((t) => t.operators.includes(route.operator)).map((t) => t.name);
  }
  route.rollingStock = raw ? cleanRollingStock(raw) : "";
  route.allowedTrains = allowed;
  delete route._rollingStockRaw;
}
console.log(
  `Roster: ${trains.length} train ids (${doubleClasses.size} double-variant classes); ` +
    `rolling_stock fell back to operator fleet for ${stockMisses} route(s)`,
);

const data = {
  scrapedAt: new Date().toISOString(),
  source: "https://scr.fandom.com/wiki/List_of_Routes",
  operators,
  trains,
  routes,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(
  `\nWrote ${routes.length} routes to ${OUT}\n` +
    `calls from Route table: ${tableHits}, from diagram: ${diagramHits}, termini-only fallback: ${misses}`
);
console.log("operators:", operators.map((o) => `${o.name} ${o.color}`).join(", "));
