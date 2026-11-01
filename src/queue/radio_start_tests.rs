use super::test_support::*;
use super::*;

#[test]
fn starting_radio_clears_five_explicit_tracks_without_restarting_the_song() {
    let (queue, spotify) = fixture(vec![playable(0), playable(1)], Some(1));
    queue.play(1, false, false);
    for id in 2..7 {
        queue.append(playable(id));
    }
    let progress = Duration::from_millis(42_123);
    spotify.update_status(PlayerEvent::Paused(progress));
    let mut commands = spotify.capture_commands_for_test();
    let (revision, _, _) = queue.rpc_snapshot();

    let generation = queue.replace_queue_with_radio(&track(1));

    assert_eq!(queue.len(), 1);
    assert_eq!(queue.get_current_index(), Some(0));
    assert_eq!(queue.get_current().unwrap().uri(), uri(1));
    assert!(queue.upcoming(20).is_empty());
    assert_eq!(queue.parked_context_count(), 0);
    assert!(queue.queue_provenance().0.is_empty());
    assert!(queue.queue_provenance().1.is_empty());
    assert_eq!(spotify.get_current_status(), PlayerEvent::Paused(progress));
    assert_eq!(spotify.get_current_progress(), progress);
    assert!(
        commands.try_recv().is_err(),
        "startup must not reload or stop playback"
    );
    assert!(
        queue
            .rpc_checked_action("clear", &revision, None, None)
            .is_err()
    );
    assert!(queue.session_played().contains(&uri(1)));

    // Songs removed from the old queue are available as fresh recommendations.
    assert_eq!(
        queue.append_radio_next_if_current(generation, &uri(1), &radio_batch(2, 6)),
        Some(6)
    );
    assert_eq!(queue.upcoming(20).len(), 6);
    assert!(
        queue
            .upcoming(20)
            .iter()
            .all(|(index, _)| queue.queue_origin(*index) == "radio")
    );
    queue.cancel_radio();
    assert!(
        queue.upcoming(20).is_empty(),
        "stopping must not restore the cleared queue"
    );
}

#[test]
fn starting_radio_rebases_shuffle_and_keeps_the_exact_current_occurrence() {
    let (queue, spotify) = fixture(
        vec![playable(1), playable(2), playable(1), playable(3)],
        Some(2),
    );
    if let Playable::Track(track) = &mut queue.queue.write().unwrap()[2] {
        track.title = "Current occurrence".to_string();
    }
    queue.set_shuffle(true);
    *queue.random_order.write().unwrap() = Some(vec![1, 2, 3, 0]);
    let started = std::time::SystemTime::now() - Duration::from_secs(60);
    spotify.update_status(PlayerEvent::Playing(started));
    let mut commands = spotify.capture_commands_for_test();

    let generation = queue.replace_queue_with_radio(&track(1));

    assert!(queue.get_shuffle());
    assert_eq!(queue.get_random_order(), Some(vec![0]));
    assert_eq!(
        queue.get_current().unwrap().track().unwrap().title,
        "Current occurrence"
    );
    assert_eq!(spotify.get_current_status(), PlayerEvent::Playing(started));
    assert!(commands.try_recv().is_err());
    assert_eq!(
        queue.append_radio_next_if_current(generation, &uri(1), &[playable(4)]),
        Some(1)
    );
    assert_eq!(queue.next_index(), Some(1));
    assert_eq!(queue.get_random_order(), Some(vec![0, 1]));

    // New explicit choices made after startup still take priority over radio.
    queue.append(playable(5));
    assert_eq!(queue.next_index(), Some(2));
}

#[test]
fn restarting_radio_clears_old_station_and_context_and_rejects_delayed_fill() {
    let (queue, _) = fixture(vec![playable(0), playable(1), playable(2)], Some(0));
    let old_generation = queue.start_radio(&uri(0));
    queue.append_radio_at_tail_if_current(old_generation, &uri(0), &[playable(3), playable(4)]);
    queue.play(3, false, false);
    let claim = queue.radio_begin_fill(true, 5).unwrap();
    queue.append(playable(5));
    let heard = queue.session_played();
    let song_keys = queue.session_played_song_keys();

    let generation = queue.replace_queue_with_radio(&track(3));

    assert_ne!(generation, old_generation);
    assert_eq!(queue.len(), 1);
    assert_eq!(queue.get_current().unwrap().uri(), uri(3));
    assert!(queue.resume_context().is_empty());
    assert_eq!(queue.session_played(), heard);
    assert_eq!(queue.session_played_song_keys(), song_keys);
    assert_eq!(
        queue.append_radio_at_tail_if_claim_current(&claim, &[playable(6)]),
        None
    );
    assert!(!queue.radio_finish_fill(old_generation, 1));
    let fresh = queue.radio_begin_fill(true, 5).unwrap();
    assert_eq!(fresh.generation, generation);
    assert_eq!(fresh.current_index, 0);
    assert_eq!(fresh.seed.uri, uri(3));
    assert_ne!(fresh.current_token, claim.current_token);
    assert_eq!(
        queue.append_radio_at_tail_if_claim_current(&fresh, &[playable(6)]),
        Some(1)
    );
}
