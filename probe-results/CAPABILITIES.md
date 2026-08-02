# Premiere MCP — measured capability map

**Probed 2026-08-02 against Premiere 26.5.0.** 176 of 202 registered tools have a real verdict.

Every verdict below comes from observing Premiere's state before and after the call. No tool's
self-report was trusted — this bridge's defining failure mode is fabricated success.

| Verdict | Count | Means |
|---|---|---|
| WORKS | 90 | reported success **and** the observed world changed accordingly |
| FABRICATES | 5 | 🚨 asserts a positive outcome while nothing changed — the fabricated-success class |
| WEDGES | 1 | 🛑 killed the CEP bridge; recovery is a manual step in Premiere |
| NOOP_REPORTED_OK | 2 | returned success for a no-op; payload honestly reports zero |
| UNWITNESSED | 26 | reported success in a domain the snapshot does not observe — **unknown, not broken** |
| HONEST_ERROR | 49 | refused with an error and changed nothing (often just a fixture the prober couldn't supply) |
| THREW | 3 | the handler itself threw before reaching Premiere |
| UNTESTABLE | 1 | no fixture could satisfy a required argument |
| SKIPPED | 25 | tier disabled for this run, or on the deny-list |

## FABRICATES

- **`add_tracks`** — asserts a positive outcome while its OWN counters report zero, and nothing observable changed
  - reported: `{"success":true,"data":{"added":true,"videoTracks":0,"audioTracks":0,"audioMonoTracks":0,"audio51Tracks":0}}`
- **`close_source_monitor`** — asserts a positive outcome but nothing observable changed
  - reported: `{"success":true,"data":{"closed":true}}`
- **`color_correct`** — asserts a positive outcome but nothing observable changed
  - reported: `{"success":true,"data":{"colorCorrected":true,"clipName":"PROBE_TMP","changes":{},"errors":{}}}`
- **`duplicate_clip`** — asserts a positive outcome but nothing observable changed
  - reported: `{"success":true,"data":{"duplicated":true,"clipName":"PROBE_TMP","newTrackIndex":1}}`
- **`remove_all_effects`** — asserts a positive outcome but nothing observable changed
  - reported: `{"success":true,"data":{"removed":true,"clipName":"a3b80439-7829-4cb1-86af-f942819e7218-b9ab5f948d.png"}}`

## WEDGES

- **`replace_clip`** — bridge stopped responding after this call

## NOOP_REPORTED_OK

- **`batch_enable_disable`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"affected":0,"enabled":true}}`
- **`copy_effects_between_clips`** — returned success for a no-op; its payload is honest about having done nothing
  - reported: `{"success":true,"data":{"copiedEffects":0,"source":"PROBE_TMP","target":"PROBE_TMP"}}`

## WORKS — verified against observation

`add_marker` · `add_to_timeline` · `batch_rename_clips` · `check_offline_media` · `create_bin` · `create_sequence_from_clips` · `create_sequence` · `create_smart_bin` · `create_subclip` · `create_subsequence` · `duplicate_sequence` · `find_items_by_media_path` · `freeze_frame` · `get_active_sequence` · `get_advanced_feature_support` · `get_all_project_paths` · `get_av_feature_support` · `get_bridge_telemetry` · `get_capabilities` · `get_clip_adjustment_layer` · `get_clip_at_playhead` · `get_clip_at_position` · `get_clip_links` · `get_clip_markers` · `get_clip_properties` · `get_clip_speed` · `get_color_label` · `get_color_space` · `get_duplicate_media` · `get_encoder_presets` · `get_export_file_extension` · `get_footage_interpretation` · `get_full_clip_info` · `get_full_project_overview` · `get_full_sequence_info` · `get_graphics_white_luminance` · `get_insertion_bin` · `get_item_info` · `get_linked_items` · `get_metadata` · `get_next_edit_point` · `get_offline_media` · `get_playhead_position` · `get_premiere_state` · `get_project_info` · `get_project_item_info` · `get_project_panel_metadata` · `get_project_scratch_disks` · `get_render_queue_status` · `get_selected_clips` · `get_sequence_count` · `get_sequence_in_out_points` · `get_sequence_markers_by_type` · `get_sequence_settings` · `get_sequence_structure` · `get_source_monitor_info` · `get_source_monitor_position` · `get_target_tracks` · `get_timeline_gaps` · `get_timeline_summary` · `get_total_clip_count` · `get_track_info` · `get_unused_media` · `get_used_media_report` · `get_version_info` · `get_workspaces` · `get_xmp_metadata` · `has_proxy` · `import_media` · `inspect_project_item_av_metadata` · `inspect_project_recovery` · `inspect_sequence_av_settings` · `list_available_audio_effects` · `list_available_audio_transitions` · `list_available_effects` · `list_available_transitions` · `list_clip_effects` · `list_markers` · `list_project_items` · `list_sequence_tracks` · `list_sequences` · `nest_clips` · `open_in_source` · `overwrite_clip` · `overwrite_from_source` · `ping` · `razor_all_tracks` · `remove_from_timeline` · `rename_project_item` · `search_project_items`

## UNWITNESSED — the prober's blind spots, not verdicts

These reported success in a domain the snapshot does not cover. Widening the snapshot (or
adding a domain-specific witness — a filesystem check, a rendered frame) converts them.

- **bins** (2): `move_item_to_bin` · `move_items_to_bin`
- **filesystem** (5): `capture_frame` · `export_as_fcp_xml` · `export_as_project` · `export_frame` · `export_omf`
- **media** (3): `import_ae_comps` · `import_image_sequence` · `refresh_media`
- **metadata** (2): `add_custom_metadata_field` · `attach_custom_property`
- **playback** (4): `match_frame` · `move_playhead_to_edit` · `play_source_monitor` · `play_timeline`
- **projectitem** (2): `add_marker_to_project_item` · `clear_item_in_out`
- **selection** (5): `deselect_all_clips` · `extract_selection` · `invert_selection` · `link_selection` · `remove_selected_clips`
- **trackprops** (3): `lock_track` · `mute_track` · `rename_track`

## Never fired (deny-list)

- `close_project` — closes the project the probe is running in
- `create_project` — switches project mid-run
- `get_qe_clip_info` — wedges the CEP bridge; recovery is manual
- `import_fcp_xml` — calls app.openFCPXML() which opens the XML AS A NEW PROJECT (verified)
- `multiple_undo` — same
- `open_project` — switches project mid-run
- `redo` — same
- `replace_clip` — wedges the CEP bridge (observed); recovery is manual
- `save_project` — writes probe scratch sequences into Sam's project file on disk; saving is his call
- `save_project_as` — forks the project file, switching the active one
- `set_project_scratch_disk` — mutates global scratch settings
- `set_scratch_disk_path` — mutates global app preferences
- `set_transcode_on_ingest` — mutates global ingest preferences
- `set_workspace` — rearranges Sam's actual UI layout
- `undo` — rewinds probe-applied state; corrupts the world model
