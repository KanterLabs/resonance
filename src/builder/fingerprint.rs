//! What a track sounds like, learned by listening to it.
//!
//! Spotify no longer offers audio features to this app, so arcs measure tracks the way the
//! waveform does: while a track plays, a background sampler reads the audio tap's level,
//! spectrum and tempo and folds them into a small summary. Only those numbers are kept, never
//! audio. The sampler runs in the engine, so it learns under every frontend.

use std::collections::HashMap;
#[cfg(not(test))]
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
#[cfg(not(test))]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::model::track::Track;
use crate::recommendations::engine::song_key;

#[cfg_attr(test, allow(dead_code))]
pub const FINGERPRINT_VERSION: u16 = 1;
#[cfg(not(test))]
const CACHE_FILE: &str = "fingerprints.json";
const MAX_ENTRIES: usize = 50_000;
/// Listening needed before a measurement is kept: this much, or `MIN_SHARE` of the track,
/// whichever is shorter.
const MIN_LISTEN_MS: u64 = 45_000;
const MIN_SHARE: f64 = 0.6;
/// The least audio a fingerprint can be taken from outside of playback, such as a preview.
const MIN_EXCERPT_MS: u64 = 20_000;
/// Position buckets used to measure how a track starts and ends.
const EDGE_BUCKETS: usize = 20;
/// Bands read from the tap for brightness and density.
pub(crate) const BANDS: usize = 16;
/// Tempo readings must agree this closely with their median to count.
const TEMPO_AGREEMENT: f32 = 0.06;
const MIN_TEMPO_CONFIDENCE: f32 = 0.5;
#[cfg(not(test))]
const SAMPLE_EVERY: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fingerprint {
    #[serde(default)]
    pub song_key: String,
    /// Raw loudness and density, 0 to 1. Arcs normalize it against the library at solve
    /// time, since mastering loudness differs so much between records.
    pub energy: f32,
    /// How much the level moves around over the track, 0 to 1.
    pub dynamics: f32,
    /// Spectral centroid, 0 (dark) to 1 (bright).
    pub brightness: f32,
    pub tempo: Option<f32>,
    pub tempo_confidence: f32,
    pub intro_energy: f32,
    pub outro_energy: f32,
    pub listened_ms: u64,
    pub measured_at: i64,
    /// Whether `intro_energy` and `outro_energy` were heard. A preview is an excerpt from the
    /// middle of a track, so it says nothing about how the track starts or ends.
    #[serde(default = "edges_heard")]
    pub edges: bool,
}

fn edges_heard() -> bool {
    true
}

/// One instant of playback, as read from the audio tap.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub level: f32,
    pub bands: Option<Vec<f32>>,
    pub tempo: Option<f32>,
    pub position_ms: u64,
    pub elapsed_ms: u64,
}

/// Measurements in progress for the track playing now.
#[derive(Debug)]
struct Session {
    uri: String,
    song_key: String,
    duration_ms: u32,
    listened_ms: u64,
    levels: Vec<f32>,
    brightness: Vec<f32>,
    density: Vec<f32>,
    tempos: Vec<f32>,
    edges: [(f32, u32); EDGE_BUCKETS],
}

impl Session {
    fn new(track: &Track) -> Self {
        Self {
            uri: track.uri.clone(),
            song_key: song_key(track),
            duration_ms: track.duration,
            listened_ms: 0,
            levels: Vec::new(),
            brightness: Vec::new(),
            density: Vec::new(),
            tempos: Vec::new(),
            edges: [(0.0, 0); EDGE_BUCKETS],
        }
    }

