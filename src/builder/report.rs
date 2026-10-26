//! `resonance arcs-debug`: an arc built from the cache without logging in, described in text.

use super::Measurements;
use super::recipe::{self, Recipe};
use super::solve::{self, Pool, PoolInput};
use super::{fingerprint, recommendations};
use crate::recommendations::history;

/// Build an arc from the cache without logging in and describe it, for `arcs-debug`.
pub fn offline_report(
    seeds: Vec<String>,
    preset: Option<String>,
    tracks: usize,
    discovery: u8,
    rng_seed: u64,
) -> Result<String, String> {
    use std::fmt::Write;
    let catalog = recommendations::offline_catalog()?;
    let find = |wanted: &str| {
        catalog
            .tracks
            .iter()
            .find(|track| track.uri == wanted || track.id.as_deref() == Some(wanted))
            .cloned()
            .ok_or_else(|| format!("Seed {wanted} isn't in the local catalog"))
    };
    let seeds = if seeds.is_empty() {
        vec![
            catalog
                .tracks
                .iter()
                .find(|track| !track.is_local && track.id.is_some())
                .cloned()
                .ok_or("No cached songs; play or search for music first")?,
        ]
    } else {
        seeds
            .iter()
            .map(|seed| find(seed))
            .collect::<Result<Vec<_>, _>>()?
    };
    let preset = match preset {
        Some(id) => recipe::Preset::from_id(&id).ok_or_else(|| {
            let known: Vec<_> = recipe::Preset::ALL.iter().map(|p| p.id()).collect();
            format!("Unknown preset {id}; choose one of {}", known.join(", "))
        })?,
        None => recipe::Preset::RiseAndFall,
    };
    let mut recipe = Recipe {
        seeds: seeds.iter().map(|track| track.uri.clone()).collect(),
        curve: preset.curve(),
        length: recipe::Length::Tracks(tracks),
        discovery,
        rng_seed,
        preset: Some(preset.id().to_string()),
        ..Recipe::default()
    };
    recipe.normalize()?;
    let history = history::shared();
    let measured = Measurements::of(catalog.tracks.iter().chain(&seeds));
    let pool = Pool::build(&PoolInput {
        catalog: &catalog,
        seeds: &seeds,
        discovery: recipe.discovery,
        feedback: &history.snapshot(),
        recent: &history.recent(),
        fingerprints: &measured.fingerprints,
        library_energies: &measured.energies,
        previews: &measured.previews,
        heard: &measured.heard,
    });
    let started = std::time::Instant::now();
    let draft = solve::solve(&pool, &recipe);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} arc from {} · {} tracks · pool {} of {} cached · {} fingerprinted · {} previewed · {} heard · confidence {:.0}% · {} ms",
        preset.label(),
        seeds[0].title,
        draft.slots.len(),
        pool.len(),
        catalog.tracks.len(),
        fingerprint::shared().len(),
        measured.previews.len(),
        measured.heard.len(),
        draft.confidence * 100.0,
        started.elapsed().as_millis()
    );
    for note in &draft.notes {
        let _ = writeln!(out, "note: {note}");
    }
    for (index, slot) in draft.slots.iter().enumerate() {
        let _ = writeln!(
            out,
            "{:>2}. target {:.2} energy {:.2} {:<10} {} — {}  [{}]",
            index + 1,
            slot.target,
            slot.energy,
            format!("{:?}", slot.measure).to_lowercase(),
            slot.track.title,
            slot.track.artists.join(", "),
            slot.reasons.join("; ")
        );
    }
    Ok(out)
}
