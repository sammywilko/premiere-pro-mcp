#!/usr/bin/env node
/**
 * Capability prober — fires every registered tool at a live Premiere and records what ACTUALLY
 * happened, judged by independent observation rather than by the tool's own report.
 *
 * Why observation and not self-report: this bridge's defining failure mode is fabricated success
 * (`applied:1` for a nonsense effect, `razored:3` with nothing razored, `moved:true` on a no-op).
 * A prober that believed tool responses would emit a confident capability map that is wrong in
 * exactly the places that already burned us — worse than no map, because it would be trusted.
 *
 * It talks to the CEP bridge DIRECTLY (file transport), not through MCP. Three consequences:
 *   - no /mcp reconnect tax, which is the project's real velocity limit;
 *   - it exercises the freshly built dist/ helpers, so a probe run doubles as live verification;
 *   - it bypasses the `unsafe-script` capability gate, which is deliberate — that gate exists so
 *     an LLM cannot run arbitrary script through MCP. A prober an operator runs on purpose is the
 *     gate's intended escape hatch, but say so out loud rather than let it look accidental.
 *
 * Usage:
 *   node scripts/probe/probe.mjs --scratch "PROBE-SCRATCH"        # T0 reads + T1 writes
 *   node scripts/probe/probe.mjs --scratch "..." --reads-only
 *   node scripts/probe/probe.mjs --scratch "..." --destructive --slow
 *   node scripts/probe/probe.mjs --scratch "..." --resume
 */

import { readdirSync, existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "probe-results");

const { buildToolScript } = await import(pathToFileURL(join(ROOT, "dist/bridge/script-builder.js")).href);
const { sendCommand, getTempDir } = await import(pathToFileURL(join(ROOT, "dist/bridge/file-bridge.js")).href);

import { classify, enabledTiers, TIER, DENY, isWitnessed, witnessDomain } from "./classify.mjs";

/** Sam's real assembly. The prober must never be pointed at it, and must prove it survived. */
const PROTECTED_SEQUENCE_ID = "bdda4d9d-76a9-4cf1-ab26-44b5ce57e349";
const PROTECTED_EXPECTED_CLIPS = 146;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const SCRATCH = opt("scratch");
const TIERS = enabledTiers({
  write: !flag("reads-only"),
  destructive: flag("destructive"),
  slow: flag("slow"),
});
const bridge = { tempDir: getTempDir(), timeoutMs: Number(opt("timeout", 30000)) };

if (!SCRATCH) { console.error("ERROR: --scratch <sequence name> is required."); process.exit(2); }
mkdirSync(OUT_DIR, { recursive: true });
const JOURNAL = join(OUT_DIR, "journal.jsonl");

// ---------------------------------------------------------------- raw observation

/**
 * Run an ExtendScript snippet for observation. Returns parsed data or {__error}.
 *
 * 🛑 The transport reports SYNTAX errors as SUCCESS. A runtime error is caught by the generated
 * IIFE's try/catch and comes back honestly as {success:false}; a PARSE failure never reaches that
 * try/catch, so ExtendScript's evalScript returns the literal string "EvalScript error." and the
 * bridge wraps it as {success:true, data:"EvalScript error."}.
 *
 * Left unhandled this is fatal to the prober specifically: every snapshot would "succeed" with an
 * identical string, so pre === post for every tool, and every single write would be scored LIES.
 * A confidently inverted capability map is the exact failure this whole exercise exists to prevent.
 */
async function observe(code) {
  try {
    const res = await sendCommand(buildToolScript(code), bridge);
    if (!res || !res.success) return { __error: (res && res.error) || "unknown" };
    if (typeof res.data === "string" && /EvalScript error/i.test(res.data)) {
      return { __error: "EvalScript error (SYNTAX error in the probe script — check for ES3 reserved words used as property names, e.g. protected/export/class/final)" };
    }
    if (res.data === null || res.data === undefined) return { __error: "empty response" };
    return res.data;
  } catch (e) {
    return { __error: String(e && e.message ? e.message : e) };
  }
}

async function ping() {
  const d = await observe(`return __result({ ok: true, seq: app.project.activeSequence ? app.project.activeSequence.name : null, project: app.project.name });`);
  return d && !d.__error ? d : null;
}

/**
 * Compact digest of everything a tool could plausibly disturb. Deliberately cheap — it runs
 * twice per tool, ~560 times a run. Clip identity includes geometry, name, enabled and speed so
 * a mutation that swaps WHICH clip changed is still visible, not just that a count moved.
 */
