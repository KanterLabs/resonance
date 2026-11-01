use super::*;
use crate::config::Config;
use crate::events::EventManager;
use crate::library::Library;
use crate::model::track::Track;
use crate::spotify::Spotify;

pub(super) fn track(id: usize) -> Track {
    let id = id.to_string();
    Track {
        id: Some(id.clone()),
        uri: format!("spotify:track:test-{id}"),
        title: format!("Test {id}"),
        track_number: 1,
        disc_number: 1,
        duration: 180_000,
        artists: vec!["Test artist".to_string()],
        artist_ids: vec![],
        album: Some("Test album".to_string()),
        album_id: None,
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

pub(super) fn playable(id: usize) -> Playable {
    Playable::Track(track(id))
}

pub(super) fn fixture(tracks: Vec<Playable>, current: Option<usize>) -> (Queue, Spotify) {
    let config = Config::new_for_test();
    let events = EventManager::new_for_test();
    let spotify = Spotify::new_for_test(config.clone(), events.clone());
    let library = Library::new_for_test(events, spotify.clone(), config.clone());
    (
        Queue::new_for_test(tracks, current, spotify.clone(), config, library),
        spotify,
    )
}

pub(super) fn uri(id: usize) -> String {
    track(id).uri
}

pub(super) fn radio_batch(start: usize, count: usize) -> Vec<Playable> {
    (start..start + count).map(playable).collect()
}

pub(super) fn alternate_release(id: usize, uri_id: &str) -> Playable {
    let mut track = track(id);
    track.id = Some(uri_id.to_string());
    track.uri = format!("spotify:track:{uri_id}");
    Playable::Track(track)
}
