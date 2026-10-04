# Playlist Builder v1: Arcs

Status: v1 implemented. Owner: KanterLabs. Target: OpenTUI workspace on Unix.

## Summary

An **Arc** is a playlist built from a listening journey rather than a song list. The user picks
one or more seeds, shapes an energy curve (warm up, peak, cool down), and sets a length. Resonance
fills each slot from cached library metadata, explains every choice, and saves the result to
Spotify as an ordinary playlist.

Arcs reuse the existing local recommendation stack. `recommendations::engine::rank` supplies
affinity, `history.rs` supplies skip and completion feedback, and a new sonic fingerprint store
supplies energy and tempo measured from Resonance's own audio tap. Spotify no longer offers
`audio-features` or `recommendations` to new apps, so v1 depends on neither.

## Decisions

| Question | v1 decision | Reason |
|---|---|---|
| Scope | Arc curve only. Bridge mode (A to Z paths) is v2. | Bridge reuses the same solver and fingerprints; shipping the solver first keeps v1 testable. |
| Candidate pool | Local only: library, playlists, and the radio enrichment cache. A build makes no network requests. | Fast, offline, deterministic, and explainable, matching radio's contract. |
| Recipe storage | Stored locally. Writing the recipe into the playlist description is an opt-in setting, off by default. | Descriptions on public playlists are public. |
| Interface | OpenTUI only. The legacy Cursive UI gets no builder in v1. | OpenTUI is the default workspace; Windows support follows the legacy UI's roadmap. |
| Saved visibility | New playlists are private by default. | Least surprising for a generated draft. |
| Entry key | `0` opens the Arcs screen; the `arc` command and "Build arc from current song" also open it. | `1`–`9`, `B`, and `?` are taken, and screens already use `a`. |

## Non-goals for v1

- Bridge mode, preset sharing, collaborative arcs.
- Fetching new tracks from Spotify during a build (the existing enrichment refresh still runs in
  the background as it does for radio).
- Crossfade or beatmatched playback. Transition scoring only affects ordering.
- Editing an existing Spotify playlist in place. v1 saves a new playlist or overwrites one it
  previously created.

## User experience

### Layout (wide terminal)

```
┌ Arcs ───────────────────────────────────────────────────────────────┐
│ Seeds: Everything In Its Right Place · Windowlicker      Length 18  │
│                                                                     │
│ Energy  10 ┤              ●──●                                      │
│            ┤          ●─╯      ╰─●                                  │
│            ┤      ●─╯              ╰─●                              │
│          0 ┤  ●─╯                      ╰─●   preset: Rise & Fall    │
│                                                                     │
│ Familiar ▮▮▮▮▮▮▯▯▯▯ Discovery        Fingerprinted 412/3100 (13%)   │
├─────────────────────────────────────────────────────────────────────┤
│  #  Track                     Artist        Energy  BPM   Why       │
│  1  Svefn-g-englar            Sigur Rós     ▂ 0.21  —     shares 3… │
│  2 🔒 Teardrop                Massive Attack▃ 0.34  77    pinned    │
│  3  Pyramid Song              Radiohead     ▃ 0.38  ~     seed art… │
│ ...                                                                 │
│ Enter build · r reroll slot · k pin · x ban · P play · s save       │
└─────────────────────────────────────────────────────────────────────┘
```

At 80×24 the curve shrinks to a single sparkline row and the "Why" column moves to a detail
line under the selected row.

### Controls

Arc Studio builds an arc from the playing song as soon as it opens, and every change rebuilds it.
The track list always owns **↑/↓**, like every other screen. Two legend lines at the top show the
keys for the current mode.

