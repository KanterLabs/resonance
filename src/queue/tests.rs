use super::*;
use crate::config::Config;
use crate::events::EventManager;
use crate::library::Library;
use crate::model::track::Track;
use crate::spotify::Spotify;

fn make_track(id: u32) -> Playable {
    Playable::Track(Track {
        id: Some(format!("id_{id}")),
        uri: format!("spotify:track:id_{id}"),
        title: format!("Track {id}"),
        track_number: id,
        disc_number: 1,
        duration: 180_000,
        artists: vec!["Artist".to_string()],
        artist_ids: vec![],
        album: Some("Album".to_string()),
        album_id: None,
        album_artists: vec![],
        cover_url: None,
        url: String::new(),
        added_at: None,
        list_index: 0,
        is_local: false,
        // Must be Some(true) so Spotify::load() doesn't fire events.
        is_playable: Some(true),
        isrc: None,
    })
}

#[test]
fn preload_tolerates_entry_removed_after_next_index_snapshot() {
    let queue = make_queue(vec![make_track(1), make_track(2)], Some(0));
    let candidate = queue.next_index().unwrap();
    assert_eq!(candidate, 1);
    queue.remove(candidate);
    queue.preload_at(candidate);
    assert_eq!(queue.len(), 1);
    assert_eq!(queue.get_current_index(), Some(0));
}

#[test]
fn previous_index_tolerates_current_absent_from_new_shuffle_snapshot() {
    let queue = make_queue(vec![make_track(1), make_track(2), make_track(3)], Some(1));
    // Models the order after an edit between current snapshot and order acquisition.
    *queue.random_order.write().unwrap() = Some(vec![0, 2]);
    assert_eq!(queue.previous_index(), None);
}

#[test]
fn shuffle_and_clear_tolerate_stale_current_on_empty_queue() {
    let queue = make_queue(vec![], Some(3));
    queue.generate_random_order();
    assert_eq!(queue.get_random_order(), Some(vec![]));
    queue.clear();
    assert_eq!(queue.get_current_index(), None);
    assert_eq!(queue.len(), 0);
}

#[test]
fn rpc_duplicate_occurrences_and_stale_revision() {
    let queue = make_queue(vec![make_track(1), make_track(1), make_track(2)], None);
    let (revision, items, _) = queue.rpc_snapshot();
    assert_eq!(items.len(), 3);
    let duplicate_id = format!("{revision}:1");
    queue
        .rpc_checked_action("remove", &revision, Some(&duplicate_id), None)
        .unwrap();
    assert_eq!(queue.len(), 2);
    assert_eq!(track_id(&queue.queue.read().unwrap()[0]), "id_1");
    assert_eq!(track_id(&queue.queue.read().unwrap()[1]), "id_2");
    assert!(
        queue
            .rpc_checked_action("remove", &revision, Some(&duplicate_id), None)
            .is_err()
    );
    let (revision, _, _) = queue.rpc_snapshot();
    assert!(
        queue
            .rpc_checked_action("move", &revision, Some(&format!("{revision}:0")), Some(2))
            .is_err()
    );
    queue
        .rpc_checked_action("move", &revision, Some(&format!("{revision}:0")), Some(1))
        .unwrap();
    assert_eq!(track_id(&queue.queue.read().unwrap()[0]), "id_2");
}

#[test]
fn rpc_revision_changes_for_identical_duplicate_reorder() {
    let queue = make_queue(vec![make_track(1), make_track(1)], None);
    let (before, _, _) = queue.rpc_snapshot();
    queue.shift(0, 1);
    let (after, _, _) = queue.rpc_snapshot();
    assert_ne!(before, after);
    assert!(
        queue
            .rpc_checked_action("clear", &before, None, None)
            .is_err()
    );
    queue
        .rpc_checked_action("clear", &after, None, None)
        .unwrap();
    assert_eq!(queue.len(), 0);
}

fn track_id(p: &Playable) -> &str {
    match p {
        Playable::Track(t) => t.id.as_deref().unwrap_or(""),
        Playable::Episode(_) => "",
    }
}

fn make_queue(tracks: Vec<Playable>, current: Option<usize>) -> Queue {
    let cfg = Config::new_for_test();
    let ev = EventManager::new_for_test();
    let spotify = Spotify::new_for_test(cfg.clone(), ev.clone());
    let library = Library::new_for_test(ev, spotify.clone(), cfg.clone());
    Queue::new_for_test(tracks, current, spotify, cfg, library)
}

// --- next_index / previous_index ---

#[test]
fn test_next_index_basic() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(0));
    assert_eq!(q.next_index(), Some(1));
}

#[test]
fn test_next_index_at_end_returns_none() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(2));
    assert_eq!(q.next_index(), None);
}

#[test]
fn test_next_index_no_current_returns_none() {
    let q = make_queue(vec![make_track(0), make_track(1)], None);
    assert_eq!(q.next_index(), None);
}

#[test]
fn test_previous_index_basic() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(2));
    assert_eq!(q.previous_index(), Some(1));
}

