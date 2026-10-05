//! The shape of each song, learned by listening to it.
//!
//! The background sampler that measures tracks for arcs hands each of its readings here too.
//! A track is cut into `BUCKETS` equal stretches, and each reading is filed under the
//! stretch it came from: how loud it was, and how much bass, middle and treble it had. Once
//! a song has been heard it can be drawn whole, as a skyline, before it plays again. Repeat
//! listens refine it. Only these numbers are kept, never audio.

use std::collections::HashMap;
#[cfg(not(test))]
use std::io::Write;
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::builder::fingerprint::Sample;
use crate::model::track::Track;

/// Stretches per track. A four minute song gets one every 1.2 seconds, fine enough to show
/// a drop and coarse enough that a single listen fills most of them.
pub const BUCKETS: usize = 200;
/// Level, bass, middle and treble.
const LANES: usize = 4;
/// Which of the sampler's 16 log-spaced bands count as bass, middle and treble.
const BASS: Range<usize> = 0..4;
const MIDDLE: Range<usize> = 4..11;
const TREBLE: Range<usize> = 11..16;
/// Songs remembered, the least recently heard forgotten first. About 1.6KB each on disk.
const MAX_ENTRIES: usize = 5_000;
/// A stored map this far off the track's length belongs to a different edit of it.
const DURATION_TOLERANCE_MS: u32 = 2_000;
#[cfg(not(test))]
const CACHE_FILE: &str = "song_maps.json";
#[cfg(not(test))]
const VERSION: u16 = 1;

/// What is known of one song's shape.
#[derive(Clone, Debug, PartialEq)]
pub struct SongMap {
    pub duration_ms: u32,
    /// Per stretch: level, bass, middle and treble from 0 to 255, or None where that
    /// stretch has never been heard.
    pub buckets: Vec<Option<[u8; LANES]>>,
    pub updated_at: i64,
}

impl SongMap {
    fn empty(duration_ms: u32) -> Self {
        Self {
            duration_ms,
            buckets: vec![None; BUCKETS],
            updated_at: 0,
        }
    }

    /// The share of the song that has been heard, 0 to 1.
    pub fn heard(&self) -> f32 {
        self.buckets
            .iter()
            .filter(|bucket| bucket.is_some())
            .count() as f32
            / BUCKETS as f32
    }

    /// Fold a listen in: stretches heard before are averaged with it, new ones taken as heard.
    fn merge(&mut self, listen: &Listen) {
        for (bucket, heard) in self.buckets.iter_mut().zip(listen.means()) {
            let Some(heard) = heard else {
                continue;
            };
            *bucket = Some(match bucket {
                Some(known) => std::array::from_fn(|lane| {
                    (u16::from(known[lane]) + u16::from(heard[lane])).div_ceil(2) as u8
                }),
                None => heard,
            });
        }
    }
}

/// A map as written to disk: every stretch as eight hex digits, or dashes where unheard.
#[derive(Serialize, Deserialize)]
struct StoredMap {
    duration_ms: u32,
    updated_at: i64,
    lanes: String,
}

impl From<&SongMap> for StoredMap {
    fn from(map: &SongMap) -> Self {
        let lanes = map
            .buckets
            .iter()
            .map(|bucket| match bucket {
                Some(values) => values.iter().map(|value| format!("{value:02x}")).collect(),
                None => "-".repeat(LANES * 2),
            })
            .collect();
        Self {
            duration_ms: map.duration_ms,
            updated_at: map.updated_at,
            lanes,
        }
    }
}

impl TryFrom<StoredMap> for SongMap {
    type Error = ();

    fn try_from(stored: StoredMap) -> Result<Self, ()> {
        let width = LANES * 2;
        if stored.lanes.len() != BUCKETS * width || !stored.lanes.is_ascii() {
            return Err(());
        }
        let buckets = (0..BUCKETS)
            .map(|index| {
                let text = &stored.lanes[index * width..(index + 1) * width];
                if text.bytes().all(|byte| byte == b'-') {
                    return Ok(None);
                }
                let mut values = [0u8; LANES];
                for (lane, value) in values.iter_mut().enumerate() {
                    *value =
                        u8::from_str_radix(&text[lane * 2..lane * 2 + 2], 16).map_err(|_| ())?;
                }
                Ok(Some(values))
            })
            .collect::<Result<_, ()>>()?;
        Ok(Self {
            duration_ms: stored.duration_ms,
            buckets,
            updated_at: stored.updated_at,
        })
    }
}

#[cfg(not(test))]
#[derive(Serialize, Deserialize)]
struct Stored {
    version: u16,
    entries: HashMap<String, StoredMap>,
}

/// What has been heard of the playing track so far, stretch by stretch.
struct Listen {
    uri: String,
    duration_ms: u32,
    sums: Vec<[f32; LANES]>,
    counts: Vec<u32>,
}

