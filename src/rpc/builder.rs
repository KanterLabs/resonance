//! `builder.*` methods: build, edit, play and save arcs.
use super::{Result, RpcService, fail, invalid, number, remote, string};
use crate::builder::{
    self, fingerprint,
    recipe::{Preset, Recipe},
    solve::{Draft, Pool, Slot},
};
use crate::model::{playable::Playable, track::Track};
use crate::traits::ListItem;
use serde_json::{Value, json};
use std::collections::HashSet;

const DESCRIPTION: &str = "Built with Resonance Arcs";
const ALTERNATIVES: usize = 5;

fn slot(index: usize, slot: &Slot) -> Value {
    json!({
        "slot": index,
        "uri": slot.track.uri,
        "title": slot.track.title,
        "artists": slot.track.artists,
        "album": slot.track.album,
        "duration_ms": slot.track.duration,
        "target": round(slot.target),
        "energy": round(slot.energy),
        "measure": slot.measure,
        "tempo": slot.tempo,
        "score": round(slot.score),
        "affinity": round(slot.affinity),
        "curve_fit": round(slot.curve_fit),
        "transition": round(slot.transition),
        "penalty": round(slot.penalty),
        "reasons": slot.reasons,
        "pinned": slot.pinned,
        "seed": slot.seed,
    })
}

