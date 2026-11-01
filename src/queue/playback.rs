use super::*;

impl Queue {
    /// Play the item at `index` in `self.queue`.
    ///
    /// `reshuffle`: Reshuffle the current order of the queue.
    /// `shuffle_index`: If this is true, `index` isn't actually used, but is
    /// chosen at random as a valid index in the queue.
    pub fn play(&self, index: usize, reshuffle: bool, shuffle_index: bool) {
        self.play_at(index, reshuffle, shuffle_index, None);
    }

    // Explicit undo or previous may replay a consumed station occurrence.
    pub(super) fn play_at(
        &self,
        mut index: usize,
        reshuffle: bool,
        shuffle_index: bool,
        resume: Option<(u32, bool)>,
    ) {
        let queue_length = self.queue.read().unwrap().len();
        // The length of the queue must be bigger than 0 or gen_range panics!
        if queue_length > 0 && shuffle_index && self.get_shuffle() {
            let mut rng = rand::rng();
            index = rng.random_range(0..queue_length);
        }

        self.observe_listening();
        // Choose, mark and advance atomically with station insertion. A worker
        // cannot shift the chosen entry between cloning it and setting current.
        let previous_index = self.get_current_index();
        let track = {
            let mut radio = self.radio.lock().unwrap();
            let items = self.queue.read().unwrap();
            let consumed = self.played_indices.read().unwrap().contains(&index);
            let automatic = self.radio_generated.read().unwrap().contains(&index);
            let session_duplicate = automatic
                && Some(index) != previous_index
                && items.get(index).is_some_and(|item| {
                    self.session_played.lock().unwrap().contains(&item.uri())
                        || playable_song_key(item).is_some_and(|key| {
                            self.session_song_keys.lock().unwrap().contains(&key)
                        })
                });
            if resume.is_none() && (consumed || session_duplicate) && (radio.active || automatic) {
                crate::ui::osd::notify(
                    "Already played this session; queue the song again to replay it",
                );
                return;
            }
            let track = items.get(index).cloned();
            if let Some(track) = &track {
                self.listening.lock().unwrap().finish(false, false);
                self.mark_session_played_item(track);
                self.played_indices.write().unwrap().insert(index);
                self.resume_context
                    .write()
                    .unwrap()
                    .retain(|pending| *pending != index);
                self.current_track.write().unwrap().replace(index);
                let mut token = self.current_token.write().unwrap();
                *token = token.wrapping_add(1).max(1);
                radio.natural_end = false;
            }
            track
        };
        if let Some(track) = track.as_ref() {
            let (position_ms, playing) = resume.unwrap_or((0, true));
            self.spotify.load(track, playing, position_ms);
            self.listening.lock().unwrap().observe(track.track(), false);
            self.spotify.update_track();

            #[cfg(feature = "notify")]
            if self.cfg.values().notify.unwrap_or(false) {
                std::thread::spawn({
                    // use same parser as track_format, Playable::format
                    let format = self
                        .cfg
                        .values()
                        .notification_format
                        .clone()
                        .unwrap_or_default();
                    let default_title = crate::config::NotificationFormat::default().title.unwrap();
                    let title = format.title.unwrap_or_else(|| default_title.clone());

                    let default_body = crate::config::NotificationFormat::default().body.unwrap();
                    let body = format.body.unwrap_or_else(|| default_body.clone());

                    let summary_txt = Playable::format(track, &title, &self.library);
                    let body_txt = Playable::format(track, &body, &self.library);
                    let cover_url = track.cover_url();
                    move || send_notification(&summary_txt, &body_txt, cover_url)
                });
            }

            // Send a Seeked signal at start of new track
            #[cfg(feature = "mpris")]
            self.spotify.notify_seeked(position_ms);
        }

        if reshuffle && self.get_shuffle() {
            self.generate_random_order()
        }
    }

    /// Toggle the playback. If playback is currently stopped, this will either
    /// play the next song if one is available, or restart from the start.
    pub fn toggleplayback(&self) {
        match self.spotify.get_current_status() {
            PlayerEvent::Playing(_) | PlayerEvent::Paused(_) => {
                self.spotify.toggleplayback();
            }
            PlayerEvent::Stopped => {
                let _mutation = self.rpc_mutation.lock().unwrap();
                if self.get_current_index().is_none() {
                    if let Some((index, _)) = self.upcoming(1).into_iter().next() {
                        self.play(index, false, false);
                    } else {
                        self.play(0, false, false);
                    }
                } else if self.next_index().is_some() {
                    self.next_inner(false);
                } else {
                    self.play(0, false, false);
                }
            }
            _ => (),
        }
    }

    /// Stop playback.
    pub fn stop(&self) {
        self.cancel_radio();
        self.finish_listening();
        let mut current = self.current_track.write().unwrap();
        if current.take().is_some() {
            let mut token = self.current_token.write().unwrap();
            *token = token.wrapping_add(1).max(1);
        }
        self.spotify.stop();
    }

