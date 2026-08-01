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
          var before = __clipGeometry(clip);
          var beforeStartTicks = clip.start.ticks;
          var newStartTicks = __secondsToTicks(${args.new_start_seconds}).toString();

          if (Math.abs(before.start - ${args.new_start_seconds}) < 0.0005) {
            return __result({ moved: false, verified: true, clipName: clip.name, note: "Clip already starts at the requested time; nothing to do.", geometry: before });
          }

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

          ${args.new_track_index !== undefined ? `
          var seq = app.project.activeSequence;
          var targetTracks = result.trackType === "video" ? seq.videoTracks : seq.audioTracks;
          if (${args.new_track_index} >= targetTracks.numTracks) return __error("Target track index ${args.new_track_index} out of range (start-time move already applied and verified)");
          clip.moveToTrack(targetTracks[${args.new_track_index}]);
          var relocated = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!relocated || relocated.trackIndex !== ${args.new_track_index}) {
            return __error("Start-time move applied and verified, but moveToTrack did not land the clip on track ${args.new_track_index} (clip is on track " + (relocated ? relocated.trackIndex : "unknown") + ").");
          }
          ` : ""}

          return __result({
            moved: true,
            verified: true,
            clipName: clip.name,
            before: before,
            after: __clipGeometry(clip)
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

          ${args.new_in_seconds !== undefined ? `clip.inPoint = __secondsToTicks(${args.new_in_seconds}).toString();` : ""}
          ${args.new_out_seconds !== undefined ? `clip.outPoint = __secondsToTicks(${args.new_out_seconds}).toString();` : ""}

          var after = __clipGeometry(clip);
          var sourceChanged = Math.abs(after.inPoint - before.inPoint) > 0.0005 || Math.abs(after.outPoint - before.outPoint) > 0.0005;
          var footprintChanged = Math.abs(after.start - before.start) > 0.0005 || Math.abs(after.end - before.end) > 0.0005;

          if (!sourceChanged && !footprintChanged) {
            return __error("trim wrote nothing — neither the source range nor the timeline footprint changed.");
          }
          if (!footprintChanged) {
            // Source metadata moved but the cut did not (observed on stills on
            // 26.5). A half-landed write is worse than none — restore it.
            clip.inPoint = beforeInTicks;
            clip.outPoint = beforeOutTicks;
            return __error("trim updated the clip's source range but the timeline cut did not move (known behaviour for stills on this build). The source range has been restored; nothing changed. To change a still's timeline length, land it at the desired duration instead (overwrite_from_source with a source in/out).");
          }

          return __result({
            trimmed: true,
            verified: true,
            clipName: clip.name,
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

          var clip = result.clip;
          var before = __clipGeometry(clip);
          var beforeSpeed = null;
          try { beforeSpeed = clip.getSpeed(); } catch(e) {}

          var speed = "${args.speed_percent}";
          ${args.reverse ? 'speed = "-" + speed;' : ""}
          clip.setSpeed(speed);

          var after = __clipGeometry(clip);
          var afterSpeed = null;
          try { afterSpeed = clip.getSpeed(); } catch(e) {}
          var reversedNow = null;
          try { reversedNow = clip.isSpeedReversed() == 1; } catch(e) {}

          var speedMoved = beforeSpeed !== null && afterSpeed !== null && Math.abs(afterSpeed - beforeSpeed) > 0.0001;
          var durationMoved = Math.abs(after.duration - before.duration) > 0.0005;
          var alreadyThere = beforeSpeed !== null && (Math.abs(beforeSpeed - ${args.speed_percent}) < 0.01 || Math.abs(beforeSpeed - ${args.speed_percent} / 100) < 0.0001);

          if (!speedMoved && !durationMoved && !alreadyThere) {
            return __error("setSpeed ran but neither the clip's speed (getSpeed: " + beforeSpeed + " -> " + afterSpeed + ") nor its duration changed — nothing was applied.");
          }

          return __result({
            speedChanged: true,
            verified: true,
            clipName: clip.name,
            requestedPercent: ${args.speed_percent},
            reverse: ${!!args.reverse},
            observedSpeed: afterSpeed,
            observedReversed: reversedNow,
            before: before,
            after: after
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },
  };
}
