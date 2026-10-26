//! Arcs: playlists built from a listening journey. See `doc/playlist-builder.md`.
//!
//! The solver is pure; this module owns the one draft being edited, the pool it was drawn
//! from, and the small file of recipes and playlists arcs have created.

pub mod audition;
pub mod deezer;
pub mod fingerprint;
pub mod offline;
pub mod preview;
pub mod recipe;
mod report;
pub mod sampler;
pub mod solve;
pub mod transition;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::library::Library;
use crate::model::track::Track;
use crate::queue::Queue;
use crate::recommendations::{self, engine::song_key, history};
use recipe::{Pin, Recipe};
pub use report::offline_report;
use solve::{Draft, Pool, PoolInput, Slot};

#[cfg_attr(test, allow(dead_code))]
const STORE_VERSION: u16 = 1;
#[cfg(not(test))]
const STORE_FILE: &str = "arcs.json";
const MAX_SAVED: usize = 50;

/// A playlist an arc created. Re-saving an arc may only overwrite one of these.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedArc {
    pub playlist_id: String,
    pub name: String,
    pub recipe: Recipe,
    pub saved_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    version: u16,
    #[serde(default)]
    last: Option<Recipe>,
    #[serde(default)]
    saved: Vec<SavedArc>,
}

/// The arc being edited.
pub struct Active {
    pub recipe: Recipe,
    pub pool: Pool,
    pub draft: Draft,
    /// The playlist this arc was last saved to, if any.
    pub playlist_id: Option<String>,
}

#[derive(Default)]
pub struct Service {
    active: Mutex<Option<Active>>,
    stored: Mutex<Option<Stored>>,
}

pub fn service() -> &'static Service {
    static SERVICE: OnceLock<Service> = OnceLock::new();
    SERVICE.get_or_init(Service::default)
}

/// Gather the pool for a recipe from what is already cached, and ask for the candidates that
/// have not been played to be measured from previews before anything else.
pub fn pool(queue: &Queue, library: &Library, seeds: &[Track], discovery: u8) -> Pool {
    let catalog = recommendations::catalog(queue, library);
    let history = history::shared();
    let measured = Measurements::of(catalog.tracks.iter().chain(seeds));
    let pool = Pool::build(&PoolInput {
        catalog: &catalog,
        seeds,
        discovery,
        feedback: &history.snapshot(),
        recent: &history.recent(),
        fingerprints: &measured.fingerprints,
        library_energies: &measured.energies,
        previews: &measured.previews,
        heard: &measured.heard,
    });
    if preview::queue::enabled(library) {
        let mut wanted: Vec<_> = pool
            .candidates
            .iter()
            .filter(|candidate| {
                !matches!(
                    candidate.measure,
                    solve::Measure::Measured | solve::Measure::Previewed
                )
            })
            .collect();
        wanted.sort_by(|a, b| b.seed.cmp(&a.seed).then(b.affinity.total_cmp(&a.affinity)));
        preview::queue::shared().enqueue(
            wanted.into_iter().map(|candidate| candidate.track.clone()),
            preview::queue::Priority::Urgent,
        );
    }
    pool
}

/// Everything measured about a set of tracks, in the shape the solver takes.
struct Measurements {
    fingerprints: HashMap<String, fingerprint::Fingerprint>,
    previews: HashMap<String, fingerprint::Fingerprint>,
    heard: HashMap<String, f64>,
    /// Every listened raw energy, for normalizing against the library.
    energies: Vec<f32>,
}

impl Measurements {
    fn of<'a>(tracks: impl Iterator<Item = &'a Track> + Clone) -> Self {
        let store = fingerprint::shared();
        let fingerprints = store.lookup(tracks.clone());
        let previews = preview::shared();
        let unplayed = tracks
            .clone()
            .filter(|track| !fingerprints.contains_key(&track.uri));
        let previews = previews
            .calibration(&store)
            .apply_all(previews.lookup(unplayed));
        let heard = heard_energy(tracks, &fingerprints);
        Self {
            fingerprints,
            previews,
            heard,
            energies: store.energies(),
        }
    }
}

