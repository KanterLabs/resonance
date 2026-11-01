use super::*;

impl Queue {
    /// Return the URI set accumulated by this terminal session.
    ///
    /// This is a snapshot so recommendation workers can hold it without
    /// keeping the queue lock. Queue edits never clear the set.
    pub fn session_played(&self) -> HashSet<String> {
        self.session_played.lock().unwrap().clone()
    }

    pub(super) fn mark_session_played(&self, uri: String) {
        self.session_played.lock().unwrap().insert(uri);
    }

    /// Return canonical song identities observed in this terminal session.
    /// Queue edits never clear this set.
    pub fn session_played_song_keys(&self) -> HashSet<String> {
        self.session_song_keys.lock().unwrap().clone()
    }

    pub(super) fn mark_session_played_track(&self, track: &Track) {
        self.mark_session_played(track.uri.clone());
        let key = crate::recommendations::engine::song_key(track);
        if !key.is_empty() {
            self.session_song_keys.lock().unwrap().insert(key);
        }
    }

    pub(super) fn mark_session_played_item(&self, item: &Playable) {
        if let Some(track) = item.track() {
            self.mark_session_played_track(&track);
        } else {
            self.mark_session_played(item.uri());
        }
    }

    /// Return exact per-occurrence provenance for persistence. Indices are
    /// already maintained under queue edits; sorting makes state output stable.
    pub fn queue_provenance(&self) -> (Vec<usize>, Vec<usize>) {
        let mut explicit: Vec<_> = self
            .explicit_queued
            .read()
            .unwrap()
            .iter()
            .copied()
            .collect();
        let mut radio: Vec<_> = self
            .radio_generated
            .read()
            .unwrap()
            .iter()
            .copied()
            .collect();
        explicit.sort_unstable();
        radio.sort_unstable();
        (explicit, radio)
    }

    /// Snapshot the parked continuation so shutdown persistence can preserve a
    /// station's original context even after playback reaches a raw radio tail.
    pub fn resume_context(&self) -> Vec<usize> {
        self.resume_context.read().unwrap().clone()
    }

    pub fn queue_resume_context(&self) -> Vec<usize> {
        self.resume_context()
    }

    pub fn queue_resume_context_valid(&self) -> bool {
        *self.resume_context_valid.read().unwrap()
    }

    pub(crate) fn radio_seed_track(&self) -> Option<Track> {
        self.radio.lock().unwrap().seed_track.clone()
    }

    /// Return the URI set that actually reserves songs for the current radio
    /// request. Parked context and past entries are intentionally omitted.
    pub fn recommendation_queued(&self) -> HashSet<String> {
        let radio = self.radio.lock().unwrap();
        let random_order = self.random_order.read().unwrap();
        let queue = self.queue.read().unwrap();
        let current = *self.current_track.read().unwrap();
        let played = self.played_indices.read().unwrap();
        let explicit = self.explicit_queued.read().unwrap();
        let active_radio = self.active_radio.read().unwrap();
        let radio_generated = self.radio_generated.read().unwrap();
        let resume_context = self.resume_context.read().unwrap();
        let resume_context_valid = *self.resume_context_valid.read().unwrap();
        let session_played = self.session_played.lock().unwrap();
        let session_song_keys = self.session_song_keys.lock().unwrap();
        let auto_excluded = automatic_session_excluded(
            &queue,
            &radio_generated,
            &session_played,
            &session_song_keys,
        );
        let mut queued = HashSet::new();
        if let Some(index) = current
            && let Some(item) = queue.get(index)
        {
            queued.insert(item.uri());
        }
        let indices = self.upcoming_indices_locked(
            usize::MAX,
            current,
            random_order.as_ref(),
            queue.len(),
            &played,
            &explicit,
            &active_radio,
            &radio_generated,
            &resume_context,
            resume_context_valid,
            &auto_excluded,
            radio.active,
        );
        drop(radio);
        for index in indices {
            if let Some(item) = queue.get(index) {
                queued.insert(item.uri());
            }
        }
        queued
    }

    pub fn queue_origin(&self, index: usize) -> &'static str {
        if self.explicit_queued.read().unwrap().contains(&index) {
            "explicit"
        } else if self.radio_generated.read().unwrap().contains(&index) {
            "radio"
        } else {
            "context"
        }
    }

    /// Count future entries parked behind the active radio lane. Historical
    /// radio entries are included because they are not active in this station.
    pub fn parked_context_count(&self) -> usize {
        let radio = self.radio.lock().unwrap();
        if !radio.active {
            return 0;
        }
        let random_order = self.random_order.read().unwrap();
        let queue = self.queue.read().unwrap();
        let current = *self.current_track.read().unwrap();
        let played = self.played_indices.read().unwrap();
        let explicit = self.explicit_queued.read().unwrap();
        let active_radio = self.active_radio.read().unwrap();
        let radio_generated = self.radio_generated.read().unwrap();
        let resume_context = self.resume_context.read().unwrap();
        let session_played = self.session_played.lock().unwrap();
        let session_song_keys = self.session_song_keys.lock().unwrap();
        let auto_excluded = automatic_session_excluded(
            &queue,
            &radio_generated,
            &session_played,
            &session_song_keys,
        );
        let Some(current_position) =
            Self::current_play_position_locked(current, random_order.as_ref(), queue.len())
        else {
            return 0;
        };
        let order_len = random_order.as_ref().map_or(queue.len(), Vec::len);
        let mut parked = HashSet::new();
        if !resume_context.is_empty() {
            parked.extend(resume_context.iter().copied().filter(|index| {
                *index < queue.len()
                    && !played.contains(index)
                    && !explicit.contains(index)
                    && !active_radio.contains(index)
                    && !radio_generated.contains(index)
                    && !auto_excluded.contains(index)
            }));
        }
        parked.extend(
            ((current_position + 1)..order_len)
                .filter_map(|position| {
                    Self::play_index_at_locked(random_order.as_ref(), position, queue.len())
                })
                .filter(|index| {
                    !played.contains(index)
                        && !explicit.contains(index)
                        && !active_radio.contains(index)
                        && !radio_generated.contains(index)
                        && !auto_excluded.contains(index)
                }),
        );
        parked.len()
    }

    pub fn observe_listening(&self) {
        let playing = matches!(self.spotify.get_current_status(), PlayerEvent::Playing(_));
        let track = {
            // Snapshot and mark one exact occurrence under the same lock order
            // used by structural radio edits. The tracker callback runs after
            // releasing the queue locks so it cannot observe a half-updated
            // queue while another player event arrives.
            let _radio = self.radio.lock().unwrap();
            let queue = self.queue.read().unwrap();
            let current = *self.current_track.read().unwrap();
            let current_item = current.and_then(|index| queue.get(index).cloned());
            if playing {
                if let Some(item) = &current_item {
                    self.mark_session_played_item(item);
                }
                if let Some(index) = current {
                    self.played_indices.write().unwrap().insert(index);
                    self.resume_context
                        .write()
                        .unwrap()
                        .retain(|pending| *pending != index);
                }
            }
            current_item.as_ref().and_then(|item| item.track())
        };
        self.listening.lock().unwrap().observe(track, playing);
    }

    pub fn finish_listening(&self) {
        self.observe_listening();
        self.listening.lock().unwrap().finish(false, false);
    }
}
