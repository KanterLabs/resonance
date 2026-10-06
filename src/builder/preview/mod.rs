//! What a track sounds like, learned from Deezer's 30 second preview of it.
//!
//! Fingerprints need a track to be played. Previews let arcs measure tracks that have not
//! been: the preview is decoded, run through the audio tap's analysis, and kept as a
//! fingerprint without edges. Only those numbers are kept, never audio. They live apart from
//! `fingerprints.json`, so they never shift how listened energy is normalized.

pub mod calibrate;
pub mod measure;
pub mod queue;

use std::collections::HashMap;
#[cfg(not(test))]
use std::io::Write;
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use super::fingerprint::{Fingerprint, FingerprintStore};
use crate::model::track::Track;
use crate::recommendations::engine::song_key;
use calibrate::Calibration;

#[cfg_attr(test, allow(dead_code))]
const PREVIEW_VERSION: u16 = 1;
#[cfg(not(test))]
const CACHE_FILE: &str = "previews.json";
const MAX_ENTRIES: usize = 50_000;
/// A track Deezer could not help with is asked about again after this long.
const RETRY_AFTER_S: i64 = 30 * 24 * 60 * 60;

/// What Deezer gave for one track. Kept even when it gave nothing, so it is not asked again soon.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preview {
    #[serde(default)]
    pub song_key: String,
    pub deezer_id: Option<u64>,
    /// None when Deezer had no match, no playable preview, or a preview too short to measure.
    pub fingerprint: Option<Fingerprint>,
    pub deezer_bpm: Option<f32>,
    pub deezer_gain: Option<f32>,
    pub checked_at: i64,
}

#[derive(Default)]
struct Entries {
    by_uri: HashMap<String, Preview>,
    by_song: HashMap<String, String>,
}

impl Entries {
    fn insert(&mut self, uri: String, preview: Preview) {
        if !preview.song_key.is_empty() {
            self.by_song.insert(preview.song_key.clone(), uri.clone());
        }
        self.by_uri.insert(uri, preview);
        while self.by_uri.len() > MAX_ENTRIES {
            let Some(oldest) = self
                .by_uri
                .iter()
                .min_by(|a, b| a.1.checked_at.cmp(&b.1.checked_at).then(a.0.cmp(b.0)))
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
    entries: HashMap<String, Preview>,
}

/// Every preview checked, in memory and on disk.
#[derive(Default)]
pub struct PreviewStore {
    entries: RwLock<Entries>,
}

pub fn shared() -> Arc<PreviewStore> {
    static SHARED: OnceLock<Arc<PreviewStore>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            let store = Arc::new(PreviewStore::default());
            #[cfg(not(test))]
            store.load();
            store
        })
        .clone()
}

impl PreviewStore {
    /// What Deezer gave for a track, or for another release of the same song.
    pub fn get(&self, track: &Track) -> Option<Preview> {
        let entries = self.entries.read().unwrap();
        entries.by_uri.get(&track.uri).cloned().or_else(|| {
            entries
                .by_song
                .get(&song_key(track))
                .and_then(|uri| entries.by_uri.get(uri))
                .cloned()
        })
    }

