use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures::SinkExt;
use log::{debug, error, info};
use tokio::net::{UnixListener, UnixStream};
use tokio::runtime::Handle;
use tokio::sync::watch::{Receiver, Sender};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::WatchStream;
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use crate::audio_tap::AudioTap;
use crate::events::{Event, EventManager, Notification};
use crate::model::playable::Playable;
use crate::model::track::Track;
use crate::queue::Queue;
use crate::rpc::RpcService;
use crate::spotify::PlayerEvent;
use crate::traits::ListItem;
use resonance::BIN_NAME;
use std::os::unix::fs::{FileTypeExt, MetadataExt};

mod energy;

pub struct IpcSocket {
    tx: Sender<Status>,
    path: PathBuf,
    worker: tokio::task::JoinHandle<()>,
    socket_identity: (u64, u64),
}

#[derive(Clone, Debug, Serialize)]
struct Status {
    mode: PlayerEvent,
    playable: Option<Playable>,
    prototype: PrototypeStatus,
    notifications: Vec<Notification>,
}

#[derive(Clone, Debug, Serialize)]
struct PrototypeStatus {
    position_ms: u64,
    discovery: u8,
    volume_percent: u16,
    radio_active: bool,
    radio_waiting: bool,
    up_next: Vec<Track>,
    up_next_origins: Vec<String>,
    audio: Option<AudioStatus>,
    energy: Option<energy::EnergyStatus>,
}

#[derive(Clone, Debug, Serialize)]
struct AudioStatus {
    bands: Vec<f32>,
    level: f32,
    pulse: f32,
    tempo: Option<f32>,
}

/// A connection's subscription to the audio feed: how often, and in how much detail.
///
/// The status snapshot only goes out twice a second, which is plenty for a track
/// title and far too slow to draw music by. A frontend that wants to visualize
/// asks for this instead, and gets audio alone at its own rate.
#[derive(Clone, Copy, Debug, PartialEq)]
struct AudioFeed {
    fps: u64,
    bands: usize,
    waveform: usize,
}

impl AudioFeed {
    /// The feed a connection is left with after an `audio.*` response: the one it
    /// just asked for, none if it unsubscribed, or the one it had if it failed.
    fn after(response: &serde_json::Value, current: Option<Self>) -> Option<Self> {
        if response["ok"] != true {
            return current;
        }
        let result = &response["result"];
        if result["subscribed"] != true {
            return None;
        }
        Some(Self {
            fps: result["fps"].as_u64().filter(|fps| *fps > 0)?,
            bands: result["bands"].as_u64()? as usize,
            waveform: result["waveform"].as_u64()? as usize,
        })
    }

    fn clock(self) -> tokio::time::Interval {
        let mut clock = tokio::time::interval(Duration::from_secs(1) / self.fps as u32);
        // A frame that comes late is stale; skip it rather than send a burst.
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        clock
    }
}

/// One frame of the audio feed, sent as its own line beside the status snapshots.
#[derive(Debug, Serialize)]
struct AudioFrame {
    audio: AudioReading,
}

#[derive(Debug, Serialize)]
struct AudioReading {
    /// False once playback has stopped or paused; the other fields then read as
    /// silence, and frames stop until sound comes back.
    live: bool,
    bands: Vec<f32>,
    waveform: Vec<f32>,
    level: f32,
    pulse: f32,
    /// Beats heard so far. A change between frames means one landed.
    beats: u64,
    tempo: Option<f32>,
}

impl AudioReading {
    fn take(tap: &AudioTap, feed: AudioFeed) -> Self {
        Self {
            live: tap.is_live(),
            bands: tap.bands(feed.bands).unwrap_or_default(),
            waveform: tap.waveform(feed.waveform).unwrap_or_default(),
            level: tap.level(),
            pulse: tap.pulse(),
            beats: tap.beats(),
            tempo: tap.tempo(),
        }
    }
}

/// Whether a request line is about this connection's audio feed, which the
/// connection has to act on itself rather than hand off.
fn is_audio_request(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line).is_ok_and(|request| {
        request["method"]
            .as_str()
            .is_some_and(|method| method.starts_with("audio."))
    })
}