| Key | Action |
|---|---|
| `↑` `↓` | Pick a track; the bottom line says why it is there (`i` adds the full score) |
| `Enter` | Play the arc from the selected track |
| `p` | Play the whole arc from the start |
| `←` `→` | Previous / next shape (preset) |
| `-` `+` | Shorter / longer |
| `[` `]` | More familiar / more new music |
| `g` | Remix: same shape and songs, different picks (kept tracks stay) |
| `r` | Swap the selected track: pick a replacement with `↑↓ Enter`, `Esc` keeps it |
| `k` | Keep the selected track in place |
| `x` | Remove the selected track; it will not come back in this arc |
| `/` | Search for a starting song to add |
| `c` | Start over from the song playing now |
| `Backspace` | Drop the last starting song |
| `e` | Edit the curve: `←→` choose a point, `↑↓` raise or lower it, `Enter`/`Esc` done |
| `s` | Save as a private playlist (later saves update that same playlist) |
| `Esc` | Back to Now Playing |

Rows mark each track's energy: a bar when it is known, `·` when it has not been learned yet, `◆`
for kept tracks and `✦` for starting songs. Until most energies are known the summary says so:
playing an arc is how it learns.

Presets: **Rise & Fall** (default), **Steady Focus**, **Build to Peak**, **Wind Down**, **Run**
(high, flat, with a short warm-up).

### Explanations

Every slot shows its strongest two reasons, built from `ScoreComponents` plus builder terms, for
example `shares 3 playlists with Teardrop`, `energy 0.62 ≈ target 0.60`, `124 BPM after 122`,
`saved track`, or `unmeasured energy`. The draft header shows overall confidence, which drops when
many slots rely on estimated rather than measured energy.

## Architecture

```
OpenTUI screens/arcs ──RPC──▶ rpc builder.* handlers ──▶ builder::solve
                                                         │
                         recommendations::catalog ───────┤ affinity via engine::rank
                         recommendations::history ───────┤ feedback
                         builder::fingerprint store ─────┘ energy, tempo, intro/outro
audio_tap + waveform ──▶ builder::fingerprint collector (during normal playback)
```

### New Rust module `src/builder/`

Each file stays well below the 1000-line cap.

| File | Responsibility |
|---|---|
| `mod.rs` | Public service: active draft state, build, reroll, pin, ban, save; persistence of recipes. |
| `fingerprint.rs` | Collector and on-disk store for per-track sonic fingerprints. |
| `recipe.rs` | `Recipe`, `CurvePoint`, `Preset`, validation, curve interpolation. |
| `solve.rs` | Candidate pooling and beam-search sequencer. Pure: no I/O, no clock in scoring. |
| `transition.rs` | Pairwise transition cost between adjacent tracks. |
| `tests.rs` | Fixed-catalog tests in the style of `src/queue/radio_tests.rs`. |

RPC handlers live in `src/rpc/builder.rs` as free functions (the workspace denies
`clippy::multiple_inherent_impl`) rather than growing `rpc.rs`.

### Fingerprints

Spotify exposes no audio analysis to this app, so Resonance measures tracks as they play.

```rust
pub struct Fingerprint {
    pub version: u16,
    pub energy: f32,            // 0..=1, normalized mean RMS level weighted by band density
    pub dynamics: f32,          // 0..=1, loudness variance across the track
    pub brightness: f32,        // 0..=1, spectral centroid from AudioTap::bands
    pub tempo: Option<f32>,     // BPM, folded into 60..=180
    pub tempo_confidence: f32,  // share of beat intervals within 6% of the median
    pub intro_energy: f32,      // mean level of the first 10% (from waveform buckets)
    pub outro_energy: f32,      // mean level of the last 10%
    pub listened_ms: u64,       // audio actually observed
    pub measured_at: i64,       // unix seconds
}
```

- **Collection:** a `Collector` attached beside the waveform recorder samples `AudioTap::level`,
  `bands(16)`, and beat intervals about 10 times per second while a track plays. It runs no
  extra FFT; it reads the tap's existing outputs.
- **Commit rule:** save when at least 45 s or 60% of the track was heard, whichever is shorter.
  A later listen with more observed audio replaces an earlier one.
- **Tempo:** the tap's median-gap `tempo()` is tuned for animation. The collector keeps its own
  interval histogram over the whole listen and reports a tempo only when `tempo_confidence ≥ 0.5`.
  Otherwise `tempo` is `None` and shown as `~`.