impl Listen {
    fn new(track: &Track) -> Self {
        Self {
            uri: track.uri.clone(),
            duration_ms: track.duration,
            sums: vec![[0.0; LANES]; BUCKETS],
            counts: vec![0; BUCKETS],
        }
    }

    fn add(&mut self, sample: &Sample) {
        let Some(bands) = sample
            .bands
            .as_deref()
            .filter(|bands| bands.len() >= TREBLE.end)
        else {
            return;
        };
        if self.duration_ms == 0 {
            return;
        }
        let bucket = ((sample.position_ms * BUCKETS as u64) / u64::from(self.duration_ms))
            .min(BUCKETS as u64 - 1) as usize;
        let mean = |range: Range<usize>| {
            let length = range.len() as f32;
            bands[range].iter().sum::<f32>() / length
        };
        let reading = [sample.level, mean(BASS), mean(MIDDLE), mean(TREBLE)];
        for (sum, value) in self.sums[bucket].iter_mut().zip(reading) {
            *sum += value.clamp(0.0, 1.0);
        }
        self.counts[bucket] += 1;
    }

    fn is_empty(&self) -> bool {
        self.counts.iter().all(|count| *count == 0)
    }

    /// The average reading in each stretch, on the stored 0 to 255 scale.
    fn means(&self) -> impl Iterator<Item = Option<[u8; LANES]>> + '_ {
        self.sums.iter().zip(&self.counts).map(|(sums, &count)| {
            (count > 0).then(|| {
                std::array::from_fn(|lane| (sums[lane] / count as f32 * 255.0).round() as u8)
            })
        })
    }
}

/// Every song's map, in memory and on disk, and the listen in progress.
#[derive(Default)]
pub struct SongMapStore {
    entries: RwLock<HashMap<String, SongMap>>,
    listen: Mutex<Option<Listen>>,
}

pub fn shared() -> Arc<SongMapStore> {
    static SHARED: OnceLock<Arc<SongMapStore>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            let store = Arc::new(SongMapStore::default());
            #[cfg(not(test))]
            store.load();
            store
        })
        .clone()
}

impl SongMapStore {
    /// What is known of a track's shape, including what has been heard of it so far if it
    /// is playing now.
    pub fn get(&self, uri: &str, duration_ms: u32) -> SongMap {
        let mut map = self
            .entries
            .read()
            .unwrap()
            .get(uri)
            .filter(|map| map.duration_ms.abs_diff(duration_ms) <= DURATION_TOLERANCE_MS)
            .cloned()
            .unwrap_or_else(|| SongMap::empty(duration_ms));
        if let Some(listen) = self
            .listen
            .lock()
            .unwrap()
            .as_ref()
            .filter(|listen| listen.uri == uri)
        {
            map.merge(listen);
        }
        map
    }

    /// Fold one reading of the playing track in. A change of track files the previous
    /// listen away. Returns true when one was.
    pub fn observe(&self, track: Option<&Track>, sample: Option<&Sample>) -> bool {
        let mut listen = self.listen.lock().unwrap();
        let changed = match (&*listen, track) {
            (Some(current), Some(track)) => current.uri != track.uri,
            (Some(_), None) => true,
            _ => false,
        };
        let mut committed = false;
        if changed && let Some(finished) = listen.take() {
            committed = self.commit(&finished);
        }
        if let Some(track) = track.filter(|track| !track.is_local && track.id.is_some()) {
            let current = listen.get_or_insert_with(|| Listen::new(track));
            if let Some(sample) = sample {
                current.add(sample);
            }
        }
        committed
    }

    /// File away whatever has been heard of the playing track, for shutdown.
    pub fn finish(&self) -> bool {
        let finished = self.listen.lock().unwrap().take();
        finished.is_some_and(|listen| self.commit(&listen))
    }