impl Status {
    fn from_queue(queue: &Queue) -> Self {
        let spotify = queue.get_spotify();
        let upcoming: Vec<_> = queue
            .upcoming(16)
            .into_iter()
            .filter_map(|(index, item)| item.track().map(|track| (index, track)))
            .collect();
        let up_next: Vec<Track> = upcoming.iter().map(|(_, track)| track.clone()).collect();
        let current = queue.get_current();
        let previous: Vec<Playable> = queue.get_current_index().map_or_else(Vec::new, |index| {
            let items = queue.queue.read().unwrap();
            let index = index.min(items.len());
            items[index.saturating_sub(energy::PREVIOUS)..index].to_vec()
        });
        let energy = energy::status(
            &crate::builder::fingerprint::shared(),
            current.as_ref(),
            &previous,
            &up_next,
        );
        Self {
            notifications: spotify.events().notifications(),
            mode: spotify.get_current_status(),
            playable: current,
            prototype: PrototypeStatus {
                position_ms: spotify
                    .get_current_progress()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
                discovery: queue.get_library().cfg.discovery(),
                volume_percent: (f64::from(spotify.volume()) / 65535.0 * 100.0).round() as u16,
                radio_active: queue.radio_active(),
                radio_waiting: queue.radio_waiting() || queue.radio_natural_end(),
                up_next,
                up_next_origins: upcoming
                    .iter()
                    .map(|(index, _)| queue.queue_origin(*index).to_owned())
                    .collect(),
                audio: spotify.audio_tap().bands(32).map(|bands| {
                    let tap = spotify.audio_tap();
                    AudioStatus {
                        bands,
                        level: tap.level(),
                        pulse: tap.pulse(),
                        tempo: tap.tempo(),
                    }
                }),
                energy,
            },
        }
    }
}

impl Drop for IpcSocket {
    fn drop(&mut self) {
        self.worker.abort();
        self.try_remove_socket();
    }
}

