//! Auditions: a short listen to a track from Arc Studio that leaves the queue alone.
//!
//! The track is loaded straight into the player from part way in, and whatever was playing is
//! loaded back afterwards at the position it was at. While an audition plays, listening
//! history, fingerprints and waveforms ignore playback, because the queue still names the
//! track that was playing before. When the queue moves on to something else during an
//! audition, the audition is forgotten rather than restored.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::model::{playable::Playable, track::Track};
use crate::queue::Queue;
use crate::spotify::{PlayerEvent, Spotify};

/// How long an audition plays before what was playing comes back.
pub const LENGTH: Duration = Duration::from_secs(20);
/// Where in the track an audition starts, as a share of its length: past the intro, near
/// where a chorus usually is.
const START_AT: f64 = 0.3;

struct Audition {
    /// What was playing, where, and whether it was playing rather than paused.
    resume: Option<(Playable, u32, bool)>,
    /// The queue position that was current, to notice the queue moving on.
    index: Option<usize>,
    until: Instant,
}

#[cfg(not(test))]
static STATE: Mutex<Option<Audition>> = Mutex::new(None);

// Tests run in parallel; a thread-local state keeps one test's audition from hiding playback
// from another test's queue.
#[cfg(test)]
thread_local! {
    static STATE: Mutex<Option<Audition>> = const { Mutex::new(None) };
}

#[cfg(not(test))]
fn with_state<T>(action: impl FnOnce(&mut Option<Audition>) -> T) -> T {
    action(&mut STATE.lock().unwrap())
}

#[cfg(test)]
fn with_state<T>(action: impl FnOnce(&mut Option<Audition>) -> T) -> T {
    STATE.with(|state| action(&mut state.lock().unwrap()))
}

/// Whether an audition is playing, so observers of playback should look away.
pub fn active() -> bool {
    with_state(|state| state.is_some())
}

/// Play `track` for [LENGTH] from part way in. A second audition replaces the first but
/// still returns to what was playing before either. Returns how long it will play.
pub fn start(queue: &Queue, track: Track) -> Result<Duration, String> {
    let spotify = queue.get_spotify();
    if spotify.cast_target().is_some() {
        return Err("Auditions are not available while casting".into());
    }
    if track.is_local || track.id.is_none() {
        return Err("Only Spotify tracks can be auditioned".into());
    }
    with_state(|state| {
        let resume = match state.take() {
            Some(previous) => previous.resume,
            None => queue.get_current().map(|playable| {
                let playing = matches!(spotify.get_current_status(), PlayerEvent::Playing(_));
                let position = spotify.get_current_progress().as_millis();
                (
                    playable,
                    u32::try_from(position).unwrap_or(u32::MAX),
                    playing,
                )
            }),
        };
        *state = Some(Audition {
            resume,
            index: queue.get_current_index(),
            until: Instant::now() + LENGTH,
        });
    });
    let position = (f64::from(track.duration) * START_AT) as u32;
    spotify.load(&Playable::Track(track), true, position);
    Ok(LENGTH)
}

/// End the audition and bring back what was playing. Returns whether one was playing.
pub fn stop(spotify: &Spotify) -> bool {
    let Some(audition) = with_state(Option::take) else {
        return false;
    };
    match audition.resume {
        Some((playable, position, playing)) => spotify.load(&playable, playing, position),
        None => spotify.stop(),
    }
    true
}

/// Forget the audition without restoring anything, because the queue has started playing
/// something else and that should win.
pub fn forget() {
    with_state(Option::take);
}

/// What to do with an audition on each tick.
#[derive(Debug, PartialEq, Eq)]
enum Tick {
    Continue,
    /// It has run its length: bring back what was playing.
    Expired,
    /// The queue moved on to another track: keep that, restore nothing.
    Superseded,
}

fn tick(audition: &Audition, index: Option<usize>, now: Instant) -> Tick {
    if index != audition.index {
        Tick::Superseded
    } else if now >= audition.until {
        Tick::Expired
    } else {
        Tick::Continue
    }
}

/// End an audition that has run its length, or that the queue has moved past. Call this from
/// the engine's regular tick.
pub fn maintain(queue: &Queue) {
    let index = queue.get_current_index();
    let state = with_state(|state| {
        state
            .as_ref()
            .map(|audition| tick(audition, index, Instant::now()))
    });
    match state {
        Some(Tick::Expired) => {
            stop(&queue.get_spotify());
        }
        Some(Tick::Superseded) => forget(),
        Some(Tick::Continue) | None => {}
    }
}

/// The player finished a track. If that was the audition, restore what was playing and
/// return true so the queue does not skip ahead.
pub fn finished(spotify: &Spotify) -> bool {
    stop(spotify)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forgetting_ends_an_audition_without_restoring() {
        with_state(|state| {
            *state = Some(Audition {
                resume: None,
                index: Some(2),
                until: Instant::now() + LENGTH,
            })
        });
        assert!(active());
        forget();
        assert!(!active());
    }

    #[test]
    fn an_audition_ends_on_time_or_when_the_queue_moves_on() {
        let now = Instant::now();
        let audition = Audition {
            resume: None,
            index: Some(2),
            until: now + LENGTH,
        };
        assert_eq!(tick(&audition, Some(2), now), Tick::Continue);
        assert_eq!(tick(&audition, Some(2), now + LENGTH), Tick::Expired);
        assert_eq!(tick(&audition, Some(3), now), Tick::Superseded);
        assert_eq!(tick(&audition, None, now), Tick::Superseded);
    }
}