- **Normalization:** raw energy depends on mastering loudness, so `energy` is stored raw and
  normalized at solve time against percentiles of the fingerprinted library.
- **Storage:** `fingerprints.json` under `config::cache_path`, keyed by track URI with an
  `engine::song_key` index so another release of the same song reuses the measurement. The format
  is versioned and owned by this module, following the `waveform.rs` and `enrichment.rs` pattern,
  with atomic temp-file writes. Cap: 50,000 entries, evicting the oldest `measured_at` first.
- **Privacy:** the store holds no audio, only the summary numbers above.

### Estimated energy for unmeasured tracks

Early on most of the library is unmeasured. For an unmeasured candidate the solver estimates
energy as the affinity-weighted mean of measured tracks that share its artist, album, or
playlists, and flags the slot `estimated`. With no neighbours it uses 0.5 and flags it
`unmeasured`. Both lower slot confidence; neither is hidden.

### Recipe

```rust
pub struct Recipe {
    pub version: u16,
    pub seeds: Vec<String>,          // track URIs, 1..=5
    pub curve: Vec<CurvePoint>,      // 2..=12 points, x in 0..=1 sorted, energy in 0..=1
    pub length: Length,              // Tracks(5..=100) | Minutes(20..=300)
    pub discovery: u8,               // 0..=100, the engine's discovery dial
    pub pins: Vec<Pin>,              // { uri, slot: Option<usize> }
    pub bans: HashSet<String>,       // URIs and song keys
    pub rng_seed: u64,
}
```

The curve is sampled with monotone cubic interpolation, so targets never overshoot the drawn
points. `Minutes` lengths resolve to a slot count from the mean candidate duration and are then
trimmed or extended by one slot to land within ±3 minutes.

### Solver (`solve.rs`)

1. **Pool.** For each seed, call `engine::rank` with `limit = MAX_RECOMMENDATIONS`, the
   recipe's discovery level, and the current history snapshot. Union the selections, keep the best
   affinity per URI, add pins, and remove bans, the seeds' own repeats beyond one occurrence, and
   unplayable tracks. Normalize affinity to 0..=1 across the pool.
2. **Targets.** Sample the curve at `slot / (n - 1)` for each slot.
3. **Beam search** (width 8, deterministic tie-break by URI, sampling noise from `rng_seed`):

   ```
   slot_score = 0.45 * affinity
              + 0.35 * (1 - |energy - target|)
              + 0.20 * transition(prev, candidate)
              - penalties
   ```

   Penalties: the same artist within 3 slots (hard exclusion), the same album within 5 slots
   (0.15), an artist above `ceil(n / 6)` appearances (hard exclusion), and recent plays from
   `history.recent()` (0.1).
4. **Pins** occupy their slot first. A pin without a slot is placed where its energy best fits
   the curve.
5. **Output.** A `Draft` with per-slot `{ track, target, energy, measured: Measured | Estimated |
   Unmeasured, tempo, score, components, reasons }`, plus overall confidence and the fingerprint
   coverage of the pool.

The same recipe, catalog, and history always produce the same draft. Scoring never reads the
clock.

### Transitions (`transition.rs`)

`transition(a, b)` is in 0..=1 and combines:

- **Tempo:** 1.0 within 4%, decaying to 0 at 15%, also accepting double and half time. Neutral
  0.5 when either tempo is unknown.
- **Edge energy:** `1 - |a.outro_energy - b.intro_energy|`, so a fade-out leads into a soft
  intro. Neutral when either is unmeasured.
- **Brightness:** small weight on `1 - |a.brightness - b.brightness|`.
- **Context:** a bonus when both tracks appear in the same user playlist (from `Catalog`).

### Reroll, pin, and ban

- `reroll(slot)` re-runs the beam for that slot only with neighbours fixed, returning the top
  five alternatives with reasons. Choosing one replaces the slot without touching others.
