//! Deezer's public catalogue, used to find a 30 second preview of a track to measure.
//!
//! No account or key is needed. A track is found by its ISRC, or failing that by a plain
//! title and artist search checked against its length. Every request goes through one
//! process-wide limiter that stays well inside Deezer's quota and backs off when told to.
// Requests are only made from the background worker, which tests do not start.
#![cfg_attr(test, allow(dead_code))]

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::model::track::Track;

const API: &str = "https://api.deezer.com";
/// At most five requests a second; Deezer allows about fifty every five seconds.
const MIN_GAP: Duration = Duration::from_millis(200);
/// How long every request waits after Deezer says the quota is spent.
const QUOTA_PAUSE: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// A 30 s preview at 128 kbps is about 500 KB.
const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
/// A search hit may differ from the Spotify track by this much and still be the same recording.
const DURATION_SLACK_S: i64 = 4;
const SEARCH_LIMIT: usize = 10;
/// Deezer's error codes: quota exceeded, and no data for the query.
const CODE_QUOTA: i64 = 4;
const CODE_NO_DATA: i64 = 800;

#[derive(Clone, Debug, PartialEq)]
pub struct DeezerTrack {
    pub id: u64,
    pub duration_s: u32,
    /// Deezer's own tempo; it reports 0 when it has none, which becomes None.
    pub bpm: Option<f32>,
    pub gain: Option<f32>,
    pub preview: String,
}

#[derive(Debug, PartialEq)]
pub enum Lookup {
    Found(DeezerTrack),
    /// Deezer does not have the track.
    Missing,
    /// Deezer has the track but no preview it will play.
    NoPreview,
}

#[derive(Debug, PartialEq)]
pub enum Error {
    /// Deezer asked us to slow down; every request is paused for a while.
    Quota,
    Network(String),
    Status(u16),
    Api(i64, String),
    Parse(String),
    TooLarge,
    /// A preview link that does not point at Deezer's CDN.
    BadUrl,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Quota => write!(f, "Deezer quota exceeded"),
            Self::Network(error) => write!(f, "network error: {error}"),
            Self::Status(status) => write!(f, "HTTP {status}"),
            Self::Api(code, message) => write!(f, "Deezer error {code}: {message}"),
            Self::Parse(error) => write!(f, "unexpected reply: {error}"),
            Self::TooLarge => write!(f, "preview too large"),
            Self::BadUrl => write!(f, "preview is not on Deezer's CDN"),
        }
    }
}

impl Error {
    /// A short name for the kind of failure, so callers can log each kind once.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Network(_) => "network",
            Self::Status(_) => "status",
            Self::Api(..) => "api",
            Self::Parse(_) => "parse",
            Self::TooLarge => "too_large",
            Self::BadUrl => "bad_url",
        }
    }
}

#[derive(Deserialize)]
struct RawTrack {
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    duration: u32,
    #[serde(default)]
    bpm: Option<f64>,
    #[serde(default)]
    gain: Option<f64>,
    #[serde(default)]
    preview: String,
    #[serde(default = "readable_default")]
    readable: bool,
    #[serde(default)]
    artist: Option<RawArtist>,
}

fn readable_default() -> bool {
    true
}

#[derive(Deserialize)]
struct RawArtist {
    name: String,
}

#[derive(Deserialize)]
struct RawError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: i64,
}

/// Deezer answers errors with HTTP 200 and an `error` object instead of the data.
#[derive(Deserialize)]
#[serde(untagged)]
enum Reply<T> {
    Failed { error: RawError },
    Done(T),
}

#[derive(Deserialize)]
struct SearchPage {
    #[serde(default)]
    data: Vec<RawTrack>,
}

/// Find `track` on Deezer.
pub fn lookup(track: &Track) -> Result<Lookup, Error> {
    if let Some(isrc) = track.isrc.as_deref().filter(|isrc| valid_isrc(isrc))
        && let Some(found) = parse_track(&get(&format!("{API}/track/isrc:{isrc}"))?)?
    {
        return Ok(to_lookup(found));
    }
    let Some(artist) = track.artists.first() else {
        return Ok(Lookup::Missing);
    };
    let query = format!("{} {artist}", track.title);
    let url = reqwest::Url::parse_with_params(
        &format!("{API}/search"),
        &[("q", query.as_str()), ("limit", &SEARCH_LIMIT.to_string())],
    )
    .map_err(|error| Error::Parse(error.to_string()))?;
    let hits = parse_search(&get(url.as_str())?)?;
    let Some(id) = pick(track, &hits) else {
        return Ok(Lookup::Missing);
    };
    // Search hits leave out the tempo and gain, which only the track itself carries.
    Ok(match parse_track(&get(&format!("{API}/track/{id}"))?)? {
        Some(found) => to_lookup(found),
        None => Lookup::Missing,
    })
}

