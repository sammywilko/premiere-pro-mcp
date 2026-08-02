import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand, BridgeOptions } from "../bridge/file-bridge.js";

export function getTimelineTools(bridgeOptions: BridgeOptions) {
  return {
    add_to_timeline: {
      description: "Add a project item (clip) to the timeline at a specific position",
      parameters: {
        type: "object" as const,
        properties: {
          item_id: {
            type: "string",
            description: "Node ID or name of the project item to add",
          },
          track_index: {
            type: "number",
            description: "Video track index (0-based, default: 0)",
          },
          start_seconds: {
            type: "number",
            description: "Start time in seconds on the timeline (default: 0)",
          },
          audio_track_index: {
            type: "number",
            description: "Audio track index for the audio portion (default: 0)",
          },
        },
        required: ["item_id"],
      },
      handler: async (args: { item_id: string; track_index?: number; start_seconds?: number; audio_track_index?: number }) => {
        const trackIndex = args.track_index ?? 0;
        const startSeconds = args.start_seconds ?? 0;
        const audioTrackIndex = args.audio_track_index ?? 0;

        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Project item not found: ${escapeForExtendScript(args.item_id)}");
          if (${trackIndex} >= seq.videoTracks.numTracks) return __error("Video track index ${trackIndex} out of range");

          var vTrack = seq.videoTracks[${trackIndex}];
          var aTrack = ${audioTrackIndex} < seq.audioTracks.numTracks ? seq.audioTracks[${audioTrackIndex}] : null;
          var vBefore = __trackClipIds(vTrack);
          var aBefore = aTrack ? __trackClipIds(aTrack) : [];

          var startTicks = __secondsToTicks(${startSeconds}).toString();
          seq.insertClip(item, startTicks, ${trackIndex}, ${audioTrackIndex});

          var newVideo = __newClipsOnTrack(vTrack, vBefore);
          var newAudio = aTrack ? __newClipsOnTrack(aTrack, aBefore) : [];
          if (newVideo.length === 0 && newAudio.length === 0) {
            return __error("insertClip ran but no new clip appeared on video track ${trackIndex} / audio track ${audioTrackIndex} — nothing was added.");
          }

          return __result({
            added: true,
            verified: true,
            item: item.name,
            trackIndex: ${trackIndex},
            startSeconds: ${startSeconds},
            newClips: { video: newVideo, audio: newAudio },
            note: "Insert semantics: adding inside an existing clip splits it and ripples the tail; the split tail also appears in newClips."
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    remove_from_timeline: {
      description: "Remove a clip from the timeline",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to remove",
          },
          ripple: {
            type: "boolean",
            description: "Whether to ripple delete (close the gap). Default: false",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string; ripple?: boolean }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");

          var clip = result.clip;
          var clipName = clip.name;
          clip.remove(${args.ripple ? "true" : "false"}, ${args.ripple ? "true" : "false"});

          if (__findClip("${escapeForExtendScript(args.node_id)}")) {
            return __error("remove() ran but the clip is still on the timeline — nothing was removed.");
          }
          return __result({ removed: true, verified: true, clipName: clipName });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    move_clip: {
      description: "Move a clip to a new position on the timeline",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to move",
          },
          new_start_seconds: {
            type: "number",
            description: "New start time in seconds",
          },
          new_track_index: {
            type: "number",
            description: "Optional new track index to move the clip to",
          },
        },
        required: ["node_id", "new_start_seconds"],
      },
      handler: async (args: { node_id: string; new_start_seconds: number; new_track_index?: number }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");

          var clip = result.clip;
          var clipName = clip.name;
          var before = __clipGeometry(clip);
          var beforeStartTicks = clip.start.ticks;
          var newStartTicks = __secondsToTicks(${args.new_start_seconds}).toString();

          ${args.new_track_index !== undefined ? `
          // Validate the destination BEFORE touching anything. This check used to run AFTER
          // the start write, so new_track_index:99 moved the clip in time and then returned
          // "out of range" — a caller that treated the error as "nothing happened" and retried
          // moved the clip twice. There is no undo through this bridge, so every precondition
          // has to be settled while the timeline is still untouched.
          var seq = app.project.activeSequence;
          var targetTracks = result.trackType === "video" ? seq.videoTracks : seq.audioTracks;
          if (${args.new_track_index} < 0 || ${args.new_track_index} >= targetTracks.numTracks) {
            return __error("Target track index ${args.new_track_index} is out of range (valid 0.." + (targetTracks.numTracks - 1) + "). Nothing was changed.");
          }
          var trackMoveNeeded = result.trackIndex !== ${args.new_track_index};
          ` : `
          var trackMoveNeeded = false;
          `}

          var startMoveNeeded = Math.abs(before.start - ${args.new_start_seconds}) >= 0.0005;

          // Short-circuit only when NOTHING is outstanding. The old check returned as soon as
          // the start time already matched, which silently skipped a requested track move while
          // still reporting verified:true — the clip never left its original track.
          if (!startMoveNeeded && !trackMoveNeeded) {
            return __result({ moved: false, verified: true, clipName: clipName, note: "Clip is already at the requested position; nothing to do.", geometry: before });
          }

          if (startMoveNeeded) {
            clip.start = newStartTicks;

            // A real move shifts the whole clip: start hits the target, end follows,
            // duration is invariant. On builds where the DOM merely accepts the start
            // write without moving the clip (observed live on 26.5), end/duration
            // don't follow — restore the property so reads aren't poisoned, and fail.
            var after = __clipGeometry(clip);
            var startOk = Math.abs(after.start - ${args.new_start_seconds}) < 0.0005;
            var durationOk = Math.abs(after.duration - before.duration) < 0.0005;
            var endFollowed = Math.abs((after.end - before.end) - (after.start - before.start)) < 0.0005;

            if (!startOk || !durationOk || !endFollowed) {
              clip.start = beforeStartTicks;
              return __error("move_clip cannot move clips on this Premiere build: the DOM accepted the start write without moving the clip (end/duration did not follow). The start property has been restored so timeline reads stay truthful. Land clips at their final position instead (e.g. overwrite_from_source), or move them in the UI.");
            }
          }

          ${args.new_track_index !== undefined ? `
          if (trackMoveNeeded) {
            clip.moveToTrack(targetTracks[${args.new_track_index}]);
            var relocated = __findClip("${escapeForExtendScript(args.node_id)}");
            if (!relocated || relocated.trackIndex !== ${args.new_track_index}) {
              // Roll the time write back so a failed call leaves no partial mutation behind.
              // Re-resolve the clip first: after a moveToTrack attempt the original handle may
              // be stale.
              var restoredStart = false;
              if (startMoveNeeded) {
                try {
                  var handle = relocated ? relocated.clip : clip;
                  handle.start = beforeStartTicks;
                  restoredStart = Math.abs(__clipGeometry(handle).start - before.start) < 0.0005;
                } catch (e) {}
              }
              return __error("moveToTrack did not land the clip on track ${args.new_track_index} (clip is on track " + (relocated ? relocated.trackIndex : "unknown") + "). "
                + (!startMoveNeeded
                    ? "No start-time change was requested, so nothing was modified."
                    : (restoredStart
                        ? "The start-time move has been rolled back; nothing was modified."
                        : "WARNING: the start-time move could NOT be rolled back — the clip is now at ${args.new_start_seconds}s on its ORIGINAL track. Fix it by hand; there is no undo through this bridge.")));
            }
          }
          ` : ""}

          var finalResult = __findClip("${escapeForExtendScript(args.node_id)}");
          return __result({
            moved: true,
            verified: true,
            clipName: clipName,
            before: before,
            after: finalResult ? __clipGeometry(finalResult.clip) : null,
            trackIndex: finalResult ? finalResult.trackIndex : null
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    trim_clip: {
      description: "Trim a clip's in or out point",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to trim",
          },
          new_in_seconds: {
            type: "number",
            description: "New in-point in seconds (relative to clip's source media)",
          },
          new_out_seconds: {
            type: "number",
            description: "New out-point in seconds (relative to clip's source media)",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string; new_in_seconds?: number; new_out_seconds?: number }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");

          var clip = result.clip;
          var before = __clipGeometry(clip);
          var beforeInTicks = clip.inPoint.ticks;
          var beforeOutTicks = clip.outPoint.ticks;

          // Reject an inverted or negative range BEFORE writing. Premiere clamps silently, and
          // a clamped write followed by a "something changed" check reports success on a clip
          // it has just collapsed.
          ${args.new_in_seconds !== undefined ? `if (${args.new_in_seconds} < 0) return __error("new_in_seconds must be >= 0 (got ${args.new_in_seconds}). Nothing was changed.");` : ""}
          ${args.new_out_seconds !== undefined ? `if (${args.new_out_seconds} < 0) return __error("new_out_seconds must be >= 0 (got ${args.new_out_seconds}). Nothing was changed.");` : ""}
          ${
            args.new_in_seconds !== undefined && args.new_out_seconds !== undefined
              ? `if (${args.new_in_seconds} >= ${args.new_out_seconds}) return __error("new_in_seconds (${args.new_in_seconds}) must be less than new_out_seconds (${args.new_out_seconds}). Nothing was changed.");`
              : ""
          }

          // Tolerance is one frame at the sequence rate: Premiere snaps source points to frame
          // boundaries, so an exact-seconds comparison would false-alarm on 23.976/29.97.
          // videoFrameRate is a Time-LIKE object whose .ticks is ticks-per-FRAME, not fps.
          var trimFps = 25;
          try {
            var tvfr = app.project.activeSequence.getSettings().videoFrameRate;
            var ttpf = parseFloat(tvfr && tvfr.ticks !== undefined ? tvfr.ticks : tvfr);
            if (isFinite(ttpf) && ttpf > 0) trimFps = TICKS_PER_SECOND / ttpf;
          } catch (e) {}
          if (!isFinite(trimFps) || trimFps < 1) trimFps = 25;
          var trimTol = Math.max(1 / trimFps, 0.002);

          ${args.new_in_seconds !== undefined ? `clip.inPoint = __secondsToTicks(${args.new_in_seconds}).toString();` : ""}
          ${args.new_out_seconds !== undefined ? `clip.outPoint = __secondsToTicks(${args.new_out_seconds}).toString();` : ""}

          var after = __clipGeometry(clip);
          var sourceChanged = Math.abs(after.inPoint - before.inPoint) > 0.0005 || Math.abs(after.outPoint - before.outPoint) > 0.0005;
          var footprintChanged = Math.abs(after.start - before.start) > 0.0005 || Math.abs(after.end - before.end) > 0.0005;

          // Verifying only that SOMETHING changed is not verification. A request beyond the end
          // of the source clamps, collapsing the clip toward a single frame — and both
          // sourceChanged and footprintChanged are true for that, so it used to report
          // trimmed:true on a destroyed clip. Compare each requested point with what landed.
          var landedMismatch = null;
          ${
            args.new_in_seconds !== undefined
              ? `if (Math.abs(after.inPoint - ${args.new_in_seconds}) > trimTol) landedMismatch = "in-point: asked for ${args.new_in_seconds}s, Premiere landed on " + after.inPoint + "s";`
              : ""
          }
          ${
            args.new_out_seconds !== undefined
              ? `if (landedMismatch === null && Math.abs(after.outPoint - ${args.new_out_seconds}) > trimTol) landedMismatch = "out-point: asked for ${args.new_out_seconds}s, Premiere landed on " + after.outPoint + "s";`
              : ""
          }

          function restoreSourceRange() {
            try {
              clip.inPoint = beforeInTicks;
              clip.outPoint = beforeOutTicks;
              var back = __clipGeometry(clip);
              return Math.abs(back.inPoint - before.inPoint) <= 0.0005 && Math.abs(back.outPoint - before.outPoint) <= 0.0005;
            } catch (e) { return false; }
          }

          if (!sourceChanged && !footprintChanged) {
            return __error("trim wrote nothing — neither the source range nor the timeline footprint changed.");
          }
          if (landedMismatch !== null) {
            var undone = restoreSourceRange();
            return __error("trim was CLAMPED by Premiere, not applied as requested (" + landedMismatch
              + "; the clip's source runs " + before.inPoint + "s to " + before.outPoint + "s). "
              + (undone
                  ? "The source range has been restored; nothing changed."
                  : "WARNING: the range could NOT be restored — this clip is now " + after.duration + "s. Fix it by hand; there is no undo through this bridge."));
          }
          if (!footprintChanged) {
            // Source metadata moved but the cut did not (observed on stills on
            // 26.5). A half-landed write is worse than none — restore it.
            var stillUndone = restoreSourceRange();
            return __error("trim updated the clip's source range but the timeline cut did not move (known behaviour for stills on this build). "
              + (stillUndone ? "The source range has been restored; nothing changed." : "WARNING: the source range could NOT be restored — inspect this clip by hand.")
              + " To change a still's timeline length, land it at the desired duration instead (overwrite_from_source with a source in/out).");
          }

          return __result({
            trimmed: true,
            verified: true,
            clipName: clip.name,
            toleranceSeconds: trimTol,
            before: before,
            after: after
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    split_clip: {
      description: "Split (razor) a clip at a specific time position. Requires QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          time_seconds: {
            type: "number",
            description: "Time position in seconds where to split",
          },
          track_index: {
            type: "number",
            description: "Track index (0-based)",
          },
          track_type: {
            type: "string",
            enum: ["video", "audio"],
            description: "Track type (default: video)",
          },
        },
        required: ["time_seconds"],
      },
      handler: async (args: { time_seconds: number; track_index?: number; track_type?: string }) => {
        const trackType = args.track_type || "video";
        const trackIndex = args.track_index ?? 0;

        const script = buildToolScript(`
          app.enableQE();
          var seq = qe.project.getActiveSequence();
          if (!seq) return __error("No active sequence (QE)");
          
          var track = ${trackType === "video" ? `seq.getVideoTrackAt(${trackIndex})` : `seq.getAudioTrackAt(${trackIndex})`};
          if (!track) return __error("Track not found");

          var domTrack = ${trackType === "video" ? `app.project.activeSequence.videoTracks[${trackIndex}]` : `app.project.activeSequence.audioTracks[${trackIndex}]`};
          var clipCountBefore = domTrack.clips.numItems;
          var timeTicks = __secondsToTicks(${args.time_seconds}).toString();
          track.razor(timeTicks);

          var clipCountAfter = domTrack.clips.numItems;
          if (clipCountAfter <= clipCountBefore) {
            return __error("Premiere reported razor but the track clip count did not change. Structural QE edits are known to no-op on some Premiere Pro 26.3 installations.");
          }
          return __result({ split: true, verified: true, atSeconds: ${args.time_seconds}, trackIndex: ${trackIndex}, trackType: "${trackType}" });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    duplicate_clip: {
      description: "Duplicate a clip on the timeline (copy to same position on next available track)",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to duplicate",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          var seq = app.project.activeSequence;
          var projectItem = clip.projectItem;
          
          if (!projectItem) return __error("Cannot find source project item for clip");
          
          var newTrackIndex = result.trackIndex + 1;
          var startTicks = clip.start.ticks;
          
          seq.insertClip(projectItem, startTicks, newTrackIndex, newTrackIndex);
          
          return __result({ duplicated: true, clipName: clip.name, newTrackIndex: newTrackIndex });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    enable_disable_clip: {
      description: "Enable or disable a clip on the timeline",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          enabled: {
            type: "boolean",
            description: "Set to true to enable, false to disable",
          },
        },
        required: ["node_id", "enabled"],
      },
      handler: async (args: { node_id: string; enabled: boolean }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          result.clip.setDisabled(${args.enabled ? "false" : "true"});
          return __result({ clipName: result.clip.name, enabled: ${args.enabled} });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_clip_properties: {
      description: "Set properties on a clip (opacity, speed, etc.)",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          opacity: {
            type: "number",
            description: "Opacity value (0-100)",
          },
          speed: {
            type: "number",
            description: "Playback speed multiplier (1.0 = normal, 2.0 = double speed)",
          },
          scale: {
            type: "number",
            description: "Scale percentage (100 = original size)",
          },
          position_x: {
            type: "number",
            description: "Horizontal position",
          },
          position_y: {
            type: "number",
            description: "Vertical position",
          },
          rotation: {
            type: "number",
            description: "Rotation in degrees",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: {
        node_id: string;
        opacity?: number;
        speed?: number;
        scale?: number;
        position_x?: number;
        position_y?: number;
        rotation?: number;
      }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          var changes = {};
          
          ${args.opacity !== undefined ? `
          // Set opacity via Motion component
          for (var i = 0; i < clip.components.numItems; i++) {
            var comp = clip.components[i];
            if (comp.matchName === "AE.ADBE Opacity" || comp.displayName === "Opacity") {
              for (var p = 0; p < comp.properties.numItems; p++) {
                if (comp.properties[p].displayName === "Opacity") {
                  comp.properties[p].setValue(${args.opacity}, true);
                  changes.opacity = ${args.opacity};
                }
              }
            }
          }
          ` : ""}
          
          ${args.speed !== undefined ? `
          clip.setSpeed(${args.speed * 100});
          changes.speed = ${args.speed};
          ` : ""}
          
          ${args.scale !== undefined || args.position_x !== undefined || args.position_y !== undefined || args.rotation !== undefined ? `
          for (var i = 0; i < clip.components.numItems; i++) {
            var comp = clip.components[i];
            if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "Motion") {
              for (var p = 0; p < comp.properties.numItems; p++) {
                var prop = comp.properties[p];
                ${args.scale !== undefined ? `
                if (prop.displayName === "Scale") {
                  prop.setValue(${args.scale}, true);
                  changes.scale = ${args.scale};
                }` : ""}
                ${args.position_x !== undefined || args.position_y !== undefined ? `
                if (prop.displayName === "Position") {
                  var posVal = prop.getValue();
                  var px = posVal && typeof posVal === "object" && posVal.length >= 2 ? posVal[0] : 0;
                  var py = posVal && typeof posVal === "object" && posVal.length >= 2 ? posVal[1] : 0;
                  ${args.position_x !== undefined ? `px = ${args.position_x}; changes.position_x = ${args.position_x};` : ""}
                  ${args.position_y !== undefined ? `py = ${args.position_y}; changes.position_y = ${args.position_y};` : ""}
                  prop.setValue([px, py], true);
                }` : ""}
                ${args.rotation !== undefined ? `
                if (prop.displayName === "Rotation") {
                  prop.setValue(${args.rotation}, true);
                  changes.rotation = ${args.rotation};
                }` : ""}
              }
            }
          }
          ` : ""}
          
          return __result({ updated: true, clipName: clip.name, changes: changes });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    replace_clip: {
      description: "Replace a clip on the timeline with a different project item, preserving position and duration",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to replace",
          },
          new_item_id: {
            type: "string",
            description: "Node ID or name of the new project item to replace with",
          },
        },
        required: ["node_id", "new_item_id"],
      },
      handler: async (args: { node_id: string; new_item_id: string }) => {
        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var newItem = __findProjectItem("${escapeForExtendScript(args.new_item_id)}");
          if (!newItem) return __error("Replacement project item not found: ${escapeForExtendScript(args.new_item_id)}");
          
          var clip = result.clip;
          var oldName = clip.name;
          var startTicks = clip.start.ticks;
          var trackIndex = result.trackIndex;
          var trackType = result.trackType;
          
          // Remove old clip
          clip.remove(false, false);
          
          // Insert new clip at same position
          if (trackType === "video") {
            seq.insertClip(newItem, startTicks, trackIndex, trackIndex);
          } else {
            seq.insertClip(newItem, startTicks, 0, trackIndex);
          }
          
          return __result({
            replaced: true,
            oldClip: oldName,
            newClip: newItem.name,
            trackIndex: trackIndex,
            trackType: trackType
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    speed_change: {
      description: "Change the playback speed of a clip",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          speed_percent: {
            type: "number",
            description: "Speed as percentage (100 = normal, 200 = double, 50 = half)",
          },
          reverse: {
            type: "boolean",
            description: "Reverse playback direction (default: false)",
          },
        },
        required: ["node_id", "speed_percent"],
      },
      handler: async (args: { node_id: string; speed_percent: number; reverse?: boolean }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");

          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          // 26.5 has no DOM TrackItem.setSpeed — this used to call it and die with a
          // ReferenceError while app.enableQE()/qeSeq above went unused. Route through QE.
          // __qeSetSpeed verifies against getSpeed(), and on a wrong-rate landing it restores
          // the clip and returns ok:false with the full story — so ok is the only check needed.
          var outcome = __qeSetSpeed(result, ${args.speed_percent} / 100, ${!!args.reverse});
          if (!outcome.ok) return __error(outcome.error);

          return __result({
            speedChanged: true,
            verified: true,
            clipName: result.clip.name,
            requestedPercent: ${args.speed_percent},
            reverse: ${!!args.reverse},
            observedSpeed: outcome.observedSpeed,
            observedRatioFromDuration: outcome.observedRatioFromDuration,
            observedReversed: outcome.reversed,
            qeSignature: outcome.signature,
            attempts: outcome.tried,
            before: outcome.before,
            after: outcome.after
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },
  };
}
