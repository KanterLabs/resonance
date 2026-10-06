//! The background thread that measures previews, most useful tracks first.
//!
//! Arcs never wait on it. A build asks for its candidates to be measured ahead of the rest,
//! and when there is nothing more urgent the whole cached library is worked through, so the
//! next build has more to go on.

use std::collections::{HashSet, VecDeque};
use std::sync::{Condvar, Mutex, OnceLock};
#[cfg(not(test))]
use std::time::{Duration, Instant};

use crate::model::track::Track;

/// How often an idle worker looks over the library again for tracks it has not checked.
#[cfg(not(test))]
const LIBRARY_SWEEP: Duration = Duration::from_secs(10 * 60);
/// Measurements are written out at most this often while the queue drains.
#[cfg(not(test))]
const SAVE_EVERY: Duration = Duration::from_secs(10);
/// How long to wait after Deezer says the quota is spent.
#[cfg(not(test))]
const QUOTA_BACKOFF: Duration = Duration::from_secs(10);
/// How long to wait when Deezer cannot be reached, so being offline does not burn the queue.
#[cfg(not(test))]
const OFFLINE_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    /// Candidates for an arc being built, in the order given.
    Urgent,
    /// The rest of the library.
    Background,
}

#[derive(Default)]
struct Waiting {
    urgent: VecDeque<Track>,
    background: VecDeque<Track>,
    queued: HashSet<String>,
}

#[derive(Default)]
pub struct Queue {
    waiting: Mutex<Waiting>,
    ready: Condvar,
}

pub fn shared() -> &'static Queue {
    static QUEUE: OnceLock<Queue> = OnceLock::new();
    QUEUE.get_or_init(Queue::default)
}

impl Queue {
    /// Ask for `tracks` to be measured. Tracks already queued are moved up when the new
    /// request is more urgent; local files and tracks without an id are skipped.
    pub fn enqueue(&self, tracks: impl IntoIterator<Item = Track>, priority: Priority) {
        let mut waiting = self.waiting.lock().unwrap();
        let mut urgent = Vec::new();
        for track in tracks {
            if track.is_local || track.id.is_none() {
                continue;
            }
            let fresh = waiting.queued.insert(track.uri.clone());
            match priority {
                Priority::Urgent => {
                    if !fresh {
                        waiting.background.retain(|queued| queued.uri != track.uri);
                        waiting.urgent.retain(|queued| queued.uri != track.uri);
                    }
                    urgent.push(track);
                }
                Priority::Background if fresh => waiting.background.push_back(track),
                Priority::Background => {}
            }
        }
        // The newest build's candidates go ahead of an older build's, in the order given.
        for track in urgent.into_iter().rev() {
            waiting.urgent.push_front(track);
        }
        drop(waiting);
        self.ready.notify_one();
    }

    /// Tracks waiting to be measured.
    pub fn pending(&self) -> usize {
        let waiting = self.waiting.lock().unwrap();
        waiting.urgent.len() + waiting.background.len()
    }

    fn take(&self) -> Option<Track> {
        let mut waiting = self.waiting.lock().unwrap();
        let track = waiting
            .urgent
            .pop_front()
            .or_else(|| waiting.background.pop_front())?;
        waiting.queued.remove(&track.uri);
        Some(track)
    }

    /// The next track, waiting up to `timeout` for one to be queued.
    #[cfg(not(test))]
    fn next(&self, timeout: Duration) -> Option<Track> {
        if let Some(track) = self.take() {
            return Some(track);
        }
        let waiting = self.waiting.lock().unwrap();
        drop(
            self.ready
                .wait_timeout_while(waiting, timeout, |waiting| {
                    waiting.urgent.is_empty() && waiting.background.is_empty()
                })
                .unwrap(),
        );
        self.take()
    }

    /// Put a track back at the front, after a request that should be retried.
    #[cfg(not(test))]
    fn retry(&self, track: Track) {
        self.enqueue([track], Priority::Urgent);
    }
}

/// Measure previews in the background for as long as the process runs, unless the user turned
/// preview lookups off.
#[cfg(not(test))]
pub fn start(
    queue: std::sync::Arc<crate::queue::Queue>,
    library: std::sync::Arc<crate::library::Library>,
) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if !enabled(&library) || STARTED.set(()).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("arc-previews".into())
        .spawn(move || run(&queue, &library));
    if let Err(error) = spawned {
        log::error!("could not start arc previews: {error}");
    }
}

#[cfg(test)]
pub fn start(_: std::sync::Arc<crate::queue::Queue>, _: std::sync::Arc<crate::library::Library>) {}

