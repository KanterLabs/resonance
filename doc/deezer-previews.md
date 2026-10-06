# Arc energy from Deezer previews

Arcs need energy and tempo for every candidate before a draft is built, but fingerprints are only
learned by playing a track (`src/builder/fingerprint.rs`). Most of a pool is therefore `heard`,
`estimated` or `unmeasured`. This plan measures unplayed tracks from Deezer's free 30 second
previews, using the same analysis the audio tap runs during playback, so the numbers sit on the
same scale as real fingerprints.

Nothing here plays audio, stores audio, or needs a Deezer account. Only the derived numbers are
kept, exactly as with fingerprints.

## Deezer API facts (verified 2026-10-06)

- `GET https://api.deezer.com/track/isrc:<ISRC>` returns a track with `bpm` (float, sometimes
  `0`), `gain` (dB), `duration` (s), `readable`, and `preview` (a 30 s, 128 kbps, 44.1 kHz MP3).
  No key, no auth. An unknown ISRC returns `{"error": {...}}` with HTTP 200.
- `GET https://api.deezer.com/search?q=<title> <artist>` is the fallback when there is no ISRC.
  Use plain terms: the advanced `artist:"…" track:"…"` syntax returned no results for tracks the
  plain query finds. Search hits lack `bpm` and `gain`; fetch `/track/<id>` for them.
- Preview URLs are signed and expire (`hdnea=exp=...`). Never cache a URL; download it straight
  after the lookup.
- Quota is about 50 requests per 5 s per IP. Error `code: 4` means quota exceeded.

## Evidence (benchmark, 2026-10-06)

Graded against 27 full-listen fingerprints from the laptop, plus 200 random library tracks for
coverage. Agreement is Spearman ρ, since the solver ranks energy against the library anyway.

| Source | ρ vs full listen | Coverage (200 library tracks) |
|---|---|---|
| Deezer preview through a port of the tap | **0.86** (27/27) | 96% |
| Deezer `gain`, no download | 0.86, inverted sign (27/27) | 96% |
| Same-artist estimate (today) | 0.48 (14/27) | — |
| ReccoBeats `energy` | 0.38 (23/27) | 82% |
| Heard loudness (today) | 1/27 had data | — |

- Tempo: Deezer `bpm` is non-zero for 44% of tracks, and then agrees with ReccoBeats within 4%
  for 78/80. The tap's tempo on a preview agrees for only 55/97. So Deezer `bpm` is trusted and
  preview tempo is a weak fallback.
- Lookup: 163/200 matched by ISRC and 30 more by plain search; 7 not on Deezer.
- Full-listen energy is loudness-dominated (raw spread is only σ 0.04 across the 27 tracks),
  which is why Deezer `gain` tracks it so well. Previews still win because they also give
  brightness, dynamics and a tempo fallback, on the same scale as fingerprints.

## Design

```
candidate without a fingerprint
  └─ preview queue (background thread, rate limited)
       ├─ ISRC lookup ─┐
       ├─ or search  ──┴─ Deezer track ─ preview MP3 ─ symphonia decode
       │                                                └─ offline tap analysis ─ Samples
       │                                                     └─ Session::finish ─ Fingerprint
       └─ previews.json (store, separate from fingerprints.json)
solver: Measured > Previewed > Heard > Estimated > Unmeasured
```

### Data kept per track

```rust
pub struct Preview {
    pub song_key: String,
    pub deezer_id: Option<u64>,
    /// None when Deezer had no match or no playable preview; kept so it is not retried soon.
    pub fingerprint: Option<Fingerprint>,
    /// Deezer's own BPM when it is non-zero.
    pub deezer_bpm: Option<f32>,
    pub deezer_gain: Option<f32>,
    pub checked_at: i64,
}
```

The store is `previews.json` in the cache dir, keyed by URI with a `by_song` index, mirroring
`FingerprintStore` (cap at 50 000 entries, evict oldest `checked_at`). It is kept apart from
`fingerprints.json` so preview energies never enter `FingerprintStore::energies()` normalization
or the song maps.

## Tasks

Six tasks, each one commit with tests, each leaving `cargo fmt --check`, `cargo clippy
--all-targets -- -D warnings` and `cargo test` green. Order and parallelism:

```
1 ISRC on Track ──────────────┐
2 offline tap analysis ───────┼─> 4 preview store + measure ─> 5 queue ─> 6 solver, RPC, UI
3 Deezer client (fixtures) ───┘
```

1, 2 and 3 touch disjoint files and can go to separate agents at once. Every new file stays well
under the 1000 line cap; `solve.rs` (862) and `fingerprint.rs` (604) must only take small
additions, so new logic goes in new modules.

### 1. Carry the ISRC on `Track`

Files: `src/model/track.rs`, plus every `Track { .. }` literal (test fixtures in `engine.rs`,
`ipc.rs`, `config.rs`, `cast/mod.rs`, `search_cache.rs`, `song_map.rs`, `ui/quick_search.rs`,
`recommendations/{mod,enrichment}.rs`, `queue/radio_tests.rs`, `builder/mod.rs::test_track`).