/// Loudness the waveform learned for tracks without a fingerprint. Streamed audio is loudness
/// normalized, so heard levels sit between roughly 0.4 and 0.95; that band is stretched onto
/// the 0 to 1 energy scale directly rather than ranked, which would exaggerate small gaps.
fn heard_energy<'a>(
    tracks: impl IntoIterator<Item = &'a Track>,
    fingerprints: &HashMap<String, fingerprint::Fingerprint>,
) -> HashMap<String, f64> {
    const QUIET: f32 = 0.4;
    const LOUD: f32 = 0.95;
    let waveforms = crate::waveform::shared();
    tracks
        .into_iter()
        .filter(|track| !fingerprints.contains_key(&track.uri))
        .filter_map(|track| {
            let level = waveforms.loudness(track.id.as_deref()?)?;
            let energy = ((level - QUIET) / (LOUD - QUIET)).clamp(0.0, 1.0);
            Some((track.uri.clone(), f64::from(energy)))
        })
        .collect()
}

fn rebuild(active: &mut Active, uris: &[String]) {
    let mut notes: Vec<String> = active
        .draft
        .notes
        .iter()
        .filter(|note| !note.starts_with("most tracks"))
        .cloned()
        .collect();
    let mut draft = solve::assemble(&active.pool, &active.recipe, uris, &active.draft.targets);
    notes.append(&mut draft.notes);
    draft.notes = notes;
    active.draft = draft;
}

fn uris(draft: &Draft) -> Vec<String> {
    draft
        .slots
        .iter()
        .map(|slot| slot.track.uri.clone())
        .collect()
}

impl Service {
    /// Build a fresh draft, keeping the saved playlist when the same arc is rebuilt.
    pub fn build(&self, pool: Pool, recipe: Recipe) -> Draft {
        let draft = solve::solve(&pool, &recipe);
        let mut active = self.active.lock().unwrap();
        let playlist_id = active.take().and_then(|previous| previous.playlist_id);
        *active = Some(Active {
            recipe: recipe.clone(),
            pool,
            draft: draft.clone(),
            playlist_id,
        });
        drop(active);
        self.with_store(|stored| stored.last = Some(recipe));
        draft
    }

    pub fn with_active<T>(
        &self,
        action: impl FnOnce(&mut Active) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut active = self.active.lock().unwrap();
        let active = active
            .as_mut()
            .ok_or_else(|| "Build an arc first".to_string())?;
        action(active)
    }

    pub fn active_snapshot(&self) -> Option<(Recipe, Draft, Option<String>)> {
        self.active.lock().unwrap().as_ref().map(|active| {
            (
                active.recipe.clone(),
                active.draft.clone(),
                active.playlist_id.clone(),
            )
        })
    }

    pub fn alternatives(&self, slot: usize, limit: usize) -> Result<Vec<Slot>, String> {
        self.with_active(|active| {
            check_slot(&active.draft, slot)?;
            Ok(solve::alternatives(
                &active.pool,
                &active.recipe,
                &active.draft,
                slot,
                limit,
            ))
        })
    }

    pub fn choose(&self, slot: usize, uri: &str) -> Result<Draft, String> {
        self.with_active(|active| {
            check_slot(&active.draft, slot)?;
            if active.pool.get(uri).is_none() {
                return Err("That track is not in this arc's pool".into());
            }
            let mut sequence = uris(&active.draft);
            let replaced = std::mem::replace(&mut sequence[slot], uri.to_string());
            // A track picked by hand is kept where it was put, so later rebuilds keep it.
            active
                .recipe
                .pins
                .retain(|pin| pin.uri != replaced && pin.uri != uri);
            active.recipe.pins.push(Pin {
                uri: uri.to_string(),
                slot: Some(slot),
            });
            rebuild(active, &sequence);
            Ok(active.draft.clone())
        })
    }