const SNAPSHOT = `
var seq = app.project.activeSequence;
var out = { seqId: seq ? seq.sequenceID : null, seqName: seq ? seq.name : null, v: [], a: [],
            items: 0, seqCount: 0, vTracks: 0, aTracks: 0, seqMarkers: 0, seqIn: null, seqOut: null,
            srcMon: null };
/**
 * The digest defines what "changed" MEANS, so anything missing from it makes the verdict engine
 * blind — and a blind engine reports a working tool as LIES, which is the single most damaging
 * output this prober could produce. First write pass did exactly that: add_marker and
 * color_correct scored LIES purely because markers and components were not in here.
 * Per clip: geometry, identity, enabled, speed, EFFECT COUNT and MARKER COUNT.
 */
function digest(track) {
  var s = [];
  for (var c = 0; c < track.clips.numItems; c++) {
    var k = track.clips[c];
    var sp = 1; try { sp = k.getSpeed(); } catch (e) {}
    var nComp = -1; try { nComp = k.components ? k.components.numItems : -1; } catch (e) {}
    var nMark = -1; try { nMark = k.markers ? k.markers.numMarkers : -1; } catch (e) {}
    var comps = ""; try {
      for (var q = 0; q < k.components.numItems; q++) comps += k.components[q].matchName + ",";
    } catch (e) {}
    s.push(k.nodeId + "|" + k.name + "|" + k.start.ticks + "|" + k.end.ticks + "|" +
           k.inPoint.ticks + "|" + k.outPoint.ticks + "|" + (k.disabled ? 0 : 1) + "|" + sp +
           "|c" + nComp + "|m" + nMark + "|" + comps);
  }
  return s.join(";");
}
if (seq) {
  out.vTracks = seq.videoTracks.numTracks;
  out.aTracks = seq.audioTracks.numTracks;
  for (var t = 0; t < seq.videoTracks.numTracks; t++) out.v.push(digest(seq.videoTracks[t]));
  for (var u = 0; u < seq.audioTracks.numTracks; u++) out.a.push(digest(seq.audioTracks[u]));
  try { out.seqMarkers = seq.markers.numMarkers; } catch (e) {}
  try { out.seqIn = String(seq.getInPointAsTime().ticks); } catch (e) {}
  try { out.seqOut = String(seq.getOutPointAsTime().ticks); } catch (e) {}
}
try {
  var sm = app.sourceMonitor.getProjectItem();
  out.srcMon = sm ? sm.name : "none";
} catch (e) { out.srcMon = "unreadable"; }
function countItems(bin) {
  var n = 0;
  for (var i = 0; i < bin.children.numItems; i++) {
    n++;
    var it = bin.children[i];
    if (it.type === 2) n += countItems(it);
    if (it.type === 1 || (it.getSequence && it.getSequence())) {}
  }
  return n;
}
try { out.items = countItems(app.project.rootItem); } catch (e) {}
try { out.seqCount = app.project.sequences.numSequences; } catch (e) {}
return __result(out);
`;

const snapshot = () => observe(SNAPSHOT);

function snapEqual(a, b) {
  if (!a || !b || a.__error || b.__error) return null; // unknown, not "equal"
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------- tool discovery

async function loadTools() {
  const dir = join(ROOT, "dist/tools");
  const all = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    let mod;
    try { mod = await import(pathToFileURL(join(dir, f)).href); } catch { continue; }
    for (const [fnName, fn] of Object.entries(mod)) {
      if (typeof fn !== "function" || !/^get[A-Z]\w*Tools$/.test(fnName)) continue;
      let tools;
      try { tools = fn(bridge); } catch { continue; }
      for (const [name, t] of Object.entries(tools || {})) {
        if (t && typeof t.handler === "function") {
          all[name] = { name, module: f.replace(".js", ""), schema: t.parameters || {}, handler: t.handler };
        }
      }
    }
  }
  return all;
}

// ---------------------------------------------------------------- fixtures + arg synthesis

async function buildFixtures() {
  const d = await observe(`
    var seq = app.project.activeSequence;
    if (!seq) return __error("no active sequence");
    var out = { seqName: seq.name, seqId: seq.sequenceID, nodeId: null, clipName: null, itemId: null, itemName: null, mediaPath: null, effectName: null };
    for (var t = 0; t < seq.videoTracks.numTracks && !out.nodeId; t++) {
      var tr = seq.videoTracks[t];
      if (tr.clips.numItems > 0) { out.nodeId = tr.clips[0].nodeId; out.clipName = tr.clips[0].name; }
    }
    function firstMedia(bin) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === 2) { var r = firstMedia(it); if (r) return r; }
        else if (it.getMediaPath && it.getMediaPath()) return it;
      }
      return null;
    }
    var m = firstMedia(app.project.rootItem);
    if (m) { out.itemId = m.nodeId; out.itemName = m.name; out.mediaPath = m.getMediaPath(); }
    return __result(out);
  `);
  if (!d || d.__error) throw new Error("fixture build failed: " + (d && d.__error));
  return {
    ...d,
    outDir: join(OUT_DIR, "artifacts"),
  };
}