- Add `#[serde(default)] pub isrc: Option<String>` to `Track`.
- Fill it from `external_ids.get("isrc")` in `From<&FullTrack>` and `From<&SavedTrack>`.
  `SimplifiedTrack` (album listings) has none; `None`.
- Literals get `isrc: None`.
- Tests: a `FullTrack` with an ISRC converts with it; `Track` JSON without the field still
  deserializes (old `tracks.db`, `playlists.db`, `radio-catalog.json`).

### 2. Run the tap's analysis on decoded audio

Files: `src/audio_tap.rs`, new `src/builder/offline.rs`.

`BeatDetector` reads `Instant::now()` and `elapsed()`, so it cannot analyse audio faster than
real time.

- `BeatDetector::feed(&mut self, samples, at: Duration)`: `last_beat: Option<Duration>`, gaps
  and the refractory check computed from `at`. `AudioTap` keeps a `started: Instant` and passes
  `started.elapsed()` from `push`, so live behaviour is unchanged. `pulse()` keeps working from
  the same clock.
- Make the window maths callable without a tap: `pub(crate) fn level_of(window: &[f32]) -> f32`
  and `pub(crate) fn bands_of(window: &[f32], count) -> Vec<f32>`, which `level()` and `bands()`
  then call.
- `offline::analyze(mono: &[f32], rate: u32) -> Option<Vec<Sample>>`: `None` unless
  `rate == 44_100`. Feeds 1024-frame packets with timestamps `frames / rate`, and every 100 ms of
  audio reads level, 16 bands and tempo from the last 1024 frames into a `Sample`
  (`position_ms` = offset, `elapsed_ms = 100`). This is what `scripts/arcbench/bench.py::analyze`
  does; it produced the benchmark numbers.
- Tests: a synthesized 120 BPM bass click gives a tempo within 4% of 120 (the Python port read
  117); a steady tone gives a steady level; existing `audio_tap` tests pass untouched.

### 3. Deezer client

File: new `src/builder/deezer.rs`, using the blocking `reqwest` already in `Cargo.toml`. Test
fixtures under `src/builder/fixtures/deezer/`.

```rust
pub struct DeezerTrack { pub id: u64, pub duration_s: u32, pub bpm: Option<f32>,
                         pub gain: Option<f32>, pub preview: String }
pub enum Lookup { Found(DeezerTrack), Missing, NoPreview }
pub fn lookup(track: &Track) -> Result<Lookup, Error>;
pub fn download(preview_url: &str) -> Result<Vec<u8>, Error>; // capped at 2 MB
```

- `isrc:` lookup first. Otherwise a plain `search?q=<title> <first artist>&limit=10`; accept a
  hit when normalized title and artist both match (reuse the normalization behind `song_key`)
  and `|duration − track.duration| ≤ 4 s`, then fetch `/track/<id>` for `bpm` and `gain`.
- `bpm == 0` becomes `None`. `readable == false` or an empty `preview` becomes `NoPreview`.
- One process-wide limiter: at most 5 requests per second across lookup and download. Deezer
  `error.code == 4` or HTTP 429 pauses all calls for 10 s; other errors are returned, logged at
  `warn` once per error kind.
- Parsing is split from transport so tests run on fixtures: ISRC hit, ISRC miss (error object
  with HTTP 200), search hit, search hit rejected on duration, `bpm: 0`. No network in tests.

### 4. Preview store and measurement

Files: new `src/builder/preview.rs`; small additions to `fingerprint.rs` and `transition.rs`.

- `Fingerprint` gains `#[serde(default = "edges_known")] pub edges: bool` (true for every
  existing and listened fingerprint). `transition()` uses the edge term only when both sides
  have `edges`, otherwise the neutral 0.5 it already uses for unknowns.
- `fingerprint.rs` exposes `pub(crate) fn from_samples(track, &[Sample], now) -> Option<Fingerprint>`
  that folds samples through `Session` without the 45 s listen minimum; previews need ≥ 20 s.
- `preview.rs` holds the `Preview` record above and a `PreviewStore` shaped like
  `FingerprintStore` (`by_uri` and `by_song`, 50 000 cap, saved to `config::cache_path
  ("previews.json")`, versioned). Its `measure(track, &DeezerTrack, mp3) -> Preview`:
  - decodes with symphonia (add `symphonia = { version = "0.5", default-features = false,
    features = ["mp3"] }`, already compiled through librespot), down-mixed to mono;
  - runs `offline::analyze` and `from_samples`, then sets `edges = false`;
  - tempo: Deezer `bpm` folded into the tap's range with confidence 0.9; otherwise the analysed
    tempo only when its confidence is ≥ 0.8.
- Negative results are stored with `fingerprint: None` and retried after 30 days. A song with a
  listened fingerprint keeps its preview entry; the solver simply prefers the fingerprint.
- Tests: the store round-trips and evicts; a fixture MP3 (a few seconds of generated tone,
  checked in, under 50 KB) decodes and measures; `edges: false` makes `transition` neutral.

### 5. Background preview queue