- `pin(slot)` adds the current track to `recipe.pins` at that slot.
- `ban(slot)` adds the URI and song key to `recipe.bans`, then refills that slot like a reroll's
  best choice.
- A full rebuild keeps pins and bans.

### Playback and learning

`P` loads the draft into the queue as a normal playback context; it is not radio. Skips and
completions already flow into `history.rs` through the tracker, so the next build reflects them.
In v1 the draft does not change itself during playback; the living draft that refills on skip is
deferred to v2.

### Saving

`builder.save { name, public = false, overwrite? }`:

1. `SpotifyApi::create_playlist(name, Some(public), description)`, then
   `overwrite_playlist(id, tracks)`.
2. The description defaults to `Built with Resonance Arcs`. With the opt-in setting
   `arcs_recipe_in_description = true`, a compact recipe token is appended.
3. The recipe and created playlist id are stored in `arcs.json` (cache path, versioned, up to 50
   recipes). Re-saving an arc offers to overwrite the playlist it created; Resonance never
   overwrites a playlist it did not create.
4. Library state refreshes so the playlist appears on the Playlists screen.

Failures use the existing `remote()` error path and keep the draft intact.

## RPC contract

All methods return the standard RPC envelope. Builds are local and finish well under the 250 ms
budget, so they are synchronous in v1.

| Method | Params | Result |
|---|---|---|
| `builder.state` | — | Active recipe, draft, presets, coverage |
| `builder.build` | `{ recipe }` | `{ draft }` |
| `builder.reroll` | `{ slot }` | `{ alternatives: Slot[5] }` |
| `builder.choose` | `{ slot, uri }` | `{ draft }` |
| `builder.pin` | `{ slot, pinned }` | `{ draft }` |
| `builder.ban` | `{ slot }` | `{ draft }` |
| `builder.play` | — | `{ queued }` |
| `builder.save` | `{ name, public?, overwrite? }` | `{ playlist_id, uri }` |
| `builder.coverage` | — | `{ fingerprinted, total, percent }` |

TypeScript types go in `prototype/opentui/src/workspace/contracts.ts`, and the contract test
`test/engine-contract.ts` gains fixtures for each method.

## OpenTUI screen

`prototype/opentui/src/screens/arcs/` follows the Radio screen's split:

- `model.ts`: view state and pure reducers (focus, curve edits, selection, alternatives).
- `controller.ts`: RPC calls, debounced rebuild (400 ms after the last curve edit), notices.
- `index.ts`: rendering of the curve, dials, and draft table, plus key handling.

Wiring: add route `arcs` to `FACTORIES`, `SHORTCUTS["0"]`, `LABELS` (`0 Arcs`), the `focus arcs`
binding, and the `arc` command target in `bindings.ts`. Now Playing gains a command-palette
action "Build arc from current song", which opens Arcs seeded with the playing track. Reduced
motion disables curve animation. Light and dark themes use existing theme tokens.

## CLI and diagnostics

- `resonance arcs-debug RECIPE.json [--replay SNAPSHOT]` prints the draft with full score
  breakdowns, mirroring `radio-debug`. A snapshot captures catalog, history, and fingerprints so a
  build can be replayed offline.
- The Settings diagnostics panel shows fingerprint coverage and store health.

## Testing

Rust (`src/builder/tests.rs`, fixed catalogs, no network):

- Determinism: the same inputs produce an identical draft; a different `rng_seed` changes only
  near-tie choices.
- Curve fit: on a fully fingerprinted catalog, mean `|energy - target|` stays under 0.12 for every
  preset.
- Constraints: no artist within 3 slots, artist cap respected, bans never appear, pins keep their
  slots.
- Sparse data: with zero fingerprints the build succeeds, every slot is flagged, and confidence is
  below 0.5.
- Transitions: tempo folding (double and half time) and neutral scoring for unknown tempos.
- Fingerprint store: commit rule, replacement by a longer listen, song-key reuse, version
  mismatch discards cleanly, eviction cap.
- Reroll changes only the target slot.