/// Whether arcs may look tracks up on Deezer. On unless `arcs_preview_lookup = false`.
pub fn enabled(library: &crate::library::Library) -> bool {
    library.cfg.values().arcs_preview_lookup.unwrap_or(true)
}

#[cfg(not(test))]
fn run(queue: &crate::queue::Queue, library: &crate::library::Library) {
    use super::measure::{measure, unmeasured};
    use crate::builder::deezer::{self, Error, Lookup};

    let work = shared();
    let store = super::shared();
    let fingerprints = crate::builder::fingerprint::shared();
    let mut last_sweep: Option<Instant> = None;
    let mut last_save = Instant::now();
    let mut unsaved = false;
    loop {
        if last_sweep.is_none_or(|at| at.elapsed() >= LIBRARY_SWEEP) {
            let catalog = crate::recommendations::catalog(queue, library);
            let now = now_seconds();
            work.enqueue(
                catalog
                    .tracks
                    .into_iter()
                    .filter(|track| fingerprints.get(track).is_none())
                    .filter(|track| store.needs_check(track, now)),
                Priority::Background,
            );
            last_sweep = Some(Instant::now());
        }
        if unsaved && last_save.elapsed() >= SAVE_EVERY {
            store.save();
            last_save = Instant::now();
            unsaved = false;
        }
        let Some(track) = work.next(SAVE_EVERY) else {
            continue;
        };
        let now = now_seconds();
        if fingerprints.get(&track).is_some() || !store.needs_check(&track, now) {
            continue;
        }
        let result = deezer::lookup(&track).and_then(|lookup| match lookup {
            Lookup::Found(found) => {
                let mp3 = deezer::download(&found.preview)?;
                Ok(measure(&track, &found, &mp3, now))
            }
            Lookup::Missing | Lookup::NoPreview => Ok(unmeasured(&track, now)),
        });
        match result {
            Ok(preview) => {
                store.insert(track.uri.clone(), preview);
                unsaved = true;
            }
            Err(Error::Quota) => {
                work.retry(track);
                std::thread::sleep(QUOTA_BACKOFF);
            }
            Err(error @ Error::Network(_)) => {
                warn_once(&error);
                work.retry(track);
                std::thread::sleep(OFFLINE_BACKOFF);
            }
            // A passing failure: the track is not recorded as a miss, so a later build or
            // sweep asks again.
            Err(error) => warn_once(&error),
        }
    }
}

/// Log each kind of failure once per run rather than once per track.
#[cfg(not(test))]
fn warn_once(error: &crate::builder::deezer::Error) {
    static SEEN: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);
    let mut seen = SEEN.lock().unwrap();
    if seen.get_or_insert_with(HashSet::new).insert(error.kind()) {
        log::warn!("arc previews: {error}");
    } else {
        log::debug!("arc previews: {error}");
    }
}

#[cfg(not(test))]
fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::test_track;

    fn tracks(names: &[&str]) -> Vec<Track> {
        names
            .iter()
            .map(|name| test_track(&format!("spotify:track:{name}"), "a", "a", 1))
            .collect()
    }

    fn order(queue: &Queue) -> Vec<String> {
        std::iter::from_fn(|| queue.take())
            .map(|track| track.uri.rsplit(':').next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn urgent_work_goes_first_in_the_order_given() {
        let queue = Queue::default();
        queue.enqueue(tracks(&["l1", "l2"]), Priority::Background);
        queue.enqueue(tracks(&["a", "b"]), Priority::Urgent);
        assert_eq!(queue.pending(), 4);
        assert_eq!(order(&queue), ["a", "b", "l1", "l2"]);
    }

    #[test]
    fn a_newer_build_jumps_an_older_one() {
        let queue = Queue::default();
        queue.enqueue(tracks(&["old1", "old2"]), Priority::Urgent);
        queue.enqueue(tracks(&["new", "old2"]), Priority::Urgent);
        assert_eq!(order(&queue), ["new", "old2", "old1"]);
    }

    #[test]
    fn a_track_is_queued_once() {
        let queue = Queue::default();
        queue.enqueue(tracks(&["a", "b"]), Priority::Background);
        queue.enqueue(tracks(&["b", "a"]), Priority::Background);
        assert_eq!(order(&queue), ["a", "b"]);
        // Once taken it may be queued again.
        queue.enqueue(tracks(&["a"]), Priority::Background);
        assert_eq!(queue.pending(), 1);
    }

    #[test]
    fn local_files_are_never_looked_up() {
        let queue = Queue::default();
        let mut local = tracks(&["local"]);
        local[0].is_local = true;
        let mut no_id = tracks(&["noid"]);
        no_id[0].id = None;
        queue.enqueue(local.into_iter().chain(no_id), Priority::Urgent);
        assert_eq!(queue.pending(), 0);
    }
}
