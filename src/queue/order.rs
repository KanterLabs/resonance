use super::*;

impl Queue {
    pub(super) fn current_play_position_locked(
        current: Option<usize>,
        random_order: Option<&Vec<usize>>,
        queue_len: usize,
    ) -> Option<usize> {
        current.and_then(|index| {
            random_order
                .and_then(|order| order.iter().position(|&item| item == index))
                .or_else(|| current.filter(|&index| index < queue_len))
        })
    }

    pub(super) fn play_index_at_locked(
        random_order: Option<&Vec<usize>>,
        position: usize,
        queue_len: usize,
    ) -> Option<usize> {
        let index = match random_order {
            Some(order) => *order.get(position)?,
            None => position,
        };
        (index < queue_len).then_some(index)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn upcoming_indices_locked(
        &self,
        count: usize,
        current: Option<usize>,
        random_order: Option<&Vec<usize>>,
        queue_len: usize,
        played: &HashSet<usize>,
        explicit: &HashSet<usize>,
        active_radio: &HashSet<usize>,
        radio_generated: &HashSet<usize>,
        resume_context: &[usize],
        resume_context_valid: bool,
        auto_excluded: &HashSet<usize>,
        radio_active: bool,
    ) -> Vec<usize> {
        let order_len = random_order.map_or(queue_len, Vec::len);
        if order_len == 0 {
            return Vec::new();
        }
        let current_position = Self::current_play_position_locked(current, random_order, queue_len);
        let cyclic_position = |offset: usize| {
            current_position
                .map(|position| (position + 1 + offset) % order_len)
                .unwrap_or(offset)
        };
        if !radio_active {
            if !resume_context_valid {
                let start = current_position.map_or(0, |position| position + 1);
                return (start..order_len)
                    .filter_map(|position| {
                        Self::play_index_at_locked(random_order, position, queue_len)
                    })
                    .filter(|index| {
                        !(played.contains(index) && radio_generated.contains(index))
                            && !auto_excluded.contains(index)
                    })
                    .take(count)
                    .collect();
            }
            let mut upcoming = Vec::new();
            let mut seen = HashSet::new();
            // Explicit entries are user choices and retain priority after a
            // station is stopped, including when they were appended behind a
            // raw radio tail.
            for offset in 0..order_len {
                let position = cyclic_position(offset);
                let Some(index) = Self::play_index_at_locked(random_order, position, queue_len)
                else {
                    continue;
                };
                if explicit.contains(&index)
                    && Some(index) != current
                    && !played.contains(&index)
                    && seen.insert(index)
                {
                    upcoming.push(index);
                    if upcoming.len() == count {
                        return upcoming;
                    }
                }
            }
            // Context that was parked at station start may now lie before the
            // current automatic item in the raw vector. Preserve its original
            // order so stopping radio resumes that context.
            for index in resume_context {
                if *index < queue_len
                    && Some(*index) != current
                    && !played.contains(index)
                    && !radio_generated.contains(index)
                    && seen.insert(*index)
                {
                    upcoming.push(*index);
                    if upcoming.len() == count {
                        return upcoming;
                    }
                }
            }
            // Finally expose ordinary future raw entries. Generated entries
            // from the abandoned station stay parked after cancellation.
            let start = current_position.map_or(0, |position| position + 1);
            for position in start..order_len {
                let Some(index) = Self::play_index_at_locked(random_order, position, queue_len)
                else {
                    continue;
                };
                if !radio_generated.contains(&index)
                    && !auto_excluded.contains(&index)
                    && seen.insert(index)
                {
                    upcoming.push(index);
                    if upcoming.len() == count {
                        return upcoming;
                    }
                }
            }
            return upcoming;
        }

        let mut upcoming = Vec::new();
        // Explicit and current-generation radio entries are station lanes. Walk
        // the whole playback order cyclically: a manual item at the raw tail
        // may become current before automatic items that were inserted earlier.
        for (lane, automatic) in [(explicit, false), (active_radio, true)] {
            let mut seen = HashSet::new();
            for offset in 0..order_len {
                let position = cyclic_position(offset);
                let Some(index) = Self::play_index_at_locked(random_order, position, queue_len)
                else {
                    continue;
                };
                if lane.contains(&index)
                    && Some(index) != current
                    && !played.contains(&index)
                    && (!automatic || !auto_excluded.contains(&index))
                    && seen.insert(index)
                {
                    upcoming.push(index);
                    if upcoming.len() == count {
                        return upcoming;
                    }
                }
            }
        }
        upcoming
    }

    /// Return future entries in the effective playback lane. During radio,
    /// unplayed explicit entries come first, followed by the current station's
    /// automatic entries; restored and older-station context is parked.
    pub fn upcoming(&self, count: usize) -> Vec<(usize, Playable)> {
        if count == 0 {
            return Vec::new();
        }
        let radio = self.radio.lock().unwrap();
        let radio_active = radio.active;
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
        let indices = self.upcoming_indices_locked(
            count,
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
            radio_active,
        );
        drop(radio);
        indices
            .into_iter()
            .filter_map(|index| queue.get(index).cloned().map(|item| (index, item)))
            .collect()
    }

    /// The index of the next item in `self.queue` that should be played. None
    /// if the active station has no eligible lane entries or the queue is at
    /// its end.
    pub fn next_index(&self) -> Option<usize> {
        self.get_current_index()?;
        self.upcoming(1).into_iter().next().map(|(index, _)| index)
    }

    /// The index of the previous item in `self.queue` that should be played.
    /// None if at the start of the queue.
    pub fn previous_index(&self) -> Option<usize> {
        // Copy and release before taking shuffle order: edits acquire order before current.
        let current = self.get_current_index();
        match current {
            Some(mut index) => {
                let random_order = self.random_order.read().unwrap();
                if let Some(order) = random_order.as_ref() {
                    index = order.iter().position(|&i| i == index)?;
                }

                if index > 0 {
                    let mut next_index = index - 1;
                    if let Some(order) = random_order.as_ref() {
                        next_index = order[next_index];
                    }

                    Some(next_index)
                } else {
                    None
                }
            }
            None => None,
        }
    }

    /// Up to `count` items in the order they will play, starting `start` places into
    /// that order, each with its index in `self.queue`.
    pub fn in_play_order(&self, start: usize, count: usize) -> Vec<(usize, Playable)> {
        let random_order = self.random_order.read().unwrap();
        let queue = self.queue.read().unwrap();
        (start..queue.len().min(start.saturating_add(count)))
            .filter_map(|position| {
                let index = match random_order.as_ref() {
                    Some(order) => *order.get(position)?,
                    None => position,
                };
                Some((index, queue.get(index)?.clone()))
            })
            .collect()
    }

    /// Where the item at `index` in `self.queue` falls in the order the queue plays.
    pub fn play_position(&self, index: usize) -> Option<usize> {
        match self.random_order.read().unwrap().as_ref() {
            Some(order) => order.iter().position(|&i| i == index),
            None => Some(index),
        }
    }

    /// Get the current repeat behavior.
    pub fn get_repeat(&self) -> RepeatSetting {
        self.cfg.state().repeat
    }

    /// Find a manual queue item for repeat-playlist wrapping. Autogenerated
    /// radio items are intentionally skipped so repeat settings cannot replay a
    /// station item after the station has advanced.
    pub(super) fn repeatable_index(&self, reverse: bool) -> Option<usize> {
        let radio_active = self.radio.lock().unwrap().active;
        let random_order = self.random_order.read().unwrap();
        let queue = self.queue.read().unwrap();
        let generated = self.radio_generated.read().unwrap();
        let explicit = self.explicit_queued.read().unwrap();
        let active_radio = self.active_radio.read().unwrap();
        let played = self.played_indices.read().unwrap();
        let session_played = self.session_played.lock().unwrap();
        let session_song_keys = self.session_song_keys.lock().unwrap();
        let auto_excluded =
            automatic_session_excluded(&queue, &generated, &session_played, &session_song_keys);
        let indices: Vec<usize> = match random_order.as_ref() {
            Some(order) if reverse => order.iter().rev().copied().collect(),
            Some(order) => order.clone(),
            None if reverse => (0..queue.len()).rev().collect(),
            None => (0..queue.len()).collect(),
        };
        indices.into_iter().find(|index| {
            queue.get(*index).is_some_and(|track| {
                track.is_playable()
                    && if radio_active {
                        (explicit.contains(index) || active_radio.contains(index))
                            && !played.contains(index)
                            && (!active_radio.contains(index) || !auto_excluded.contains(index))
                    } else {
                        !generated.contains(index)
                    }
            })
        })
    }

    /// Set the current repeat behavior and save it to the configuration.
    pub fn set_repeat(&self, new: RepeatSetting) {
        self.cfg.with_state_mut(|s| s.repeat = new);
    }

    /// Get the current shuffle behavior.
    pub fn get_shuffle(&self) -> bool {
        self.cfg.state().shuffle
    }

    /// Get the current order that is used to shuffle.
    pub fn get_random_order(&self) -> Option<Vec<usize>> {
        self.random_order.read().unwrap().clone()
    }

    /// (Re)generate the random shuffle order.
    pub(super) fn generate_random_order(&self) {
        let mut random_order = self.random_order.write().unwrap();
        let q = self.queue.read().unwrap();
        let mut order: Vec<usize> = Vec::with_capacity(q.len());
        let mut random: Vec<usize> = (0..q.len()).collect();

        if let Some(current) =
            (*self.current_track.read().unwrap()).filter(|current| *current < q.len())
        {
            order.push(current);
            random.remove(current);
        }

        let mut rng = rand::rng();
        random.shuffle(&mut rng);
        order.extend(random);

        *random_order = Some(order);
    }

    /// Set the current shuffle behavior.
    pub fn set_shuffle(&self, new: bool) {
        self.cfg.with_state_mut(|s| s.shuffle = new);
        if new {
            self.generate_random_order();
        } else {
            let mut random_order = self.random_order.write().unwrap();
            *random_order = None;
        }
    }
}
