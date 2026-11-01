use super::*;

impl Queue {
    /// Insert `track` as the item that should logically follow the currently
    /// playing item, taking into account shuffle status.
    pub fn insert_after_current(&self, track: Playable) {
        let mut generation = self.rpc_mutation.lock().unwrap();
        self.insert_after_current_inner(track);
        *generation = generation.wrapping_add(1);
    }

    pub(super) fn insert_after_current_inner(&self, track: Playable) {
        if let Some(index) = self.get_current_index() {
            let mut random_order = self.random_order.write().unwrap();
            if let Some(order) = random_order.as_mut() {
                let next_i = order.iter().position(|&i| i == index).unwrap();
                // shift everything after the insertion in order
                for item in order.iter_mut() {
                    if *item > index {
                        *item += 1;
                    }
                }
                // finally, add the next track index
                order.insert(next_i + 1, index + 1);
            }
            let mut q = self.queue.write().unwrap();
            q.insert(index + 1, track);
            let inserted = index + 1;
            shift_indices_on_insert(&mut self.explicit_queued.write().unwrap(), inserted, 1);
            self.explicit_queued.write().unwrap().insert(inserted);
            shift_indices_on_insert(&mut self.radio_generated.write().unwrap(), index + 1, 1);
            shift_indices_on_insert(&mut self.active_radio.write().unwrap(), inserted, 1);
            shift_indices_on_insert(&mut self.played_indices.write().unwrap(), index + 1, 1);
            shift_resume_on_insert(&mut self.resume_context.write().unwrap(), inserted, 1);
        } else {
            self.append_inner(track);
        }
    }

    /// Add `track` to the end of the queue.
    pub fn append(&self, track: Playable) {
        let mut generation = self.rpc_mutation.lock().unwrap();
        self.append_inner(track);
        *generation = generation.wrapping_add(1);
    }

    pub(super) fn append_inner(&self, track: Playable) {
        self.append_item_inner(track, true);
    }

    /// Append an item that belongs to a loaded playback context. Context
    /// entries stay unmarked so an active radio station can park and resume
    /// them instead of treating every playlist tail as a manual priority.
    pub(super) fn append_context_inner(&self, track: Playable) {
        self.append_item_inner(track, false);
    }

    pub(super) fn append_item_inner(&self, track: Playable, explicit: bool) {
        let mut random_order = self.random_order.write().unwrap();
        if let Some(order) = random_order.as_mut() {
            order.push(order.len());
        }

        let mut q = self.queue.write().unwrap();
        let index = q.len();
        q.push(track);
        if explicit {
            self.explicit_queued.write().unwrap().insert(index);
        }
    }

    /// Append `tracks` after the currently playing item, taking into account
    /// shuffle status. Returns the first index(in `self.queue`) of added items.
    pub fn append_next(&self, tracks: &[Playable]) -> usize {
        self.append_next_checked(None, tracks).unwrap().0
    }

    /// Compare the seed and insert under the same locks. A delayed radio worker
    /// must never splice its songs behind a track the user switched to.
    pub fn append_next_if_current(&self, seed: &str, tracks: &[Playable]) -> Option<usize> {
        self.append_next_checked(Some(seed), tracks)
            .map(|(_, count)| count)
    }

    pub(super) fn append_next_checked(
        &self,
        seed: Option<&str>,
        tracks: &[Playable],
    ) -> Option<(usize, usize)> {
        let mut generation_guard = self.rpc_mutation.lock().unwrap();
        *generation_guard = generation_guard.wrapping_add(1);
        let mut random_order = self.random_order.write().unwrap();
        let mut q = self.queue.write().unwrap();

        let current = *self.current_track.read().unwrap();
        if let Some(seed) = seed
            && !current
                .and_then(|index| q.get(index))
                .is_some_and(|track| track.uri() == seed)
        {
            return None;
        }
        let filtered;
        let tracks = if seed.is_some() {
            let mut known: std::collections::HashSet<_> = q.iter().map(Playable::uri).collect();
            filtered = tracks
                .iter()
                .filter(|track| known.insert(track.uri()))
                .cloned()
                .collect::<Vec<_>>();
            filtered.as_slice()
        } else {
            tracks
        };
        let first = match current {
            Some(index) => index + 1,
            None => q.len(),
        };

        if !tracks.is_empty() {
            if let Some(order) = random_order.as_mut() {
                let insertion_position = current
                    .and_then(|index| order.iter().position(|&item| item == index))
                    .map_or(order.len(), |position| position + 1);

                // Inserting into the raw queue shifts every existing item at or
                // after `first`; update their shuffle indices before adding the
                // new indices immediately after the current play position.
                for index in order.iter_mut() {
                    if *index >= first {
                        *index += tracks.len();
                    }
                }
                order.splice(
                    insertion_position..insertion_position,
                    first..first + tracks.len(),
                );
            }

            shift_indices_on_insert(
                &mut self.explicit_queued.write().unwrap(),
                first,
                tracks.len(),
            );
            shift_indices_on_insert(
                &mut self.radio_generated.write().unwrap(),
                first,
                tracks.len(),
            );
            shift_indices_on_insert(&mut self.active_radio.write().unwrap(), first, tracks.len());
            shift_indices_on_insert(
                &mut self.played_indices.write().unwrap(),
                first,
                tracks.len(),
            );
            shift_resume_on_insert(
                &mut self.resume_context.write().unwrap(),
                first,
                tracks.len(),
            );

            for (i, track) in (first..).zip(tracks.iter()) {
                q.insert(i, track.clone());
            }
            if seed.is_none() {
                let mut explicit = self.explicit_queued.write().unwrap();
                explicit.extend(first..first + tracks.len());
            }
        }

        Some((first, tracks.len()))
    }