    fn add(&mut self, sample: &Sample) {
        self.listened_ms += sample.elapsed_ms;
        self.levels.push(sample.level);
        if let Some(bands) = sample.bands.as_ref().filter(|bands| bands.len() > 1) {
            let total: f32 = bands.iter().sum();
            if total > f32::EPSILON {
                let centroid: f32 = bands
                    .iter()
                    .enumerate()
                    .map(|(index, value)| index as f32 * value)
                    .sum::<f32>()
                    / total;
                self.brightness.push(centroid / (bands.len() - 1) as f32);
            }
            self.density.push(total / bands.len() as f32);
        }
        if let Some(tempo) = sample
            .tempo
            .filter(|tempo| tempo.is_finite() && *tempo > 0.0)
        {
            self.tempos.push(tempo);
        }
        if self.duration_ms > 0 {
            let bucket = ((sample.position_ms as u128 * EDGE_BUCKETS as u128)
                / self.duration_ms as u128) as usize;
            let edge = &mut self.edges[bucket.min(EDGE_BUCKETS - 1)];
            edge.0 += sample.level;
            edge.1 += 1;
        }
    }

    fn ready(&self) -> bool {
        let share = (self.duration_ms as f64 * MIN_SHARE) as u64;
        let needed = if share > 0 {
            MIN_LISTEN_MS.min(share)
        } else {
            MIN_LISTEN_MS
        };
        self.listened_ms >= needed && !self.levels.is_empty()
    }

    fn finish(&self, now: i64) -> Option<Fingerprint> {
        if !self.ready() {
            return None;
        }
        self.summarize(now)
    }

    fn summarize(&self, now: i64) -> Option<Fingerprint> {
        if self.levels.is_empty() {
            return None;
        }
        let level = mean(&self.levels);
        let density = if self.density.is_empty() {
            level
        } else {
            mean(&self.density)
        };
        let variance = self
            .levels
            .iter()
            .map(|value| (value - level).powi(2))
            .sum::<f32>()
            / self.levels.len() as f32;
        let (tempo, tempo_confidence) = tempo_of(&self.tempos);
        let edge = |range: std::ops::Range<usize>| {
            let (sum, count) = self.edges[range]
                .iter()
                .fold((0.0, 0), |(s, c), (sum, count)| (s + sum, c + count));
            if count == 0 {
                level
            } else {
                sum / count as f32
            }
        };
        Some(Fingerprint {
            song_key: self.song_key.clone(),
            energy: (0.6 * level + 0.4 * density).clamp(0.0, 1.0),
            // A standard deviation of a third of the scale is already a very dynamic track.
            dynamics: (variance.sqrt() * 3.0).clamp(0.0, 1.0),
            brightness: if self.brightness.is_empty() {
                0.5
            } else {
                mean(&self.brightness).clamp(0.0, 1.0)
            },
            tempo,
            tempo_confidence,
            intro_energy: edge(0..2),
            outro_energy: edge(EDGE_BUCKETS - 2..EDGE_BUCKETS),
            listened_ms: self.listened_ms,
            measured_at: now,
            edges: true,
        })
    }
}

/// A fingerprint of `track` from readings taken outside of playback, such as from a preview
/// run through `super::offline`. Its edges are not known.
pub(crate) fn from_samples(track: &Track, samples: &[Sample], now: i64) -> Option<Fingerprint> {
    let mut session = Session::new(track);
    for sample in samples {
        session.add(sample);
    }
    if session.listened_ms < MIN_EXCERPT_MS {
        return None;
    }
    let mut fingerprint = session.summarize(now)?;
    fingerprint.edges = false;
    Some(fingerprint)
}

fn mean(values: &[f32]) -> f32 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f32>() / values.len() as f32
    }
}