/** Map a schema property to a live value. Name first (most reliable), then type. */
function valueFor(propName, spec, fx) {
  const n = propName.toLowerCase();
  const byName = {
    node_id: fx.nodeId, source_node_id: fx.nodeId, target_node_id: fx.nodeId, clip_node_id: fx.nodeId,
    item_id: fx.itemId, project_item_id: fx.itemId, bin_id: fx.itemId,
    sequence_id: fx.seqName, sequence_name: fx.seqName,
    track_index: 0, video_track_index: 0, audio_track_index: 0, target_track_index: 0, clip_index: 0,
    track_type: "video", media_type: "video",
    time_seconds: 1, start_seconds: 0, end_seconds: 2, position_seconds: 1, offset_seconds: 0.2,
    in_seconds: 0, out_seconds: 2, duration_seconds: 1, new_start_seconds: 0,
    speed_percent: 100, opacity: 100, volume: 0, scale: 100, value: 50,
    effect_name: "Gaussian Blur", transition_name: "Cross Dissolve", property_name: "Blur",
    name: "PROBE_TMP", new_name: "PROBE_TMP", bin_name: "PROBE_TMP_BIN", comments: "probe",
    enabled: true, reverse: false, ripple: false, selected_only: false, suppress_ui: true,
    file_paths: fx.mediaPath ? [fx.mediaPath] : [],
    path: fx.mediaPath, file_path: fx.mediaPath, media_path: fx.mediaPath,
    output_path: join(fx.outDir, `probe_${propName}.png`),
    item_ids: fx.itemId ? [fx.itemId] : [],
    node_ids: fx.nodeId ? [fx.nodeId] : [],
    count: 1, color_index: 1, width: 1920, height: 1080, frame_rate: 25, sample_rate: 48000,
  };
  if (n in byName && byName[n] !== undefined && byName[n] !== null) return byName[n];
  if (spec?.enum?.length) return spec.enum[0];
  if (spec?.default !== undefined) return spec.default;
  switch (spec?.type) {
    case "number": return 1;
    case "boolean": return false;
    case "string": return "PROBE_TMP";
    case "array": return [];
    case "object": return {};
    default: return null;
  }
}

function synthArgs(schema, fx) {
  const props = schema?.properties || {};
  const required = schema?.required || [];
  const args = {};
  const missing = [];
  for (const r of required) {
    const v = valueFor(r, props[r], fx);
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) { missing.push(r); continue; }
    args[r] = v;
  }
  return { args, missing };
}

// ---------------------------------------------------------------- verdict engine

/**
 * Four inputs: what the tool SAID, whether the world moved, whether it was supposed to move, and
 * whether the bridge is still alive. The interesting verdicts are the disagreements.
 */
function verdictFor({ tier, reported, changed, threw, witnessed, domain }) {
  if (changed === null) return { verdict: "UNKNOWN", why: "could not observe world state" };
  const ok = reported?.success === true;

  if (tier === TIER.READ) {
    if (changed) return { verdict: "READ_MUTATES", why: "a read-only tool changed timeline state" };
    if (threw) return { verdict: "THREW", why: "handler threw" };
    return ok ? { verdict: "WORKS", why: "returned data, world unchanged" }
              : { verdict: "HONEST_ERROR", why: "errored, world unchanged" };
  }

  // Writes. The two disagreements below are the whole point of the prober.
  if (ok && !changed) {
    // Only accuse a tool of lying when the instrument could actually have seen the change.
    // Otherwise this is the prober's blind spot, and saying "LIES" would be the same species
    // of fabrication the prober exists to catch.
    if (!witnessed) {
      return { verdict: "UNWITNESSED", why: `reported success; changes to '${domain}' are outside what the snapshot observes, so this is neither confirmed nor refuted` };
    }
    return { verdict: "LIES", why: "reported success but nothing changed in an observed domain" };
  }
  if (!ok && changed) return { verdict: "ERRORED_BUT_MUTATED", why: "returned an error AFTER changing the timeline — partial mutation, unrecoverable here" };
  if (ok && changed) return { verdict: "WORKS", why: "reported success and the world moved" };
  return { verdict: "HONEST_ERROR", why: "errored, world unchanged" };
}