impl IpcSocket {
    pub fn new(
        handle: &Handle,
        path: PathBuf,
        ev: EventManager,
        queue: Arc<Queue>,
    ) -> io::Result<Self> {
        let path = if path.exists() && Self::is_open_socket(&path) {
            let mut new_path = path;
            new_path.set_file_name(format!("{BIN_NAME}.{}.sock", std::process::id()));
            new_path
        } else if path.exists() && !Self::is_open_socket(&path) {
            if !std::fs::symlink_metadata(&path)?.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "IPC path is occupied by a non-socket file",
                ));
            }
            std::fs::remove_file(&path)?;
            path
        } else {
            path
        };

        info!("Creating IPC domain socket at {path:?}");

        let status = Status::from_queue(&queue);

        let (tx, rx) = tokio::sync::watch::channel(status);
        let listener = {
            let _runtime = handle.enter();
            UnixListener::bind(&path)?
        };
        let metadata = std::fs::symlink_metadata(&path)?;
        let socket_identity = (metadata.dev(), metadata.ino());
        let worker_tx = tx.clone();
        let worker = handle.spawn(async move {
            Self::worker(listener, ev, worker_tx, rx, queue).await;
        });

        Ok(Self {
            tx,
            path,
            worker,
            socket_identity,
        })
    }

    fn is_open_socket(path: &PathBuf) -> bool {
        std::os::unix::net::UnixStream::connect(path).is_ok()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn publish(&self, queue: &Queue) {
        self.tx.send_replace(Status::from_queue(queue));
    }

    async fn worker(
        listener: UnixListener,
        ev: EventManager,
        tx: Sender<Status>,
        rx: Receiver<Status>,
        queue: Arc<Queue>,
    ) {
        let rpc = Arc::new(RpcService::from_queue(queue.clone(), ev.clone()));
        let tap = queue.get_spotify().audio_tap();
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, sockaddr)) => {
                        debug!("Connection from {sockaddr:?}");
                        // Refresh before subscription so a newly opened frontend gets live state immediately.
                        tx.send_replace(Status::from_queue(&queue));
                        tokio::spawn(Self::stream_handler(stream, ev.clone(), WatchStream::new(rx.clone()), rpc.clone(), tap.clone()));
                    }
                    Err(e) => error!("Error accepting connection: {e}"),
                },
                _ = ticker.tick() => {
                    // The worker owns one receiver. Avoid snapshots when no frontend is connected.
                    if tx.receiver_count() > 1 {
                        tx.send_replace(Status::from_queue(&queue));
                    }
                }
            }
        }
    }

    async fn stream_handler(
        mut stream: UnixStream,
        ev: EventManager,
        mut rx: WatchStream<Status>,
        rpc: Arc<RpcService>,
        tap: Arc<AudioTap>,
    ) -> Result<(), String> {
        let (reader, writer) = stream.split();
        let mut framed_reader =
            FramedRead::new(reader, LinesCodec::new_with_max_length(1024 * 1024));
        let mut framed_writer = FramedWrite::new(writer, LinesCodec::new());
        let (responses_tx, mut responses_rx) = tokio::sync::mpsc::channel::<serde_json::Value>(32);

        let inflight = Arc::new(tokio::sync::Semaphore::new(16));
        let mut feed: Option<AudioFeed> = None;
        let mut audio_clock: Option<tokio::time::Interval> = None;
        // Whether the last frame sent had sound in it, so silence is sent once
        // rather than at the full frame rate for as long as playback is paused.
        let mut sent_live = true;
        loop {
            tokio::select! {
                line = framed_reader.next() => {
                    match line {
                        Some(Ok(line)) => {
                            debug!("Received IPC request ({} bytes)", line.len());
                            if line.trim_start().starts_with('{') && is_audio_request(&line) {
                                // Answered here and now: it only checks parameters, and the
                                // feed has to change before the next frame is due.
                                let response = rpc.handle_line(&line);
                                let next = AudioFeed::after(&response, feed);
                                if next != feed {
                                    feed = next;
                                    audio_clock = feed.map(AudioFeed::clock);
                                    sent_live = true;
                                }
                                framed_writer.send(serde_json::to_string(&response).map_err(|e| e.to_string())?)
                                    .await.map_err(|e| e.to_string())?;
                            } else if line.trim_start().starts_with('{') || line.trim_start().starts_with('[') {
                                let service = rpc.clone();
                                let responses = responses_tx.clone();
                                match inflight.clone().try_acquire_owned() {
                                    Ok(permit) => {
                                        tokio::task::spawn_blocking(move || {
                                            let _permit = permit;
                                            let response = service.handle_line(&line);
                                            let _ = responses.blocking_send(response);
                                        });
                                    }
                                    Err(_) => {
                                        let response = service.busy_response(&line);
                                        framed_writer.send(serde_json::to_string(&response).map_err(|e| e.to_string())?)
                                            .await.map_err(|e| e.to_string())?;
                                    }
                                }
                            } else {
                                ev.send(Event::IpcInput(line));
                            }
                        }
                        Some(Err(e)) => error!("Error reading line: {e}"),
                        None => {
                            debug!("Closing IPC connection");
                            return Ok(())
                        }
                    }
                }
                Some(response) = responses_rx.recv() => {
                    framed_writer.send(serde_json::to_string(&response).map_err(|e| e.to_string())?)
                        .await.map_err(|e| e.to_string())?;
                }
                _ = async { audio_clock.as_mut().unwrap().tick().await }, if audio_clock.is_some() => {
                    let Some(feed) = feed else { continue; };
                    let audio = AudioReading::take(&tap, feed);
                    if !audio.live && !sent_live {
                        continue;
                    }
                    sent_live = audio.live;
                    let frame = serde_json::to_string(&AudioFrame { audio }).map_err(|e| e.to_string())?;
                    framed_writer.send(frame).await.map_err(|e| e.to_string())?;
                }
                status = rx.next() => {
                    let Some(status) = status else { return Ok(()); };
                    debug!("IPC Status update: {status:?}");
                    let status_str = serde_json::to_string(&status).map_err(|e| e.to_string())?;
                    framed_writer.send(status_str).await.map_err(|e| e.to_string())?;
                }
                else => {
                    error!("All streams are closed");
                    return Ok(())
                }
            }
        }
    }

    /// Try to remove the IPC socket if there is one for this instance of Resonance. Don't do
    /// anything if the socket has already been removed for some reason.
    fn try_remove_socket(&mut self) {
        let owned = std::fs::symlink_metadata(&self.path).is_ok_and(|meta| {
            meta.file_type().is_socket() && (meta.dev(), meta.ino()) == self.socket_identity
        });
        if owned && std::fs::remove_file(&self.path).is_ok() {
            info!("removed socket at {:?}", self.path);
        } else {
            info!("socket already removed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, library::Library, spotify::Spotify};

    fn fixture_track(index: usize) -> Track {
        Track {
            id: Some(format!("FixtureTrack{index:02}")),
            uri: format!("spotify:track:FixtureTrack{index:02}"),
            title: format!("Fixture Track {index}"),
            track_number: index as u32 + 1,
            disc_number: 1,
            duration: 180_000,
            artists: vec!["Fixture Artist".to_owned()],
            artist_ids: vec![],
            album: Some("Fixture Album".to_owned()),
            album_id: Some("FixtureAlbum".to_owned()),
            album_artists: vec!["Fixture Artist".to_owned()],
            cover_url: None,
            url: String::new(),
            added_at: None,
            list_index: index,
            is_local: false,
            is_playable: Some(true),
            isrc: None,
        }
    }

    #[test]
    fn status_up_next_includes_sixteen_tracks_after_current() {
        let config = Config::new_for_test();
        let events = EventManager::new_for_test();
        let spotify = Spotify::new_for_test(config.clone(), events.clone());
        let library = Library::new_for_test(events, spotify.clone(), config.clone());
        let items = (0..20)
            .map(|index| Playable::Track(fixture_track(index)))
            .collect();
        let queue = Queue::new_for_test(items, Some(3), spotify, config, library);

        let status = Status::from_queue(&queue);
        let up_next = status
            .prototype
            .up_next
            .iter()
            .map(|track| track.id.as_deref().unwrap())
            .collect::<Vec<_>>();
        let expected = (4..20)
            .map(|index| format!("FixtureTrack{index:02}"))
            .collect::<Vec<_>>();

        assert_eq!(up_next.len(), 16);
        assert_eq!(
            up_next,
            expected.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(!up_next.contains(&"FixtureTrack03"));
    }

    #[test]
    fn status_up_next_reports_only_station_lane_with_explicit_provenance() {
        let config = Config::new_for_test();
        let events = EventManager::new_for_test();
        let spotify = Spotify::new_for_test(config.clone(), events.clone());
        let library = Library::new_for_test(events, spotify.clone(), config.clone());
        let seed = fixture_track(0);
        let queue = Queue::new_for_test(
            (0..100)
                .map(|index| Playable::Track(fixture_track(index)))
                .collect(),
            Some(0),
            spotify,
            config,
            library,
        );
        queue.start_radio_track(&seed);
        queue.rpc_append_many(&[Playable::Track(fixture_track(101))]);
        let status = Status::from_queue(&queue);
        assert_eq!(status.prototype.up_next.len(), 1);
        assert_eq!(
            status.prototype.up_next[0].id.as_deref(),
            Some("FixtureTrack101")
        );
        assert_eq!(status.prototype.up_next_origins, vec!["explicit"]);
        assert_eq!(queue.queue.read().unwrap().len(), 101);
    }

    #[test]
    fn audio_feed_follows_subscribe_and_unsubscribe_responses() {
        let current = AudioFeed {
            fps: 30,
            bands: 64,
            waveform: 0,
        };
        let subscribed = serde_json::json!({"ok":true,"result":{"subscribed":true,"fps":60,"bands":32,"waveform":128}});
        assert_eq!(
            AudioFeed::after(&subscribed, Some(current)),
            Some(AudioFeed {
                fps: 60,
                bands: 32,
                waveform: 128
            })
        );
        let unsubscribed = serde_json::json!({"ok":true,"result":{"subscribed":false}});
        assert_eq!(AudioFeed::after(&unsubscribed, Some(current)), None);
        // A rejected request leaves whatever the connection already had.
        let failed = serde_json::json!({"ok":false,"error":{"code":"invalid_params"}});
        assert_eq!(AudioFeed::after(&failed, Some(current)), Some(current));
        assert_eq!(AudioFeed::after(&failed, None), None);
    }

    #[test]
    fn only_audio_methods_are_kept_by_the_connection() {
        assert!(is_audio_request(
            r#"{"protocol":"resonance","version":1,"id":1,"method":"audio.subscribe"}"#
        ));
        assert!(is_audio_request(r#"{"id":1,"method":"audio.unsubscribe"}"#));
        assert!(!is_audio_request(r#"{"id":1,"method":"player.status"}"#));
        assert!(!is_audio_request(r#"{"id":1}"#));
        assert!(!is_audio_request("not json"));
    }

    #[test]
    fn a_silent_tap_reads_as_not_live() {
        let reading = AudioReading::take(
            &AudioTap::new(),
            AudioFeed {
                fps: 30,
                bands: 16,
                waveform: 64,
            },
        );
        assert!(!reading.live);
        assert!(reading.bands.is_empty() && reading.waveform.is_empty());
        assert_eq!(reading.beats, 0);
    }

    /// Hosts the actual IPC/RPC stack for an externally driven OpenTUI integration test.
    /// This test never starts authentication, a Spotify worker, or library refresh.
    #[test]
    #[ignore = "requires an external frontend driver and RESONANCE_TEST_SOCKET"]
    fn opentui_frontend_fixture() {
        use crate::model::{artist::Artist, episode::Episode, playlist::Playlist, show::Show};
        let path = PathBuf::from(
            std::env::var("RESONANCE_TEST_SOCKET").expect("fixture socket path required"),
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let config = Config::new_for_test();
        let events = EventManager::new();
        let spotify = Spotify::new_for_test(config.clone(), events.clone());
        let library = Library::new_for_test(events.clone(), spotify.clone(), config.clone());
        let track = |id: &str, title: &str, index| Track {
            id: Some(id.to_owned()),
            uri: format!("spotify:track:{id}"),
            title: title.to_owned(),
            track_number: index as u32 + 1,
            disc_number: 1,
            duration: 180_000,
            artists: vec!["Fixture Artist".to_owned()],
            artist_ids: vec!["FixtureArtist000000001".to_owned()],
            album: Some("Fixture Album".to_owned()),
            album_id: Some("FixtureAlbum0000000001".to_owned()),
            album_artists: vec!["Fixture Artist".to_owned()],
            cover_url: None,
            url: String::new(),
            added_at: None,
            list_index: index,
            is_local: false,
            is_playable: Some(true),
            isrc: None,
        };
        let alpha = track("FixtureTrackAlpha00001", "Fixture Alpha", 0);
        let beta = track("FixtureTrackBeta000002", "Fixture Beta", 1);
        *library.tracks.write().unwrap() = vec![alpha.clone(), beta.clone()];
        let mut artist = Artist::new(
            "FixtureArtist000000001".to_owned(),
            "Fixture Artist".to_owned(),
        );
        artist.tracks = Some(vec![alpha.clone(), beta.clone()]);
        artist.is_followed = true;
        library.artists.write().unwrap().push(artist);
        let album = serde_json::from_value(serde_json::json!({
            "id":"FixtureAlbum0000000001","title":"Fixture Album","artists":["Fixture Artist"],
            "artist_ids":["FixtureArtist000000001"],"year":"2026","cover_url":null,"url":null,
            "tracks":[alpha.clone(),beta.clone()],"added_at":null,"total_tracks":2
        }))
        .unwrap();
        library.albums.write().unwrap().push(album);
        let mut duplicate = alpha.clone();
        duplicate.list_index = 1;
        let mut final_track = beta.clone();
        final_track.list_index = 2;
        let items = vec![
            Playable::Track(alpha.clone()),
            Playable::Track(duplicate),
            Playable::Track(final_track),
        ];
        library.playlists.write().unwrap().push(Playlist {
            id: "FixturePlaylist000001".to_owned(),
            name: "Fixture Duplicates".to_owned(),
            owner_id: "FixtureOwner000000001".to_owned(),
            owner_name: Some("Fixture Owner".to_owned()),
            snapshot_id: "fixture-snapshot-1".to_owned(),
            num_tracks: 3,
            tracks: Some(items.clone()),
            collaborative: true,
            cover_url: None,
        });
        library.shows.write().unwrap().push(Show {
            id: "FixtureShow00000000001".to_owned(),
            uri: "spotify:show:FixtureShow00000000001".to_owned(),
            name: "Fixture Podcast".to_owned(),
            description: "Cached fixture podcast".to_owned(),
            cover_url: None,
            episodes: Some(vec![Episode {
                id: "FixtureEpisode0000001".to_owned(),
                uri: "spotify:episode:FixtureEpisode0000001".to_owned(),
                duration: 240_000,
                name: "Fixture Episode".to_owned(),
                description: "Cached episode".to_owned(),
                release_date: "2026-10-01".to_owned(),
                cover_url: None,
                added_at: None,
                list_index: 0,
            }]),
        });
        library.set_load_state_for_test(crate::library::LoadState::Ready);
        let queue = Arc::new(Queue::new_for_test(
            items,
            None,
            spotify,
            config.clone(),
            library,
        ));
        let ipc = IpcSocket::new(
            runtime.handle(),
            path.clone(),
            events.clone(),
            queue.clone(),
        )
        .unwrap();
        events.notify("Fixture engine ready");
        let stopped = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(60), async {
                loop {
                    if events
                        .msg_iter()
                        .any(|event| matches!(event, Event::Shutdown))
                    {
                        break;
                    }
                    ipc.publish(&queue);
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
        });
        drop(ipc);
        assert!(
            stopped.is_ok(),
            "frontend driver did not issue quit within 60 seconds"
        );
        assert!(!path.exists(), "fixture must remove its socket on shutdown");
    }

    #[test]
    fn prototype_receives_live_state_and_sends_commands_to_existing_engine() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let config = Config::new_for_test();
        let events = EventManager::new();
        let spotify = Spotify::new_for_test(config.clone(), events.clone());
        let library = Library::new_for_test(events.clone(), spotify.clone(), config.clone());
        let queue = Arc::new(Queue::new_for_test(
            vec![],
            None,
            spotify,
            config.clone(),
            library,
        ));
        let path = std::env::temp_dir().join(format!(
            "resonance-prototype-{}.sock",
            rand::random::<u64>()
        ));
        let ipc = IpcSocket::new(runtime.handle(), path.clone(), events.clone(), queue).unwrap();
        runtime.block_on(async {
            let client = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(client) = UnixStream::connect(&path).await {
                        break client;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let (read, write) = client.into_split();
            let mut read = FramedRead::new(read, LinesCodec::new());
            let mut write = FramedWrite::new(write, LinesCodec::new());
            let initial = tokio::time::timeout(Duration::from_secs(2), read.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let initial: serde_json::Value = serde_json::from_str(&initial).unwrap();
            assert_eq!(initial["mode"], "Stopped");
            assert!(initial["playable"].is_null());
            assert_eq!(initial["prototype"]["discovery"], 50);
            config.set_discovery(75);
            let updated = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let line = read.next().await.unwrap().unwrap();
                    let state: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if state["prototype"]["discovery"] == 75 {
                        break state;
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(updated["prototype"]["position_ms"], 0);
            write.send(r#"{"protocol":"resonance","version":1,"id":"integration","method":"session.info","params":{}}"#.to_owned()).await.unwrap();
            let response = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let line = read.next().await.unwrap().unwrap();
                    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if response["id"] == "integration" { break response; }
                }
            }).await.unwrap();
            assert_eq!(response["ok"], true);
            assert_eq!(response["protocol"], "resonance");
            assert_eq!(response["result"]["version"], 1);
            assert!(response["result"]["capabilities"].as_array().unwrap().iter().any(|method| method == "queue.action"));
            write.send("discovery 25".to_string()).await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if events.msg_iter().any(
                        |event| matches!(event, Event::IpcInput(input) if input == "discovery 25"),
                    ) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        });
        drop(ipc);
        assert!(!path.exists());
    }
}