/// Download a preview found by `lookup`. Links are signed and expire, so fetch it straight away.
pub fn download(preview: &str) -> Result<Vec<u8>, Error> {
    if !on_deezer_cdn(preview) {
        return Err(Error::BadUrl);
    }
    wait_turn()?;
    let mut response = client()
        .get(preview)
        .send()
        .map_err(|error| Error::Network(error.to_string()))?;
    check_status(response.status())?;
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_PREVIEW_BYTES)
    {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut response, MAX_PREVIEW_BYTES as u64 + 1),
        &mut bytes,
    )
    .map_err(|error| Error::Network(error.to_string()))?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}

fn valid_isrc(isrc: &str) -> bool {
    isrc.len() == 12 && isrc.chars().all(|c| c.is_ascii_alphanumeric())
}

fn on_deezer_cdn(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host == "dzcdn.net" || host.ends_with(".dzcdn.net"))
    })
}

/// A track reply, or None when Deezer has no such track.
fn parse_track(body: &str) -> Result<Option<RawTrack>, Error> {
    match serde_json::from_str::<Reply<RawTrack>>(body) {
        Ok(Reply::Done(track)) => Ok(Some(track)),
        Ok(Reply::Failed { error }) => failed(error).map(|()| None),
        Err(error) => Err(Error::Parse(error.to_string())),
    }
}

fn parse_search(body: &str) -> Result<Vec<RawTrack>, Error> {
    match serde_json::from_str::<Reply<SearchPage>>(body) {
        Ok(Reply::Done(page)) => Ok(page.data),
        Ok(Reply::Failed { error }) => failed(error).map(|()| Vec::new()),
        Err(error) => Err(Error::Parse(error.to_string())),
    }
}

/// "No data" is an answer, not a failure. Running out of quota pauses every request.
fn failed(error: RawError) -> Result<(), Error> {
    match error.code {
        CODE_NO_DATA => Ok(()),
        CODE_QUOTA => {
            pause();
            Err(Error::Quota)
        }
        code => Err(Error::Api(code, error.message)),
    }
}

/// The search hit that is the same recording as `track`: same title and first artist once
/// versions and features are set aside, and close to the same length.
fn pick(track: &Track, hits: &[RawTrack]) -> Option<u64> {
    let title = comparable(&track.title);
    let artist = comparable(track.artists.first()?);
    let duration_s = i64::from(track.duration / 1000);
    hits.iter()
        .find(|hit| {
            comparable(&hit.title) == title
                && hit
                    .artist
                    .as_ref()
                    .is_some_and(|found| comparable(&found.name) == artist)
                && (i64::from(hit.duration) - duration_s).abs() <= DURATION_SLACK_S
        })
        .map(|hit| hit.id)
}

/// A title or name with bracketed notes, " - Remastered" style suffixes, featured artists and
/// punctuation removed, so the two catalogues' spellings compare equal.
fn comparable(value: &str) -> String {
    let lower = value.to_lowercase();
    let mut kept = String::with_capacity(lower.len());
    let mut depth = 0usize;
    for c in lower.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => kept.push(c),
            _ => {}
        }
    }
    let kept = kept.split(" - ").next().unwrap_or_default();
    let kept = kept.split(" feat.").next().unwrap_or_default();
    kept.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn to_lookup(track: RawTrack) -> Lookup {
    if !track.readable || track.preview.is_empty() {
        return Lookup::NoPreview;
    }
    Lookup::Found(DeezerTrack {
        id: track.id,
        duration_s: track.duration,
        bpm: track
            .bpm
            .filter(|bpm| bpm.is_finite() && *bpm > 0.0)
            .map(|bpm| bpm as f32),
        gain: track.gain.filter(|gain| gain.is_finite()).map(|g| g as f32),
        preview: track.preview,
    })
}

fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Resonance/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

fn get(url: &str) -> Result<String, Error> {
    wait_turn()?;
    let response = client()
        .get(url)
        .send()
        .map_err(|error| Error::Network(error.to_string()))?;
    check_status(response.status())?;
    response
        .text()
        .map_err(|error| Error::Network(error.to_string()))
}

fn check_status(status: reqwest::StatusCode) -> Result<(), Error> {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        pause();
        return Err(Error::Quota);
    }
    if !status.is_success() {
        return Err(Error::Status(status.as_u16()));
    }
    Ok(())
}

/// When the next request may go, and until when every request is held back.
struct Limiter {
    next: Option<Instant>,
    paused_until: Option<Instant>,
}

fn limiter() -> &'static Mutex<Limiter> {
    static LIMITER: Mutex<Limiter> = Mutex::new(Limiter {
        next: None,
        paused_until: None,
    });
    &LIMITER
}

/// Sleep until this request's turn. While a quota pause is on, fail fast instead, so the
/// caller can put the track back rather than tie up a thread.
fn wait_turn() -> Result<(), Error> {
    let wait = {
        let mut limiter = limiter().lock().unwrap();
        let now = Instant::now();
        if limiter.paused_until.is_some_and(|until| until > now) {
            return Err(Error::Quota);
        }
        let at = limiter.next.filter(|next| *next > now).unwrap_or(now);
        limiter.next = Some(at + MIN_GAP);
        at - now
    };
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
    Ok(())
}