#[test]
fn test_previous_index_at_start_returns_none() {
    let q = make_queue(vec![make_track(0), make_track(1)], Some(0));
    assert_eq!(q.previous_index(), None);
}

#[test]
fn test_previous_index_no_current_returns_none() {
    let q = make_queue(vec![make_track(0)], None);
    assert_eq!(q.previous_index(), None);
}

// --- next / previous with shuffle ---

#[test]
fn test_next_index_respects_random_order() {
    // Queue [0,1,2,3], current_track=2, random_order=[2,0,3,1]
    // Position of 2 in order = 0, next position = 1, order[1] = 0 → Some(0)
    let q = make_queue(
        vec![make_track(0), make_track(1), make_track(2), make_track(3)],
        Some(2),
    );
    *q.random_order.write().unwrap() = Some(vec![2, 0, 3, 1]);
    assert_eq!(q.next_index(), Some(0));
}

#[test]
fn test_previous_index_respects_random_order() {
    // Queue [0,1,2,3], current_track=0, random_order=[2,0,3,1]
    // Position of 0 in order = 1, prev position = 0, order[0] = 2 → Some(2)
    let q = make_queue(
        vec![make_track(0), make_track(1), make_track(2), make_track(3)],
        Some(0),
    );
    *q.random_order.write().unwrap() = Some(vec![2, 0, 3, 1]);
    assert_eq!(q.previous_index(), Some(2));
}

#[test]
fn test_next_index_at_end_of_shuffle_order_returns_none() {
    // Queue [0,1,2,3], current_track=1, random_order=[2,0,3,1]
    // Position of 1 in order = 3 (last), next = 4 → None
    let q = make_queue(
        vec![make_track(0), make_track(1), make_track(2), make_track(3)],
        Some(1),
    );
    *q.random_order.write().unwrap() = Some(vec![2, 0, 3, 1]);
    assert_eq!(q.next_index(), None);
}

// --- len, get_current ---

#[test]
fn test_len() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], None);
    assert_eq!(q.len(), 3);
}

#[test]
fn test_get_current_returns_right_track() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(1));
    let current = q.get_current().expect("should have current");
    assert_eq!(track_id(&current), "id_1");
}

#[test]
fn test_get_current_none_when_no_current() {
    let q = make_queue(vec![make_track(0)], None);
    assert!(q.get_current().is_none());
}

// --- append / append_next / insert_after_current ---

#[test]
fn test_append_increases_len() {
    let q = make_queue(vec![make_track(0)], None);
    q.append(make_track(1));
    assert_eq!(q.len(), 2);
}

#[test]
fn test_append_adds_to_end() {
    let q = make_queue(vec![make_track(0), make_track(1)], None);
    q.append(make_track(2));
    let queue = q.queue.read().unwrap();
    assert_eq!(track_id(&queue[2]), "id_2");
}

#[test]
fn test_append_next_inserts_after_current() {
    // [0, 1, 2], current=1 → append_next([3, 4]) → [0, 1, 3, 4, 2]
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(1));
    let first = q.append_next(&[make_track(3), make_track(4)]);
    assert_eq!(first, 2);
    let queue = q.queue.read().unwrap();
    let ids: Vec<&str> = queue.iter().map(track_id).collect();
    assert_eq!(ids, ["id_0", "id_1", "id_3", "id_4", "id_2"]);
}

#[test]
fn test_append_next_no_current_appends_at_end() {
    let q = make_queue(vec![make_track(0), make_track(1)], None);
    let first = q.append_next(&[make_track(2)]);
    assert_eq!(first, 2);
    assert_eq!(q.len(), 3);
}

#[test]
fn test_append_next_in_shuffle_mode_preserves_play_order() {
    // Raw queue [0,1,2,3,4], current=1, play order [3,0,1,4,2].
    let q = make_queue(
        vec![
            make_track(0),
            make_track(1),
            make_track(2),
            make_track(3),
            make_track(4),
        ],
        Some(1),
    );
    q.set_shuffle(true);
    *q.random_order.write().unwrap() = Some(vec![3, 0, 1, 4, 2]);

    let first = q.append_next(&[make_track(5), make_track(6)]);

    assert_eq!(first, 2);
    let queue = q.queue.read().unwrap();
    let ids: Vec<&str> = queue.iter().map(track_id).collect();
    assert_eq!(
        ids,
        ["id_0", "id_1", "id_5", "id_6", "id_2", "id_3", "id_4"]
    );
    drop(queue);
    assert_eq!(
        q.get_random_order(),
        Some(vec![5, 0, 1, 2, 3, 6, 4]),
        "new tracks must follow the current while existing tracks keep their order"
    );
    let play_order = q.in_play_order(0, q.len());
    let play_ids: Vec<String> = play_order
        .iter()
        .map(|(_, track)| track_id(track).to_owned())
        .collect();
    assert_eq!(
        play_ids,
        ["id_3", "id_0", "id_1", "id_5", "id_6", "id_4", "id_2"]
    );
}

