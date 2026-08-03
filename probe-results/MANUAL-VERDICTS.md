# Hand-measured verdicts (not produced by `probe.mjs`)

`capabilities.json` and `CAPABILITIES.md` are **generated** — do not hand-edit them, they are
rewritten by `scripts/probe/report.mjs`. This file records verdicts reached by a bespoke live
experiment instead, where that experiment is stronger evidence than the generic prober could get.

Each entry states the experiment, so it can be argued with.

---

## 2026-08-03 — the `media` domain (recipe 09, relink offline media)

The prober has **no witness for the `media` domain** — that is why `refresh_media` scored
`UNWITNESSED`. It is not a defect in the tool; it is a gap in the instrument. Closing it properly
means teaching the snapshot to record, per project item, `isOffline()` + `getMediaPath()`. **That is
the highest-value remaining prober change** and would convert this whole family in one go.

| Tool | Generated verdict | Hand-measured verdict | Evidence |
|---|---|---|---|
| `refresh_media` | `UNWITNESSED` | ✅ **WORKS** | Renamed the containing folder, then called it on ONE of three clips in that folder. That clip flipped `isOffline` false→true; the other two did not. Only this call could have caused that. Its `{refreshed:true}` payload is hardcoded and remains worthless as evidence. |
| `relink_media` | `SKIPPED` (T2 destructive) | ✅ **WORKS, and is HONEST** | Repointed three offline items at a renamed folder; each returned online with `getMediaPath()` showing the new path. A deliberate bad path returned **`relinked:false`** and left the item untouched — it fails closed. Confirmed by a rendered frame, not just the flag. |
| `find_items_by_media_path` | `WORKS` | ⚠️ **WORKS, with caveats** | The generated verdict was reached on an **empty result set** (`count:0`), so it never exercised the reporting path. With real matches: one item returns **3 rows**, three items return **9**. `count` is a row count — dedupe by `nodeId`. It also labels video clips `type:"bin"` while their raw `type` is 1 (CLIP). |
| `check_offline_media` / `get_offline_media` | `WORKS` | ⚠️ **WORKS, but LAZY** | Both report Premiere's cached belief, not the disk. After a folder rename they reported every affected clip **online**. They only become truthful after `refresh_media` on each item. A "nothing is offline" result from these tools is not an answer unless every item was refreshed first. |

**Safety note:** `relink_media` was exercised only against throwaway ffmpeg-generated fixtures
(`PROBE-clip-a/b/c.mp4`) in a scratch folder. No media belonging to Sam's 146-clip assembly was
touched, the assembly measured 146 clips before and after, and the project was never saved.

Full route, craft and traps: `~/.claude/skills/premiere-library/references/recipes/relink-offline-media.md`
