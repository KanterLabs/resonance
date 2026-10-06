//! Fill an arc's slots from cached tracks.
//!
//! Everything here is pure: the same pool and recipe always produce the same draft, and
//! nothing reads the clock or the network. Affinity comes from the radio ranking engine, so an
//! arc and a radio station agree on what belongs together; the arc adds the energy curve and
//! track-to-track flow on top.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

use super::fingerprint::Fingerprint;
use super::recipe::{Length, MAX_TRACKS, MIN_TRACKS, Recipe};
use super::transition::transition;
use crate::model::track::Track;
use crate::recommendations::engine::{
    self, Catalog, Context, MAX_RECOMMENDATIONS, familiar_artists, song_key,
};
use crate::recommendations::history::Feedback;

const BEAM_WIDTH: usize = 8;
const ARTIST_SPACING: usize = 3;
const ALBUM_SPACING: usize = 5;
const ALBUM_PENALTY: f64 = 0.15;
const RECENT_PENALTY: f64 = 0.1;
const NOISE: f64 = 0.02;
const WEIGHT_AFFINITY: f64 = 0.45;
const WEIGHT_CURVE: f64 = 0.35;
const WEIGHT_TRANSITION: f64 = 0.20;
const DEFAULT_DURATION_MS: f64 = 210_000.0;
/// Fewer measured tracks than this and raw energy is used as is.
const MIN_NORMALIZATION_SAMPLES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Measure {
    Measured,
    /// From Deezer's 30 second preview, run through the same analysis.
    Previewed,
    /// From the loudness the waveform recorded the last time the track played.
    Heard,
    Estimated,
    Unmeasured,
}

/// Everything the solver may draw on. Built once per build and reused for rerolls.
pub struct PoolInput<'a> {
    pub catalog: &'a Catalog,
    pub seeds: &'a [Track],
    pub discovery: u8,
    pub feedback: &'a HashMap<String, Feedback>,
    pub recent: &'a [String],
    /// Measurements for catalog tracks, keyed by URI.
    pub fingerprints: &'a HashMap<String, Fingerprint>,
    /// Every stored raw energy, for normalizing against the library.
    pub library_energies: &'a [f32],
    /// Preview measurements of tracks not fingerprinted, energy already on the fingerprint scale.
    pub previews: &'a HashMap<String, Fingerprint>,
    /// Normalized loudness of tracks heard before but not fingerprinted, keyed by URI.
    pub heard: &'a HashMap<String, f64>,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub track: Track,
    pub affinity: f64,
    pub energy: f64,
    pub measure: Measure,
    pub fingerprint: Option<Fingerprint>,
    pub reasons: Vec<String>,
    pub seed: bool,
    artists: Vec<String>,
    album: Option<String>,
    song: String,
    playlists: Vec<usize>,
    recent: bool,
}

