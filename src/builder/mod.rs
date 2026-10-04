//! Arcs: playlists built from a listening journey. See `doc/playlist-builder.md`.
//!
//! The solver is pure; this module owns the one draft being edited, the pool it was drawn
//! from, and the small file of recipes and playlists arcs have created.

pub mod fingerprint;
pub mod recipe;
pub mod solve;
pub mod transition;

#[cfg(test)]
mod tests;

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::library::Library;
use crate::model::track::Track;
use crate::queue::Queue;
use crate::recommendations::{self, engine::song_key, history};
use recipe::{Pin, Recipe};
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

/// Gather the pool for a recipe from what is already cached.
pub fn pool(queue: &Queue, library: &Library, seeds: &[Track], discovery: u8) -> Pool {
    let catalog = recommendations::catalog(queue, library);
    let history = history::shared();
    let feedback = history.snapshot();
    let recent = history.recent();
    let store = fingerprint::shared();
    let fingerprints = store.lookup(catalog.tracks.iter().chain(seeds));
    let energies = store.energies();
    Pool::build(&PoolInput {
        catalog: &catalog,
        seeds,
        discovery,
        feedback: &feedback,
        recent: &recent,
        fingerprints: &fingerprints,
        library_energies: &energies,
    })
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
            active.recipe.pins.retain(|pin| pin.uri != replaced);
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
    }
}