    /// Remove the item at `index`. This doesn't take into account shuffle
    /// status, and will literally remove the item at `index` in `self.queue`.
    pub fn remove(&self, index: usize) {
        let mut generation = self.rpc_mutation.lock().unwrap();
        self.remove_inner(index);
        *generation = generation.wrapping_add(1);
    }

    pub(super) fn remove_inner(&self, index: usize) {
        let (current, len) = {
            // Use the same order as station insertion and shuffle generation.
            let _station = self.radio.lock().unwrap();
            let mut order = self.random_order.write().unwrap();
            let mut items = self.queue.write().unwrap();
            if index >= items.len() {
                return;
            }
            let mut current = self.current_track.write().unwrap();
            let previous = *current;
            items.remove(index);
            shift_indices_on_remove(&mut self.explicit_queued.write().unwrap(), index);
            shift_indices_on_remove(&mut self.radio_generated.write().unwrap(), index);
            shift_indices_on_remove(&mut self.active_radio.write().unwrap(), index);
            shift_indices_on_remove(&mut self.played_indices.write().unwrap(), index);
            shift_resume_on_remove(&mut self.resume_context.write().unwrap(), index);
            if let Some(order) = order.as_mut() {
                order.retain(|item| *item != index);
                for item in order {
                    if *item > index {
                        *item -= 1;
                    }
                }
            }
            match previous {
                Some(position) if position > index => {
                    *current = Some(position - 1);
                }
                Some(position) if position == index => {
                    *current = None;
                    let mut token = self.current_token.write().unwrap();
                    *token = token.wrapping_add(1).max(1);
                }
                _ => {}
            }
            (previous, items.len())
        };
        if len == 0 {
            self.stop();
        } else if current == Some(index) {
            if index < len {
                self.play(index, false, false);
            } else {
                self.stop();
            }
        }
    }

    /// Clear all the items from the queue and stop playback.
    pub fn clear(&self) {
        let mut generation = self.rpc_mutation.lock().unwrap();
        self.clear_inner();
        *generation = generation.wrapping_add(1);
    }

    pub(super) fn clear_inner(&self) {
        self.stop();

        let mut random_order = self.random_order.write().unwrap();
        let mut q = self.queue.write().unwrap();
        q.clear();
        // A concurrent play may have selected an item after stop but before this write lock.
        // Reset while holding items, matching play's items -> current lock order.
        let had_current = self.current_track.write().unwrap().take().is_some();
        if had_current {
            let mut token = self.current_token.write().unwrap();
            *token = token.wrapping_add(1).max(1);
        }
        if let Some(o) = random_order.as_mut() {
            o.clear()
        }
        self.explicit_queued.write().unwrap().clear();
        self.radio_generated.write().unwrap().clear();
        self.active_radio.write().unwrap().clear();
        self.played_indices.write().unwrap().clear();
        self.resume_context.write().unwrap().clear();
        *self.resume_context_valid.write().unwrap() = false;
    }

    /// Shift the item at `from` in `self.queue` to `to`.
    pub fn shift(&self, from: usize, to: usize) {
        let mut generation = self.rpc_mutation.lock().unwrap();
        self.shift_inner(from, to);
        *generation = generation.wrapping_add(1);
    }

    pub(super) fn shift_inner(&self, from: usize, to: usize) {
        let mut random_order = self.random_order.write().unwrap();
        let mut queue = self.queue.write().unwrap();
        let item = queue.remove(from);
        queue.insert(to, item);
        if let Some(order) = random_order.as_mut() {
            for index in order {
                if *index == from {
                    *index = to;
                } else if to < from && *index >= to && *index < from {
                    *index += 1;
                } else if from < to && *index > from && *index <= to {
                    *index -= 1;
                }
            }
        }

        shift_indices_on_move(&mut self.explicit_queued.write().unwrap(), from, to);
        shift_indices_on_move(&mut self.radio_generated.write().unwrap(), from, to);
        shift_indices_on_move(&mut self.active_radio.write().unwrap(), from, to);
        shift_indices_on_move(&mut self.played_indices.write().unwrap(), from, to);
        shift_resume_on_move(&mut self.resume_context.write().unwrap(), from, to);

        // if the currently playing track is affected by the shift, update its
        // index
        let mut current = self.current_track.write().unwrap();
        if let Some(index) = *current {
            if index == from {
                current.replace(to);
            } else if to < from && index >= to && index < from {
                current.replace(index + 1);
            } else if from < to && index > from && index <= to {
                current.replace(index - 1);
            }
        }
    }
}