fn pause() {
    limiter().lock().unwrap().paused_until = Some(Instant::now() + QUOTA_PAUSE);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artist: &str, duration_ms: u32) -> Track {
        let mut track = crate::builder::test_track("spotify:track:a", artist, "Album", duration_ms);
        track.title = title.to_string();
        track.artists = vec![artist.to_string()];
        track
    }

    const ISRC_HIT: &str = r#"{"id":15646529,"readable":true,"title":"Cut To The Feeling",
        "isrc":"USUM71703861","duration":207,"bpm":114.84,"gain":-6.5,
        "preview":"https://cdnt-preview.dzcdn.net/api/1/1/f/2/c/0/f2c8.mp3?hdnea=exp=1",
        "artist":{"id":1,"name":"Carly Rae Jepsen"}}"#;

    #[test]
    fn an_isrc_hit_carries_tempo_gain_and_preview() {
        let found = to_lookup(parse_track(ISRC_HIT).unwrap().unwrap());
        let Lookup::Found(found) = found else {
            panic!("expected a preview, got {found:?}");
        };
        assert_eq!(found.id, 15646529);
        assert_eq!(found.bpm, Some(114.84));
        assert_eq!(found.gain, Some(-6.5));
        assert!(on_deezer_cdn(&found.preview));
    }

    #[test]
    fn an_unknown_isrc_is_missing_not_an_error() {
        let body = r#"{"error":{"type":"DataException","message":"no data","code":800}}"#;
        assert!(parse_track(body).unwrap().is_none());
    }

    #[test]
    fn other_api_errors_are_reported() {
        let body = r#"{"error":{"type":"Exception","message":"boom","code":100}}"#;
        assert_eq!(
            parse_track(body).err(),
            Some(Error::Api(100, "boom".into()))
        );
    }

    #[test]
    fn a_zero_bpm_means_unknown_and_no_preview_means_none() {
        let body = r#"{"id":1,"duration":200,"bpm":0,"preview":"https://e-cdns-preview-a.dzcdn.net/x.mp3"}"#;
        let Lookup::Found(found) = to_lookup(parse_track(body).unwrap().unwrap()) else {
            panic!("expected a preview");
        };
        assert_eq!(found.bpm, None);
        let body = r#"{"id":1,"duration":200,"preview":"","readable":true}"#;
        assert_eq!(
            to_lookup(parse_track(body).unwrap().unwrap()),
            Lookup::NoPreview
        );
        let body =
            r#"{"id":1,"duration":200,"preview":"https://a.dzcdn.net/x.mp3","readable":false}"#;
        assert_eq!(
            to_lookup(parse_track(body).unwrap().unwrap()),
            Lookup::NoPreview
        );
    }

    const SEARCH: &str = r#"{"data":[
        {"id":11,"title":"grab the wheel (lil uzi vert cover)","duration":196,"artist":{"name":"Lil Lotus"}},
        {"id":12,"title":"Lotus","duration":193,"artist":{"name":"Lil Uzi Vert"}},
        {"id":13,"title":"Lotus (Live)","duration":260,"artist":{"name":"Lil Uzi Vert"}}
    ],"total":3}"#;

    #[test]
    fn search_picks_the_same_recording() {
        let hits = parse_search(SEARCH).unwrap();
        assert_eq!(
            pick(&track("Lotus", "Lil Uzi Vert", 193_861), &hits),
            Some(12)
        );
    }

    #[test]
    fn search_rejects_a_hit_of_the_wrong_length() {
        let hits = parse_search(SEARCH).unwrap();
        assert_eq!(pick(&track("Lotus", "Lil Uzi Vert", 240_000), &hits), None);
        assert_eq!(pick(&track("Lotus", "Someone Else", 193_861), &hits), None);
    }

    #[test]
    fn spellings_compare_equal_across_catalogues() {
        assert_eq!(comparable("Moon & Stars (feat. Someone)"), "moon stars");
        assert_eq!(comparable("Big Iron - Remastered 2002"), "big iron");
        assert_eq!(comparable("Breaking Point (F U)"), "breaking point");
        assert_eq!(comparable("Don't Stop  Me"), "don t stop me");
    }

    #[test]
    fn only_deezer_preview_links_are_downloaded() {
        assert!(on_deezer_cdn(
            "https://cdnt-preview.dzcdn.net/api/1/x.mp3?hdnea=1"
        ));
        assert!(!on_deezer_cdn("http://cdnt-preview.dzcdn.net/x.mp3"));
        assert!(!on_deezer_cdn("https://dzcdn.net.evil.example/x.mp3"));
        assert_eq!(download("https://example.com/x.mp3"), Err(Error::BadUrl));
    }

    #[test]
    fn malformed_isrcs_are_not_sent() {
        assert!(valid_isrc("GBAHS1600463"));
        assert!(!valid_isrc("GB-AHS-16-00463"));
        assert!(!valid_isrc("short"));
    }
}
