/**
 * Safety classification for the capability prober.
 *
 * The prober fires real tools at a real Premiere on a host with NO programmatic undo, so the
 * tiering here is the primary safety control — not an afterthought. Default runs cover T0+T1
 * only; everything above that is opt-in per run, and DENY is never fired at all.
 *
 * Bias: when a tool's blast radius is unclear, classify it HIGHER. A tool wrongly parked in
 * DESTRUCTIVE costs one line of config to promote later; a tool wrongly parked in WRITE can
 * cost a project.
 */

/** Never fire. Each entry needs a reason — no silent entries. */
export const DENY = {
  // Verified live 2026-08-02: hangs 30s, kills the CEP bridge, and recovery is a HUMAN action
  // (Window -> Extensions -> MCP Bridge). One call would end the probe run.
  get_qe_clip_info: "wedges the CEP bridge; recovery is manual",
  // 💀 CRASHES PREMIERE. Both of these took the whole application down with an IDENTICAL
  // signature — EXC_CRASH / SIGABRT via dvacore::config::DoThrowNullPtrException -> Panic ->
  // Abort — confirmed against ~/Library/Logs/DiagnosticReports on 2026-08-02 and 2026-08-03.
  // The prober originally logged replace_clip as "WEDGES"; that understated it. The bridge went
  // quiet because the HOST PROCESS HAD DIED, not because the panel stopped listening.
  replace_clip: "💀 CRASHES Premiere (SIGABRT, null-ptr panic) — verified via crash report",
  reverse_clip: "💀 CRASHES Premiere (SIGABRT, null-ptr panic) — verified via crash report",

  // These swap or close the project out from under the run. Catastrophic mid-probe: every
  // subsequent write would land somewhere unintended, possibly in Sam's real project.
  close_project: "closes the project the probe is running in",
  open_project: "switches project mid-run",
  create_project: "switches project mid-run",
  save_project_as: "forks the project file, switching the active one",
  import_fcp_xml: "calls app.openFCPXML() which opens the XML AS A NEW PROJECT (verified)",

  // Global/app-level state that outlives the probe and affects Sam's normal work.
  set_scratch_disk_path: "mutates global app preferences",
  set_project_scratch_disk: "mutates global scratch settings",
  set_transcode_on_ingest: "mutates global ingest preferences",
  set_workspace: "rearranges Sam's actual UI layout",
  save_project: "writes probe scratch sequences into Sam's project file on disk; saving is his call",

  // Rewrites the world model the verdict engine depends on, so every later verdict would be
  // computed against a timeline the prober no longer understands.
  undo: "rewinds probe-applied state; corrupts the world model",
  redo: "same",
  multiple_undo: "same",
};

/** Slow and/or spawn Adobe Media Encoder. Correct to probe, but not in a default run. */
export const SLOW = new Set([
  "encode_file", "encode_project_item", "export_sequence", "add_to_render_queue",
  "start_batch_encode", "auto_reframe_sequence", "scene_edit_detection", "stabilize_clip",
  "consolidate_and_transfer", "consolidate_duplicates", "import_folder", "delete_preview_files",
]);

/** Destroy project CONTENTS (not timeline edits — those are the point of the probe). */
export const DESTRUCTIVE = new Set([
  "delete_sequence", "delete_project_item", "delete_multiple_project_items", "delete_bin",
  "set_offline", "relink_media", "replace_clip_media", "detach_proxy", "manage_proxies",
  "close_all_source_clips", "close_sequence",
]);

/** Reads: must NOT mutate. If one does, that is itself a finding. */
const READ_RE = /^(get_|list_|inspect_|find_|check_|has_|is_|search_|validate_|preview_|read_|ping$|verify_)/;

export const TIER = {
  READ: "T0_READ",
  WRITE: "T1_WRITE",
  DESTRUCTIVE: "T2_DESTRUCTIVE",
  SLOW: "T3_SLOW",
  DENY: "DENY",
};

