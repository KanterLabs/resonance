use super::*;

impl Queue {
    /// Start a user-selected station with only the playing occurrence retained.
    /// Keep the player and session history intact while removing every previous
    /// queue lane, including explicit entries and parked station context.
    pub(crate) fn replace_queue_with_radio(&self, track: &Track) -> u64 {
        let mut mutation = self.rpc_mutation.lock().unwrap();
        {
            // Use the same lock order as station fills and playback selection.
            let _radio = self.radio.lock().unwrap();
            let mut order = self.random_order.write().unwrap();
            let mut queue = self.queue.write().unwrap();
            let mut current = self.current_track.write().unwrap();
            let playing = current.and_then(|index| queue.get(index).cloned());
            queue.clear();
            queue.extend(playing);
            *current = (!queue.is_empty()).then_some(0);
            if let Some(order) = order.as_mut() {
                *order = (0..queue.len()).collect();
            }
            let mut token = self.current_token.write().unwrap();
            *token = token.wrapping_add(1).max(1);
            self.explicit_queued.write().unwrap().clear();
            self.radio_generated.write().unwrap().clear();
            self.active_radio.write().unwrap().clear();
            self.played_indices.write().unwrap().clear();
            self.resume_context.write().unwrap().clear();
            *self.resume_context_valid.write().unwrap() = false;
            self.last_skip.lock().unwrap().take();
        }
        let generation = self.start_radio_track_locked(track);
        *mutation = mutation.wrapping_add(1);
        generation
    }

    /// Begin a new radio station anchored to the supplied track metadata.
    /// Starting another station invalidates delayed workers and parks older
    /// automatic entries without deleting any raw queue item.
    pub fn start_radio_track(&self, track: &Track) -> u64 {
        let _mutation = self.rpc_mutation.lock().unwrap();
        self.start_radio_track_locked(track)
    }