/// The median tempo reading, and the share of readings that agree with it. A tempo is only
/// reported when enough readings agree.
fn tempo_of(readings: &[f32]) -> (Option<f32>, f32) {
    if readings.len() < 20 {
        return (None, 0.0);
    }
    let mut sorted = readings.to_vec();
    sorted.sort_by(f32::total_cmp);
    let median = sorted[sorted.len() / 2];
    let agreeing = sorted
        .iter()
        .filter(|tempo| ((**tempo - median) / median).abs() <= TEMPO_AGREEMENT)
        .count();
    let confidence = agreeing as f32 / sorted.len() as f32;
    if confidence >= MIN_TEMPO_CONFIDENCE {
        (Some((median * 10.0).round() / 10.0), confidence)
    } else {
        (None, confidence)
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[derive(Default)]
struct Entries {
    by_uri: HashMap<String, Fingerprint>,
    by_song: HashMap<String, String>,
}

impl Entries {
    fn insert(&mut self, uri: String, fingerprint: Fingerprint) {
        if !fingerprint.song_key.is_empty() {
            self.by_song
                .insert(fingerprint.song_key.clone(), uri.clone());
        }
        self.by_uri.insert(uri, fingerprint);
        while self.by_uri.len() > MAX_ENTRIES {
            let Some(oldest) = self
                .by_uri
                .iter()
                .min_by(|a, b| a.1.measured_at.cmp(&b.1.measured_at).then(a.0.cmp(b.0)))
                .map(|(uri, _)| uri.clone())
            else {
                break;
            };
            if let Some(removed) = self.by_uri.remove(&oldest)
                && self.by_song.get(&removed.song_key) == Some(&oldest)
            {
                self.by_song.remove(&removed.song_key);
            }
        }
    }
}

#[cfg_attr(test, allow(dead_code))]
#[derive(Serialize, Deserialize)]
struct Stored {
    version: u16,
    entries: HashMap<String, Fingerprint>,
}

/// Every measurement taken, in memory and on disk.
#[derive(Default)]
pub struct FingerprintStore {
    entries: RwLock<Entries>,
    session: Mutex<Option<Session>>,
}

pub fn shared() -> Arc<FingerprintStore> {
    static SHARED: OnceLock<Arc<FingerprintStore>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            let store = Arc::new(FingerprintStore::default());
            #[cfg(not(test))]
            store.load();
            store
        })
        .clone()
}

impl FingerprintStore {
    /// The measurement for a track, or for another release of the same song.
    pub fn get(&self, track: &Track) -> Option<Fingerprint> {
        let entries = self.entries.read().unwrap();
        entries.by_uri.get(&track.uri).cloned().or_else(|| {
            let key = song_key(track);
            entries
                .by_song
                .get(&key)
                .and_then(|uri| entries.by_uri.get(uri))
                .cloned()
        })
    }

    /// Measurements for `tracks`, keyed by each track's own URI.
    pub fn lookup<'a>(
        &self,
        tracks: impl IntoIterator<Item = &'a Track>,
    ) -> HashMap<String, Fingerprint> {
        tracks
            .into_iter()
            .filter_map(|track| self.get(track).map(|found| (track.uri.clone(), found)))
            .collect()
    }

    /// Every stored raw energy, used to normalize energy against the library.
    pub fn energies(&self) -> Vec<f32> {
        self.entries
            .read()
            .unwrap()
            .by_uri
            .values()
            .map(|fingerprint| fingerprint.energy)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.entries.read().unwrap().by_uri.len()
    }

    /// The raw energy measured for a URI, or for another release with the same song key.
    pub fn energy_of(&self, uri: &str, song_key: &str) -> Option<f32> {
        let entries = self.entries.read().unwrap();
        entries
            .by_uri
            .get(uri)
            .or_else(|| {
                entries
                    .by_song
                    .get(song_key)
                    .and_then(|uri| entries.by_uri.get(uri))
            })
            .map(|fingerprint| fingerprint.energy)
    }

    /// Fold one sample of the playing track in. A change of track finishes the previous one.
    /// Returns true when a measurement was committed.
    pub fn observe(&self, track: Option<&Track>, sample: Option<&Sample>) -> bool {
        let mut session = self.session.lock().unwrap();
        let changed = match (&*session, track) {
            (Some(current), Some(track)) => current.uri != track.uri,
            (Some(_), None) => true,
            _ => false,
        };
        let mut committed = false;
        if changed && let Some(finished) = session.take() {
            committed = self.commit(&finished);
        }
        if let Some(track) = track.filter(|track| !track.is_local && track.id.is_some()) {
            let current = session.get_or_insert_with(|| Session::new(track));
            if let Some(sample) = sample {
                current.add(sample);
            }
        }
        committed
    }

    /// Commit whatever has been heard of the playing track, for shutdown.
    pub fn finish(&self) -> bool {
        let finished = self.session.lock().unwrap().take();
        finished.is_some_and(|session| self.commit(&session))
    }

    fn commit(&self, session: &Session) -> bool {
        let Some(fingerprint) = session.finish(now_seconds()) else {
            return false;
        };
        let mut entries = self.entries.write().unwrap();
        // A longer listen is a better measurement; a shorter one never replaces it.
        if entries
            .by_uri
            .get(&session.uri)
            .is_some_and(|existing| existing.listened_ms > fingerprint.listened_ms)
        {
            return false;
        }
        entries.insert(session.uri.clone(), fingerprint);
        true
    }

    #[cfg(test)]
    pub fn save(&self) {}

    #[cfg(not(test))]
    pub fn save(&self) {
        let path = crate::config::cache_path(CACHE_FILE);
        let stored = Stored {
            version: FINGERPRINT_VERSION,
            entries: self.entries.read().unwrap().by_uri.clone(),
        };
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(&temp)?;
            serde_json::to_writer(&mut file, &stored)?;
            file.flush()?;
            file.sync_all()?;
            std::fs::rename(&temp, &path)
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temp);
            log::error!("could not write arc fingerprints: {error}");
        }
    }

    #[cfg(not(test))]
    fn load(&self) {
        let path = crate::config::cache_path(CACHE_FILE);
        let Ok(file) = std::fs::File::open(&path) else {
            return;
        };
        match serde_json::from_reader::<_, Stored>(std::io::BufReader::new(file)) {
            Ok(stored) if stored.version == FINGERPRINT_VERSION => {
                let mut entries = self.entries.write().unwrap();
                for (uri, fingerprint) in stored.entries {
                    entries.insert(uri, fingerprint);
                }
            }
            Ok(_) => log::debug!("ignoring arc fingerprints from another version"),
            Err(error) => log::error!("could not read arc fingerprints: {error}"),
        }
    }
}