Files: `preview.rs` (or `preview/queue.rs` if it grows), `engine.rs` and `application.rs` next
to `fingerprint::start`, `config.rs`.

- `preview::start()` spawns one `arc-previews` thread draining a priority queue, about one track
  per second (a lookup, maybe a track fetch, and a download, under the shared limiter).
- What gets queued, deduplicated by URI and skipping anything fingerprinted or checked in the
  last 30 days:
  - on start, and after each library refresh, every track in `recommendations::catalog` at low
    priority, so a library of ~1 200 tracks is measured within about an hour of the app running;
  - on `builder::pool`, every non-`Measured` candidate at high priority by affinity, seeds first.
- Save the store at most every 10 s while draining, and in `fingerprint::flush` on exit.
- Config: `arcs_preview_lookup: Option<bool>` on `ConfigValues`, default true. When false the
  thread never starts and nothing is queued. Document it in `doc/users.md`, including that
  lookups send track titles and ISRCs to Deezer.
- Tests: queue ordering, dedup, and the 30-day skip, with the network stubbed.

### 6. Solver, RPC and UI

Files: `solve.rs`, `builder/mod.rs`, `rpc/builder.rs`, the OpenTUI arcs screen, docs.

- `Measure::Previewed` between `Measured` and `Heard`, serialized `"previewed"`. `PoolInput`
  gains `previews: &HashMap<String, Fingerprint>`; `builder::pool` fills it from the store.
  Order in `Pool::build`: fingerprint, then preview, then heard, then unmeasured.
- Normalization (in `preview.rs`, passed in as already-normalized energies, to keep `solve.rs`
  small): with ≥ 20 tracks having both a fingerprint and a preview, fit
  `fingerprint_raw ≈ a·preview_raw + b` by least squares and map previews through it, then the
  usual library percentile. With fewer pairs, use the preview's percentile among all previews.
  Log the fit and its mean error at `debug`.
- `estimate_energy` also borrows from `Previewed`. The slot reason reads
  `energy {n}% from a preview`.
- `Draft` gains `previewed`; confidence weights it 0.9 (measured 1.0, heard 0.8).
- `rpc/builder.rs`: `draft()` emits `previewed`; `builder.coverage` adds `catalog_previewed`
  and `preview_pending` (queue length).
- OpenTUI `prototype/opentui/src/screens/arcs/model.ts`: add `"previewed"` to `Measure`, label
  it `prev.`, count it as known in coverage, update the demo data in `workspace/demo-arcs.ts`
  and `test/arcs-model.test.ts`. While a draft is open and `preview_pending > 0`, poll
  `builder.coverage` every 10 s; when more of the draft's tracks could now be previewed, show
  `N more songs measured, u refresh` rather than rebuilding under the user.
- Docs: `doc/playlist-builder.md` (measures, the v2 background pass now shipped, risks) and
  `CHANGELOG.md`.

## Handoff

Each task above is self-contained enough to paste into an agent prompt with this doc. Point the
agent at the task number, the files listed, and the Acceptance section. Tasks 1–3 in parallel;
4 after all three; 5 and 6 in order. Reviewing each before the next starts is cheaper than
untangling a stack.

## Acceptance

- With an empty `fingerprints.json` and a library of a few hundred tracks, half an hour of the app
  running previews most of them, and a fresh arc reports mostly `previewed` slots.
- Rerunning the benchmark scripts against the Rust store reproduces the Python numbers within
  noise (ρ ≈ 0.85 against fingerprints, ~95% coverage).
- `arcs_preview_lookup = false` produces zero requests to Deezer.
- No preview audio is ever written to disk.
- Live visualizer and fingerprint behaviour is unchanged (task 2 is a pure refactor for them).

## Out of scope

- ReccoBeats or other feature APIs (valence / mood). A possible later source, kept separate.
- Full-track offline analysis through librespot.
- Using previews for song maps or the waveform.

## As built (2026-10-06)

Where the implementation differs from the tasks above:

- **ID3 tags:** Deezer's previews open with an ID3v2.4 tag declaring a size of zero, which
  symphonia's probe rejects. `measure::without_id3` skips any leading ID3v2 tag before decoding.
- **Beat detector warm-up:** the detector's running average starts from silence, so the first
  seconds of any audio fire beats at its refractory rate (232 ms, read as 129 BPM). Live playback
  soon outgrows that; a 30 s preview may not. `offline::analyze` plays the first 4 s into the
  detector and forgets those beats before measuring. Live behaviour is unchanged.
- **Refresh key:** `r` is already swap in Arc Studio, so a rebuild with new measurements is `u`.
- **Misses** are stored without a Deezer id; `Lookup::NoPreview` does not carry one.
- **Rust vs the Python benchmark:** on live previews the Rust energies sit a constant ~0.05 below
  `bench.py`'s, which is ffmpeg's −3 dB downmix in the script, not a difference in analysis; the
  Rust values match the tap. Seven benchmark tracks matched by plain search and measured in about
  2–3 s each, download included.
- **RPC:** `builder.coverage` also reports `previewed`, `catalog_previewed`, `preview_lookup` and
  `preview_pending`; drafts report `previewed`.

