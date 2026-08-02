#!/usr/bin/env node
/**
 * Turn probe-results/journal.jsonl into capabilities.json + CAPABILITIES.md.
 *
 * Re-applies the witness-domain rule to historic rows, so a journal written before the rule
 * existed is re-scored rather than trusted. LIES is only ever claimed for a tool whose domain
 * the snapshot actually observes.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, isWitnessed, witnessDomain, DENY } from "./classify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIR = join(ROOT, "probe-results");
const JOURNAL = join(DIR, "journal.jsonl");

if (!existsSync(JOURNAL)) { console.error("no journal at " + JOURNAL); process.exit(1); }

const rows = {};
for (const line of readFileSync(JOURNAL, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try { const r = JSON.parse(line); rows[r.tool] = r; } catch {}
}

/**
 * Re-score in two passes.
 *
 * 1. Witness domains: a LIES recorded before the rule existed may be a blind spot, not a lie.
 * 2. Split what remains. "Reported success, nothing changed" is two different things:
 *    - FABRICATES — the payload asserts a positive outcome (`added:true`) while its OWN counters
 *      say zero. add_tracks returned {added:true, videoTracks:0, audioTracks:0}. That is the
 *      fabricated-success class this whole project exists to kill.
 *    - NOOP_REPORTED_OK — the payload is honest (`affected:0`, `copiedEffects:0`) but the call
 *      still returns success. Defensible, and much weaker than a lie. Reporting these two as one
 *      number would overstate the finding.
 */
const CLAIM = /"(added|removed|applied|copied|duplicated|moved|renamed|cleared\w*|closed|colorCorrected|razored|trimmed|inserted|overwritten|changed|speedSet|reversed)":\s*(true|[1-9]\d*)/;
const ZERO = /"(\w*(?:Tracks|Effects|Clips|Count|affected|copied|applied|removed))":\s*0\b/i;

for (const r of Object.values(rows)) {
  r.domain = r.domain || witnessDomain(r.tool);
  if (r.verdict === "LIES" && !isWitnessed(r.tool)) {
    r.verdict = "UNWITNESSED";
    r.why = `reported success; changes to '${r.domain}' are outside what the snapshot observes (re-scored)`;
    r.rescored = true;
    continue;
  }
  if (r.verdict === "LIES") {
    const p = r.reported || "";
    const claims = CLAIM.test(p);
    const zeros = ZERO.test(p);
    if (claims) {
      r.verdict = "FABRICATES";
      r.why = zeros
        ? "asserts a positive outcome while its OWN counters report zero, and nothing observable changed"
        : "asserts a positive outcome but nothing observable changed";
    } else {
      r.verdict = "NOOP_REPORTED_OK";
      r.why = "returned success for a no-op; its payload is honest about having done nothing";
    }
  }
}

const ORDER = ["WORKS", "FABRICATES", "ERRORED_BUT_MUTATED", "READ_MUTATES", "WEDGES", "NOOP_REPORTED_OK",
               "UNWITNESSED", "HONEST_ERROR", "THREW", "UNKNOWN", "UNTESTABLE", "HALTED", "SKIPPED"];
const byVerdict = {};
for (const r of Object.values(rows)) (byVerdict[r.verdict] ||= []).push(r);

const total = Object.keys(rows).length;
const probed = Object.values(rows).filter((r) => !["SKIPPED", "UNTESTABLE", "HALTED"].includes(r.verdict)).length;

const caps = {
  probedAt: new Date().toISOString().slice(0, 10),
  premiere: "26.5.0",
  note: "Verdicts are judged by observing Premiere before/after, never by the tool's own report. " +
        "UNWITNESSED means the prober could not see the tool's domain — it is 'unknown', not 'broken'.",
  summary: Object.fromEntries(ORDER.filter((v) => byVerdict[v]).map((v) => [v, byVerdict[v].length])),
  totals: { registered: total, probed, unprobed: total - probed },
  tools: Object.fromEntries(
    Object.entries(rows).sort().map(([k, r]) => [k, {
      verdict: r.verdict, domain: r.domain, tier: r.tier, why: r.why,
      ...(r.reported ? { reported: r.reported.slice(0, 240) } : {}),
      ...(r.rescored ? { rescored: true } : {}),
    }])
  ),
};
writeFileSync(join(DIR, "capabilities.json"), JSON.stringify(caps, null, 2));

