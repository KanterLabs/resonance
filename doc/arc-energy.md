# Arcs: measuring energy

Part of [Playlist Builder v1: Arcs](playlist-builder.md). Spotify exposes no audio analysis to
this app, so arcs learn each track's energy themselves, in the order the solver trusts them:
measured during playback, previewed, heard, estimated, unmeasured.

## Fingerprints

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

## Previewed energy

Tracks without a fingerprint are measured from Deezer's 30 second previews by a background thread
(`builder::preview`), through the same analysis the tap runs during playback. Previews are kept in
`previews.json`, apart from fingerprints, and their energy is calibrated onto the listened scale
before the library percentile. A preview has no intro or outro, so its edges score neutrally in
transitions. The solver trusts measures in this order: measured, previewed, heard, estimated,
unmeasured. Details and the benchmark behind it are in [deezer-previews.md](deezer-previews.md).

## Estimated energy for unmeasured tracks

Early on most of the library is unmeasured. For an unmeasured candidate the solver estimates
energy as the affinity-weighted mean of measured tracks that share its artist, album, or
playlists, and flags the slot `estimated`. With no neighbours it uses 0.5 and flags it
`unmeasured`. Both lower slot confidence; neither is hidden.