    fn commit(&self, listen: &Listen) -> bool {
        if listen.is_empty() {
            return false;
        }
        let mut entries = self.entries.write().unwrap();
        let map = entries
            .entry(listen.uri.clone())
            .or_insert_with(|| SongMap::empty(listen.duration_ms));
        if map.duration_ms.abs_diff(listen.duration_ms) > DURATION_TOLERANCE_MS {
            *map = SongMap::empty(listen.duration_ms);
        }
        map.merge(listen);
        map.updated_at = now_seconds();
        if entries.len() > MAX_ENTRIES
            && let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, map)| map.updated_at)
                .map(|(uri, _)| uri.clone())
        {
            entries.remove(&oldest);
        }
        true
    }

    #[cfg(test)]
    pub fn save(&self) {}

    #[cfg(not(test))]
    pub fn save(&self) {
        let path = crate::config::cache_path(CACHE_FILE);
        let stored = Stored {
            version: VERSION,
            entries: self
                .entries
                .read()
                .unwrap()
                .iter()
                .map(|(uri, map)| (uri.clone(), StoredMap::from(map)))
                .collect(),
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
            log::error!("could not write song maps: {error}");
        }
    }

    #[cfg(not(test))]
    fn load(&self) {
        let path = crate::config::cache_path(CACHE_FILE);
        let Ok(file) = std::fs::File::open(&path) else {
            return;
        };
        match serde_json::from_reader::<_, Stored>(std::io::BufReader::new(file)) {
            Ok(stored) if stored.version == VERSION => {
                let mut entries = self.entries.write().unwrap();
                for (uri, map) in stored.entries {
                    if let Ok(map) = SongMap::try_from(map) {
                        entries.insert(uri, map);
                    }
                }
            }
            Ok(_) => log::debug!("ignoring song maps from another version"),
            Err(error) => log::error!("could not read song maps: {error}"),
        }
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

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

    const MINUTE: u32 = 60_000;

    fn track(uri: &str, duration: u32) -> Track {
        crate::builder::test_track(uri, "artist", "album", duration)
    }

    /// A reading at `position_ms` with every band at `bands` and the level at `level`.
    fn sample(position_ms: u64, level: f32, bands: f32) -> Sample {
        Sample {
            level,
            bands: Some(vec![bands; 16]),
            tempo: None,
            position_ms,
            elapsed_ms: 100,
        }
    }

    #[test]
    fn readings_are_filed_under_the_stretch_they_came_from() {
        let store = SongMapStore::default();
        let song = track("spotify:track:a", 4 * MINUTE);
        store.observe(Some(&song), Some(&sample(0, 1.0, 0.5)));
        store.observe(Some(&song), Some(&sample(u64::from(2 * MINUTE), 0.2, 0.0)));

        let map = store.get(&song.uri, song.duration);
        assert_eq!(map.buckets[0], Some([255, 128, 128, 128]));
        assert_eq!(map.buckets[BUCKETS / 2], Some([51, 0, 0, 0]));
        assert_eq!(map.buckets[1], None, "never heard");
        assert!((map.heard() - 2.0 / BUCKETS as f32).abs() < 1e-6);
    }

    #[test]
    fn a_listen_is_kept_when_the_track_changes_and_refined_by_the_next() {
        let store = SongMapStore::default();
        let song = track("spotify:track:a", 4 * MINUTE);
        let other = track("spotify:track:b", 3 * MINUTE);
        store.observe(Some(&song), Some(&sample(0, 1.0, 1.0)));
        assert!(
            store.observe(Some(&other), None),
            "changing track files the listen"
        );

        store.observe(Some(&song), Some(&sample(0, 0.0, 0.0)));
        assert!(store.finish());
        let map = store.get(&song.uri, song.duration);
        // Averaged with what was heard before, not replaced by it.
        assert_eq!(map.buckets[0], Some([128, 128, 128, 128]));
    }

    #[test]
    fn a_different_edit_of_the_track_starts_its_map_over() {
        let store = SongMapStore::default();
        store.observe(
            Some(&track("spotify:track:a", 4 * MINUTE)),
            Some(&sample(0, 1.0, 1.0)),
        );
        store.finish();
        let longer = track("spotify:track:a", 5 * MINUTE);
        assert_eq!(store.get(&longer.uri, longer.duration).heard(), 0.0);

        store.observe(Some(&longer), Some(&sample(0, 0.0, 0.0)));
        store.finish();
        assert_eq!(
            store.get(&longer.uri, longer.duration).buckets[0],
            Some([0, 0, 0, 0])
        );
    }

    #[test]
    fn maps_survive_the_trip_to_disk_and_back() {
        let mut map = SongMap::empty(4 * MINUTE);
        map.buckets[3] = Some([1, 2, 254, 255]);
        map.updated_at = 42;
        let stored = StoredMap::from(&map);
        assert_eq!(stored.lanes.len(), BUCKETS * LANES * 2);
        assert_eq!(&stored.lanes[24..32], "0102feff");
        assert_eq!(SongMap::try_from(stored), Ok(map));

        let broken = StoredMap {
            duration_ms: 1,
            updated_at: 0,
            lanes: "zz".repeat(BUCKETS * LANES),
        };
        assert!(SongMap::try_from(broken).is_err());
    }

    #[test]
    fn local_tracks_and_silence_leave_no_map() {
        let store = SongMapStore::default();
        let mut local = track("spotify:local:a", MINUTE);
        local.is_local = true;
        store.observe(Some(&local), Some(&sample(0, 1.0, 1.0)));
        assert!(!store.finish());

        let quiet = track("spotify:track:q", MINUTE);
        store.observe(Some(&quiet), None);
        assert!(!store.finish(), "nothing was heard");
    }
}