fn round(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn draft(draft: &Draft, recipe: &Recipe, playlist_id: Option<&str>) -> Value {
    json!({
        "recipe": recipe,
        "slots": draft.slots.iter().enumerate().map(|(i, s)| slot(i, s)).collect::<Vec<_>>(),
        "targets": draft.targets.iter().copied().map(round).collect::<Vec<_>>(),
        "confidence": draft.confidence,
        "measured": draft.measured,
        "previewed": draft.previewed,
        "heard": draft.heard,
        "estimated": draft.estimated,
        "unmeasured": draft.unmeasured,
        "pool_size": draft.pool_size,
        "duration_ms": draft.duration_ms,
        "notes": draft.notes,
        "playlist_id": playlist_id,
    })
}

fn presets() -> Value {
    Preset::ALL
        .iter()
        .map(|preset| json!({"id": preset.id(), "label": preset.label(), "curve": preset.curve()}))
        .collect()
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn rejected(message: String) -> super::Error {
    fail("arc_error", message)
}

pub(super) fn dispatch(rpc: &RpcService, method: &str, p: &Value) -> Result<Value> {
    let service = builder::service();
    match method {
        "builder.state" => {
            let active = service.active_snapshot();
            let recipe = active
                .as_ref()
                .map(|(recipe, _, _)| recipe.clone())
                .or_else(|| service.last_recipe())
                .unwrap_or_default();
            Ok(json!({
                "presets": presets(),
                "recipe": recipe,
                "draft": active.as_ref().map(|(recipe, d, id)| draft(d, recipe, id.as_deref())),
                "fingerprinted": fingerprint::shared().len(),
                "current": rpc.queue.get_current().and_then(|p| p.track()).map(|t| seed_row(&t)),
                "seeds": recipe.seeds.iter().filter_map(|uri| cached_track(rpc, uri)).map(|t| seed_row(&t)).collect::<Vec<_>>(),
                "saved": service.saved().iter().map(|saved| json!({"playlist_id": saved.playlist_id, "name": saved.name, "saved_at": saved.saved_at})).collect::<Vec<_>>(),
            }))
        }
        "builder.coverage" => {
            let catalog = crate::recommendations::catalog(&rpc.queue, &rpc.library);
            let store = fingerprint::shared();
            let unique: HashSet<&str> = catalog.tracks.iter().map(|t| t.uri.as_str()).collect();
            let measured = store.lookup(catalog.tracks.iter());
            let previews = builder::preview::shared();
            let unplayed = catalog
                .tracks
                .iter()
                .filter(|track| !measured.contains_key(&track.uri));
            Ok(json!({
                "fingerprinted": store.len(),
                "previewed": previews.measured(),
                "catalog_measured": measured.len(),
                "catalog_previewed": previews.lookup(unplayed).len(),
                "catalog_tracks": unique.len(),
                "preview_lookup": builder::preview::queue::enabled(&rpc.library),
                "preview_pending": builder::preview::queue::shared().pending(),
            }))
        }
        "builder.build" => {
            let recipe = parse_recipe(rpc, p)?;
            let pool = arc_pool(rpc, &recipe)?;
            let built = service.build(pool, recipe.clone());
            let playlist_id = service.active_snapshot().and_then(|(_, _, id)| id);
            Ok(draft(&built, &recipe, playlist_id.as_deref()))
        }
        "builder.restore" => {
            let recipe = parse_recipe(rpc, p)?;
            let uris: Vec<String> = p
                .get("uris")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("uris required"))?
                .iter()
                .filter_map(|uri| uri.as_str().map(str::to_string))
                .collect();
            let pool = if service.same_pool(&recipe) {
                None
            } else {
                Some(arc_pool(rpc, &recipe)?)
            };
            service.restore(pool, recipe, &uris).map_err(rejected)?;
            active_draft()
        }
        "builder.move" => {
            let from = number(p, "from", 0, usize::MAX)?;
            let to = number(p, "to", 0, usize::MAX)?;
            service.move_slot(from, to).map_err(rejected)?;
            active_draft()
        }
        "builder.audition" => {
            let uri = string(p, "uri")?;
            let track = match service.pool_track(uri) {
                Some(track) => track,
                None => seed_track(rpc, uri)?,
            };
            let length = builder::audition::start(&rpc.queue, track).map_err(rejected)?;
            Ok(json!({"uri": uri, "ends_in_ms": length.as_millis() as u64}))
        }
        "builder.audition_stop" => Ok(json!({
            "stopped": builder::audition::stop(&rpc.queue.get_spotify())
        })),
        "builder.reroll" => {
            let index = number(p, "slot", 0, usize::MAX)?;
            let options = service
                .alternatives(index, ALTERNATIVES)
                .map_err(rejected)?;
            Ok(
                json!({"slot": index, "alternatives": options.iter().map(|s| slot(index, s)).collect::<Vec<_>>()}),
            )
        }
        "builder.choose" => {
            let index = number(p, "slot", 0, usize::MAX)?;
            let uri = string(p, "uri")?;
            service.choose(index, uri).map_err(rejected)?;
            active_draft()
        }
        "builder.pin" => {
            let index = number(p, "slot", 0, usize::MAX)?;
            let pinned = p.get("pinned").and_then(Value::as_bool).unwrap_or(true);
            service.pin(index, pinned).map_err(rejected)?;
            active_draft()
        }
        "builder.ban" => {
            let index = number(p, "slot", 0, usize::MAX)?;
            service.ban(index).map_err(rejected)?;
            active_draft()
        }
        "builder.play" => {
            let (_, built, _) = service
                .active_snapshot()
                .ok_or_else(|| fail("not_ready", "Build an arc first"))?;
            let tracks = playables(&built);
            if tracks.is_empty() {
                return Err(fail("empty_context", "This arc has no tracks"));
            }
            // Starting part way through plays the rest of the arc from that track.
            let start = number(p, "slot", 0, usize::MAX)?;
            let tracks = tracks
                .get(start..)
                .filter(|rest| !rest.is_empty())
                .ok_or_else(|| invalid("slot is outside this arc"))?;
            rpc.queue.rpc_append_play_many(tracks);
            Ok(json!({"queued": tracks.len(), "slot": start}))
        }
        "builder.save" => save_arc(rpc, p),
        _ => Err(fail("unknown_method", format!("Unknown method {method}"))),
    }
}

/// The recipe in `p`, brought into range, seeded from the playing song when it has no seeds.
fn parse_recipe(rpc: &RpcService, p: &Value) -> Result<Recipe> {
    let mut recipe: Recipe = match p.get("recipe") {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| invalid(format!("invalid recipe: {error}")))?,
        None => Recipe::default(),
    };
    if recipe.seeds.is_empty()
        && let Some(current) = rpc.queue.get_current().and_then(|p| p.track())
        && !current.is_local
    {
        recipe.seeds.push(current.uri.clone());
    }
    recipe.normalize().map_err(invalid)?;
    if recipe.seeds.is_empty() {
        return Err(fail(
            "not_ready",
            "Play a song or add a seed to build an arc",
        ));
    }
    Ok(recipe)
}