/// Sample the playing track in the background for as long as the process runs.
#[cfg(not(test))]
pub fn start(spotify: crate::spotify::Spotify, queue: Arc<crate::queue::Queue>) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("arc-fingerprints".into())
        .spawn(move || {
            let store = shared();
            // Song maps learn from the same readings.
            let maps = crate::song_map::shared();
            loop {
                std::thread::sleep(SAMPLE_EVERY);
                let track = queue
                    .get_current()
                    .and_then(|playable| crate::traits::ListItem::track(&playable));
                let tap = spotify.audio_tap();
                let playing = matches!(
                    spotify.get_current_status(),
                    crate::spotify::PlayerEvent::Playing(_)
                );
                let sample = (playing && tap.is_live()).then(|| Sample {
                    level: tap.level(),
                    bands: tap.bands(BANDS),
                    tempo: tap.tempo(),
                    position_ms: spotify.get_current_progress().as_millis() as u64,
                    elapsed_ms: SAMPLE_EVERY.as_millis() as u64,
                });
                if store.observe(track.as_ref(), sample.as_ref()) {
                    store.save();
                }
                if maps.observe(track.as_ref(), sample.as_ref()) {
                    maps.save();
                }
            }
        });
    if let Err(error) = spawned {
        log::error!("could not start arc fingerprinting: {error}");
    }
}

/// Tests never sample real playback.
#[cfg(test)]
pub fn start(_: crate::spotify::Spotify, _: Arc<crate::queue::Queue>) {}

