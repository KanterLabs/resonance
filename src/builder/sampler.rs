//! The background sampler: while a track plays, read the audio tap about ten times a second
//! and hand each reading to the fingerprint store and the song maps.

use std::sync::Arc;
#[cfg(not(test))]
use std::sync::OnceLock;
#[cfg(not(test))]
use std::time::Duration;

#[cfg(not(test))]
use super::fingerprint::{BANDS, Sample};

#[cfg(not(test))]
const SAMPLE_EVERY: Duration = Duration::from_millis(100);

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
            let store = super::fingerprint::shared();
            // Song maps learn from the same readings.
            let maps = crate::song_map::shared();
            loop {
                std::thread::sleep(SAMPLE_EVERY);
                // An audition's audio belongs to a track the queue does not name.
                if super::audition::active() {
                    continue;
                }
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
    let store = super::fingerprint::shared();
    if store.finish() {
        store.save();
    }
}