export function classify(name) {
  if (DENY[name]) return { tier: TIER.DENY, reason: DENY[name] };
  if (SLOW.has(name)) return { tier: TIER.SLOW, reason: "slow / invokes AME" };
  if (DESTRUCTIVE.has(name)) return { tier: TIER.DESTRUCTIVE, reason: "destroys project contents" };
  if (READ_RE.test(name)) return { tier: TIER.READ, reason: "read-only by name" };
  return { tier: TIER.WRITE, reason: "mutates timeline state" };
}

/** Tiers enabled for a run. READ is always on; the rest are opt-in. */
export function enabledTiers({ write = true, destructive = false, slow = false } = {}) {
  const t = new Set([TIER.READ]);
  if (write) t.add(TIER.WRITE);
  if (destructive) t.add(TIER.DESTRUCTIVE);
  if (slow) t.add(TIER.SLOW);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Witness domains
//
// The verdict engine can only call something a LIE if its instrument can SEE the thing the tool
// claims to change. The first write pass scored add_marker, color_correct, export_frame and
// ~25 others as LIES purely because the snapshot did not cover markers, components, or the
// filesystem — export_frame had literally been used minutes earlier to prove the XML dissolve.
//
// Publishing that list would have been the exact failure this prober exists to prevent: a
// confident, trusted, WRONG capability map. So a tool whose domain is not witnessed gets
// UNWITNESSED — an honest "I cannot tell" — never LIES.

/** Domains the snapshot actually observes. Widen the snapshot before widening this set. */
export const WITNESSED = new Set([
  "timeline",   // clip identity, geometry, enabled, speed, component count, clip markers
  "tracks",     // track COUNT (not lock/mute/name)
  "seqmarkers",
  "seqinout",
  "project",    // project item count, sequence count
  "srcmonitor", // which item is loaded
  "clipprops",  // Motion/Opacity PROPERTY VALUES per clip (added 2026-08-03)
  "seqsettings",// sequence settings block (added 2026-08-03)
  "workarea",   // work area, zero point, sequence in/out
]);

const DOMAIN_RULES = [
  // Newly witnessed once the snapshot started capturing property values and sequence settings.
  [/^(set_clip_(opacity|scale|position|rotation|anchor_point|properties|start_time)|set_uniform_scale|set_scale_|set_blend_mode|set_anti_alias_quality)/, "clipprops"],
  [/^(set_sequence_(settings|resolution|frame_rate|field_type|display_format|audio_settings|pixel_aspect_ratio)|set_override_|set_graphics_white_luminance)/, "seqsettings"],
  [/^(set_work_area|set_zero_point|set_start_time|set_sequence_in_out_points)/, "workarea"],
  // Explicitly NOT witnessed: the snapshot records which item is in the source monitor, not its
  // in/out points, and footage interpretation lives on the project item.
  [/^set_source_in_out/, "srcinout"],
  [/^set_footage_interpretation/, "media"],
  [/^(export_|encode_|capture_frame|verify_delivery|add_to_render_queue|start_batch_encode)/, "filesystem"],
  [/^(play_|stop_playback|set_playhead|move_playhead|match_frame)/, "playback"],
  [/(select|selection)/, "selection"],
  [/^(lock_track|mute_track|rename_track|toggle_track_visibility|set_target_track|set_all_tracks_targeted)/, "trackprops"],
  [/^(move_item_to_bin|move_items_to_bin|rename_bin|create_bin|delete_bin|get_bin)/, "bins"],
  [/(metadata|custom_property|custom_metadata|color_label|poster_frame|xmp)/, "metadata"],
  [/^(add_marker_to_project_item|set_item_in_out|clear_item_in_out|set_poster_frame)/, "projectitem"],
  [/^(set_source_in_out|open_in_source|close_source)/, "srcmonitor"],
  [/^(refresh_media|relink|set_offline|import_)/, "media"],
  [/keyframe/, "keyframes"],
  [/^(set_workspace|get_workspaces)/, "ui"],
];

/** Best-guess domain for a tool. Defaults to "timeline", which IS witnessed. */
export function witnessDomain(name) {
  for (const [re, dom] of DOMAIN_RULES) if (re.test(name)) return dom;
  return "timeline";
}

export function isWitnessed(name) {
  return WITNESSED.has(witnessDomain(name));
}
