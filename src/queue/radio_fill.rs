use super::*;

impl Queue {
    /// Insert a radio batch immediately after the current item. The station
    /// generation, seed, queue URI set, and session URI set are checked while
    /// the queue locks are held.
    #[cfg(test)]
    pub(crate) fn append_radio_next_if_current(
        &self,
        generation: u64,
        seed: &str,
        tracks: &[Playable],
    ) -> Option<usize> {
        self.append_radio_checked(generation, None, None, seed, None, tracks, true)
    }

    /// Insert a radio refill at the raw queue tail. This lets explicitly queued
    /// manual items keep their priority while the station remains continuous.
    #[cfg(test)]
    pub(crate) fn append_radio_at_tail_if_current(
        &self,
        generation: u64,
        seed: &str,
        tracks: &[Playable],
    ) -> Option<usize> {
        self.append_radio_checked(generation, None, None, seed, None, tracks, false)
    }

    /// Apply a fill only to the exact queue occurrence captured by a radio worker.
    /// The original station seed is kept separate from the current track so a
    /// station remains anchored while playback advances.
    pub(crate) fn append_radio_next_if_claim_current(
        &self,
        claim: &RadioFill,
        tracks: &[Playable],
    ) -> Option<usize> {
        self.append_radio_checked(
            claim.generation,
            Some(claim.current_index),
            Some(claim.current_token),
            &claim.current_uri,
            Some(&claim.seed),
            tracks,
            true,
        )
    }

    pub(crate) fn append_radio_at_tail_if_claim_current(
        &self,
        claim: &RadioFill,
        tracks: &[Playable],
    ) -> Option<usize> {
        self.append_radio_checked(
            claim.generation,
            Some(claim.current_index),
            Some(claim.current_token),
            &claim.current_uri,
            Some(&claim.seed),
            tracks,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn append_radio_checked(
        &self,
        generation: u64,
        expected_index: Option<usize>,
        expected_token: Option<u64>,
        current_uri: &str,
        station_seed: Option<&Track>,
        tracks: &[Playable],
        after_current: bool,
    ) -> Option<usize> {
        let mut generation_guard = self.rpc_mutation.lock().unwrap();
        let radio = self.radio.lock().unwrap();
        if !self.radio_is_current_locked(&radio, generation) {
            return None;
        }
        let mut random_order = self.random_order.write().unwrap();
        let mut q = self.queue.write().unwrap();

        let current = *self.current_track.read().unwrap();
        if expected_index.is_some_and(|index| current != Some(index)) {
            return None;
        }
        if expected_token.is_some_and(|token| *self.current_token.read().unwrap() != token) {
            return None;
        }

        let current_item = current.and_then(|index| q.get(index));
        if !current_item.is_some_and(|item| item.uri() == current_uri) {
            return None;
        }
        let seed_track = station_seed
            .cloned()
            .or_else(|| radio.seed_track.clone())
            .or_else(|| current_item.and_then(Playable::track));
        let seed_key = seed_track
            .as_ref()
            .map(crate::recommendations::engine::song_key)
            .filter(|key| !key.is_empty());

        // Only actual current/future lane entries reserve radio candidates.
        // Parked restored context remains metadata and may be rediscovered.
        let played_indices = self.played_indices.read().unwrap().clone();
        let explicit = self.explicit_queued.read().unwrap().clone();
        let active_radio = self.active_radio.read().unwrap().clone();
        let radio_generated = self.radio_generated.read().unwrap().clone();
        let resume_context = self.resume_context.read().unwrap().clone();
        let resume_context_valid = *self.resume_context_valid.read().unwrap();
        let random_order_ref = random_order.as_ref();
        let mut queued_uris = HashSet::new();
        let mut queued_keys = HashSet::new();
        if let Some(index) = current
            && let Some(item) = q.get(index)
        {
            queued_uris.insert(item.uri());
            if let Some(key) = playable_song_key(item) {
                queued_keys.insert(key);
            }
        }
        let session_played = self.session_played.lock().unwrap().clone();
        let session_song_keys = self.session_song_keys.lock().unwrap().clone();
        let auto_excluded =
            automatic_session_excluded(&q, &radio_generated, &session_played, &session_song_keys);
        for index in self.upcoming_indices_locked(
            usize::MAX,
            current,
            random_order_ref,
            q.len(),
            &played_indices,
            &explicit,
            &active_radio,
            &radio_generated,
            &resume_context,
            resume_context_valid,
            &auto_excluded,
            true,
        ) {
            if let Some(item) = q.get(index) {
                queued_uris.insert(item.uri());
                if let Some(key) = playable_song_key(item) {
                    queued_keys.insert(key);
                }
            }
        }
        let mut batch_uris = HashSet::new();
        let mut batch_keys = HashSet::new();
        let filtered: Vec<_> = tracks
            .iter()
            .filter(|track| {
                let uri = track.uri();
                let key = playable_song_key(track);
                if uri == current_uri
                    || seed_track
                        .as_ref()
                        .is_some_and(|seed| same_track_identity(seed, track))
                    || seed_key
                        .as_ref()
                        .zip(key.as_ref())
                        .is_some_and(|(seed, candidate)| seed == candidate)
                    || session_played.contains(&uri)
                    || key
                        .as_ref()
                        .is_some_and(|key| session_song_keys.contains(key))
                    || queued_uris.contains(&uri)
                    || key.as_ref().is_some_and(|key| queued_keys.contains(key))
                    || !batch_uris.insert(uri)
                    || key
                        .as_ref()
                        .is_some_and(|key| !batch_keys.insert(key.clone()))
                {
                    return false;
                }
                true
            })
            .cloned()
            .collect();
        if filtered.is_empty() {
            return Some(0);
        }

        let first = if after_current {
            match current {
                Some(index) => index + 1,
                None => q.len(),
            }
        } else {
            q.len()
        };
        if let Some(order) = random_order.as_mut() {
            if after_current {
                let insertion_position = current
                    .and_then(|index| order.iter().position(|&item| item == index))
                    .map_or(order.len(), |position| position + 1);
                for index in order.iter_mut() {
                    if *index >= first {
                        *index += filtered.len();
                    }
                }
                order.splice(
                    insertion_position..insertion_position,
                    first..first + filtered.len(),
                );
            } else {
                order.extend(first..first + filtered.len());
            }
        }

        shift_indices_on_insert(
            &mut self.explicit_queued.write().unwrap(),
            first,
            filtered.len(),
        );
        let mut generated = self.radio_generated.write().unwrap();
        let mut active_radio = self.active_radio.write().unwrap();
        if after_current {
            shift_indices_on_insert(&mut generated, first, filtered.len());
            shift_indices_on_insert(&mut active_radio, first, filtered.len());
            shift_indices_on_insert(
                &mut self.played_indices.write().unwrap(),
                first,
                filtered.len(),
            );
            shift_resume_on_insert(
                &mut self.resume_context.write().unwrap(),
                first,
                filtered.len(),
            );
        }
        for (offset, track) in filtered.iter().enumerate() {
            let index = first + offset;
            q.insert(index, track.clone());
            generated.insert(index);
            active_radio.insert(index);
        }
        *generation_guard = generation_guard.wrapping_add(1);
        Some(filtered.len())
    }
}