pub struct Pool {
    pub candidates: Vec<Candidate>,
    index: HashMap<String, usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Slot {
    pub track: Track,
    pub target: f64,
    pub energy: f64,
    pub measure: Measure,
    pub tempo: Option<f32>,
    pub score: f64,
    pub affinity: f64,
    pub curve_fit: f64,
    pub transition: f64,
    pub penalty: f64,
    pub reasons: Vec<String>,
    pub pinned: bool,
    pub seed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Draft {
    pub slots: Vec<Slot>,
    pub targets: Vec<f64>,
    pub confidence: f64,
    pub measured: usize,
    pub previewed: usize,
    pub heard: usize,
    pub estimated: usize,
    pub unmeasured: usize,
    pub pool_size: usize,
    pub duration_ms: u64,
    /// Constraints that had to be relaxed, and other things worth saying about the draft.
    pub notes: Vec<String>,
}

fn artist_keys(track: &Track) -> Vec<String> {
    if track.artist_ids.is_empty() {
        track
            .artists
            .iter()
            .map(|name| name.to_lowercase())
            .collect()
    } else {
        track.artist_ids.clone()
    }
}

fn album_key(track: &Track) -> Option<String> {
    track
        .album_id
        .clone()
        .or_else(|| track.album.as_ref().map(|album| album.to_lowercase()))
}

fn percentile(sorted: &[f32], value: f32) -> f64 {
    let below = sorted.partition_point(|other| *other < value);
    let equal = sorted[below..].partition_point(|other| *other <= value);
    (below as f64 + equal as f64 / 2.0) / sorted.len() as f64
}

impl Pool {
    pub fn build(input: &PoolInput) -> Self {
        let mut catalog = input.catalog.clone();
        catalog.familiar_artists = familiar_artists(&catalog, input.feedback);
        let mut best: HashMap<String, (f64, Track, Vec<String>)> = HashMap::new();
        for seed in input.seeds {
            for discovery in [None, Some(input.discovery)] {
                let context = Context {
                    seed: seed.clone(),
                    queued: HashSet::new(),
                    session_played: HashSet::new(),
                    session_song_keys: HashSet::new(),
                    recent: input.recent.to_vec(),
                    feedback: input.feedback.clone(),
                    rng_seed: 42,
                    limit: MAX_RECOMMENDATIONS,
                    discovery,
                };
                let report = engine::rank(&catalog, &context);
                let top = report
                    .selected
                    .iter()
                    .map(|selection| selection.score)
                    .fold(0.0f64, f64::max);
                if top <= 0.0 {
                    continue;
                }
                for selection in report.selected {
                    let affinity = (selection.score.max(0.0) / top).clamp(0.0, 1.0);
                    let entry = best.entry(selection.track.uri.clone());
                    match entry {
                        std::collections::hash_map::Entry::Occupied(mut found) => {
                            if affinity > found.get().0 {
                                found.insert((affinity, selection.track, selection.reasons));
                            }
                        }
                        std::collections::hash_map::Entry::Vacant(empty) => {
                            empty.insert((affinity, selection.track, selection.reasons));
                        }
                    }
                }
            }
        }
        for seed in input.seeds {
            best.insert(seed.uri.clone(), (1.0, seed.clone(), vec!["seed".into()]));
        }

        // One release per song, keeping whichever the ranking liked most.
        let seed_uris: HashSet<&str> = input.seeds.iter().map(|seed| seed.uri.as_str()).collect();
        let mut by_song: HashMap<String, (f64, Track, Vec<String>)> = HashMap::new();
        let mut ordered: Vec<_> = best.into_values().collect();
        ordered.sort_by(|a, b| a.1.uri.cmp(&b.1.uri));
        for (affinity, track, reasons) in ordered {
            if track.is_local || track.is_playable == Some(false) {
                continue;
            }
            let key = song_key(&track);
            let key = if key.is_empty() {
                track.uri.clone()
            } else {
                key
            };
            let keep = by_song.get(&key).is_none_or(|existing| {
                !seed_uris.contains(existing.1.uri.as_str())
                    && (seed_uris.contains(track.uri.as_str()) || affinity > existing.0)
            });
            if keep {
                by_song.insert(key, (affinity, track, reasons));
            }
        }

        let mut memberships: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, playlist) in input.catalog.playlists.iter().enumerate() {
            for uri in playlist {
                memberships.entry(uri.as_str()).or_default().push(index);
            }
        }
        let recent: HashSet<&str> = input.recent.iter().map(String::as_str).collect();
        let mut energies = input.library_energies.to_vec();
        energies.sort_by(f32::total_cmp);
        let normalize = |raw: f32| {
            if energies.len() >= MIN_NORMALIZATION_SAMPLES {
                percentile(&energies, raw)
            } else {
                raw as f64
            }
        };

        let mut candidates: Vec<Candidate> = by_song
            .into_iter()
            .map(|(song, (affinity, track, reasons))| {
                let measured = input.fingerprints.get(&track.uri);
                let previewed = input.previews.get(&track.uri);
                let mut playlists = memberships
                    .get(track.uri.as_str())
                    .cloned()
                    .unwrap_or_default();
                playlists.sort_unstable();
                playlists.dedup();
                let heard = input.heard.get(&track.uri).copied();
                let (energy, measure) = match (measured, previewed, heard) {
                    (Some(found), _, _) => (normalize(found.energy), Measure::Measured),
                    (None, Some(preview), _) => (normalize(preview.energy), Measure::Previewed),
                    (None, None, Some(level)) => (level, Measure::Heard),
                    (None, None, None) => (0.5, Measure::Unmeasured),
                };
                let fingerprint = measured.or(previewed).cloned();
                Candidate {
                    affinity,
                    energy,
                    measure,
                    seed: seed_uris.contains(track.uri.as_str()),
                    artists: artist_keys(&track),
                    album: album_key(&track),
                    recent: recent.contains(track.uri.as_str()),
                    fingerprint,
                    reasons,
                    song,
                    playlists,
                    track,
                }
            })
            .collect();
        candidates.sort_by(|a, b| a.track.uri.cmp(&b.track.uri));
        estimate_energy(&mut candidates);
        let index = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| (candidate.track.uri.clone(), index))
            .collect();
        Self { candidates, index }
    }