OpenTUI (`bun test`):

- `arcs-model.test.ts`: curve editing, focus cycling, preset cycling, 80×24 layout fallback.
- `arcs-controller.test.ts`: debounced rebuilds, error notices, save flow.
- `arcs-screen.test.ts`: rendering snapshots in light and dark themes and key handling.
- `workspace-bindings.test.ts`: `0` and `arc` route to Arcs.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| 1 | Fingerprint collector and store | Playing a track for 45 s writes a fingerprint; coverage shows in diagnostics; tests pass. Ship this first so data builds up during normal listening. |
| 2 | Recipe, solver, and transitions | `arcs-debug` produces a deterministic, explained draft from a fixture; all Rust solver tests pass. |
| 3 | RPC methods and contracts | All `builder.*` methods are covered by the engine contract tests. |
| 4 | Arcs screen | Build, edit curve, reroll, pin, ban, and play from the UI at both wide and 80×24 sizes. |
| 5 | Save to Spotify | Saving creates a private playlist with the draft order; re-save overwrites only an Arcs-created playlist; recipe persists in `arcs.json`. |
| 6 | Docs and polish | README features list, `doc/opentui-prototype.md` routes and keys, Help screen entry, CHANGELOG. |

## v2 candidates

- **Bridge mode:** a shortest path from song A to song Z over a k-nearest-neighbour graph of the
  catalog, using the same slot and transition scores.
- **Living draft:** the draft refills a skipped slot during playback.
- **Rebuild from description:** recreate an arc from a recipe token in a playlist description.
- **Transition preview:** play the last and first 10 s of adjacent tracks back to back.
- **Background fingerprint pass:** quietly measure high-value unmeasured candidates.

## Risks

| Risk | Mitigation |
|---|---|
| Low fingerprint coverage at launch | Ship milestone 1 early, estimate from neighbours, and show coverage and confidence plainly. |
| Inaccurate tempo from bass-onset detection | Report tempo only above a confidence threshold, fold into 60–180 BPM, and score unknowns neutrally. |
| Mastering loudness skews energy | Normalize against library percentiles at solve time, and weight band density, not just RMS. |
| Small libraries cannot satisfy constraints | Relax album spacing first, then artist cap, and report each relaxation in the draft reasons. |
| `rpc.rs` and `engine.rs` line pressure | All new logic lives in `src/builder/` and a separate RPC module. |

## v1 as shipped

Differences from the plan above, recorded when v1 landed:

- **Scoring:** the curve term is `max(0, 1 - 2.5·|energy - target|)` rather than linear, so a
  flat curve such as Steady Focus is followed closely even when affinity varies a lot.
- **Pool:** each seed is ranked twice, once with the legacy ranking (broad, with fallback) and once
  at the recipe's discovery level (seed-related only), and the better affinity per track is kept.
  Seeds are always in their own arc and are placed where their energy fits the curve.
- **Sampling:** a background thread in the engine reads the audio tap ten times a second, so
  fingerprints are learned under OpenTUI, `--headless`, and the legacy UI alike.
- **Heard energy:** tracks without a fingerprint use the loudness the waveform cache recorded the
  last time they played, stretched from its 0.4–0.95 band onto 0–1. Estimates borrow only from the
  same album or artist; playlists were too mixed and spread one quiet song across dozens.
- **Plain reasons:** engine evidence is reworded ("in a playlist with your starting song", "you
  usually play it through") and bookkeeping reasons such as tie-breaks are dropped.
- **`resonance arcs-debug`** prints an arc built from the cache without logging in:
  `--seed URI` (repeatable), `--preset`, `--tracks`, `--discovery`, `--rng-seed`.
- **Deferred to a later release:** replay snapshots, the
  `arcs_recipe_in_description` setting (it is only useful with rebuild-from-description), and a
  Settings diagnostics panel. Coverage is shown on the Arcs screen and via `builder.coverage`.
- **Offline demo:** `DemoApi` builds illustrative arcs from its fixtures; saving is unavailable.
