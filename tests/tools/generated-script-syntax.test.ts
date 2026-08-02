import { describe, it, expect, vi, beforeEach } from "vitest";
import { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getTimelineTools } from "../../src/tools/timeline.js";
import { getAdvancedTools } from "../../src/tools/advanced.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/test-bridge", timeoutMs: 5000 };

async function scriptFor(tool: { handler: (args: never) => Promise<unknown> }, args: unknown) {
  mockedSendCommand.mockClear();
  await tool.handler(args as never);
  expect(mockedSendCommand).toHaveBeenCalled();
  return mockedSendCommand.mock.calls[0][0] as string;
}

beforeEach(() => vi.clearAllMocks());

/**
 * These tools assemble ExtendScript by string interpolation, and several of them switch
 * whole blocks in and out on whether an optional argument was supplied. A variant that
 * only appears for one arg shape — `move_clip` without `new_track_index`, `trim_clip`
 * with just an out-point — is invisible to tsc, ships as a syntax error, and fails inside
 * Premiere on a system with no undo.
 *
 * `new Function(src)` parses without executing, so this asserts every arg shape at least
 * produces parseable code. It cannot prove the script is correct — only that it is not
 * malformed, which is the failure mode string templating actually produces.
 */
function expectParses(script: string, label: string) {
  expect(script.length, `${label}: empty script`).toBeGreaterThan(0);
  expect(() => new Function(script), `${label}: generated ExtendScript does not parse`).not.toThrow();
}

describe("generated ExtendScript parses for every optional-argument shape", () => {
  const timeline = getTimelineTools(bridgeOptions);
  const advanced = getAdvancedTools(bridgeOptions);

  const cases: Array<[string, { handler: (args: never) => Promise<unknown> }, unknown]> = [
    ["move_clip / start only", timeline.move_clip, { node_id: "abc123", new_start_seconds: 5 }],
    ["move_clip / start + track", timeline.move_clip, { node_id: "abc123", new_start_seconds: 5, new_track_index: 2 }],
    ["move_clip / track 0", timeline.move_clip, { node_id: "abc123", new_start_seconds: 0, new_track_index: 0 }],
    ["trim_clip / in only", timeline.trim_clip, { node_id: "abc123", new_in_seconds: 1 }],
    ["trim_clip / out only", timeline.trim_clip, { node_id: "abc123", new_out_seconds: 9 }],
    ["trim_clip / in + out", timeline.trim_clip, { node_id: "abc123", new_in_seconds: 1, new_out_seconds: 9 }],
    ["trim_clip / neither", timeline.trim_clip, { node_id: "abc123" }],
    ["speed_change / forward", timeline.speed_change, { node_id: "abc123", speed_percent: 50 }],
    ["speed_change / reversed", timeline.speed_change, { node_id: "abc123", speed_percent: 200, reverse: true }],
    ["add_to_timeline", timeline.add_to_timeline, { item_id: "item1", track_index: 0, start_seconds: 0 }],
    ["remove_from_timeline / ripple", timeline.remove_from_timeline, { node_id: "abc123", ripple: true }],
    ["remove_from_timeline / no ripple", timeline.remove_from_timeline, { node_id: "abc123" }],
    ["roll_edit", advanced.roll_edit, { node_id: "abc123", offset_seconds: 0.5 }],
    ["set_clip_speed_qe", advanced.set_clip_speed_qe, { node_id: "abc123", speed_percent: 25 }],
    ["set_clip_speed_qe / reversed", advanced.set_clip_speed_qe, { node_id: "abc123", speed_percent: 25, reverse: true }],
  ];

  for (const [label, tool, args] of cases) {
    it(`${label} produces parseable ExtendScript`, async () => {
      expectParses(await scriptFor(tool, args), label);
    });
  }

  it("a node_id containing quotes cannot break out of its string literal", async () => {
    const script = await scriptFor(timeline.move_clip, {
      node_id: 'x"); app.project.close(); ("',
      new_start_seconds: 1,
    });
    // The payload still appears in the source — inert, inside the string literal. What must
    // never happen is an UNESCAPED quote closing that literal and letting the rest run, so
    // assert on the escaping rather than on the text being absent.
    expectParses(script, "move_clip / hostile node_id");
    expect(script).toContain('x\\"); app.project.close(); (\\"');
    expect(script).not.toMatch(/[^\\]"\); app\.project\.close/);
  });
});
