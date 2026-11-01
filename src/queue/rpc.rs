use super::*;

impl Queue {
    /// Append and select one exact occurrence atomically with other structural edits.
    pub fn rpc_append_play(&self, item: Playable) {
        self.rpc_append_play_many(&[item]);
    }

    /// Append an entire explicit user context without interleaving radio insertions.
    pub fn rpc_append_many(&self, items: &[Playable]) {
        if items.is_empty() {
            return;
        }
        let mut generation = self.rpc_mutation.lock().unwrap();
        for item in items {
            self.append_inner(item.clone());
        }
        *generation = generation.wrapping_add(1);
    }

    /// Append a complete playback context and select its first exact occurrence atomically.
    pub fn rpc_append_play_many(&self, items: &[Playable]) {
        if items.is_empty() {
            return;
        }
        let mut generation = self.rpc_mutation.lock().unwrap();
        // Choosing a fresh playback context is an explicit station escape:
        // discard the parked continuation so this newly selected context owns
        // the next lane. Existing raw items remain retained in the queue.
        self.cancel_radio();
        self.resume_context.write().unwrap().clear();
        *self.resume_context_valid.write().unwrap() = false;
        let index = self.len();
        for item in items {
            self.append_context_inner(item.clone());
        }
        self.play(index, false, false);
        *generation = generation.wrapping_add(1);
    }

    /// Select a radio seed that is outside the current queue while preserving
    /// the station's parked continuation. The station is initialized before
    /// the new occurrence is appended, so capturing the old current position
    /// cannot mistake the newly selected seed for retained context.
    pub fn rpc_append_play_radio_seed(&self, track: &Track) -> u64 {
        let _mutation = self.rpc_mutation.lock().unwrap();
        let current_matches = self
            .get_current()
            .is_some_and(|item| item.uri() == track.uri);
        let generation = self.start_radio_track_locked(track);
        if !current_matches {
            let index = self.len();
            self.append_item_inner(Playable::Track(track.clone()), true);
            self.play(index, false, false);
        }
        generation
    }

    /// A revision identifies one exact structural snapshot, including duplicate occurrences.
    pub fn rpc_snapshot(&self) -> (String, Vec<Playable>, Option<usize>) {
        let generation = self.rpc_mutation.lock().unwrap();
        let items = self.queue.read().unwrap().clone();
        let revision = Self::rpc_revision(*generation, &items);
        (revision, items, self.get_current_index())
    }

    pub(super) fn rpc_revision(generation: u64, items: &[Playable]) -> String {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        generation.hash(&mut hash);
        for item in items {
            item.uri().hash(&mut hash);
        }
        format!("{:016x}", hash.finish())
    }

    /// Validate and mutate under the same structural lock used by queue and radio edits.
    pub fn rpc_checked_action(
        &self,
        action: &str,
        revision: &str,
        entry_id: Option<&str>,
        to: Option<usize>,
    ) -> Result<(), String> {
        let mut generation = self.rpc_mutation.lock().unwrap();
        let (current_revision, len) = {
            let items = self.queue.read().unwrap();
            (Self::rpc_revision(*generation, &items), items.len())
        };
        if revision != current_revision {
            return Err("Queue changed; refresh before editing".into());
        }
        let index = if action == "clear" {
            0
        } else {
            let prefix = format!("{revision}:");
            entry_id
                .and_then(|id| id.strip_prefix(&prefix))
                .and_then(|index| index.parse::<usize>().ok())
                .filter(|index| *index < len)
                .ok_or_else(|| "Queue entry no longer exists".to_string())?
        };
        match action {
            "play" => {
                let active = self.radio.lock().unwrap().active;
                let consumed = self.played_indices.read().unwrap().contains(&index);
                let automatic = self.radio_generated.read().unwrap().contains(&index);
                if consumed && (active || automatic) {
                    return Err(
                        "Entry already played this session; append another occurrence to replay"
                            .into(),
                    );
                }
                self.play(index, false, false);
            }
            "remove" => self.remove_inner(index),
            "clear" => self.clear_inner(),
            "move" => {
                let destination = to
                    .filter(|to| *to < len)
                    .ok_or_else(|| "Destination out of bounds".to_string())?;
                self.shift_inner(index, destination);
            }
            _ => return Err("Unsupported queue mutation".into()),
        }
        if action != "play" {
            *generation = generation.wrapping_add(1);
        }
        Ok(())
    }
}