const L = [];
L.push("# Premiere MCP — measured capability map");
L.push("");
L.push(`**Probed ${caps.probedAt} against Premiere ${caps.premiere}.** ${probed} of ${total} registered tools have a real verdict.`);
L.push("");
L.push("Every verdict below comes from observing Premiere's state before and after the call. No tool's");
L.push("self-report was trusted — this bridge's defining failure mode is fabricated success.");
L.push("");
L.push("| Verdict | Count | Means |");
L.push("|---|---|---|");
const MEANS = {
  WORKS: "reported success **and** the observed world changed accordingly",
  FABRICATES: "🚨 asserts a positive outcome while nothing changed — the fabricated-success class",
  NOOP_REPORTED_OK: "returned success for a no-op; payload honestly reports zero",
  ERRORED_BUT_MUTATED: "🔥 returned an error **after** changing the timeline — partial mutation, unrecoverable here",
  READ_MUTATES: "🚨 a read-only tool changed state",
  WEDGES: "🛑 killed the CEP bridge; recovery is a manual step in Premiere",
  UNWITNESSED: "reported success in a domain the snapshot does not observe — **unknown, not broken**",
  HONEST_ERROR: "refused with an error and changed nothing (often just a fixture the prober couldn't supply)",
  THREW: "the handler itself threw before reaching Premiere",
  UNKNOWN: "state could not be observed",
  UNTESTABLE: "no fixture could satisfy a required argument",
  HALTED: "run stopped here",
  SKIPPED: "tier disabled for this run, or on the deny-list",
};
for (const v of ORDER) if (byVerdict[v]) L.push(`| ${v} | ${byVerdict[v].length} | ${MEANS[v]} |`);
L.push("");

for (const v of ["FABRICATES", "ERRORED_BUT_MUTATED", "READ_MUTATES", "WEDGES", "NOOP_REPORTED_OK"]) {
  if (!byVerdict[v]?.length) continue;
  L.push(`## ${v}`);
  L.push("");
  for (const r of byVerdict[v].sort((a, b) => a.tool.localeCompare(b.tool))) {
    L.push(`- **\`${r.tool}\`** — ${r.why}`);
    if (r.reported) L.push(`  - reported: \`${r.reported.slice(0, 180)}\``);
  }
  L.push("");
}

L.push("## WORKS — verified against observation");
L.push("");
L.push((byVerdict.WORKS || []).map((r) => `\`${r.tool}\``).sort().join(" · ") || "_none_");
L.push("");

if (byVerdict.UNWITNESSED?.length) {
  L.push("## UNWITNESSED — the prober's blind spots, not verdicts");
  L.push("");
  L.push("These reported success in a domain the snapshot does not cover. Widening the snapshot (or");
  L.push("adding a domain-specific witness — a filesystem check, a rendered frame) converts them.");
  L.push("");
  const byDom = {};
  for (const r of byVerdict.UNWITNESSED) (byDom[r.domain] ||= []).push(r.tool);
  for (const [d, ts] of Object.entries(byDom).sort()) L.push(`- **${d}** (${ts.length}): ${ts.sort().map((t) => `\`${t}\``).join(" · ")}`);
  L.push("");
}

L.push("## Never fired (deny-list)");
L.push("");
for (const [t, why] of Object.entries(DENY).sort()) L.push(`- \`${t}\` — ${why}`);
L.push("");

writeFileSync(join(DIR, "CAPABILITIES.md"), L.join("\n"));
console.log(`wrote ${join(DIR, "capabilities.json")}`);
console.log(`wrote ${join(DIR, "CAPABILITIES.md")}`);
console.log("");
for (const v of ORDER) if (byVerdict[v]) console.log(`  ${String(byVerdict[v].length).padStart(4)}  ${v}`);