// ---------------------------------------------------------------- run

/**
 * Resume skips tools that already have a REAL outcome. A SKIPPED row is not an outcome — it
 * means the tool's tier was disabled on that run — so enabling a tier later must re-probe it,
 * otherwise `--reads-only` followed by `--resume` would silently never test a single write.
 */
const REAL_VERDICTS = new Set(["WORKS", "LIES", "ERRORED_BUT_MUTATED", "HONEST_ERROR", "READ_MUTATES", "THREW", "WEDGES", "UNKNOWN"]);

function readJournal() {
  if (!existsSync(JOURNAL)) return {};
  const done = {};
  for (const line of readFileSync(JOURNAL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (REAL_VERDICTS.has(r.verdict)) done[r.tool] = r;
      else delete done[r.tool];
    } catch {}
  }
  return done;
}

async function main() {
  console.log(`bridge tempDir: ${bridge.tempDir}`);
  const alive = await ping();
  if (!alive) { console.error("ERROR: bridge not responding. Open Premiere and Window > Extensions > MCP Bridge."); process.exit(3); }
  console.log(`connected. project="${alive.project}" activeSequence="${alive.seq}"`);

  if (alive.seq !== SCRATCH) {
    console.error(`\nREFUSING TO RUN.\n  active sequence : "${alive.seq}"\n  --scratch says  : "${SCRATCH}"\nMake the scratch sequence active in Premiere first. The prober fires real writes at a host with no undo; it will not guess which timeline you meant.`);
    process.exit(4);
  }

  const guard = await observe(`
    var found = null;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (s.sequenceID === "${PROTECTED_SEQUENCE_ID}") {
        var n = 0; for (var t = 0; t < s.videoTracks.numTracks; t++) n += s.videoTracks[t].clips.numItems;
        found = { name: s.name, clips: n };
      }
    }
    return __result({ guarded: found });
  `);
  const before = guard?.guarded;
  if (before) {
    console.log(`protected sequence present: ${before.clips} clips (expect ${PROTECTED_EXPECTED_CLIPS})`);
    if (before.clips !== PROTECTED_EXPECTED_CLIPS) {
      console.error(`REFUSING TO RUN: protected sequence already has ${before.clips} clips, expected ${PROTECTED_EXPECTED_CLIPS}. Investigate before probing.`);
      process.exit(5);
    }
  }

  const tools = await loadTools();
  const fx = await buildFixtures();
  mkdirSync(fx.outDir, { recursive: true });
  console.log(`fixtures: clip=${fx.nodeId} item=${fx.itemId} seq="${fx.seqName}"`);

  const done = flag("resume") ? readJournal() : {};
  if (flag("resume")) console.log(`resuming: ${Object.keys(done).length} already probed`);

  let names = Object.keys(tools).sort();
  const only = opt("only");
  if (only) { const re = new RegExp(only); names = names.filter((x) => re.test(x)); }
  const limit = Number(opt("limit", 0));
  if (limit > 0) names = names.slice(0, limit);
  console.log(`probing ${names.length} tool(s); tiers: ${[...TIERS].join(", ")}`);
  let n = 0, wedged = false;

  for (const name of names) {
    n++;
    if (done[name]) continue;
    const { tier, reason } = classify(name);
    const t = tools[name];

    if (tier === TIER.DENY || !TIERS.has(tier)) {
      const rec = { tool: name, module: t.module, tier, verdict: "SKIPPED", why: reason, at: new Date().toISOString() };
      appendFileSync(JOURNAL, JSON.stringify(rec) + "\n");
      continue;
    }

    const pre = await snapshot();

    // Some tools switch the active sequence as a side effect — create_sequence does, verified
    // here. Left alone, every subsequent write lands on a DIFFERENT timeline and the whole run
    // silently measures the wrong thing. Restore the scratch before continuing, and record that
    // the previous tool moved it, because that side effect is itself worth knowing.
    if (!pre.__error && pre.seqName && pre.seqName !== SCRATCH) {
      console.log(`      ↻ active sequence had moved to "${pre.seqName}" — restoring "${SCRATCH}"`);
      await observe(`
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var s = app.project.sequences[i];
          if (s.name === "${SCRATCH}") { app.project.activeSequence = s; return __result({ restored: true }); }
        }
        return __error("scratch sequence not found");
      `);
      const re = await snapshot();
      if (!re.__error) Object.assign(pre, re);
    }

    // Fixture staleness. Write tools legitimately delete clips from the scratch sequence, and a
    // stale node_id turns every later verdict into "Clip not found" — HONEST_ERROR everywhere,
    // which reads as "these tools are broken" when really the probe starved itself. Re-resolve
    // from the snapshot we already took (free) and halt loudly if the scratch is exhausted.
    if (!pre.__error) {
      const liveIds = (pre.v || []).join(";");
      if (fx.nodeId && !liveIds.includes(fx.nodeId)) {
        const first = (pre.v || []).find((d) => d.length > 0);
        const newId = first ? first.split("|")[0] : null;
        if (!newId) {
          console.error(`\n🛑 SCRATCH EXHAUSTED before ${name}: no clips left on any video track.\nRe-seed "${SCRATCH}" (re-import the probe XML), then re-run with --resume.`);
          appendFileSync(JOURNAL, JSON.stringify({ tool: name, module: t.module, tier, verdict: "HALTED", why: "scratch sequence had no clips left", at: new Date().toISOString() }) + "\n");
          break;
        }
        fx.nodeId = newId;
        console.log(`      ↻ fixture clip re-resolved -> ${newId}`);
      }
    }

    // Synthesised AFTER the snapshot so a re-resolved fixture applies to THIS call, not the next.
    const { args, missing } = synthArgs(t.schema, fx);
    if (missing.length) {
      appendFileSync(JOURNAL, JSON.stringify({ tool: name, module: t.module, tier, verdict: "UNTESTABLE", why: `no fixture for required arg(s): ${missing.join(", ")}`, at: new Date().toISOString() }) + "\n");
      continue;
    }

    let reported = null, threw = null;
    const t0 = Date.now();
    try {
      reported = await t.handler(args);
    } catch (e) {
      threw = String(e && e.message ? e.message : e);
    }
    const ms = Date.now() - t0;
    const post = await snapshot();

    // Bridge health: a wedge makes every later verdict meaningless, so stop rather than
    // record a run's worth of confident nonsense.
    if (post?.__error) {
      const still = await ping();
      if (!still) {
        appendFileSync(JOURNAL, JSON.stringify({ tool: name, module: t.module, tier, verdict: "WEDGES", why: "bridge stopped responding after this call", args, at: new Date().toISOString() }) + "\n");
        console.error(`\n🛑 BRIDGE WEDGED on ${name}. Recorded. Recover: Premiere > Window > Extensions > MCP Bridge, then re-run with --resume.`);
        wedged = true;
        break;
      }
    }

    const eq = snapEqual(pre, post);
    const changed = eq === null ? null : !eq;
    const { verdict, why } = verdictFor({ tier, reported, changed, threw, witnessed: isWitnessed(name), domain: witnessDomain(name) });

    const rec = {
      tool: name, module: t.module, tier, verdict, why, ms, args, domain: witnessDomain(name),
      reportedOk: reported?.success ?? null,
      reported: reported ? JSON.stringify(reported).slice(0, 600) : null,
      threw, changed, at: new Date().toISOString(),
    };
    appendFileSync(JOURNAL, JSON.stringify(rec) + "\n");

    const mark = { WORKS: "✅", LIES: "🚨", ERRORED_BUT_MUTATED: "🔥", HONEST_ERROR: "⚠️ ", READ_MUTATES: "🚨", THREW: "💥", UNKNOWN: "❔" }[verdict] || "  ";
    console.log(`${String(n).padStart(3)}/${names.length} ${mark} ${verdict.padEnd(20)} ${name}`);
  }

  // Prove the protected sequence survived. A probe run that quietly damaged Sam's assembly
  // while producing a beautiful capability map would be the worst possible outcome.
  if (before) {
    const after = (await observe(`
      var found = null;
      for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        if (s.sequenceID === "${PROTECTED_SEQUENCE_ID}") {
          var n = 0; for (var t = 0; t < s.videoTracks.numTracks; t++) n += s.videoTracks[t].clips.numItems;
          found = { name: s.name, clips: n };
        }
      }
      return __result({ guarded: found });
    `))?.guarded;
    const intact = after && after.clips === before.clips;
    console.log(`\nprotected sequence after run: ${after ? after.clips + " clips" : "NOT FOUND"} — ${intact ? "INTACT ✅" : "⚠️  CHANGED, INVESTIGATE"}`);
    writeFileSync(join(OUT_DIR, "protected-check.json"), JSON.stringify({ before, after, intact }, null, 2));
  }

  console.log(`\njournal: ${JOURNAL}`);
  if (wedged) process.exit(6);
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });
