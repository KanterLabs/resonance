//! Energy around the playhead, for the status snapshot's energy strip.
//!
//! Raw fingerprint energy only means something against the rest of the library, so
//! each value is sent as its rank among every stored measurement: 0 is the calmest
//! track measured, 1 the most energetic. This runs on every status snapshot, so the
//! store's energies are read and sorted once per snapshot and nothing is fetched.

use serde::Serialize;

use crate::builder::fingerprint::FingerprintStore;
use crate::builder::solve::percentile;
use crate::model::{playable::Playable, track::Track};
use crate::recommendations::engine::song_key;

/// Fewer measurements than this and a rank says more about the sample than the track.
const MIN_ENERGIES: usize = 8;
/// Queue items shown before the current one.
pub(super) const PREVIOUS: usize = 12;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(super) struct EnergyStatus {
    current: Option<f32>,
    /// The items before the current one in the queue, oldest first.
    previous: Vec<Option<f32>>,
    /// Parallel to the status's `up_next`.
    up_next: Vec<Option<f32>>,
}

/// Energy for the current item, the ones before it and the ones up next, or `None`
/// when too little is measured for a rank to mean anything, or nothing here is.
pub(super) fn status(
    store: &FingerprintStore,
    current: Option<&Playable>,
    previous: &[Playable],
    up_next: &[Track],
) -> Option<EnergyStatus> {
    let energies = store.energies();
    if energies.len() < MIN_ENERGIES {
        return None;
    }
    let raw = |track: &Track| store.energy_of(&track.uri, &song_key(track));
    let playable = |item: &Playable| match item {
        Playable::Track(track) => raw(track),
        Playable::Episode(_) => None,
    };
    rank(
        energies,
        current.and_then(playable),
        previous.iter().map(playable).collect(),
        up_next.iter().map(raw).collect(),
    )
}

/// Rank raw energies against `energies`, the pure half of [`status`].
fn rank(
    mut energies: Vec<f32>,
    current: Option<f32>,
    previous: Vec<Option<f32>>,
    up_next: Vec<Option<f32>>,
) -> Option<EnergyStatus> {
    if energies.len() < MIN_ENERGIES {
        return None;
    }
    if current.is_none() && previous.iter().chain(&up_next).all(Option::is_none) {
        return None;
    }
    energies.sort_by(f32::total_cmp);
    let rank = |value: Option<f32>| value.map(|raw| percentile(&energies, raw) as f32);
    Some(EnergyStatus {
        current: rank(current),
        previous: previous.into_iter().map(rank).collect(),
        up_next: up_next.into_iter().map(rank).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Vec<f32> {
        vec![0.8, 0.1, 0.4, 0.2, 0.7, 0.3, 0.6, 0.5]
    }

    #[test]
    fn energy_is_ranked_with_ties_counted_half() {
        let status = rank(
            library(),
            Some(0.5),
            vec![Some(0.0), None, Some(0.8)],
            vec![Some(0.9), Some(0.45)],
        )
        .unwrap();
        // 0.5 has four below it and ties itself: (4 + 0.5) / 8.
        assert_eq!(status.current, Some(4.5 / 8.0));
        assert_eq!(status.previous, vec![Some(0.0), None, Some(7.5 / 8.0)]);
        assert_eq!(status.up_next, vec![Some(1.0), Some(0.5)]);

        let ties = rank(vec![0.5; 8], Some(0.5), vec![], vec![]).unwrap();
        assert_eq!(ties.current, Some(0.5));
    }

    #[test]
    fn energy_is_left_out_until_enough_is_measured_and_something_is_known() {
        let mut few = library();
        few.pop();
        assert_eq!(rank(few, Some(0.5), vec![], vec![]), None);
        assert_eq!(rank(library(), None, vec![None], vec![None, None]), None);
        assert!(rank(library(), None, vec![], vec![None, Some(0.3)]).is_some());
    }

    #[test]
    fn an_empty_store_reports_no_energy() {
        let store = FingerprintStore::default();
        let track = crate::builder::test_track("spotify:track:x", "a", "b", 1000);
        let current = Playable::Track(track.clone());
        assert_eq!(status(&store, Some(&current), &[], &[track]), None);
    }

    #[test]
    fn energy_serializes_with_null_for_unmeasured_items() {
        let status = rank(library(), None, vec![None], vec![Some(0.1)]).unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"current": null, "previous": [null], "up_next": [0.0625]})
        );
    }
}