/// The candidates an arc with this recipe draws from, gathered from the cache.
fn arc_pool(rpc: &RpcService, recipe: &Recipe) -> Result<Pool> {
    let seeds = recipe
        .seeds
        .iter()
        .map(|uri| seed_track(rpc, uri))
        .collect::<Result<Vec<_>>>()?;
    let pool = builder::pool(&rpc.queue, &rpc.library, &seeds, recipe.discovery);
    if pool.len() < 2 {
        return Err(fail(
            "empty_pool",
            "Not enough cached tracks near these seeds yet; browse or play more music",
        ));
    }
    Ok(pool)
}

fn active_draft() -> Result<Value> {
    let (recipe, built, id) = builder::service()
        .active_snapshot()
        .ok_or_else(|| fail("not_ready", "Build an arc first"))?;
    Ok(draft(&built, &recipe, id.as_deref()))
}

fn save_arc(rpc: &RpcService, p: &Value) -> Result<Value> {
    let service = builder::service();
    let (recipe, built, playlist_id) = service
        .active_snapshot()
        .ok_or_else(|| fail("not_ready", "Build an arc first"))?;
    let tracks = playables(&built);
    if tracks.is_empty() {
        return Err(fail("empty_context", "This arc has no tracks"));
    }
    let name = string(p, "name")?.trim();
    if name.is_empty() {
        return Err(invalid("name required"));
    }
    let public = p.get("public").and_then(Value::as_bool).unwrap_or(false);
    let overwrite = p.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
    let api = rpc.queue.get_spotify().api;
    let (id, overwritten) = match playlist_id.filter(|id| overwrite && service.created(id)) {
        Some(id) => {
            api.overwrite_playlist(&id, &tracks);
            if let Err(()) = api.rename_playlist(&id, name) {
                log::warn!("arc playlist {id} kept its previous name");
            }
            (id, true)
        }
        None => {
            if rpc.library.user_id().is_none() {
                return Err(fail("not_ready", "User identity is loading"));
            }
            let id = remote(api.create_playlist(name, Some(public), Some(DESCRIPTION)))?;
            for chunk in tracks.chunks(100) {
                remote(api.append_tracks(&id, chunk, None))?;
            }
            (id, false)
        }
    };
    service.record_save(id.clone(), name.to_string(), recipe, now_seconds());
    rpc.library.update_library();
    Ok(
        json!({"id": id, "uri": format!("spotify:playlist:{id}"), "overwritten": overwritten, "tracks": tracks.len()}),
    )
}

/// A seed from the cache when possible, so building stays offline.
fn seed_track(rpc: &RpcService, uri: &str) -> Result<Track> {
    if let Some(track) = cached_track(rpc, uri) {
        return Ok(track);
    }
    let track = rpc
        .resolve(uri)?
        .track()
        .ok_or_else(|| invalid("arc seeds must be tracks"))?;
    if track.is_local || track.id.is_none() {
        return Err(invalid("arc seeds must be Spotify tracks"));
    }
    Ok(track)
}

fn cached_track(rpc: &RpcService, uri: &str) -> Option<Track> {
    let current = rpc.queue.get_current().and_then(|p| p.track());
    current
        .filter(|track| track.uri == uri)
        .or_else(|| super::cached_radio_seed_track(&rpc.queue, &rpc.library, Some(uri)))
        .or_else(|| {
            crate::recommendations::catalog(&rpc.queue, &rpc.library)
                .tracks
                .into_iter()
                .find(|track| track.uri == uri)
        })
}

fn seed_row(track: &Track) -> Value {
    json!({"uri": track.uri, "title": track.title, "artists": track.artists})
}

fn playables(draft: &Draft) -> Vec<Playable> {
    draft
        .slots
        .iter()
        .map(|slot| Playable::Track(slot.track.clone()))
        .collect()
}
