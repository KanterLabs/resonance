use std::collections::{HashMap, HashSet};

use super::fingerprint::Fingerprint;
use super::recipe::{CurvePoint, Length, Pin, Preset, Recipe, sample};
use super::solve::{Measure, Pool, PoolInput, alternatives, solve};
use super::test_track;
use crate::model::track::Track;
use crate::recommendations::engine::Catalog;

const ARTISTS: usize = 12;
const PER_ARTIST: usize = 8;

struct Fixture {
    catalog: Catalog,
    seed: Track,
    fingerprints: HashMap<String, Fingerprint>,
}

fn fingerprint(energy: f32, tempo: Option<f32>) -> Fingerprint {
    Fingerprint {
        song_key: String::new(),
        energy,
        dynamics: 0.2,
        brightness: energy,
        tempo,
        tempo_confidence: 0.9,
        intro_energy: energy,
        outro_energy: energy,
        listened_ms: 60_000,
        measured_at: 0,
        edges: true,
    }
}

/// Twelve artists with eight songs each, all sharing playlists with the seed, and energies
/// spread evenly from quiet to loud.
fn fixture(measured: bool) -> Fixture {
    let mut tracks = Vec::new();
    let mut fingerprints = HashMap::new();
    for artist in 0..ARTISTS {
        for song in 0..PER_ARTIST {
            let index = artist * PER_ARTIST + song;
            let track = test_track(
                &format!("spotify:track:t{index:03}"),
                &format!("a{artist}"),
                &format!("al{artist}-{}", song / 4),
                200_000 + (index as u32 % 7) * 10_000,
            );
            if measured {
                let energy = ((index * 37) % 96) as f32 / 95.0;
                fingerprints.insert(
                    track.uri.clone(),
                    fingerprint(energy, Some(80.0 + (index % 9) as f32 * 8.0)),
                );
            }
            tracks.push(track);
        }
    }
    let seed = tracks[0].clone();
    let uris: Vec<String> = tracks.iter().map(|track| track.uri.clone()).collect();
    let playlists = vec![
        uris.iter().step_by(2).cloned().collect(),
        uris.iter()
            .skip(1)
            .step_by(2)
            .cloned()
            .chain([seed.uri.clone()])
            .collect(),
        uris.clone(),
    ];
    Fixture {
        catalog: Catalog {
            saved: uris.iter().take(20).cloned().collect(),
            tracks,
            playlists,
            artist_genres: HashMap::new(),
            familiar_artists: HashSet::new(),
        },
        seed,
        fingerprints,
    }
}

fn pool_for(fixture: &Fixture) -> Pool {
    let energies: Vec<f32> = fixture
        .fingerprints
        .values()
        .map(|found| found.energy)
        .collect();
    Pool::build(&PoolInput {
        catalog: &fixture.catalog,
        seeds: std::slice::from_ref(&fixture.seed),
        discovery: 30,
        feedback: &HashMap::new(),
        recent: &[],
        fingerprints: &fixture.fingerprints,
        library_energies: &energies,
        previews: &HashMap::new(),
        heard: &HashMap::new(),
    })
}

fn recipe(fixture: &Fixture) -> Recipe {
    Recipe {
        seeds: vec![fixture.seed.uri.clone()],
        length: Length::Tracks(16),
        ..Recipe::default()
    }
}

fn uris(draft: &super::solve::Draft) -> Vec<String> {
    draft
        .slots
        .iter()
        .map(|slot| slot.track.uri.clone())
        .collect()
}

#[test]
fn the_same_inputs_build_the_same_arc() {
    let fixture = fixture(true);
    let recipe = recipe(&fixture);
    let first = solve(&pool_for(&fixture), &recipe);
    let second = solve(&pool_for(&fixture), &recipe);
    assert_eq!(first.slots.len(), 16);
    assert_eq!(uris(&first), uris(&second));
}

#[test]
fn a_measured_library_follows_every_preset_closely() {
    let fixture = fixture(true);
    let pool = pool_for(&fixture);
    for preset in Preset::ALL {
        let recipe = Recipe {
            curve: preset.curve(),
            ..recipe(&fixture)
        };
        let draft = solve(&pool, &recipe);
        let error: f64 = draft
            .slots
            .iter()
            .map(|slot| (slot.energy - slot.target).abs())
            .sum::<f64>()
            / draft.slots.len() as f64;
        assert!(
            error < 0.12,
            "{} drifted from its curve by {error:.3}",
            preset.label()
        );
    }
}

