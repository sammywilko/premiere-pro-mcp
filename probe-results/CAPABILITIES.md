# Premiere MCP — measured capability map

**Probed 2026-08-03 against Premiere 26.5.0.** 241 of 281 registered tools have a real verdict.

Every verdict below comes from observing Premiere's state before and after the call. No tool's
self-report was trusted — this bridge's defining failure mode is fabricated success.

| Verdict | Count | Means |
|---|---|---|
| WORKS | 100 | reported success **and** the observed world changed accordingly |
| FABRICATES | 2 | 🚨 asserts a positive outcome while nothing changed — the fabricated-success class |
| ERRORED_BUT_MUTATED | 1 | 🔥 returned an error **after** changing the timeline — partial mutation, unrecoverable here |
| NOOP_REPORTED_OK | 19 | returned success for a no-op; payload honestly reports zero |
| UNWITNESSED | 43 | reported success in a domain the snapshot does not observe — **unknown, not broken** |
| HONEST_ERROR | 73 | refused with an error and changed nothing (often just a fixture the prober couldn't supply) |
| THREW | 3 | the handler itself threw before reaching Premiere |
| UNTESTABLE | 1 | no fixture could satisfy a required argument |
| SKIPPED | 39 | tier disabled for this run, or on the deny-list |

## FABRICATES

- **`add_tracks`** — asserts a positive outcome while its OWN counters report zero, and nothing observable changed
  - reported: `{"success":true,"data":{"added":true,"videoTracks":0,"audioTracks":0,"audioMonoTracks":0,"audio51Tracks":0}}`
- **`duplicate_clip`** — asserts a positive outcome but nothing observable changed
  - reported: `{"success":true,"data":{"duplicated":true,"clipName":"PROBE_TMP","newTrackIndex":1}}`

## ERRORED_BUT_MUTATED

- **`roll_edit`** — returned an error AFTER changing the timeline — partial mutation, unrecoverable here
  - reported: `{"success":false,"error":"roll_edit MUTATED THE TIMELINE BUT NOT AS REQUESTED via 'ticks+0+0+0': target clip's end moved 69600s, requested 0.2s. The clip was NOT restored (QE offer`

## NOOP_REPORTED_OK

- **`batch_enable_disable`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"affected":0,"enabled":true}}`
- **`set_active_sequence`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"active":true,"name":"PROBE-SCRATCH","id":"080bc1b6-4cbf-44fe-977e-23fc3180c31c"}}`
- **`set_clip_properties`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"updated":true,"clipName":"NASA-AI_3371_VID_004-V1.mp4","changes":{}}}`
- **`set_clip_start_time`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"item":"NASA-AI_3369_VID_005-V1.mp4","startSeconds":0}}`
- **`set_graphics_white_luminance`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"set":true,"graphicsWhiteLuminance":1}}`
- **`set_override_frame_rate`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"set":true,"item":"STRU-AI_2922_VID_001-V1_SQ09-SC01-A.mp4","frameRate":25}}`
- **`set_override_pixel_aspect_ratio`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"set":true,"item":"STRU-AI_2922_VID_001-V1_SQ09-SC01-A.mp4","par":"1:1"}}`
- **`set_scale_to_frame_size`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"set":true,"item":"NASA-AI_3369_VID_005-V1.mp4"}}`
- **`set_sequence_audio_settings`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"sequence":"PROBE-SCRATCH","sampleRate":{"seconds":0.00002083333333,"ticks":"5292000"},"channelType":1}}`
- **`set_sequence_display_format`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"sequence":"PROBE-SCRATCH","videoDisplayFormat":101,"audioDisplayFormat":200}}`
- **`set_sequence_field_type`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"fieldType":1,"sequence":"PROBE-SCRATCH"}}`
- **`set_sequence_frame_rate`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"frameRate":25,"ticksPerFrame":"10160640000","sequence":"PROBE-SCRATCH"}}`
- **`set_sequence_in_out_points`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"inSeconds":0,"outSeconds":2}}`
- **`set_sequence_resolution`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"width":1920,"height":1080,"sequence":"PROBE-SCRATCH"}}`
- **`set_sequence_settings`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"updated":true,"name":"PROBE-SCRATCH"}}`
- **`set_start_time`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"set":true,"item":"STRU-AI_2922_VID_001-V1_SQ09-SC01-A.mp4","startSeconds":0}}`
- **`set_uniform_scale`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"clip":"NASA-AI_3371_VID_004-V1.mp4","uniformScale":false}}`
- **`set_work_area`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"workAreaIn":0,"workAreaOut":2}}`
- **`set_zero_point`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"set":true,"startSeconds":0}}`

## WORKS — verified against observation

`add_marker` · `add_to_timeline` · `batch_rename_clips` · `check_offline_media` · `close_source_monitor` · `create_bin` · `create_sequence_from_clips` · `create_sequence` · `create_smart_bin` · `create_subclip` · `delete_marker` · `duplicate_sequence` · `find_items_by_media_path` · `freeze_frame` · `get_active_sequence` · `get_advanced_feature_support` · `get_all_project_paths` · `get_av_feature_support` · `get_bridge_telemetry` · `get_capabilities` · `get_clip_adjustment_layer` · `get_clip_at_playhead` · `get_clip_at_position` · `get_clip_links` · `get_clip_markers` · `get_clip_properties` · `get_clip_speed` · `get_color_label` · `get_color_space` · `get_duplicate_media` · `get_encoder_presets` · `get_export_file_extension` · `get_footage_interpretation` · `get_full_clip_info` · `get_full_project_overview` · `get_full_sequence_info` · `get_graphics_white_luminance` · `get_insertion_bin` · `get_item_info` · `get_linked_items` · `get_metadata` · `get_next_edit_point` · `get_offline_media` · `get_playhead_position` · `get_premiere_state` · `get_project_info` · `get_project_item_info` · `get_project_panel_metadata` · `get_project_scratch_disks` · `get_render_queue_status` · `get_selected_clips` · `get_sequence_count` · `get_sequence_in_out_points` · `get_sequence_markers_by_type` · `get_sequence_settings` · `get_sequence_structure` · `get_source_monitor_info` · `get_source_monitor_position` · `get_target_tracks` · `get_timeline_gaps` · `get_timeline_summary` · `get_total_clip_count` · `get_track_info` · `get_unused_media` · `get_used_media_report` · `get_version_info` · `get_workspaces` · `get_xmp_metadata` · `has_proxy` · `import_media` · `inspect_project_item_av_metadata` · `inspect_project_recovery` · `inspect_sequence_av_settings` · `list_available_audio_effects` · `list_available_audio_transitions` · `list_available_effects` · `list_available_transitions` · `list_clip_effects` · `list_markers` · `list_project_items` · `list_sequence_tracks` · `list_sequences` · `nest_clips` · `open_in_source` · `overwrite_clip` · `overwrite_from_source` · `ping` · `remove_from_timeline` · `remove_selected_clips` · `rename_clip` · `rename_project_item` · `search_project_items` · `set_clip_anchor_point` · `set_clip_opacity` · `set_clip_position` · `set_clip_rotation` · `set_clip_scale` · `set_scale_width_height` · `slide_edit` · `unnest_sequence`

## UNWITNESSED — the prober's blind spots, not verdicts

These reported success in a domain the snapshot does not cover. Widening the snapshot (or
adding a domain-specific witness — a filesystem check, a rendered frame) converts them.

- **bins** (2): `move_item_to_bin` · `move_items_to_bin`
- **filesystem** (5): `capture_frame` · `export_as_fcp_xml` · `export_as_project` · `export_frame` · `export_omf`
- **media** (4): `import_ae_comps` · `import_image_sequence` · `refresh_media` · `set_footage_interpretation`
- **metadata** (6): `add_custom_metadata_field` · `attach_custom_property` · `set_color_label` · `set_poster_frame` · `set_project_panel_metadata` · `set_xmp_metadata`
- **playback** (4): `play_source_monitor` · `play_timeline` · `set_playhead_position` · `stop_playback`
- **projectitem** (3): `add_marker_to_project_item` · `clear_item_in_out` · `set_item_in_out`
- **selection** (12): `deselect_all_clips` · `extract_selection` · `invert_selection` · `link_selection` · `select_all_clips` · `select_clips_by_color` · `select_clips_by_name` · `select_clips_in_range` · `select_disabled_clips` · `select_item` · `set_clip_selection` · `unlink_selection`
- **srcinout** (1): `set_source_in_out`
- **trackprops** (6): `lock_track` · `mute_track` · `rename_track` · `set_all_tracks_targeted` · `set_target_track` · `toggle_track_visibility`

## Never fired (deny-list)

- `close_project` — closes the project the probe is running in
- `create_project` — switches project mid-run
- `get_qe_clip_info` — wedges the CEP bridge; recovery is manual
- `import_fcp_xml` — calls app.openFCPXML() which opens the XML AS A NEW PROJECT (verified)
- `multiple_undo` — same
- `open_project` — switches project mid-run
- `redo` — same
- `replace_clip` — 💀 CRASHES Premiere (SIGABRT, null-ptr panic) — verified via crash report
- `reverse_clip` — 💀 CRASHES Premiere (SIGABRT, null-ptr panic) — verified via crash report
- `save_project` — writes probe scratch sequences into Sam's project file on disk; saving is his call
- `save_project_as` — forks the project file, switching the active one
- `set_project_scratch_disk` — mutates global scratch settings
- `set_scratch_disk_path` — mutates global app preferences
- `set_transcode_on_ingest` — mutates global ingest preferences
- `set_workspace` — rearranges Sam's actual UI layout
- `undo` — rewinds probe-applied state; corrupts the world model