/// Keep what was heard of the playing track before the process exits.
pub fn flush() {
    let store = shared();
    if store.finish() {
        store.save();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(uri: &str, duration: u32) -> Track {
        crate::builder::test_track(uri, "artist", "album", duration)
    }

    fn sample(position_ms: u64, level: f32, tempo: Option<f32>) -> Sample {
        Sample {
            level,
            bands: Some(vec![level; BANDS]),
            tempo,
            position_ms,
            elapsed_ms: 100,
        }
    }

    fn play(store: &FingerprintStore, track: &Track, ms: u64, level: f32, tempo: Option<f32>) {
        for step in 0..ms / 100 {
            store.observe(Some(track), Some(&sample(step * 100, level, tempo)));
        }
    }

    #[test]
    fn a_short_listen_is_not_kept() {
        let store = FingerprintStore::default();
        let song = track("spotify:track:a", 200_000);
        play(&store, &song, 30_000, 0.5, None);
        assert!(!store.finish());
        assert!(store.get(&song).is_none());
    }

    #[test]
    fn enough_listening_commits_on_track_change() {
        let store = FingerprintStore::default();
        let song = track("spotify:track:a", 200_000);
        play(&store, &song, 46_000, 0.5, Some(120.0));
        let next = track("spotify:track:b", 200_000);
        assert!(store.observe(Some(&next), None));
        let measured = store.get(&song).expect("measured");
        assert!((measured.energy - 0.5).abs() < 1e-4);
        assert_eq!(measured.tempo, Some(120.0));
        assert!(measured.tempo_confidence > 0.99);
    }

    #[test]
    fn a_short_track_needs_only_most_of_its_length() {
        let store = FingerprintStore::default();
        let song = track("spotify:track:a", 60_000);
        play(&store, &song, 37_000, 0.4, None);
        assert!(store.finish());
    }

    #[test]
    fn a_longer_listen_replaces_a_shorter_one_but_not_the_reverse() {
        let store = FingerprintStore::default();
        let song = track("spotify:track:a", 300_000);
        play(&store, &song, 50_000, 0.3, None);
        assert!(store.finish());
        play(&store, &song, 90_000, 0.7, None);
        assert!(store.finish());
        assert!((store.get(&song).unwrap().energy - 0.7).abs() < 1e-4);
        play(&store, &song, 60_000, 0.1, None);
        assert!(!store.finish());
        assert!((store.get(&song).unwrap().energy - 0.7).abs() < 1e-4);
    }

    #[test]
    fn another_release_of_the_same_song_reuses_the_measurement() {
        let store = FingerprintStore::default();
        let song = track("spotify:track:a", 200_000);
        play(&store, &song, 46_000, 0.5, None);
        assert!(store.finish());
        let mut reissue = song.clone();
        reissue.uri = "spotify:track:reissue".into();
        assert!(store.get(&reissue).is_some());
    }

    #[test]
    fn disagreeing_tempo_readings_report_no_tempo() {
        let readings: Vec<f32> = (0..40).map(|i| 70.0 + (i * 7 % 70) as f32).collect();
        let (tempo, confidence) = tempo_of(&readings);
        assert_eq!(tempo, None);
        assert!(confidence < MIN_TEMPO_CONFIDENCE);
    }

    #[test]
    fn intro_and_outro_are_measured_from_the_edges() {
        let store = FingerprintStore::default();
        let song = track("spotify:track:a", 100_000);
        for step in 0..1000u64 {
            let position = step * 100;
            let level = if position < 10_000 {
                0.1
            } else if position >= 90_000 {
                0.2
            } else {
                0.8
            };
            store.observe(Some(&song), Some(&sample(position, level, None)));
        }
        assert!(store.finish());
        let measured = store.get(&song).unwrap();
        assert!((measured.intro_energy - 0.1).abs() < 1e-4);
        assert!((measured.outro_energy - 0.2).abs() < 1e-4);
        assert!(measured.dynamics > 0.0);
    }

    #[test]
    fn local_files_are_never_measured() {
        let store = FingerprintStore::default();
        let mut song = track("spotify:local:x", 200_000);
        song.is_local = true;
        play(&store, &song, 60_000, 0.5, None);
        assert!(!store.finish());
    }

    #[test]
    fn the_store_stays_within_its_budget() {
        let mut entries = Entries::default();
        for index in 0..MAX_ENTRIES + 3 {
            entries.insert(
                format!("spotify:track:{index}"),
                Fingerprint {
                    song_key: format!("song:{index}"),
                    energy: 0.5,
                    dynamics: 0.0,
                    brightness: 0.5,
                    tempo: None,
                    tempo_confidence: 0.0,
                    intro_energy: 0.5,
                    outro_energy: 0.5,
                    listened_ms: 50_000,
                    measured_at: index as i64,
                    edges: true,
                },
            );
        }
        assert_eq!(entries.by_uri.len(), MAX_ENTRIES);
        assert!(!entries.by_uri.contains_key("spotify:track:0"));
        assert!(!entries.by_song.contains_key("song:0"));
    }
}