    pub fn pin(&self, slot: usize, pinned: bool) -> Result<Draft, String> {
        self.with_active(|active| {
            check_slot(&active.draft, slot)?;
            let uri = active.draft.slots[slot].track.uri.clone();
            active.recipe.pins.retain(|pin| pin.uri != uri);
            if pinned {
                active.recipe.pins.push(Pin {
                    uri,
                    slot: Some(slot),
                });
            }
            let sequence = uris(&active.draft);
            rebuild(active, &sequence);
            Ok(active.draft.clone())
        })
    }

    /// Move a track to another slot and keep it there. Other kept tracks keep their tracks,
    /// following them to wherever the move shifted them.
    pub fn move_slot(&self, from: usize, to: usize) -> Result<Draft, String> {
        self.with_active(|active| {
            check_slot(&active.draft, from)?;
            check_slot(&active.draft, to)?;
            if from == to {
                return Ok(active.draft.clone());
            }
            let mut sequence = uris(&active.draft);
            let uri = sequence.remove(from);
            sequence.insert(to, uri.clone());
            active.recipe.pins.retain(|pin| pin.uri != uri);
            for pin in &mut active.recipe.pins {
                if pin.slot.is_some()
                    && let Some(position) = sequence.iter().position(|item| *item == pin.uri)
                {
                    pin.slot = Some(position);
                }
            }
            active.recipe.pins.push(Pin {
                uri,
                slot: Some(to),
            });
            rebuild(active, &sequence);
            Ok(active.draft.clone())
        })
    }

    /// Whether `recipe` draws from the same pool as the active arc, so it can be restored
    /// without gathering candidates again.
    pub fn same_pool(&self, recipe: &Recipe) -> bool {
        self.active.lock().unwrap().as_ref().is_some_and(|active| {
            active.recipe.seeds == recipe.seeds && active.recipe.discovery == recipe.discovery
        })
    }

    /// Put an arc back exactly as it was: this recipe, these tracks, in this order. `pool`
    /// replaces the active pool when the seeds or discovery changed; None keeps it. Tracks
    /// that have since left the pool are dropped.
    pub fn restore(
        &self,
        pool: Option<Pool>,
        recipe: Recipe,
        uris: &[String],
    ) -> Result<Draft, String> {
        let mut guard = self.active.lock().unwrap();
        let (pool, playlist_id) = match (pool, guard.take()) {
            (Some(pool), previous) => (pool, previous.and_then(|active| active.playlist_id)),
            (None, Some(active)) => (active.pool, active.playlist_id),
            (None, None) => return Err("Build an arc first".into()),
        };
        let uris: Vec<String> = uris
            .iter()
            .filter(|uri| pool.get(uri).is_some())
            .cloned()
            .collect();
        let draft = solve::assemble(&pool, &recipe, &uris, &recipe.targets(uris.len()));
        *guard = Some(Active {
            recipe: recipe.clone(),
            pool,
            draft: draft.clone(),
            playlist_id,
        });
        drop(guard);
        self.with_store(|stored| stored.last = Some(recipe));
        Ok(draft)
    }

    /// A track from the active arc's pool, for auditioning without a network request.
    pub fn pool_track(&self, uri: &str) -> Option<Track> {
        let active = self.active.lock().unwrap();
        let candidate = active.as_ref()?.pool.get(uri)?;
        Some(candidate.track.clone())
    }

    /// Ban a slot's track from this arc and fill the slot with the best alternative.
    pub fn ban(&self, slot: usize) -> Result<Draft, String> {
        self.with_active(|active| {
            check_slot(&active.draft, slot)?;
            let track = active.draft.slots[slot].track.clone();
            active.recipe.bans.insert(track.uri.clone());
            let key = song_key(&track);
            if !key.is_empty() {
                active.recipe.bans.insert(key);
            }
            active.recipe.pins.retain(|pin| pin.uri != track.uri);
            active.recipe.seeds.retain(|seed| *seed != track.uri);
            let mut sequence = uris(&active.draft);
            match solve::alternatives(&active.pool, &active.recipe, &active.draft, slot, 1).first()
            {
                Some(replacement) => sequence[slot] = replacement.track.uri.clone(),
                None => {
                    sequence.remove(slot);
                    active.draft.targets.remove(slot);
                }
            }
            rebuild(active, &sequence);
            Ok(active.draft.clone())
        })
    }