#[test]
fn test_append_next_in_shuffle_mode_without_current_appends_in_play_order() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], None);
    q.set_shuffle(true);
    *q.random_order.write().unwrap() = Some(vec![2, 0, 1]);

    let first = q.append_next(&[make_track(3), make_track(4)]);

    assert_eq!(first, 3);
    assert_eq!(q.get_random_order(), Some(vec![2, 0, 1, 3, 4]));
    let play_order = q.in_play_order(0, q.len());
    let play_ids: Vec<String> = play_order
        .iter()
        .map(|(_, track)| track_id(track).to_owned())
        .collect();
    assert_eq!(play_ids, ["id_2", "id_0", "id_1", "id_3", "id_4"]);
}

#[test]
fn test_append_next_empty_preserves_shuffle_order() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(1));
    q.set_shuffle(true);
    *q.random_order.write().unwrap() = Some(vec![2, 0, 1]);

    let first = q.append_next(&[]);

    assert_eq!(first, 2);
    assert_eq!(q.len(), 3);
    assert_eq!(q.get_random_order(), Some(vec![2, 0, 1]));
}

#[test]
fn test_insert_after_current() {
    // [0, 1], current=0 → insert 99 → [0, 99, 1], current still 0, next is 99
    let q = make_queue(vec![make_track(0), make_track(1)], Some(0));
    q.insert_after_current(make_track(99));
    assert_eq!(q.len(), 3);
    assert_eq!(q.get_current_index(), Some(0));
    let queue = q.queue.read().unwrap();
    assert_eq!(track_id(&queue[1]), "id_99");
    assert_eq!(track_id(&queue[2]), "id_1");
}

#[test]
fn test_insert_after_current_no_current_appends() {
    let q = make_queue(vec![make_track(0)], None);
    q.insert_after_current(make_track(1));
    assert_eq!(q.len(), 2);
}

// --- remove ---

#[test]
fn test_remove_item_after_current_keeps_index() {
    // [0, 1, 2], current=0, remove(2) → current stays 0
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(0));
    q.remove(2);
    assert_eq!(q.len(), 2);
    assert_eq!(q.get_current_index(), Some(0));
}

#[test]
fn test_remove_item_before_current_adjusts_index() {
    // [0, 1, 2], current=2, remove(0) → current becomes 1
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(2));
    q.remove(0);
    assert_eq!(q.len(), 2);
    assert_eq!(q.get_current_index(), Some(1));
}

// --- shift ---

#[test]
fn test_shift_moves_item() {
    // [0, 1, 2], shift(2, 0) → [2, 0, 1]
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], None);
    q.shift(2, 0);
    let queue = q.queue.read().unwrap();
    let ids: Vec<&str> = queue.iter().map(track_id).collect();
    assert_eq!(ids, ["id_2", "id_0", "id_1"]);
}

#[test]
fn test_shift_updates_current_when_current_is_moved() {
    // [0, 1, 2], current=2, shift(2, 0) → current becomes 0
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(2));
    q.shift(2, 0);
    assert_eq!(q.get_current_index(), Some(0));
}

// --- shuffle ---

#[test]
fn test_shuffle_generates_random_order() {
    let q = make_queue(
        vec![make_track(0), make_track(1), make_track(2), make_track(3)],
        Some(1),
    );
    q.set_shuffle(true);
    let order = q.get_random_order().expect("random_order should be Some");
    assert_eq!(order.len(), 4);
    // Current track (index 1) must be first.
    assert_eq!(order[0], 1);
    // All queue indices appear exactly once.
    let mut sorted = order.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, [0, 1, 2, 3]);
}

#[test]
fn test_shuffle_disable_clears_order() {
    let q = make_queue(vec![make_track(0), make_track(1)], Some(0));
    q.set_shuffle(true);
    assert!(q.get_random_order().is_some());
    q.set_shuffle(false);
    assert!(q.get_random_order().is_none());
}

#[test]
fn test_append_in_shuffle_mode_maintains_valid_order() {
    // After appending to a shuffled queue, random_order must contain every
    // queue index exactly once.
    let q = make_queue(vec![make_track(0), make_track(1)], Some(0));
    q.set_shuffle(true);
    q.append(make_track(2));
    let order = q.get_random_order().expect("random_order should be Some");
    assert_eq!(order.len(), 3);
    let mut sorted = order.clone();
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        [0, 1, 2],
        "random_order must contain every queue index once"
    );
}

// --- clear ---

#[test]
fn test_clear_empties_queue() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(1));
    q.clear();
    assert_eq!(q.len(), 0);
}

#[test]
fn test_clear_empties_random_order_when_shuffled() {
    let q = make_queue(vec![make_track(0), make_track(1), make_track(2)], Some(1));
    q.set_shuffle(true);
    q.clear();
    // clear() clears the order contents but leaves it as Some([]).
    assert_eq!(q.get_random_order(), Some(vec![]));
}
