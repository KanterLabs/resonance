# Arc Studio UX pass

Status: implemented (see [As shipped](#as-shipped)). Owner: KanterLabs. Builds on [Playlist Builder v1: Arcs](playlist-builder.md).

## Summary

Arc Studio works, but it loses the user's choices, keeps the curve and the track list apart, and
offers few ways to shape an arc by hand. This pass fixes those in four phases:

| Phase | Items | Theme |
|---|---|---|
| 1 | 1, 2, 3, 4 | Never lose work: swaps stay, undo, no silent seed loss, no dropped keys |
| 2 | 5, 6, 13, 14 | One picture: tracks drawn on the curve, a clear status line, a short legend |
| 3 | 7, 8, 9, 10 | Hand editing: reorder, faster curve edits, minutes, a seed list |
| 4 | 12, 11 | Listen and keep: save as new, unsaved marker, audition |

Each phase ships on its own. Phase 1 comes first because
later phases add more ways to edit, and every one of them needs undo.

## Key map after this pass

| Key | Mode | Action | Status |
|---|---|---|---|
| `z` / `Z` | arc | Undo / redo | new (2) |
| `Shift+↑` `Shift+↓` | arc | Move the selected track; it stays where you put it | new (7) |
| `<` `>` | arc | Same as Shift+arrows, for terminals that do not report Shift | new (7) |
| `m` | arc | Switch length between tracks and minutes | new (9) |
| `f` | arc | Starting songs: list, remove, add | new (10) |
| `S` | arc | Save as a new playlist | new (12) |
| `a` | arc, swap | Audition the selected track | new (11) |
| `0`–`9` | curve edit | Set the point's energy (`1` = 10% … `9` = 90%, `0` = 100%) | new (8) |
| `Shift+←` `Shift+→` | curve edit | Slide the point earlier or later | new (8) |
| `n` / `d` | curve edit | Add a point after this one / delete this point | new (8) |
| `r` then `⏎` | swap | The chosen track is now kept automatically | changed (1) |

`?` stays global and opens Help, which gains a complete Arc Studio section (14). Digits are
global screen shortcuts, but curve-edit mode is modal (`editing()` is true), so the screen
receives them there.

---

## Phase 1: never lose work

### 1. Keep swapped-in tracks

**Problem.** `Service::choose` (`src/builder/mod.rs:235`) replaces the URI in the sequence but
adds no pin. The next shape, length, mix, or remix rebuild re-solves that slot.

**Change.**
- `choose`: after `retain`, push `Pin { uri, slot: Some(slot) }`. The draft returned to the client
  carries the pin in `recipe.pins`, and `ArcsController.accept` already copies the engine's
  recipe, so the next `builder.build` sends it back.
- Status: `Swapped in Teardrop and kept it there · k to let it move`.
- If the length shrinks below a pinned slot, `solve.rs:555` already treats it as unslotted and
  places it by energy. No change needed; add a test.
- `demo-arcs.ts` has no alternatives, so it needs no change.

**Tests.** `src/builder/tests.rs`: choose, then rebuild with a different preset and length, and
the chosen URI is still in the draft. Choose at slot 15, shrink to 10 tracks, and the URI is
still present. `arcs-screen.test.ts`: the swapped row shows `◆`.

### 2. Undo and redo

**Design: client-side snapshots plus one new RPC.** The engine stays stateless about history.
The client keeps snapshots and asks the engine to restore one exactly.

```ts
interface Snapshot { label: string; recipe: Recipe; uris: string[]; preset: string | null }
```

- `ArcsController` gains `past: Snapshot[]` and `future: Snapshot[]`, capped at 50.
- `record(label)` runs before every change: `choose`, `pin`, `ban`, `move` (7), `remix`,
  `useCurrent`, `addSeed`, `removeSeed`, and the first `edit()` of a burst. Debounced edits
  record once per burst, keyed on the debounce timer, so dragging a point is one undo step.
- `undo()` pops `past`, pushes the current state to `future`, and calls `builder.restore`. Any
  new change clears `future`.
- Status: `Undid: removed Teardrop · Z redo`.

**New RPC `builder.restore { recipe, uris }` → `{ draft }`** (`src/rpc/builder.rs`, plus
`Service::restore` in `mod.rs`):
1. If the seeds or discovery differ from the active recipe, rebuild the pool the way
   `builder.build` does. Otherwise reuse `active.pool`.
2. `solve::assemble(&pool, &recipe, &uris, &targets)`, with the targets sampled from the
   recipe's curve. A URI that has left the pool, which is rare, is refilled with its best
   alternative.
3. Store the result as `active`, persist the recipe as `last`, and return the draft.

Restoring by URIs rather than re-solving means undo brings back exactly what was on screen, even
if listening history changed in between.

**Contracts.** Add `builder.restore` to `contracts.ts` and to the fixtures in
`test/engine-contract.ts`. In `demo-arcs.ts`, restore re-runs the demo build with the recipe.

**Tests.** Rust: restore with the same URIs reproduces the same slots, and restore with changed
seeds rebuilds the pool. Bun: undo after ban brings the track back, redo removes it again, a new
edit clears redo, and a curve-drag burst is a single undo step.

### 3. No silent loss of a starting song

**Problem.** `Service::ban` also removes the track from `recipe.seeds`, without saying so.

**Change.** With undo in place, no confirmation is needed; the screen just says what happened:
`Removed Teardrop and dropped it as a starting song · z undo`. The controller compares seeds
before and after `ban` to choose the message. If the last seed is removed, the arc keeps
following the playing song (existing `current` fallback), and the message adds
`now building from the playing song`.

**Tests.** Bun: banning a seed row produces the seed message, and undo restores the seed.

### 4. No dropped keys while building

**Problem.** `request()` returns early while `busy`, so `k`, `x`, `r`, and `p` pressed during a
build do nothing.

**Change.**
- The controller keeps one `pending` action: `{ kind, uri }`. The latest one wins. Actions
  record a track URI, not a slot index, because a rebuild can move tracks.
- When the build finishes, `flushPending()` finds the URI's new slot and runs the action. If the
  track is gone, say `Teardrop is no longer in the arc` and drop the action.
- While an action waits, the heading shows `working… then keep Teardrop`.
- `s` (save) and `p` (play) also queue, so saving right after an edit saves the rebuilt arc.

**Tests.** `arcs-controller.test.ts` (new): with a delayed fake API, `pin` during `build` runs
after it against the right slot, a second queued action replaces the first, and a URI that left
the draft gives the "no longer in the arc" notice.

---

## Phase 2: one picture

### 5. Draw the tracks on the curve

**Problem.** The chart draws only the target curve. `draft.targets`, each slot's `energy`, and the
unused `sparkline()` in `model.ts` already hold what is needed to show how well the arc fits.

**Change.**
- New pure function in `model.ts`:
  `curveCells(curve, slots, width, height, selected): Cell[][]`, where a cell is
  `{ ch, tone }` and `tone` is one of `area | track | off | estimate | selected`.
  - The area is drawn as today with `BLOCKS`.
  - Slot `i` sits at column `round(i / (n - 1) * (width - 1))`, on the row its `energy` falls in.
    Glyph: `●` for measured or previewed energy, `○` for heard, estimated, or unmeasured.
  - Tone `off` when `|energy - target| > 0.2`, so outliers show in the warning colour.
  - When `n > width`, several slots share a column; draw the one with the worst fit.
- `index.ts` renders each curve line as styled text chunks (the same approach as
  `vu-meter.ts`) instead of a single `fg`.
- `summary()` adds `fit 87%`, the mean `curve_fit`.
- Curve-edit mode hides the dots, because they belong to the last build, not the curve being
  edited. They come back after the rebuild.

**Tests.** `arcs-model.test.ts`: dot column placement for n = 2, n = width, and n > width; the
row matches the energy; `off` tone above 0.2; and the worst fit wins in a shared column.
Snapshots for the screen in light and dark themes.

### 6. Show where the selected track is on the curve

**Change.**
- In arc mode, the marker row (now edit-only) is visible whenever `curveHeight() >= 3`. It shows
  `▲` under the selected slot's column, followed by
  `track 7 · target 72% · energy 64%`.
- On short terminals there is no marker row. The selected slot's dot gets the `selected` tone
  instead.
- Selection changes already call `render()` (the `default:` branch of `handleKey`), so no new
  wiring is needed beyond reading `selectedSlot()` in the chart.

**Tests.** Model: marker column for first, middle, and last slots. Screen: moving the selection
moves the `▲`.

### 13. A status line separate from "why"

**Problem.** Action confirmations and the selection's "why" share `surface.setMessage`, with a
4-second hold, so they push each other out.

**Change.**
- When `ctx.renderer.height >= 30`, add a `status` line to the panel under the summary. Action
  results and errors go there and stay until the next action. The bottom message line only shows
  the selection's why (or `slotExplanation` with `i`).
- Below 30 rows, keep today's shared line and hold. `STATUS_HOLD_MS` moves into that branch.
- Errors use `colors.red` in either layout.

**Tests.** Screen at 120×40: after `k`, the status line shows the confirmation and the bottom
line still shows the why. At 80×24, today's behaviour is unchanged.

### 14. A shorter legend

**Change.**
- Replace the two legend lines with one line of the most-used keys for each mode. Arc mode:
  `↑↓ pick  ⏎ play here  r swap  k keep  x remove  z undo  s save  ? all keys`.
  The second legend line (`legend2`) is removed, which gives a row back to the track list.
- `screens/help/model.ts` gains a full Arc Studio section with every key from the table above,
  grouped as: Arc, Curve edit, Swap, Starting songs.
- `COMPACT_LEGENDS` shrinks to fit 80 columns:
  `↑↓ ⏎ play  r swap  k keep  x remove  z undo  s save  ? keys`.
- Update the Controls table in `doc/playlist-builder.md` to point to Help.

**Tests.** Every legend fits its width (80 compact, 96 roomy): a test that measures each string.
The Help screen lists the Arc Studio section.

---

## Phase 3: hand editing

### 7. Reorder tracks

**New RPC `builder.move { from, to }` → `{ draft }`**, with `Service::move_slot` in `mod.rs`:
1. Take the current sequence, remove `from`, insert at `to`.
2. Pin the moved track at `to`. Re-index every other pin to its URI's new position, so kept
   tracks stay kept but follow the shift.
3. `rebuild(active, &sequence)`. `assemble` recomputes the fit and transition scores, so the
   dots (5) show what the move cost.

**Screen.** `Shift+↑` / `Shift+↓` (`ScreenKey.shift`), with `<` / `>` as a fallback. The selection
follows via `returnTo = slot-{to}`. Each move is one undo step (2). Status:
`Moved Teardrop to 4 and kept it there`.

**Tests.** Rust: moving 2 → 5 gives the expected order, the moved track is pinned at 5, and other
pins follow their URIs. Moving to the same slot is a no-op. Out-of-range values return an error.
Bun: Shift+↓ calls `builder.move` and the selection follows.

### 8. Faster curve editing

New pure helpers in `model.ts`, with the screen's `editKey` mapping keys to them:

| Key | Helper | Rule |
|---|---|---|
| `1`–`9`, `0` | `setPoint(curve, i, level)` | 10–90%, `0` = 100% |
| `Shift+←` `Shift+→` | `slidePoint(curve, i, ±0.05)` | Stays between its neighbours by at least 0.05; endpoints keep x = 0 and 1 |
| `n` | `insertPoint(curve, i)` | Midpoint between i and i+1 on the drawn curve (`sampleCurve`); at most 12 points; selects the new point |
| `d` / `Delete` | `removePoint(curve, i)` | At least 2 points; removing an endpoint makes the next point the new endpoint at x = 0 or 1 |

The engine already accepts 2–12 sorted points (`recipe.rs` validation); add a Rust test that a
12-point curve and a 2-point curve both solve. The edit legend becomes
`Curve: ←→ point  ↑↓ or 0–9 level  ⇧←→ slide  n add  d delete  ⏎ done`.

**Tests.** Model tests for each helper, including the limits (12 points, 2 points, neighbour
spacing, endpoints).

### 9. Length in minutes

- `m` toggles `recipe.length` between `{ tracks }` and `{ minutes }`. Conversion uses the current
  draft: minutes = `duration_ms` rounded to the nearest 10 (clamped to 20–300). Tracks = the
  current slot count.
- With no draft, use 18 tracks ↔ 60 minutes.
- `-`/`+` already step 10 minutes in minutes mode (`adjustLength`).
- Label in minutes mode: `60 min (17 tracks)`. In tracks mode: `18 tracks (1h 4m)`.

**Tests.** Model: toggle both ways with and without a draft, and clamping.

### 10. A starting-song list

**Problem.** The header shows `(+N more)`, and Backspace only drops the last seed.

**Change.**
- The header lists seeds by title, separated by ` · `, truncated to fit the width, with `+N`
  only for what does not fit.
- `f` opens a new list mode, `seeds`, alongside `draft`, `alternatives`, and `search`. Rows are
  the seeds, marked `✦`. Keys: `x`/`Delete` remove the selected seed, `/` add one, `c` add the
  playing song, `Esc` back. Legend: `Starting songs: ↑↓ pick  x remove  / add  c add playing  Esc back`.
- The controller gains `removeSeedAt(uri)`. Each removal is an undo step.
- Backspace in arc mode keeps dropping the last seed, for muscle memory.

**Tests.** Bun: `f` lists the seeds, `x` removes the selected one (not the last), `/` from seed
mode returns to seed mode, and the header truncates at 80 columns.

---

## Phase 4: listen and keep

### 12. Save as new, and show unsaved changes

**Change.**
- `s` keeps today's behaviour: save, or update the playlist this arc created.
- `S` always saves a new playlist (`overwrite: false`). The arc then tracks the new playlist id.
- The controller keeps `savedSignature`, the URIs joined, set on save and on restoring a draft
  that has a `playlist_id`. The heading shows `Arc Studio · saved to Night Drive arc` when the
  draft matches, and `Arc Studio · unsaved changes` when it differs.
- The saved name comes from `builder.state`'s `saved` list (`SavedArc.name`), matched by
  `playlist_id`. The engine already returns that list; `ArcState` gains `saved?: SavedArcRow[]`.
- The save prompt label names the target: `Update "Night Drive arc" (rename here)` or
  `Save as a new private playlist named`.

**Tests.** Bun: after save the heading says saved; after `x` it says unsaved; undo back to the
saved state says saved again; `S` sends `overwrite: false`.

### 11. Audition a track

The largest item. It needs a decision before building (see Open questions).

**Recommended: audition the Spotify track through the normal player.**
- New RPCs `builder.audition { uri }` and `builder.audition_stop`.
- Start: remember the playing track, position, and play state. Play `uri` from 30% of its
  length, the usual place for a chorus, without changing the queue. This needs a queue method
  that plays a transient track and can return.
- Stop on `a` again, `Esc`, any key that changes the arc, leaving the screen, or after 20 s.
  Resume the remembered track at its position (or stay paused if it was paused).
- The screen shows `♪ auditioning Teardrop · a or Esc to stop` in the status line, with a
  countdown.
- Available in arc and swap modes, which is where it matters most: comparing replacements.
- Auditions must not count as plays or skips in `history.rs` and must not write fingerprints.
  The tracker needs an `auditioning` flag to ignore them.

**Tests.** Rust: `audition_stop` restores the track and position; history and fingerprints are
untouched. Bun: `a` starts, `a`/`Esc` stops, and leaving the screen stops.

---

## Files touched

| File | Items | Notes |
|---|---|---|
| `src/builder/mod.rs` (527 lines) | 1, 2, 7, 11 | `choose` pin, `restore`, `move_slot`. If it nears 900 lines, move edit operations into `src/builder/edit.rs`. |
| `src/rpc/builder.rs` (289) | 2, 7, 11 | `builder.restore`, `builder.move`, `builder.audition*` |
| `src/builder/tests.rs` (454) | 1, 2, 7, 8 | Split off `edit_tests.rs` if it passes 800 lines |
| `screens/arcs/controller.ts` (251) | 1–4, 7, 9, 10, 12 | Undo stack and pending queue go in a new `history.ts` beside it |
| `screens/arcs/model.ts` (221) | 5, 6, 8, 9, 14 | Curve cells and point helpers may move to `curve.ts` |
| `screens/arcs/index.ts` (200) | all | Seed mode key handling may move to `seeds.ts` |
| `screens/help/model.ts` | 14 | Arc Studio section |
| `workspace/contracts.ts`, `test/engine-contract.ts` | 2, 7, 11 | New methods and fixtures |
| `workspace/demo-arcs.ts` | 2, 7 | Restore and move in the offline demo |
| `doc/playlist-builder.md`, `CHANGELOG.md` | all | Controls table, shipped notes |

## Validation for each phase

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test` (builder tests).
- `bun test` in `prototype/opentui`.
- Manual run at 80×24 and 140×45, in light and dark themes, against both a real library and the
  offline demo.

## Open questions

1. **Audition source (11).** Spotify playback (recommended: full quality, reuses the player, covers
   every track in the pool) or Deezer's 30 s preview (no queue change, but needs a second audio
   output alongside librespot and only covers tracks Deezer matched). Decide before phase 4.
2. **Digit levels (8).** `1`–`9` = 10–90% and `0` = 100% follows keyboard order. The alternative
   is `0` = 0%, with the maximum only reachable by `↑`.
3. **Should a manual move (7) also lock the tracks around it?** The plan pins only the moved
   track. Pinning its neighbours would preserve the transition the user created, at the cost of
   a less flexible arc.

## As shipped

The open questions were settled with the recommended answers:

1. Auditions play the Spotify track through the normal player (`src/builder/audition.rs`). The
   track loads straight into the player at 30% for 20 s; the queue is untouched, and the playing
   track comes back at its position afterwards. While an audition plays, listening history,
   fingerprints, and waveforms ignore playback. When the queue moves to another track the
   audition ends without restoring. Auditions are refused while casting.
2. Digits in curve editing: `1`–`9` set 10–90%, `0` sets 100%.
3. A move pins only the moved track.

Differences from the plan:

- `builder.restore` drops tracks that have left the pool instead of refilling their slots, so
  undo never brings in a track that was not on screen.
- Shape, length, and mix edits are one undo step per debounced burst. A whole curve-editing
  session (from `e` to `Enter`) is one step.
- The undo stack and the pending-action queue live in the controller; only the snapshot type and
  stack are in `screens/arcs/history.ts`. Chart and curve-point helpers are in
  `screens/arcs/curve.ts`.
- Rebuilding while the starting-song list is open keeps it open.
- The queue is not touched by auditions. Instead the listening tracker ignores playback while an
  audition plays, and the audition is forgotten when the queue's current track changes.
- To keep every file under 20 KB, the fingerprint sampler moved to `src/builder/sampler.rs`, its
  tests to `fingerprint_tests.rs`, `arcs-debug` to `src/builder/report.rs`, auditions and preview
  polling to `screens/arcs/audition.ts` and `previews.ts`, and parts of the Arcs guide to
  `doc/arc-energy.md` and `doc/arc-v1-shipped.md`.

