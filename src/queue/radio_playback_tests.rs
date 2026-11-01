use super::test_support::*;
use super::*;

#[test]
fn natural_exhaustion_keeps_station_alive_until_late_refill() {
    let (queue, spotify) = fixture(vec![playable(0)], Some(0));
    let generation = queue.start_radio(&uri(0));
    queue.append_radio_next_if_current(generation, &uri(0), &[playable(1)]);
    queue.play(1, false, false);
    queue.next(false);
    assert!(queue.radio_natural_end());
    assert!(queue.radio_active());
    assert_eq!(spotify.get_current_status(), PlayerEvent::Stopped);

    let claim = queue
        .radio_begin_fill(false, 5)
        .expect("a stopped station still claims its late refill");
    assert_eq!(claim.generation, generation);
    assert_eq!(claim.seed.uri, uri(0));
    assert_eq!(claim.current_uri, uri(1));
    assert_eq!(
        queue.append_radio_at_tail_if_current(generation, &uri(1), &[playable(2)]),
        Some(1)
    );
    assert!(queue.radio_finish_fill(generation, 1));
    assert!(queue.radio_natural_end());
    assert!(queue.resume_radio_if_ready());
    assert!(!queue.radio_natural_end());
    assert_eq!(queue.get_current_index(), Some(2));
}

#[test]
fn queue_end_during_in_flight_fill_resumes_without_replaying_seed() {
    let (queue, spotify) = fixture(vec![playable(0)], Some(0));
    let generation = queue.start_radio(&uri(0));
    assert!(queue.radio_begin_fill(false, 5).is_some());
    spotify.update_status(PlayerEvent::FinishedTrack);
    queue.next(false);
    assert!(queue.radio_natural_end());
    assert_eq!(spotify.get_current_status(), PlayerEvent::FinishedTrack);
    assert_eq!(
        queue.append_radio_at_tail_if_current(generation, &uri(0), &[playable(1)]),
        Some(1)
    );
    assert!(queue.radio_finish_fill(generation, 1));
    assert!(queue.resume_radio_if_ready());
    assert_eq!(queue.get_current_index(), Some(1));
    assert!(!queue.resume_radio_if_ready());
}

#[test]
fn undo_skip_restores_exact_duplicate_occurrence_and_paused_position() {
    use crate::spotify_worker::WorkerCommand;
    let (queue, spotify) = fixture(vec![playable(1), playable(1), playable(2)], Some(1));
    let mut commands = spotify.capture_commands_for_test();
    spotify.update_status(PlayerEvent::Paused(Duration::from_millis(42_123)));
    queue.next(true);
    assert_eq!(queue.get_current_index(), Some(2));
    while commands.try_recv().is_ok() {}
    queue.undo_skip().unwrap();
    assert_eq!(queue.get_current_index(), Some(1));
    match commands.try_recv().unwrap() {
        WorkerCommand::Load(item, playing, position) => {
            assert_eq!(item.uri(), uri(1));
            assert!(!playing);
            assert_eq!(position, 42_123);
        }
        _ => panic!("undo must load directly at the saved position"),
    }
    assert!(queue.undo_skip().is_err());
}

#[test]
fn undo_skip_rejects_queue_edits_and_unrelated_playback() {
    let (queue, _) = fixture(vec![playable(1), playable(2), playable(3)], Some(0));
    queue.next(true);
    queue.rpc_append_many(&[playable(4)]);
    assert!(queue.undo_skip().is_err());
    assert_eq!(queue.get_current_index(), Some(1));
    queue.next(true);
    queue.play(0, false, false);
    assert!(queue.undo_skip().is_err());
    assert_eq!(queue.get_current_index(), Some(0));
    queue.next(false);
    assert!(queue.undo_skip().is_err());
}

#[test]
fn undo_skip_can_restore_consumed_radio_song() {
    let (queue, spotify) = fixture(vec![playable(1), playable(2)], Some(0));
    queue.radio_generated.write().unwrap().insert(0);
    queue.played_indices.write().unwrap().insert(0);
    spotify.update_status(PlayerEvent::Paused(Duration::from_secs(12)));
    queue.next(true);
    queue.undo_skip().unwrap();
    assert_eq!(queue.get_current_index(), Some(0));
}

#[test]
fn previous_restarts_then_goes_back_on_second_press() {
    use crate::spotify_worker::WorkerCommand;
    let (queue, spotify) = fixture(vec![playable(1), playable(2)], Some(1));
    let mut commands = spotify.capture_commands_for_test();
    spotify.update_status(PlayerEvent::Paused(Duration::from_secs(15)));
    queue.previous_or_restart();
    assert_eq!(queue.get_current_index(), Some(1));
    assert!(matches!(
        commands.try_recv().unwrap(),
        WorkerCommand::Seek(0)
    ));
    queue.previous_or_restart();
    assert_eq!(queue.get_current_index(), Some(0));
}

#[test]
fn previous_can_replay_a_consumed_station_occurrence() {
    let (queue, _) = fixture(vec![playable(1), playable(2)], Some(1));
    queue.radio_generated.write().unwrap().insert(0);
    queue.played_indices.write().unwrap().insert(0);
    queue.previous_or_restart();
    assert_eq!(queue.get_current_index(), Some(0));
}
