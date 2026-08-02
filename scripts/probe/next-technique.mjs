#!/usr/bin/env node
/**
 * Pick the next technique to build, deterministically.
 *
 * The loop must not re-litigate "what should I do next?" every iteration — that is a judgement
 * call the model would make slightly differently each time, producing drift and duplicated work.
 * It is a join, so it belongs in code:
 *
 *   techniques (explorer.html)  ×  measured capabilities  ×  recipes already on disk
 *
 * Ranking is by views, but a technique whose tools are MEASURED to work outranks one resting on
 * unprobed tools — building on an unmeasured primitive is how this project lost time before.
 *
 *   node scripts/probe/next-technique.mjs            # the single best next target
 *   node scripts/probe/next-technique.mjs --top 10
 *   node scripts/probe/next-technique.mjs --json
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const LIB = "/Users/samuelwilkinson/MAC_SHARE/AI-VIDEOS/70_TOOLING/premiere/premiere-library";
const RECIPES = "/Users/samuelwilkinson/.claude/skills/premiere-library/references/recipes";
const CAPS = join(ROOT, "probe-results/capabilities.json");

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TOP = Number(opt("top", 1));

/** Extract the brace-matched `const DATA = {...}` object from explorer.html. */
function loadTechniques() {
  const html = readFileSync(join(LIB, "explorer.html"), "utf8");
  const start = html.indexOf("const DATA");
  const open = html.indexOf("{", start);
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return JSON.parse(html.slice(open, end)).techniques || [];
}

const caps = existsSync(CAPS) ? JSON.parse(readFileSync(CAPS, "utf8")) : { tools: {} };
const verdictOf = (t) => caps.tools?.[t]?.verdict || "UNPROBED";

/**
 * Recipe filenames are kebab-case abbreviations of the technique sentence
 * ("source-monitor-subrange-edit" vs "Source Monitor in/out to edit a sub-range into the
 * timeline"), so substring matching misses every one of them and the loop would happily rebuild
 * work that already exists. Compare content-word SETS instead, and require a strong overlap.
 */
const STOP = new Set("the a an and or of to in on for with into as at by it its is are be from that this then so than".split(" "));
const tokens = (s) => new Set(
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
);

const builtSets = [];
if (existsSync(RECIPES)) {
  for (const f of readdirSync(RECIPES).filter((f) => f.endsWith(".md"))) {
    const body = readFileSync(join(RECIPES, f), "utf8").slice(0, 4000);
    const title = (body.match(/^#\s+Recipe[^\n]*?—\s*(.+)$/m) || [])[1] || "";
    builtSets.push({ name: f, set: tokens(f.replace(".md", "") + " " + title) });
  }
}
const alreadyBuilt = (t) => {
  const a = tokens(t.technique);
  if (!a.size) return false;
  for (const b of builtSets) {
    let hit = 0;
    for (const w of a) if (b.set.has(w)) hit++;
    // Two thirds of the recipe's own content words present, or half the technique's.
    if (hit >= Math.max(2, Math.ceil(b.set.size * 0.5)) || hit / a.size >= 0.5) return true;
  }
  return false;
};

const BLOCKING = new Set(["FABRICATES", "WEDGES", "ERRORED_BUT_MUTATED", "READ_MUTATES"]);

const rows = loadTechniques()
  .filter((t) => t.exec === "exactly")
  .filter((t) => !alreadyBuilt(t))
  .map((t) => {
    const tools = t.tools || [];
    const v = tools.map((x) => ({ tool: x, verdict: verdictOf(x) }));
    const works = v.filter((x) => x.verdict === "WORKS").length;
    const blocked = v.filter((x) => BLOCKING.has(x.verdict));
    const unprobed = v.filter((x) => x.verdict === "UNPROBED" || x.verdict === "UNWITNESSED");
    const coverage = tools.length ? works / tools.length : 0;
    // Views decide, but measured coverage breaks ties hard: an all-verified toolchain is worth
    // far more than a marginally more popular technique resting on unmeasured primitives.
    const score = (t.views || 0) * (0.35 + 0.65 * coverage) * (blocked.length ? 0.25 : 1);
    return { technique: t.technique, views: t.views || 0, tools: v, works, blocked, unprobed, coverage, score, summary: t.summary };
  })
  .sort((a, b) => b.score - a.score);

if (argv.includes("--json")) { console.log(JSON.stringify(rows.slice(0, TOP), null, 2)); process.exit(0); }

if (!rows.length) { console.log("No unbuilt exec:'exactly' techniques left."); process.exit(0); }

for (const r of rows.slice(0, TOP)) {
  console.log("─".repeat(94));
  console.log(`TECHNIQUE : ${r.technique}`);
  console.log(`VIEWS     : ${r.views.toLocaleString()}   measured tool coverage: ${(r.coverage * 100).toFixed(0)}%`);
  if (r.summary) console.log(`SUMMARY   : ${r.summary.slice(0, 240)}`);
  console.log(`TOOLS     :`);
  for (const t of r.tools) {
    const mark = { WORKS: "✅", FABRICATES: "🚨", WEDGES: "🛑", HONEST_ERROR: "⚠️ ", UNWITNESSED: "❔", UNPROBED: "· " }[t.verdict] || "· ";
    console.log(`             ${mark} ${t.verdict.padEnd(18)} ${t.tool}`);
  }
  if (r.blocked.length) console.log(`⚠️  BLOCKED ON : ${r.blocked.map((x) => `${x.tool} (${x.verdict})`).join(", ")} — route around these, do not build on them.`);
  if (r.unprobed.length) console.log(`❔ UNMEASURED : ${r.unprobed.map((x) => x.tool).join(", ")} — probe before trusting.`);
}
console.log("─".repeat(94));
