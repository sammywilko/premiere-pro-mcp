import {
  buildToolScript,
  escapeForExtendScript,
} from "../bridge/script-builder.js";
import { sendCommand, BridgeOptions } from "../bridge/file-bridge.js";

export function getAdvancedTools(bridgeOptions: BridgeOptions) {
  return {
    ripple_delete: {
      description:
        "Ripple delete a clip (removes clip and closes the gap). Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to ripple delete",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          if (!qeTrack) return __error("QE track not found");
          
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;

          var deletedNodeId = result.clip.nodeId;
          var deletedName = result.clip.name;
          qeClip.rippleDelete();
          if (__findClip(deletedNodeId)) {
            return __error("Premiere reported rippleDelete but the clip is still present. Structural QE edits are known to no-op on some Premiere Pro 26.3 installations; rebuild the keep-segments into a new sequence as a workaround.");
          }
          return __result({ rippleDeleted: true, verified: true, clipName: deletedName });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    roll_edit: {
      description:
        "Perform a roll edit on a clip (adjusts the edit point between two adjacent clips). Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          offset_seconds: {
            type: "number",
            description:
              "Offset in seconds (positive = roll right, negative = roll left)",
          },
        },
        required: ["node_id", "offset_seconds"],
      },
      handler: async (args: { node_id: string; offset_seconds: number }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          // qeClip.roll(ticks) with a single argument answers "Not Enough Parameters" on 26.5
          // (verified live 2026-08-02), and this used to return a hardcoded {rolled:true}.
          // The ticks were already right — only the arity is wrong — so probe the declared
          // arity rather than guessing, then try the plausible forms and PROVE the result.
          var offsetTicks = __secondsToTicks(${args.offset_seconds}).toString();
          var declaredArity = null;
          try { declaredArity = qeClip.roll.length; } catch (e) {}

          var domTrack = result.trackType === "video"
            ? app.project.activeSequence.videoTracks[result.trackIndex]
            : app.project.activeSequence.audioTracks[result.trackIndex];

          function snapTrack() {
            var out = [];
            for (var c = 0; c < domTrack.clips.numItems; c++) {
              var k = domTrack.clips[c];
              out.push({
                nodeId: k.nodeId,
                start: __ticksToSeconds(k.start.ticks),
                end: __ticksToSeconds(k.end.ticks)
              });
            }
            return out;
          }
          function trackChanged(a, b) {
            if (a.length !== b.length) return true;
            for (var i = 0; i < a.length; i++) {
              if (a[i].nodeId !== b[i].nodeId) return true;
              if (Math.abs(a[i].start - b[i].start) > 0.0005) return true;
              if (Math.abs(a[i].end - b[i].end) > 0.0005) return true;
            }
            return false;
          }

          var beforeTrack = snapTrack();
          var seqBefore = __ticksToSeconds(app.project.activeSequence.end);

          // Live probe 2026-08-02: qeClip.roll.length reports 0 (host-native, not introspectable).
          // 2 args -> "Not Enough Parameters"; 3 args -> accepted but no-op. The 3-arg no-op is
          // most likely a UNIT problem: 0.5s in ticks is ~1.27e11, which as a FRAME COUNT is
          // absurd and clamps to nothing. So try frames as well as ticks, at arity 3/4/5.
          // getSettings().videoFrameRate is a Time-LIKE OBJECT whose .ticks is ticks-per-FRAME,
          // not a plain fps number — see utility.ts's parseFloat(applied.videoFrameRate.ticks).
          // Treating it as a number yields NaN (and NaN < 1 is false, so a naive guard never
          // fires), which would silently NaN out every frames-based attempt below.
          var rollFps = 25;
          try {
            var vfr = app.project.activeSequence.getSettings().videoFrameRate;
            var tpf = parseFloat(vfr && vfr.ticks !== undefined ? vfr.ticks : vfr);
            if (isFinite(tpf) && tpf > 0) rollFps = TICKS_PER_SECOND / tpf;
          } catch (e) {}
          if (!isFinite(rollFps) || rollFps < 1) rollFps = 25;
          var offsetFrames = Math.round(${args.offset_seconds} * rollFps);

          var rollAttempts = [
            { label: "frames+0+0",       run: function () { qeClip.roll(offsetFrames, 0, 0); } },
            { label: "frames+track+0",   run: function () { qeClip.roll(offsetFrames, result.trackIndex, 0); } },
            { label: "frames+0+0+0",     run: function () { qeClip.roll(offsetFrames, 0, 0, 0); } },
            { label: "frames+0+0+0+0",   run: function () { qeClip.roll(offsetFrames, 0, 0, 0, 0); } },
            { label: "ticks+0+0+0",      run: function () { qeClip.roll(offsetTicks, 0, 0, 0); } },
            { label: "ticks+0+0+0+0",    run: function () { qeClip.roll(offsetTicks, 0, 0, 0, 0); } },
            { label: "ticks+0+0",        run: function () { qeClip.roll(offsetTicks, 0, 0); } }
          ];

          // "Something on the track moved" is NOT proof of a roll. Verify the TARGET clip's own
          // end edge moved by the REQUESTED offset, in the right direction. Without this, a
          // wrong-units signature that shifts some boundary by an arbitrary amount (or shifts a
          // different cut entirely) would be reported as {rolled:true, verified:true}.
          function edgeOf(snap, nodeId) {
            for (var q = 0; q < snap.length; q++) if (snap[q].nodeId === nodeId) return snap[q];
            return null;
          }
          var targetNode = result.clip.nodeId;
          var wantDelta = ${args.offset_seconds};
          var edgeTol = Math.max(1 / rollFps, 0.002);   // one frame

          var rollTried = [];
          var prevTrack = beforeTrack;
          for (var r = 0; r < rollAttempts.length; r++) {
            var rErr = null;
            try { rollAttempts[r].run(); } catch (e) { rErr = String(e); }
            var afterTrack = snapTrack();
            // Compare against the PREVIOUS attempt's state, not a stale pre-loop baseline, so a
            // sub-threshold residue from an earlier attempt is not misattributed to this one.
            var moved = trackChanged(prevTrack, afterTrack);

            if (!moved) {
              rollTried.push(rollAttempts[r].label + (rErr ? " -> " + rErr : " -> no-op"));
              continue;
            }

            var b = edgeOf(beforeTrack, targetNode), a = edgeOf(afterTrack, targetNode);
            var gotDelta = (b && a) ? (a.end - b.end) : null;
            var edgeOk = gotDelta !== null && Math.abs(gotDelta - wantDelta) <= edgeTol;
            var seqAfter = __ticksToSeconds(app.project.activeSequence.end);
            var durationHeld = Math.abs(seqAfter - seqBefore) <= 0.0005;

            rollTried.push(rollAttempts[r].label + " -> MOVED (target edge delta "
              + (gotDelta === null ? "clip not found" : gotDelta + "s vs requested " + wantDelta + "s") + ")");

            if (edgeOk && durationHeld) {
              return __result({
                rolled: true, verified: true, durationHeld: true,
                clipName: result.clip.name,
                requestedOffsetSeconds: wantDelta,
                observedEdgeDeltaSeconds: gotDelta,
                qeSignature: rollAttempts[r].label,
                declaredArity: declaredArity,
                attempts: rollTried,
                beforeTrack: beforeTrack, afterTrack: afterTrack
              });
            }

            // Moved, but not a correct roll. There is no undo here — stop rather than stack
            // further speculative signatures on top of an already-perturbed timeline.
            return __error(
              "roll_edit MUTATED THE TIMELINE BUT NOT AS REQUESTED via '" + rollAttempts[r].label + "': "
              + (gotDelta === null
                  ? "the target clip could not be found on the track afterwards"
                  : "target clip's end moved " + gotDelta + "s, requested " + wantDelta + "s")
              + (durationHeld ? "" : "; sequence duration also changed (" + seqBefore + "s -> " + seqAfter + "s), so this behaved like a trim, not a roll")
              + ". The clip was NOT restored (QE offers no inverse for this call) — inspect and fix by hand. "
              + "Tried: " + rollTried.join(" | ")
            );
          }

          return __error(
            "roll_edit changed nothing under any tried signature. qeClip.roll declares arity "
            + declaredArity + " (null = not introspectable). Tried: " + rollTried.join(" | ")
          );
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    slide_edit: {
      description:
        "Perform a slide edit on a clip (moves clip without changing its duration, adjusting adjacent clips). Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          offset_seconds: {
            type: "number",
            description:
              "Offset in seconds (positive = slide right, negative = slide left)",
          },
        },
        required: ["node_id", "offset_seconds"],
      },
      handler: async (args: { node_id: string; offset_seconds: number }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          var offsetTicks = __secondsToTicks(${args.offset_seconds}).toString();
          qeClip.slide(offsetTicks);
          return __result({ slid: true, clipName: result.clip.name, offsetSeconds: ${args.offset_seconds} });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    slip_edit: {
      description:
        "Perform a slip edit on a clip (changes source in/out points without moving clip on timeline). Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          offset_seconds: {
            type: "number",
            description:
              "Offset in seconds (positive = slip forward in source, negative = slip backward)",
          },
        },
        required: ["node_id", "offset_seconds"],
      },
      handler: async (args: { node_id: string; offset_seconds: number }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          var offsetTicks = __secondsToTicks(${args.offset_seconds}).toString();
          qeClip.slip(offsetTicks);
          return __result({ slipped: true, clipName: result.clip.name, offsetSeconds: ${args.offset_seconds} });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    move_clip_to_track: {
      description: "Move a clip to a different track. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          target_track_index: {
            type: "number",
            description: "Target track index (0-based)",
          },
        },
        required: ["node_id", "target_track_index"],
      },
      handler: async (args: {
        node_id: string;
        target_track_index: number;
      }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          qeClip.moveToTrack(${args.target_track_index});
          return __result({ moved: true, clipName: result.clip.name, newTrackIndex: ${args.target_track_index} });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    remove_all_effects: {
      description: "Remove ALL effects from a clip. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          qeClip.removeEffects();
          return __result({ removed: true, clipName: result.clip.name });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_clip_speed_qe: {
      description:
        "Set clip playback speed using QE DOM (more reliable than ExtendScript). Supports reverse.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          speed_percent: {
            type: "number",
            description:
              "Speed as percentage (100 = normal, 200 = 2x, 50 = half speed)",
          },
          reverse: {
            type: "boolean",
            description: "Reverse playback direction (default: false)",
          },
        },
        required: ["node_id", "speed_percent"],
      },
      handler: async (args: {
        node_id: string;
        speed_percent: number;
        reverse?: boolean;
      }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          // Was: qeClip.setSpeed(percent) with a single argument, which 26.5 rejects with
          // "Not Enough Parameters". __qeSetSpeed finds the working signature and proves the
          // result against the clip's duration rather than a self-report.
          var outcome = __qeSetSpeed(result, ${args.speed_percent} / 100, ${!!args.reverse});
          if (!outcome.ok) return __error(outcome.error);

          return __result({
            speedSet: true,
            verified: true,
            clipName: result.clip.name,
            requestedPercent: ${args.speed_percent},
            observedSpeed: outcome.observedSpeed,
            observedRatioFromDuration: outcome.observedRatioFromDuration,
            observedReversed: outcome.reversed,
            reverse: ${!!args.reverse},
            qeSignature: outcome.signature,
            attempts: outcome.tried,
            before: outcome.before,
            after: outcome.after
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    reverse_clip: {
      description: "Reverse a clip's playback direction. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          reverse: {
            type: "boolean",
            description: "True to reverse, false for normal (default: true)",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string; reverse?: boolean }) => {
        const rev = args.reverse !== false;
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          qeClip.setReverse(${rev});
          return __result({ reversed: ${rev}, clipName: result.clip.name });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_frame_blend: {
      description: "Enable or disable frame blending on a clip. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          enabled: {
            type: "boolean",
            description: "True to enable frame blending, false to disable",
          },
        },
        required: ["node_id", "enabled"],
      },
      handler: async (args: { node_id: string; enabled: boolean }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          qeClip.setFrameBlend(${args.enabled});
          return __result({ frameBlend: ${args.enabled}, clipName: result.clip.name });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_time_interpolation: {
      description:
        "Set time interpolation type for a clip (Frame Sampling, Frame Blending, Optical Flow). Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          interpolation_type: {
            type: "number",
            description:
              "0 = Frame Sampling, 1 = Frame Blending, 2 = Optical Flow",
          },
        },
        required: ["node_id", "interpolation_type"],
      },
      handler: async (args: {
        node_id: string;
        interpolation_type: number;
      }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          qeClip.setTimeInterpolationType(${args.interpolation_type});
          var typeNames = ["Frame Sampling", "Frame Blending", "Optical Flow"];
          return __result({
            set: true,
            clipName: result.clip.name,
            interpolationType: typeNames[${args.interpolation_type}] || "Unknown"
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    rename_clip: {
      description: "Rename a clip on the timeline. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          new_name: {
            type: "string",
            description: "New name for the clip",
          },
        },
        required: ["node_id", "new_name"],
      },
      handler: async (args: { node_id: string; new_name: string }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : qeSeq.getAudioTrackAt(result.trackIndex);
          var qeLookup = __qeItemForDomClip(qeTrack, result);
          if (!qeLookup.ok) return __error(qeLookup.error);
          var qeClip = qeLookup.item;
          
          var oldName = result.clip.name;
          qeClip.setName("${escapeForExtendScript(args.new_name)}");
          return __result({ renamed: true, oldName: oldName, newName: "${escapeForExtendScript(args.new_name)}" });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    get_clip_speed: {
      description: "Get the playback speed and reverse state of a clip",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          // These used to be initialised to 1/false with the failure swallowed, so a missing
          // DOM method reported a confident "speed: 1" that was really just the default.
          // Say which readings are real; a duration-derived ratio is the honest fallback.
          var speed = null, reversed = null;
          var speedReadOk = false, reversedReadOk = false;
          try { speed = clip.getSpeed(); speedReadOk = true; } catch(e) {}
          try { reversed = clip.isSpeedReversed() == 1; reversedReadOk = true; } catch(e) {}

          var geo = __clipGeometry(clip);
          var sourceSpan = geo.outPoint - geo.inPoint;
          var impliedRatio = (geo.duration > 0.0005 && sourceSpan > 0.0005)
            ? (sourceSpan / geo.duration) : null;

          return __result({
            clipName: clip.name,
            speed: speedReadOk ? speed : null,
            reversed: reversedReadOk ? reversed : null,
            speedReadSupported: speedReadOk,
            reversedReadSupported: reversedReadOk,
            impliedRatioFromDuration: impliedRatio,
            note: speedReadOk
              ? undefined
              : "clip.getSpeed() is unavailable on this Premiere build — 'speed' is null rather than a fabricated 1. Use impliedRatioFromDuration, or diff duration across the change."
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_clip_selection: {
      description: "Select or deselect a clip in the active sequence",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          selected: {
            type: "boolean",
            description: "True to select, false to deselect",
          },
        },
        required: ["node_id", "selected"],
      },
      handler: async (args: { node_id: string; selected: boolean }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          result.clip.setSelected(${args.selected ? 1 : 0}, true);
          return __result({ selected: ${args.selected}, clipName: result.clip.name });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    link_selection: {
      description:
        "Link the currently selected video and audio clips in the active sequence",
      parameters: {},
      handler: async () => {
        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          seq.linkSelection();
          return __result({ linked: true });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    unlink_selection: {
      description:
        "Unlink the currently selected video and audio clips in the active sequence",
      parameters: {},
      handler: async () => {
        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          seq.unlinkSelection();
          return __result({ unlinked: true });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    overwrite_clip: {
      description:
        "Overwrite a project item onto the timeline (replaces existing clips at the insertion point)",
      parameters: {
        type: "object" as const,
        properties: {
          item_id: {
            type: "string",
            description: "Node ID or name of the project item to add",
          },
          start_seconds: {
            type: "number",
            description: "Start time in seconds on the timeline (default: 0)",
          },
          track_index: {
            type: "number",
            description: "Video track index (0-based, default: 0)",
          },
          audio_track_index: {
            type: "number",
            description: "Audio track index (0-based, default: 0)",
          },
        },
        required: ["item_id"],
      },
      handler: async (args: {
        item_id: string;
        start_seconds?: number;
        track_index?: number;
        audio_track_index?: number;
      }) => {
        const startSeconds = args.start_seconds ?? 0;
        const trackIndex = args.track_index ?? 0;
        const audioTrackIndex = args.audio_track_index ?? 0;

        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Project item not found: ${escapeForExtendScript(args.item_id)}");
          
          var startTicks = __secondsToTicks(${startSeconds}).toString();
          seq.overwriteClip(item, startTicks, ${trackIndex}, ${audioTrackIndex});
          
          return __result({
            overwritten: true,
            item: item.name,
            trackIndex: ${trackIndex},
            startSeconds: ${startSeconds}
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    create_sequence_from_clips: {
      description:
        "Create a new sequence by automatically placing project items in order",
      parameters: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Name for the new sequence",
          },
          item_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of project item names or node IDs to include in order",
          },
        },
        required: ["name", "item_ids"],
      },
      handler: async (args: { name: string; item_ids: string[] }) => {
        const itemLookups = args.item_ids
          .map(
            (id, i) =>
              `var item${i} = __findProjectItem("${escapeForExtendScript(id)}"); if (!item${i}) return __error("Item not found: ${escapeForExtendScript(id)}"); items.push(item${i});`,
          )
          .join("\n          ");

        const script = buildToolScript(`
          var items = [];
          ${itemLookups}
          
          var seq = app.project.createNewSequenceFromClips("${escapeForExtendScript(args.name)}", items);
          if (!seq) return __error("Failed to create sequence from clips");
          return __result({ created: true, name: seq.name, id: seq.sequenceID, clipCount: items.length });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    close_sequence: {
      description: "Close a sequence tab in the timeline",
      parameters: {
        type: "object" as const,
        properties: {
          sequence_id: {
            type: "string",
            description:
              "Sequence name or ID. Uses active sequence if omitted.",
          },
        },
      },
      handler: async (args: { sequence_id?: string }) => {
        const seqLookup = args.sequence_id
          ? `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`
          : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;

        const script = buildToolScript(`
          ${seqLookup}
          var name = seq.name;
          seq.close();
          return __result({ closed: true, name: name });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    export_as_project: {
      description:
        "Export a sequence as a standalone Premiere Pro project file",
      parameters: {
        type: "object" as const,
        properties: {
          sequence_id: {
            type: "string",
            description:
              "Sequence name or ID. Uses active sequence if omitted.",
          },
          output_path: {
            type: "string",
            description: "Full path for the exported .prproj file",
          },
        },
        required: ["output_path"],
      },
      handler: async (args: { sequence_id?: string; output_path: string }) => {
        const seqLookup = args.sequence_id
          ? `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`
          : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;

        const script = buildToolScript(`
          ${seqLookup}
          seq.exportAsProject("${escapeForExtendScript(args.output_path)}");
          return __result({ exported: true, path: "${escapeForExtendScript(args.output_path)}" });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_zero_point: {
      description: "Set the starting timecode (zero point) of a sequence",
      parameters: {
        type: "object" as const,
        properties: {
          sequence_id: {
            type: "string",
            description:
              "Sequence name or ID. Uses active sequence if omitted.",
          },
          start_seconds: {
            type: "number",
            description: "Start time in seconds for the timecode origin",
          },
        },
        required: ["start_seconds"],
      },
      handler: async (args: {
        sequence_id?: string;
        start_seconds: number;
      }) => {
        const seqLookup = args.sequence_id
          ? `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`
          : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;

        const script = buildToolScript(`
          ${seqLookup}
          var ticks = __secondsToTicks(${args.start_seconds}).toString();
          seq.setZeroPoint(ticks);
          return __result({ set: true, startSeconds: ${args.start_seconds} });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    scene_edit_detection: {
      description:
        "Perform scene edit detection on the selected clips in the active sequence",
      parameters: {},
      handler: async () => {
        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          seq.performSceneEditDetectionOnSelection();
          return __result({ sceneDetection: true });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    delete_preview_files: {
      description:
        "Delete all preview/render cache files for the project. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          media_type: {
            type: "string",
            description:
              "Type of preview files to delete: 'video', 'audio', or 'all' (default: 'all')",
          },
        },
      },
      handler: async (args: { media_type?: string }) => {
        const typeMap: Record<string, string> = {
          video: '"228CDA18-3625-4d2d-951E-348879E4ED93"',
          audio: '"80B8E3D5-6DCA-4195-AEFB-CB5F407AB009"',
          all: '"FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"',
        };
        const mediaType = typeMap[args.media_type || "all"] || typeMap.all;

        const script = buildToolScript(`
          app.enableQE();
          qe.project.deletePreviewFiles(${mediaType});
          return __result({ deleted: true, mediaType: "${args.media_type || "all"}" });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    add_tracks: {
      description:
        "Add video and/or audio tracks to the active sequence. Uses QE DOM.",
      parameters: {
        type: "object" as const,
        properties: {
          video_tracks: {
            type: "number",
            description: "Number of video tracks to add (default: 0)",
          },
          audio_tracks: {
            type: "number",
            description:
              "Number of standard stereo audio tracks to add (default: 0)",
          },
          audio_mono_tracks: {
            type: "number",
            description: "Number of mono audio tracks to add (default: 0)",
          },
          audio_51_tracks: {
            type: "number",
            description: "Number of 5.1 audio tracks to add (default: 0)",
          },
        },
      },
      handler: async (args: {
        video_tracks?: number;
        audio_tracks?: number;
        audio_mono_tracks?: number;
        audio_51_tracks?: number;
      }) => {
        const v = args.video_tracks ?? 0;
        const a = args.audio_tracks ?? 0;
        const aMono = args.audio_mono_tracks ?? 0;
        const a51 = args.audio_51_tracks ?? 0;

        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          qeSeq.addTracks(${v}, ${a}, ${aMono}, ${a51});
          return __result({
            added: true,
            videoTracks: ${v},
            audioTracks: ${a},
            audioMonoTracks: ${aMono},
            audio51Tracks: ${a51}
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_color_value: {
      description:
        "Set a color value on an effect property (e.g., tint color, fill color)",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          component_name: {
            type: "string",
            description: "Name of the component/effect",
          },
          property_name: {
            type: "string",
            description: "Name of the color property",
          },
          alpha: {
            type: "number",
            description: "Alpha (0-255)",
          },
          red: {
            type: "number",
            description: "Red (0-255)",
          },
          green: {
            type: "number",
            description: "Green (0-255)",
          },
          blue: {
            type: "number",
            description: "Blue (0-255)",
          },
        },
        required: [
          "node_id",
          "component_name",
          "property_name",
          "alpha",
          "red",
          "green",
          "blue",
        ],
      },
      handler: async (args: {
        node_id: string;
        component_name: string;
        property_name: string;
        alpha: number;
        red: number;
        green: number;
        blue: number;
      }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var components = clip.components;
          var targetComp = null;
          for (var i = 0; i < components.numItems; i++) {
            if (components[i].displayName === "${escapeForExtendScript(args.component_name)}") {
              targetComp = components[i];
              break;
            }
          }
          if (!targetComp) return __error("Component not found");
          
          var targetProp = null;
          for (var j = 0; j < targetComp.properties.numItems; j++) {
            if (targetComp.properties[j].displayName === "${escapeForExtendScript(args.property_name)}") {
              targetProp = targetComp.properties[j];
              break;
            }
          }
          if (!targetProp) return __error("Property not found");
          
          targetProp.setColorValue(${args.alpha}, ${args.red}, ${args.green}, ${args.blue}, true);
          return __result({
            set: true,
            color: { alpha: ${args.alpha}, red: ${args.red}, green: ${args.green}, blue: ${args.blue} }
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    get_clip_adjustment_layer: {
      description: "Check if a clip is an adjustment layer",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var isAdj = false;
          try { isAdj = clip.isAdjustmentLayer(); } catch(e) {}
          
          return __result({ clipName: clip.name, isAdjustmentLayer: isAdj });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    get_linked_items: {
      description:
        "Get all clips in the sequence that are linked to the same source as a given clip",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var linked = result.clip.getLinkedItems();
          var items = [];
          if (linked) {
            for (var i = 0; i < linked.numItems; i++) {
              items.push({
                name: linked[i].name,
                nodeId: linked[i].nodeId,
                startSeconds: __ticksToSeconds(linked[i].start.ticks)
              });
            }
          }
          
          return __result({ clipName: result.clip.name, linkedItems: items, count: items.length });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    get_mogrt_component: {
      description:
        "Get MOGRT (Motion Graphics Template) component parameters from a clip",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the MOGRT clip on the timeline",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var mgtComp = result.clip.getMGTComponent();
          if (!mgtComp) return __error("Not a MOGRT clip or no MGT component found");
          
          var params = [];
          for (var i = 0; i < mgtComp.properties.numItems; i++) {
            var p = mgtComp.properties[i];
            params.push({
              displayName: p.displayName,
              value: p.getValue()
            });
          }
          
          return __result({ clipName: result.clip.name, parameters: params });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },
  };
}