    pub(super) fn start_radio_track_locked(&self, track: &Track) -> u64 {
        let mut radio = self.radio.lock().unwrap();
        let random_order = self.random_order.read().unwrap();
        let queue = self.queue.read().unwrap();
        let current_index = *self.current_track.read().unwrap();
        let current_position =
            Self::current_play_position_locked(current_index, random_order.as_ref(), queue.len());
        let explicit = self.explicit_queued.read().unwrap().clone();
        let played = self.played_indices.read().unwrap().clone();
        let radio_generated = self.radio_generated.read().unwrap().clone();
        let session_played = self.session_played.lock().unwrap().clone();
        let session_song_keys = self.session_song_keys.lock().unwrap().clone();
        let auto_excluded = automatic_session_excluded(
            &queue,
            &radio_generated,
            &session_played,
            &session_song_keys,
        );
        let existing_resume = self.resume_context.read().unwrap().clone();
        let existing_resume_valid = *self.resume_context_valid.read().unwrap();
        let order_len = random_order.as_ref().map_or(queue.len(), Vec::len);
        let parked = if existing_resume_valid {
            existing_resume
                .into_iter()
                .filter(|index| !auto_excluded.contains(index))
                .collect::<Vec<_>>()
        } else {
            current_position
                .map(|position| {
                    ((position + 1)..order_len)
                        .filter_map(|position| {
                            Self::play_index_at_locked(random_order.as_ref(), position, queue.len())
                        })
                        .filter(|index| {
                            Some(*index) != current_index
                                && !played.contains(index)
                                && !explicit.contains(index)
                                && !radio_generated.contains(index)
                                && !auto_excluded.contains(index)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let past_explicit = if existing_resume_valid {
            Vec::new()
        } else {
            current_position
                .map(|position| {
                    (0..=position)
                        .filter_map(|position| {
                            Self::play_index_at_locked(random_order.as_ref(), position, queue.len())
                        })
                        .filter(|index| explicit.contains(index))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        drop(played);
        drop(explicit);
        drop(queue);
        drop(random_order);
        {
            let mut played = self.played_indices.write().unwrap();
            if let Some(index) = current_index {
                played.insert(index);
            }
            played.extend(past_explicit);
        }
        if let Some(index) = current_index {
            self.resume_context
                .write()
                .unwrap()
                .retain(|pending| *pending != index);
        }
        *self.resume_context.write().unwrap() = parked;
        *self.resume_context_valid.write().unwrap() = true;
        self.mark_session_played_track(track);
        self.active_radio.write().unwrap().clear();
        radio.generation = radio.generation.wrapping_add(1).max(1);
        radio.active = true;
        radio.seed = Some(track.uri.clone());
        radio.seed_track = Some(track.clone());
        radio.in_flight = false;
        radio.retry_at = None;
        radio.retry_attempt = 0;
        radio.waiting = false;
        radio.natural_end = false;
        radio.refresh_requested = false;
        radio.generation
    }

    /// Compatibility entry point for tests and older callers. Production UI
    /// paths should pass the fully resolved seed track to `start_radio_track`.
    pub fn start_radio(&self, seed: &str) -> u64 {
        let track = self
            .get_current()
            .and_then(|item| item.track().filter(|track| track.uri == seed))
            .or_else(|| {
                self.queue
                    .read()
                    .unwrap()
                    .iter()
                    .find_map(|item| item.track().filter(|track| track.uri == seed))
            })
            .or_else(|| {
                self.library
                    .tracks
                    .read()
                    .unwrap()
                    .iter()
                    .find(|track| track.uri == seed)
                    .cloned()
            });
        if let Some(track) = track {
            return self.start_radio_track(&track);
        }

        let _mutation = self.rpc_mutation.lock().unwrap();
        let mut radio = self.radio.lock().unwrap();
        *self.resume_context.write().unwrap() = Vec::new();
        *self.resume_context_valid.write().unwrap() = false;
        self.active_radio.write().unwrap().clear();
        radio.generation = radio.generation.wrapping_add(1).max(1);
        radio.active = true;
        radio.seed = Some(seed.to_owned());
        radio.seed_track = None;
        radio.in_flight = false;
        radio.retry_at = None;
        radio.retry_attempt = 0;
        radio.waiting = false;
        radio.natural_end = false;
        radio.refresh_requested = false;
        radio.generation
    }

    /// Cancel the current station and invalidate every delayed fill.
    pub fn cancel_radio(&self) {
        let mut radio = self.radio.lock().unwrap();
        radio.generation = radio.generation.wrapping_add(1).max(1);
        radio.active = false;
        radio.seed = None;
        radio.seed_track = None;
        radio.in_flight = false;
        radio.retry_at = None;
        radio.retry_attempt = 0;
        radio.waiting = false;
        radio.natural_end = false;
        radio.refresh_requested = false;
        self.active_radio.write().unwrap().clear();
    }

    pub(crate) fn radio_active(&self) -> bool {
        self.radio.lock().unwrap().active
    }

    pub(crate) fn radio_seed(&self) -> Option<String> {
        self.radio.lock().unwrap().seed.clone()
    }

    /// Whether a station is deliberately waiting for more metadata. A natural
    /// queue exhaustion keeps this state alive; playback failures cancel it from
    /// the application event loop instead.
    pub(crate) fn radio_waiting(&self) -> bool {
        let radio = self.radio.lock().unwrap();
        radio.active && (radio.waiting || radio.natural_end)
    }

    pub(crate) fn radio_natural_end(&self) -> bool {
        let radio = self.radio.lock().unwrap();
        radio.active && radio.natural_end
    }

    pub(super) fn wait_for_radio_or_stop(&self) {
        if self.radio_active() {
            self.radio.lock().unwrap().natural_end = true;
            // EndOfTrack already silenced the player. Avoid manufacturing a
            // Stopped event that could be confused with a playback failure.
            // A manual skip at the end pauses the outgoing song while waiting.
            if matches!(self.spotify.get_current_status(), PlayerEvent::Playing(_)) {
                self.spotify.pause();
            }
        } else {
            self.spotify.stop();
        }
    }

    /// Resume on the UI thread after a batch arrives, including a batch that
    /// was already in flight when the queue reached its end.
    pub(crate) fn resume_radio_if_ready(&self) -> bool {
        let _mutation = self.rpc_mutation.lock().unwrap();
        if !self.radio_natural_end() {
            return false;
        }
        let Some(index) = self.next_index() else {
            return false;
        };
        self.play(index, false, false);
        true
    }

    /// Claim one station fill. `force` is used only for a freshly started
    /// station; normal maintenance waits until the active lane has reached its
    /// low-water mark. The claim carries the original station seed and exact
    /// current queue occurrence so a delayed result cannot drift stations.
    pub(crate) fn radio_begin_fill(&self, force: bool, low_water: usize) -> Option<RadioFill> {
        let mut radio = self.radio.lock().unwrap();
        if !radio.active || radio.in_flight {
            return None;
        }
        if !force
            && radio
                .retry_at
                .is_some_and(|retry_at| Instant::now() < retry_at)
        {
            return None;
        }

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
        let upcoming = self.upcoming_indices_locked(
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
            true,
        );
        let automatic_upcoming = upcoming
            .iter()
            .filter(|index| active_radio.contains(index))
            .count();
        if !force && automatic_upcoming > low_water {
            return None;
        }
        let current_index = current.filter(|index| queue.get(*index).is_some())?;
        let current_uri = queue.get(current_index)?.uri();
        let current_token = *self.current_token.read().unwrap();
        let seed = radio
            .seed_track
            .clone()
            .or_else(|| queue.get(current_index).and_then(|item| item.track()))?;

        radio.in_flight = true;
        radio.waiting = false;
        Some(RadioFill {
            generation: radio.generation,
            seed,
            current_index,
            current_uri,
            current_token,
        })
    }

    /// Complete a claimed fill. A zero-sized batch gets exponential backoff so
    /// an empty or finite local catalogue cannot produce a request storm.
    pub(crate) fn radio_finish_fill(&self, generation: u64, added: usize) -> bool {
        let mut radio = self.radio.lock().unwrap();
        if !radio.active || radio.generation != generation {
            return false;
        }
        radio.in_flight = false;
        if added > 0 {
            radio.retry_at = None;
            radio.retry_attempt = 0;
            radio.waiting = false;
        } else {
            radio.retry_attempt = radio.retry_attempt.saturating_add(1);
            let shift = u32::from(radio.retry_attempt.saturating_sub(1).min(6));
            let delay = RADIO_RETRY_BASE
                .checked_mul(1_u32 << shift)
                .unwrap_or(RADIO_RETRY_MAX)
                .min(RADIO_RETRY_MAX);
            radio.retry_at = Some(Instant::now() + delay);
            radio.waiting = true;
        }
        true
    }

    /// Wake a station after enrichment or another metadata update. This only
    /// changes the retry deadline; the single-flight guard still owns spawning.
    pub(crate) fn radio_wake(&self, generation: u64) {
        let mut radio = self.radio.lock().unwrap();
        if radio.active && radio.generation == generation && !radio.in_flight {
            radio.retry_at = Some(Instant::now());
        }
    }

    pub(crate) fn radio_retry_delay(&self, generation: u64) -> Option<Duration> {
        let radio = self.radio.lock().unwrap();
        if !radio.active || radio.generation != generation {
            return None;
        }
        radio
            .retry_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    /// Request at most one enrichment refresh for a station lifetime.
    pub(crate) fn radio_take_refresh(&self, generation: u64) -> bool {
        let mut radio = self.radio.lock().unwrap();
        if !radio.active || radio.generation != generation || radio.refresh_requested {
            return false;
        }
        radio.refresh_requested = true;
        true
    }

    pub(super) fn radio_is_current_locked(&self, radio: &RadioState, generation: u64) -> bool {
        radio.active && radio.generation == generation
    }

    pub(super) fn is_radio_generated(&self, index: usize) -> bool {
        self.radio_generated.read().unwrap().contains(&index)
    }
}