    /// Preview measurements for `tracks`, keyed by each track's own URI.
    pub fn lookup<'a>(
        &self,
        tracks: impl IntoIterator<Item = &'a Track>,
    ) -> HashMap<String, Fingerprint> {
        tracks
            .into_iter()
            .filter_map(|track| {
                let fingerprint = self.get(track)?.fingerprint?;
                Some((track.uri.clone(), fingerprint))
            })
            .collect()
    }

    /// Whether Deezer should be asked about `track`: never asked, or asked long enough ago
    /// that a miss may since have been filled.
    pub fn needs_check(&self, track: &Track, now: i64) -> bool {
        match self.get(track) {
            None => true,
            Some(preview) => {
                preview.fingerprint.is_none() && now - preview.checked_at >= RETRY_AFTER_S
            }
        }
    }

    pub fn insert(&self, uri: String, preview: Preview) {
        self.entries.write().unwrap().insert(uri, preview);
    }

    /// How preview energy maps onto the energy `listened` measured by playing tracks.
    pub fn calibration(&self, listened: &FingerprintStore) -> Calibration {
        let entries = self.entries.read().unwrap();
        let mut pairs = Vec::new();
        let mut previews = Vec::new();
        for (uri, preview) in &entries.by_uri {
            let Some(fingerprint) = &preview.fingerprint else {
                continue;
            };
            previews.push(fingerprint.energy);
            if let Some(heard) = listened.energy_of(uri, &preview.song_key) {
                pairs.push((fingerprint.energy, heard));
            }
        }
        Calibration::fit(&pairs, &previews, &listened.energies())
    }

    /// How many tracks have a preview measurement.
    pub fn measured(&self) -> usize {
        self.entries
            .read()
            .unwrap()
            .by_uri
            .values()
            .filter(|preview| preview.fingerprint.is_some())
            .count()
    }

    #[cfg(test)]
    pub fn save(&self) {}

    #[cfg(not(test))]
    pub fn save(&self) {
        let path = crate::config::cache_path(CACHE_FILE);
        let stored = Stored {
            version: PREVIEW_VERSION,
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
            log::error!("could not write arc previews: {error}");
        }
    }

    #[cfg(not(test))]
    fn load(&self) {
        let path = crate::config::cache_path(CACHE_FILE);
        let Ok(file) = std::fs::File::open(&path) else {
            return;
        };
        match serde_json::from_reader::<_, Stored>(std::io::BufReader::new(file)) {
            Ok(stored) if stored.version == PREVIEW_VERSION => {
                let mut entries = self.entries.write().unwrap();
                for (uri, preview) in stored.entries {
                    entries.insert(uri, preview);
                }
            }
            Ok(_) => log::debug!("ignoring arc previews from another version"),
            Err(error) => log::error!("could not read arc previews: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::test_track;

    fn preview(track: &Track, measured: bool, checked_at: i64) -> Preview {
        Preview {
            song_key: song_key(track),
            deezer_id: Some(1),
            fingerprint: measured.then(|| Fingerprint {
                song_key: song_key(track),
                energy: 0.6,
                dynamics: 0.2,
                brightness: 0.5,
                tempo: Some(120.0),
                tempo_confidence: 0.9,
                intro_energy: 0.6,
                outro_energy: 0.6,
                listened_ms: 30_000,
                measured_at: checked_at,
                edges: false,
            }),
            deezer_bpm: None,
            deezer_gain: None,
            checked_at,
        }
    }

    #[test]
    fn another_release_of_the_same_song_shares_its_preview() {
        let store = PreviewStore::default();
        let single = test_track("spotify:track:single", "a", "single", 200_000);
        let mut album = single.clone();
        album.uri = "spotify:track:album".into();
        store.insert(single.uri.clone(), preview(&single, true, 0));
        assert!(store.get(&album).is_some());
        assert_eq!(store.lookup([&album]).len(), 1);
        assert_eq!(store.measured(), 1);
    }

    #[test]
    fn misses_are_retried_only_after_a_month() {
        let store = PreviewStore::default();
        let track = test_track("spotify:track:a", "a", "a", 200_000);
        assert!(store.needs_check(&track, 0));
        store.insert(track.uri.clone(), preview(&track, false, 0));
        assert!(!store.needs_check(&track, RETRY_AFTER_S - 1));
        assert!(store.needs_check(&track, RETRY_AFTER_S));
        assert!(store.lookup([&track]).is_empty());

        store.insert(track.uri.clone(), preview(&track, true, 0));
        assert!(!store.needs_check(&track, RETRY_AFTER_S * 10));
    }

    #[test]
    fn the_oldest_entries_make_way() {
        let mut entries = Entries::default();
        for index in 0..MAX_ENTRIES + 2 {
            let track = test_track(&format!("spotify:track:{index}"), "a", "a", 1);
            entries.insert(track.uri.clone(), preview(&track, false, index as i64));
        }
        assert_eq!(entries.by_uri.len(), MAX_ENTRIES);
        assert!(!entries.by_uri.contains_key("spotify:track:0"));
        assert!(!entries.by_uri.contains_key("spotify:track:1"));
    }

    #[test]
    fn stored_previews_round_trip() {
        let track = test_track("spotify:track:a", "a", "a", 200_000);
        let stored = Stored {
            version: PREVIEW_VERSION,
            entries: HashMap::from([(track.uri.clone(), preview(&track, true, 5))]),
        };
        let text = serde_json::to_string(&stored).unwrap();
        let back: Stored = serde_json::from_str(&text).unwrap();
        assert_eq!(back.entries, stored.entries);
    }
}
