# Arcs v1 as shipped

Differences from [Playlist Builder v1: Arcs](playlist-builder.md), recorded when v1 landed:

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