#[test]
fn artists_are_spaced_and_capped() {
    let fixture = fixture(true);
    let draft = solve(&pool_for(&fixture), &recipe(&fixture));
    let artists: Vec<&String> = draft
        .slots
        .iter()
        .map(|slot| &slot.track.artist_ids[0])
        .collect();
    for window in artists.windows(4) {
        let unique: HashSet<_> = window.iter().collect();
        assert_eq!(
            unique.len(),
            4,
            "artist repeated within three slots: {window:?}"
        );
    }
    let cap = 16usize.div_ceil(6);
    for artist in &artists {
        assert!(artists.iter().filter(|other| other == &artist).count() <= cap);
    }
    assert!(
        draft.notes.is_empty(),
        "no relaxation expected: {:?}",
        draft.notes
    );
}

#[test]
fn bans_never_appear_and_pins_keep_their_slot() {
    let fixture = fixture(true);
    let pool = pool_for(&fixture);
    let mut recipe = recipe(&fixture);
    let first = solve(&pool, &recipe);
    let banned = first.slots[3].track.uri.clone();
    let pinned = first.slots[7].track.uri.clone();
    recipe.bans.insert(banned.clone());
    recipe.pins.push(Pin {
        uri: pinned.clone(),
        slot: Some(2),
    });
    let second = solve(&pool, &recipe);
    assert!(!uris(&second).contains(&banned));
    assert_eq!(second.slots[2].track.uri, pinned);
    assert!(second.slots[2].pinned);
    assert_eq!(second.slots[2].reasons[0], "pinned");
}

#[test]
fn the_seed_is_part_of_its_own_arc() {
    let fixture = fixture(true);
    let draft = solve(&pool_for(&fixture), &recipe(&fixture));
    let seed = draft
        .slots
        .iter()
        .find(|slot| slot.track.uri == fixture.seed.uri);
    assert!(seed.is_some_and(|slot| slot.seed));
}

#[test]
fn an_unmeasured_library_still_builds_with_low_confidence() {
    let fixture = fixture(false);
    let draft = solve(&pool_for(&fixture), &recipe(&fixture));
    assert_eq!(draft.slots.len(), 16);
    assert!(
        draft
            .slots
            .iter()
            .all(|slot| slot.measure == Measure::Unmeasured)
    );
    assert!(draft.confidence < 0.5);
    assert!(
        draft
            .notes
            .iter()
            .any(|note| note.contains("still being learned"))
    );
}

#[test]
fn unmeasured_tracks_borrow_energy_from_their_album() {
    let mut fixture = fixture(true);
    let quiet = fixture.catalog.tracks[9].clone();
    let sibling = fixture.catalog.tracks[8].clone();
    fixture.fingerprints.remove(&quiet.uri);
    let pool = pool_for(&fixture);
    let estimated = pool.get(&quiet.uri).expect("in pool");
    assert_eq!(estimated.measure, Measure::Estimated);
    assert!(pool.get(&sibling.uri).is_some());
}

#[test]
fn a_small_library_relaxes_and_says_so() {
    let mut fixture = fixture(true);
    fixture.catalog.tracks.truncate(PER_ARTIST * 2);
    for playlist in &mut fixture.catalog.playlists {
        playlist.retain(|uri| fixture.catalog.tracks.iter().any(|track| &track.uri == uri));
    }
    let draft = solve(
        &pool_for(&fixture),
        &Recipe {
            length: Length::Tracks(10),
            ..recipe(&fixture)
        },
    );
    assert_eq!(draft.slots.len(), 10);
    assert!(!draft.notes.is_empty());
}

#[test]
fn minutes_resolve_to_a_track_count() {
    let fixture = fixture(true);
    let draft = solve(
        &pool_for(&fixture),
        &Recipe {
            length: Length::Minutes(60),
            ..recipe(&fixture)
        },
    );
    let minutes = draft.duration_ms as f64 / 60_000.0;
    assert!((minutes - 60.0).abs() <= 5.0, "{minutes:.1} minutes");
}

#[test]
fn rerolling_offers_other_tracks_for_one_slot_only() {
    let fixture = fixture(true);
    let pool = pool_for(&fixture);
    let recipe = recipe(&fixture);
    let draft = solve(&pool, &recipe);
    let options = alternatives(&pool, &recipe, &draft, 5, 5);
    assert_eq!(options.len(), 5);
    let used: HashSet<String> = uris(&draft).into_iter().collect();
    for option in &options {
        assert!(!used.contains(&option.track.uri));
        for neighbour in [3, 4, 6, 7] {
            assert_ne!(
                option.track.artist_ids,
                draft.slots[neighbour].track.artist_ids
            );
        }
    }
}

#[test]
fn curves_never_overshoot_their_points() {
    let points = vec![
        CurvePoint {
            x: 0.0,
            energy: 0.1,
        },
        CurvePoint {
            x: 0.5,
            energy: 0.9,
        },
        CurvePoint {
            x: 1.0,
            energy: 0.9,
        },
    ];
    for step in 0..=100 {
        let value = sample(&points, step as f64 / 100.0);
        assert!((0.1..=0.9 + 1e-9).contains(&value), "{value} at {step}");
    }
    assert!((sample(&points, 0.5) - 0.9).abs() < 1e-9);
}

