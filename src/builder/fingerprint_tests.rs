//! Tests for the fingerprint store: commit rules, replacement, reuse, and eviction.
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