    /// Play the next song in the queue. Stops playback if there are no playable tracks
    /// remaining.
    ///
    /// `manual`: If this is true, normal queue logic like repeat will not be
    /// used, and the next track will actually be played. This should be used
    /// when going to the next entry in the queue is the wanted behavior.
    pub fn next(&self, manual: bool) {
        let mutation = self.rpc_mutation.lock().unwrap();
        let snapshot = if manual {
            self.get_current_index().map(|index| SkipSnapshot {
                index,
                revision: Self::rpc_revision(*mutation, &self.queue.read().unwrap()),
                after_token: 0,
                position_ms: self
                    .spotify
                    .get_current_progress()
                    .as_millis()
                    .min(u32::MAX as u128) as u32,
                playing: !matches!(self.spotify.get_current_status(), PlayerEvent::Paused(_)),
            })
        } else {
            None
        };
        self.next_inner(manual);
        *self.last_skip.lock().unwrap() = snapshot.map(|mut saved| {
            saved.after_token = *self.current_token.read().unwrap();
            saved
        });
    }

    /// Restore a manual skip without a load/seek race or URI lookup ambiguity.
    pub fn undo_skip(&self) -> Result<(), String> {
        let mutation = self.rpc_mutation.lock().unwrap();
        let saved = self
            .last_skip
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "No skip to undo".to_string())?;
        if saved.after_token != *self.current_token.read().unwrap()
            || saved.revision != Self::rpc_revision(*mutation, &self.queue.read().unwrap())
        {
            return Err("Playback or queue changed; skip can no longer be undone".into());
        }
        self.play_at(
            saved.index,
            false,
            false,
            Some((saved.position_ms, saved.playing)),
        );
        Ok(())
    }

    pub fn previous_or_restart(&self) {
        if self.spotify.get_current_progress() > Duration::from_secs(3) {
            self.spotify.seek(0);
        } else {
            self.previous();
        }
    }

    pub(super) fn next_inner(&self, manual: bool) {
        self.observe_listening();
        let finished = self.spotify.get_current_status() == PlayerEvent::FinishedTrack;
        self.listening.lock().unwrap().finish(manual, finished);
        let current = *self.current_track.read().unwrap();
        let repeat = self.cfg.state().repeat;
        // Read what this needs out of the queue and drop the guard before going on:
        // `next_index` and `play` take the same lock again, and a recursive read
        // deadlocks whenever a writer on another thread is already queued behind us.
        let (current_playable, any_playable) = {
            let q = self.queue.read().unwrap();
            (
                current.is_some_and(|index| q.get(index).is_some_and(|track| track.is_playable())),
                q.iter().any(|track| track.is_playable()),
            )
        };

        let current_is_radio = current.is_some_and(|index| self.is_radio_generated(index));
        if repeat == RepeatSetting::RepeatTrack
            && !manual
            && !current_is_radio
            && !self.radio_active()
        {
            if let Some(index) = current
                && current_playable
            {
                self.play(index, false, false);
            }
        } else if let Some(index) = self.next_index() {
            self.play(index, false, false);
            if repeat == RepeatSetting::RepeatTrack && manual {
                self.set_repeat(RepeatSetting::RepeatPlaylist);
            }
        } else if repeat == RepeatSetting::RepeatPlaylist && any_playable {
            if let Some(first) = self.repeatable_index(false) {
                self.play(first, false, false);
            } else {
                // An active station may still be waiting for metadata. Keep the
                // radio generation alive so its worker can refill later, while
                // avoiding a repeat loop over autogenerated entries.
                self.wait_for_radio_or_stop();
            }
        } else {
            self.wait_for_radio_or_stop();
        }
    }

    /// Play the previous item in the queue.
    pub fn previous(&self) {
        let _mutation = self.rpc_mutation.lock().unwrap();
        let current = *self.current_track.read().unwrap();
        let repeat = self.cfg.state().repeat;
        // As in `next`: take the length and release the lock, so the `play` call
        // below is not a recursive read on `self.queue`.
        let length = self.queue.read().unwrap().len();

        if let Some(index) = self.previous_index() {
            self.play_at(index, false, false, Some((0, true)));
        } else if repeat == RepeatSetting::RepeatPlaylist && length > 0 {
            if let Some(last) = self.repeatable_index(true) {
                self.play_at(last, false, false, Some((0, true)));
            }
        } else if let Some(index) = current {
            self.play_at(index, false, false, Some((0, true)));
        }
    }

    /// Handle events that are specific to the queue.
    pub fn handle_event(&self, event: QueueEvent) {
        match event {
            QueueEvent::PreloadTrackRequest => {
                if let Some(next_index) = self.next_index() {
                    self.preload_at(next_index);
                }
            }
        }
    }

    /// The candidate index may become stale while an RPC removes or clears entries.
    pub(super) fn preload_at(&self, index: usize) {
        let track = self.queue.read().unwrap().get(index).cloned();
        if let Some(track) = track {
            debug!("Preloading track {track} as requested by librespot");
            self.spotify.preload(&track);
        }
    }
}