#[test]
fn recipes_are_brought_into_range() {
    let mut recipe = Recipe {
        seeds: vec!["a".into(), "a".into()],
        curve: vec![
            CurvePoint {
                x: 1.4,
                energy: -1.0,
            },
            CurvePoint {
                x: 0.0,
                energy: 2.0,
            },
        ],
        length: Length::Tracks(500),
        discovery: 250,
        ..Recipe::default()
    };
    recipe.normalize().unwrap();
    assert_eq!(recipe.seeds, vec!["a".to_string()]);
    assert_eq!(
        recipe.curve[0],
        CurvePoint {
            x: 0.0,
            energy: 1.0
        }
    );
    assert_eq!(
        recipe.curve[1],
        CurvePoint {
            x: 1.0,
            energy: 0.0
        }
    );
    assert_eq!(recipe.length, Length::Tracks(100));
    assert_eq!(recipe.discovery, 100);
    let mut broken = Recipe {
        curve: vec![CurvePoint {
            x: 0.2,
            energy: 0.5,
        }],
        ..Recipe::default()
    };
    assert!(broken.normalize().is_err());
}

#[test]
fn heard_loudness_counts_as_energy_and_reasons_are_plain() {
    let mut fixture = fixture(false);
    let loud = fixture.catalog.tracks[9].uri.clone();
    let energies: Vec<f32> = Vec::new();
    let heard = HashMap::from([(loud.clone(), 0.9)]);
    let pool = Pool::build(&PoolInput {
        catalog: &fixture.catalog,
        seeds: std::slice::from_ref(&fixture.seed),
        discovery: 30,
        feedback: &HashMap::new(),
        recent: &[],
        fingerprints: &fixture.fingerprints,
        library_energies: &energies,
        previews: &HashMap::new(),
        heard: &heard,
    });
    let candidate = pool.get(&loud).expect("in pool");
    assert_eq!(candidate.measure, Measure::Heard);
    assert!((candidate.energy - 0.9).abs() < 1e-9);
    // Songs on the same album borrow the heard energy rather than staying unknown.
    let sibling = &fixture.catalog.tracks[8].uri;
    assert_eq!(pool.get(sibling).unwrap().measure, Measure::Estimated);
    fixture.fingerprints.clear();
    let draft = solve(&pool, &recipe(&fixture));
    for slot in &draft.slots {
        for reason in &slot.reasons {
            assert!(
                !reason.contains("normalized") && !reason.contains("tie-break"),
                "{reason}"
            );
        }
    }
    assert_eq!(
        draft.heard + draft.estimated + draft.measured + draft.unmeasured,
        draft.slots.len()
    );
}

#[test]
fn a_preview_ranks_between_a_listen_and_heard_loudness() {
    let fixture = fixture(false);
    let uri = |index: usize| fixture.catalog.tracks[index].uri.clone();
    let (listened, previewed, heard_only) = (uri(9), uri(17), uri(25));
    let mut preview = fingerprint(0.8, Some(120.0));
    preview.edges = false;
    let fingerprints = HashMap::from([(listened.clone(), fingerprint(0.2, None))]);
    let previews = HashMap::from([
        (listened.clone(), preview.clone()),
        (previewed.clone(), preview.clone()),
    ]);
    let heard = HashMap::from([(previewed.clone(), 0.1), (heard_only.clone(), 0.3)]);
    let pool = Pool::build(&PoolInput {
        catalog: &fixture.catalog,
        seeds: std::slice::from_ref(&fixture.seed),
        discovery: 30,
        feedback: &HashMap::new(),
        recent: &[],
        fingerprints: &fingerprints,
        library_energies: &[],
        previews: &previews,
        heard: &heard,
    });
    let measure = |uri: &str| pool.get(uri).unwrap().measure;
    assert_eq!(measure(&listened), Measure::Measured);
    assert!((pool.get(&listened).unwrap().energy - 0.2).abs() < 1e-6);
    assert_eq!(measure(&previewed), Measure::Previewed);
    assert!((pool.get(&previewed).unwrap().energy - 0.8).abs() < 1e-6);
    assert!(pool.get(&previewed).unwrap().fingerprint.is_some());
    assert_eq!(measure(&heard_only), Measure::Heard);
    // Album mates of a previewed song borrow its energy.
    assert_eq!(measure(&uri(16)), Measure::Estimated);

    let draft = solve(&pool, &recipe(&fixture));
    assert_eq!(
        draft.measured + draft.previewed + draft.heard + draft.estimated + draft.unmeasured,
        draft.slots.len()
    );
    for slot in draft
        .slots
        .iter()
        .filter(|s| s.measure == Measure::Previewed)
    {
        assert!(
            slot.reasons
                .iter()
                .any(|reason| reason.contains("from a preview"))
        );
    }
}