    pub fn last_recipe(&self) -> Option<Recipe> {
        self.with_store(|stored| stored.last.clone())
    }

    pub fn saved(&self) -> Vec<SavedArc> {
        self.with_store(|stored| stored.saved.clone())
    }

    /// Whether `playlist_id` is a playlist an arc created, and so may be overwritten.
    pub fn created(&self, playlist_id: &str) -> bool {
        self.with_store(|stored| {
            stored
                .saved
                .iter()
                .any(|saved| saved.playlist_id == playlist_id)
        })
    }

    pub fn record_save(&self, playlist_id: String, name: String, recipe: Recipe, saved_at: i64) {
        if let Some(active) = self.active.lock().unwrap().as_mut() {
            active.playlist_id = Some(playlist_id.clone());
        }
        self.with_store(|stored| {
            stored
                .saved
                .retain(|saved| saved.playlist_id != playlist_id);
            stored.saved.insert(
                0,
                SavedArc {
                    playlist_id,
                    name,
                    recipe,
                    saved_at,
                },
            );
            stored.saved.truncate(MAX_SAVED);
        });
    }

    fn with_store<T>(&self, action: impl FnOnce(&mut Stored) -> T) -> T {
        let mut stored = self.stored.lock().unwrap();
        let stored = stored.get_or_insert_with(load);
        let before = serde_json::to_string(&*stored).ok();
        let result = action(stored);
        if serde_json::to_string(&*stored).ok() != before {
            save(stored);
        }
        result
    }
}

fn check_slot(draft: &Draft, slot: usize) -> Result<(), String> {
    if slot < draft.slots.len() {
        Ok(())
    } else {
        Err(format!("slot {slot} is outside this arc"))
    }
}

#[cfg(test)]
fn load() -> Stored {
    Stored::default()
}

#[cfg(test)]
fn save(_: &Stored) {}

#[cfg(not(test))]
fn load() -> Stored {
    let path = crate::config::cache_path(STORE_FILE);
    let Ok(file) = std::fs::File::open(&path) else {
        return Stored {
            version: STORE_VERSION,
            ..Stored::default()
        };
    };
    match serde_json::from_reader::<_, Stored>(std::io::BufReader::new(file)) {
        Ok(stored) if stored.version == STORE_VERSION => stored,
        Ok(_) => Stored {
            version: STORE_VERSION,
            ..Stored::default()
        },
        Err(error) => {
            log::error!("could not read saved arcs: {error}");
            Stored {
                version: STORE_VERSION,
                ..Stored::default()
            }
        }
    }
}

#[cfg(not(test))]
fn save(stored: &Stored) {
    use std::io::Write;
    let path = crate::config::cache_path(STORE_FILE);
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        let stored = Stored {
            version: STORE_VERSION,
            last: stored.last.clone(),
            saved: stored.saved.clone(),
        };
        serde_json::to_writer(&mut file, &stored)?;
        file.flush()?;
        std::fs::rename(&temp, &path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        log::error!("could not write saved arcs: {error}");
    }
}

#[cfg(test)]
pub fn test_track(uri: &str, artist: &str, album: &str, duration: u32) -> Track {
    Track {
        id: Some(uri.rsplit(':').next().unwrap_or(uri).to_string()),
        uri: uri.to_string(),
        title: format!("Song {uri}"),
        track_number: 1,
        disc_number: 1,
        duration,
        artists: vec![format!("Artist {artist}")],
        artist_ids: vec![artist.to_string()],
        album: Some(format!("Album {album}")),
        album_id: Some(album.to_string()),
        album_artists: vec![],
        cover_url: None,
        url: String::new(),
        added_at: None,
        list_index: 0,
        is_local: false,
        is_playable: Some(true),
        isrc: None,
    }
}