    pub fn len(&self) -> usize {
        self.candidates.len()
    }

    pub fn get(&self, uri: &str) -> Option<&Candidate> {
        self.index.get(uri).map(|index| &self.candidates[*index])
    }

    fn position(&self, uri: &str) -> Option<usize> {
        self.index.get(uri).copied()
    }
}

/// Unmeasured tracks borrow the energy of measured tracks from the same album, then the same
/// artist. Playlists are too mixed to borrow from: one quiet song would colour dozens.
fn estimate_energy(candidates: &mut [Candidate]) {
    let mut albums: HashMap<String, Vec<f64>> = HashMap::new();
    let mut artists: HashMap<String, Vec<f64>> = HashMap::new();
    for candidate in candidates.iter().filter(|c| {
        matches!(
            c.measure,
            Measure::Measured | Measure::Previewed | Measure::Heard
        )
    }) {
        if let Some(album) = &candidate.album {
            albums
                .entry(album.clone())
                .or_default()
                .push(candidate.energy);
        }
        for artist in &candidate.artists {
            artists
                .entry(artist.clone())
                .or_default()
                .push(candidate.energy);
        }
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
    for candidate in candidates
        .iter_mut()
        .filter(|c| c.measure == Measure::Unmeasured)
    {
        let album = candidate.album.as_ref().and_then(|album| albums.get(album));
        let artist: Vec<f64> = candidate
            .artists
            .iter()
            .filter_map(|artist| artists.get(artist))
            .flatten()
            .copied()
            .collect();
        let estimate = album
            .map(|values| mean(values))
            .or_else(|| (!artist.is_empty()).then(|| mean(&artist)));
        if let Some(energy) = estimate {
            candidate.energy = energy;
            candidate.measure = Measure::Estimated;
        }
    }
}

fn percent(value: f64) -> u32 {
    (value.clamp(0.0, 1.0) * 100.0).round() as u32
}

/// The radio engine's evidence in words a listener would use. Bookkeeping reasons, such as
/// tie-breaks and penalties, are left out.
fn plain(reason: &str) -> Option<String> {
    let text = match reason {
        r if r.starts_with("shared seed playlist") => "in a playlist with your starting song",
        r if r.starts_with("genre overlap") => "a similar genre",
        "cross-artist playlist affinity" => "shows up in playlists near your starting song",
        "same artist" => "same artist as your starting song",
        "same album" => "same album as your starting song",
        "positive listening history" => "you usually play it through",
        "saved track" => "in your liked songs",
        "broader cache candidate" => "from your wider library",
        _ => return None,
    };
    Some(text.to_string())
}

fn shares_playlist(a: &Candidate, b: &Candidate) -> bool {
    let (mut i, mut j) = (0, 0);
    while i < a.playlists.len() && j < b.playlists.len() {
        match a.playlists[i].cmp(&b.playlists[j]) {
            std::cmp::Ordering::Equal => return true,
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    false
}

fn noise(rng_seed: u64, uri: &str, slot: usize) -> f64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    rng_seed.hash(&mut hash);
    uri.hash(&mut hash);
    slot.hash(&mut hash);
    (hash.finish() % 10_000) as f64 / 10_000.0 * NOISE
}

fn banned(recipe: &Recipe, candidate: &Candidate) -> bool {
    recipe.bans.contains(&candidate.track.uri) || recipe.bans.contains(&candidate.song)
}

/// How many slots a recipe asks for, given the tracks available.
pub fn slot_count(pool: &Pool, recipe: &Recipe) -> usize {
    match recipe.length {
        Length::Tracks(count) => count,
        Length::Minutes(minutes) => {
            let mut ranked: Vec<&Candidate> = pool.candidates.iter().collect();
            ranked.sort_by(|a, b| {
                b.affinity
                    .total_cmp(&a.affinity)
                    .then(a.track.uri.cmp(&b.track.uri))
            });
            let durations: Vec<f64> = ranked
                .iter()
                .take(100)
                .map(|candidate| candidate.track.duration as f64)
                .filter(|duration| *duration > 0.0)
                .collect();
            let average = if durations.is_empty() {
                DEFAULT_DURATION_MS
            } else {
                durations.iter().sum::<f64>() / durations.len() as f64
            };
            ((minutes as f64 * 60_000.0 / average).round() as usize).clamp(MIN_TRACKS, MAX_TRACKS)
        }
    }
}

struct SlotScore {
    score: f64,
    curve_fit: f64,
    transition: f64,
    penalty: f64,
    transition_reason: Option<String>,
}

fn score_slot(
    pool: &Pool,
    recipe: &Recipe,
    sequence: &[usize],
    slot: usize,
    candidate: usize,
    target: f64,
) -> SlotScore {
    let current = &pool.candidates[candidate];
    let previous = slot
        .checked_sub(1)
        .and_then(|p| sequence.get(p))
        .map(|i| &pool.candidates[*i]);
    // Steep, so missing the curve by a fifth already costs as much as weak affinity does.
    let curve_fit = (1.0 - 2.5 * (current.energy - target).abs()).max(0.0);
    let (flow, transition_reason) = match previous {
        Some(previous) => transition(
            previous.fingerprint.as_ref(),
            current.fingerprint.as_ref(),
            shares_playlist(previous, current),
        ),
        None => (0.5, None),
    };
    let start = slot.saturating_sub(ALBUM_SPACING);
    let mut penalty = 0.0;
    if current.album.is_some()
        && sequence[start..slot.min(sequence.len())]
            .iter()
            .any(|other| pool.candidates[*other].album == current.album)
    {
        penalty += ALBUM_PENALTY;
    }
    if current.recent {
        penalty += RECENT_PENALTY;
    }
    let score =
        WEIGHT_AFFINITY * current.affinity + WEIGHT_CURVE * curve_fit + WEIGHT_TRANSITION * flow
            - penalty
            + noise(recipe.rng_seed, &current.track.uri, slot);
    SlotScore {
        score,
        curve_fit,
        transition: flow,
        penalty,
        transition_reason,
    }
}

/// Artist rules, loosened step by step when a small library cannot satisfy them.
#[derive(Clone, Copy)]
struct Rules {
    spacing: usize,
    cap: Option<usize>,
}

type Relaxation = (&'static str, fn(usize) -> Rules);

const RELAXATIONS: [Relaxation; 4] = [
    ("", |n| Rules {
        spacing: ARTIST_SPACING,
        cap: Some(n.div_ceil(6).max(1)),
    }),
    ("allowed an artist more often than usual", |_| Rules {
        spacing: ARTIST_SPACING,
        cap: None,
    }),
    ("allowed an artist within three tracks of itself", |_| {
        Rules {
            spacing: 1,
            cap: None,
        }
    }),
    ("allowed an artist to repeat back to back", |_| Rules {
        spacing: 0,
        cap: None,
    }),
];

fn allowed(
    pool: &Pool,
    fixed: &[Option<usize>],
    sequence: &[usize],
    counts: &HashMap<&str, usize>,
    slot: usize,
    candidate: usize,
    rules: Rules,
) -> bool {
    let current = &pool.candidates[candidate];
    for artist in &current.artists {
        if rules
            .cap
            .is_some_and(|cap| counts.get(artist.as_str()).copied().unwrap_or(0) >= cap)
        {
            return false;
        }
        let behind = sequence[slot.saturating_sub(rules.spacing)..slot]
            .iter()
            .map(|index| Some(*index));
        let ahead = fixed.iter().skip(slot + 1).take(rules.spacing).copied();
        if behind
            .chain(ahead)
            .flatten()
            .any(|other| pool.candidates[other].artists.contains(artist))
        {
            return false;
        }
    }
    true
}

#[derive(Clone)]
struct Beam {
    sequence: Vec<usize>,
    score: f64,
    used: HashSet<usize>,
}

/// Place pins and seeds before the search, so the curve is built around them.
fn place_fixed(pool: &Pool, recipe: &Recipe, targets: &[f64]) -> Vec<Option<usize>> {
    let slots = targets.len();
    let mut fixed: Vec<Option<usize>> = vec![None; slots];
    let mut placed = HashSet::new();
    let usable = |uri: &str| {
        pool.position(uri)
            .filter(|index| !banned(recipe, &pool.candidates[*index]))
    };
    for pin in &recipe.pins {
        if let (Some(slot), Some(index)) = (pin.slot, usable(&pin.uri))
            && slot < slots
            && fixed[slot].is_none()
            && placed.insert(index)
        {
            fixed[slot] = Some(index);
        }
    }
    let floating = recipe
        .pins
        .iter()
        .filter(|pin| pin.slot.is_none_or(|slot| slot >= slots))
        .map(|pin| pin.uri.as_str())
        .chain(recipe.seeds.iter().map(String::as_str));
    for uri in floating {
        let Some(index) = usable(uri) else { continue };
        if placed.contains(&index) {
            continue;
        }
        let energy = pool.candidates[index].energy;
        let best = (0..slots)
            .filter(|slot| fixed[*slot].is_none())
            .min_by(|a, b| {
                (energy - targets[*a])
                    .abs()
                    .total_cmp(&(energy - targets[*b]).abs())
                    .then(a.cmp(b))
            });
        if let Some(slot) = best {
            fixed[slot] = Some(index);
            placed.insert(index);
        }
    }
    fixed
}

pub fn solve(pool: &Pool, recipe: &Recipe) -> Draft {
    let slots = slot_count(pool, recipe);
    let targets = recipe.targets(slots);
    let fixed = place_fixed(pool, recipe, &targets);
    let fixed_songs: HashSet<&str> = fixed
        .iter()
        .flatten()
        .map(|index| pool.candidates[*index].song.as_str())
        .collect();
    let eligible: Vec<usize> = (0..pool.len())
        .filter(|index| {
            let candidate = &pool.candidates[*index];
            !banned(recipe, candidate) && !fixed_songs.contains(candidate.song.as_str())
        })
        .collect();

    let mut notes = Vec::new();
    let mut beams = vec![Beam {
        sequence: Vec::new(),
        score: 0.0,
        used: HashSet::new(),
    }];
    for slot in 0..slots {
        if let Some(index) = fixed[slot] {
            for beam in &mut beams {
                let scored = score_slot(pool, recipe, &beam.sequence, slot, index, targets[slot]);
                beam.score += scored.score;
                beam.sequence.push(index);
            }
            continue;
        }
        let mut expanded = Vec::new();
        for (label, rules) in RELAXATIONS {
            let rules = rules(slots);
            for (beam_index, beam) in beams.iter().enumerate() {
                let mut counts: HashMap<&str, usize> = HashMap::new();
                for index in beam
                    .sequence
                    .iter()
                    .chain(fixed.iter().skip(slot + 1).flatten())
                {
                    for artist in &pool.candidates[*index].artists {
                        *counts.entry(artist.as_str()).or_default() += 1;
                    }
                }
                for &candidate in &eligible {
                    if beam.used.contains(&candidate)
                        || !allowed(
                            pool,
                            &fixed,
                            &beam.sequence,
                            &counts,
                            slot,
                            candidate,
                            rules,
                        )
                    {
                        continue;
                    }
                    let scored =
                        score_slot(pool, recipe, &beam.sequence, slot, candidate, targets[slot]);
                    expanded.push((beam_index, candidate, beam.score + scored.score));
                }
            }
            if !expanded.is_empty() {
                if !label.is_empty() && !notes.iter().any(|note| note == label) {
                    notes.push(label.to_string());
                }
                break;
            }
        }
        if expanded.is_empty() {
            notes.push(format!(
                "ran out of suitable tracks after {} slots",
                beams[0].sequence.len()
            ));
            break;
        }
        expanded.sort_by(|a, b| {
            b.2.total_cmp(&a.2)
                .then_with(|| {
                    pool.candidates[a.1]
                        .track
                        .uri
                        .cmp(&pool.candidates[b.1].track.uri)
                })
                .then(a.0.cmp(&b.0))
        });
        let mut next = Vec::with_capacity(BEAM_WIDTH);
        let mut seen = HashSet::new();
        for (beam_index, candidate, score) in expanded {
            let mut beam = beams[beam_index].clone();
            beam.sequence.push(candidate);
            // Two beams that agree on the recent past will make the same choices from here.
            let key: Vec<usize> = beam.sequence.iter().rev().take(4).copied().collect();
            if !seen.insert(key) {
                continue;
            }
            beam.used.insert(candidate);
            beam.score = score;
            next.push(beam);
            if next.len() == BEAM_WIDTH {
                break;
            }
        }
        beams = next;
    }
    let best = beams
        .into_iter()
        .max_by(|a, b| a.score.total_cmp(&b.score))
        .map(|beam| beam.sequence)
        .unwrap_or_default();
    let uris: Vec<String> = best
        .iter()
        .map(|index| pool.candidates[*index].track.uri.clone())
        .collect();
    let mut draft = assemble(pool, recipe, &uris, &targets);
    draft.notes.splice(0..0, notes);
    draft
}

/// Score and explain a sequence of tracks against the recipe's curve.
pub fn assemble(pool: &Pool, recipe: &Recipe, uris: &[String], targets: &[f64]) -> Draft {
    let sequence: Vec<usize> = uris.iter().filter_map(|uri| pool.position(uri)).collect();
    let pinned: HashSet<&str> = recipe.pins.iter().map(|pin| pin.uri.as_str()).collect();
    let mut slots = Vec::with_capacity(sequence.len());
    for (slot, &index) in sequence.iter().enumerate() {
        let candidate = &pool.candidates[index];
        let target = targets.get(slot).copied().unwrap_or(0.5);
        let scored = score_slot(pool, recipe, &sequence, slot, index, target);
        let mut reasons = Vec::new();
        if pinned.contains(candidate.track.uri.as_str()) {
            reasons.push("pinned".to_string());
        }
        if candidate.seed {
            reasons.push("seed".to_string());
        }
        let mut engine_reasons = candidate.reasons.iter().filter_map(|reason| plain(reason));
        if let Some(first) = engine_reasons.next() {
            reasons.push(first);
        }
        let (energy, wanted) = (percent(candidate.energy), percent(target));
        reasons.push(match candidate.measure {
            Measure::Measured if (candidate.energy - target).abs() <= 0.08 => {
                format!("energy {energy}%, right on the arc")
            }
            Measure::Measured => format!("energy {energy}%, the arc wants {wanted}%"),
            Measure::Previewed => format!("energy {energy}% from a preview"),
            Measure::Heard => format!("energy {energy}% from how loud it played last time"),
            Measure::Estimated => format!("energy ~{energy}%, guessed from related songs"),
            Measure::Unmeasured => "energy not learned yet".to_string(),
        });
        if let Some(reason) = scored.transition_reason {
            reasons.push(reason);
        }
        reasons.extend(engine_reasons.take(1));
        slots.push(Slot {
            track: candidate.track.clone(),
            target,
            energy: candidate.energy,
            measure: candidate.measure,
            tempo: candidate.fingerprint.as_ref().and_then(|found| found.tempo),
            score: scored.score,
            affinity: candidate.affinity,
            curve_fit: scored.curve_fit,
            transition: scored.transition,
            penalty: scored.penalty,
            reasons,
            pinned: pinned.contains(candidate.track.uri.as_str()),
            seed: candidate.seed,
        });
    }
    let count = |measure| slots.iter().filter(|slot| slot.measure == measure).count();
    let (measured, previewed, heard, estimated, unmeasured) = (
        count(Measure::Measured),
        count(Measure::Previewed),
        count(Measure::Heard),
        count(Measure::Estimated),
        count(Measure::Unmeasured),
    );
    let confidence = if slots.is_empty() {
        0.0
    } else {
        let n = slots.len() as f64;
        let quality = (measured as f64
            + 0.9 * previewed as f64
            + 0.8 * heard as f64
            + 0.6 * estimated as f64
            + 0.3 * unmeasured as f64)
            / n;
        let affinity = slots.iter().map(|slot| slot.affinity).sum::<f64>() / n;
        ((0.6 * quality + 0.4 * affinity) * 100.0).round() / 100.0
    };
    let mut notes = Vec::new();
    if !slots.is_empty() && unmeasured * 2 > slots.len() {
        notes.push(
            "energy is still being learned; every song you play sharpens the shape".to_string(),
        );
    }
    Draft {
        duration_ms: slots.iter().map(|slot| slot.track.duration as u64).sum(),
        slots,
        targets: targets.to_vec(),
        confidence,
        measured,
        previewed,
        heard,
        estimated,
        unmeasured,
        pool_size: pool.len(),
        notes,
    }
}

/// The best replacements for one slot, with its neighbours left where they are.
pub fn alternatives(
    pool: &Pool,
    recipe: &Recipe,
    draft: &Draft,
    slot: usize,
    limit: usize,
) -> Vec<Slot> {
    let Some(current) = draft.slots.get(slot) else {
        return Vec::new();
    };
    let uris: Vec<String> = draft
        .slots
        .iter()
        .map(|slot| slot.track.uri.clone())
        .collect();
    let sequence: Vec<usize> = uris.iter().filter_map(|uri| pool.position(uri)).collect();
    if sequence.len() != uris.len() {
        return Vec::new();
    }
    let used: HashSet<&str> = sequence
        .iter()
        .enumerate()
        .filter(|(position, _)| *position != slot)
        .map(|(_, index)| pool.candidates[*index].song.as_str())
        .collect();
    let neighbours: Vec<usize> = sequence
        .iter()
        .enumerate()
        .filter(|(position, _)| *position != slot && position.abs_diff(slot) <= ARTIST_SPACING)
        .map(|(_, index)| *index)
        .collect();
    let next = sequence.get(slot + 1).map(|index| &pool.candidates[*index]);
    let mut options: Vec<(f64, usize)> = (0..pool.len())
        .filter(|index| {
            let candidate = &pool.candidates[*index];
            candidate.track.uri != current.track.uri
                && !banned(recipe, candidate)
                && !used.contains(candidate.song.as_str())
                && !neighbours.iter().any(|other| {
                    pool.candidates[*other]
                        .artists
                        .iter()
                        .any(|artist| candidate.artists.contains(artist))
                })
        })
        .map(|index| {
            let mut trial = sequence.clone();
            trial[slot] = index;
            let mut score = score_slot(pool, recipe, &trial, slot, index, current.target).score;
            if let Some(next) = next {
                let candidate = &pool.candidates[index];
                score += WEIGHT_TRANSITION
                    * transition(
                        candidate.fingerprint.as_ref(),
                        next.fingerprint.as_ref(),
                        shares_playlist(candidate, next),
                    )
                    .0;
            }
            (score, index)
        })
        .collect();
    options.sort_by(|a, b| {
        b.0.total_cmp(&a.0).then_with(|| {
            pool.candidates[a.1]
                .track
                .uri
                .cmp(&pool.candidates[b.1].track.uri)
        })
    });
    options
        .into_iter()
        .take(limit)
        .filter_map(|(_, index)| {
            let mut trial = uris.clone();
            trial[slot] = pool.candidates[index].track.uri.clone();
            assemble(pool, recipe, &trial, &draft.targets)
                .slots
                .into_iter()
                .nth(slot)
        })
        .collect()
}
