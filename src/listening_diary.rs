//! A diary of listening: plays and minutes per local day, and per artist per month.
//!
//! The radio history keys feedback by track and forgets when a listen happened. The
//! listening calendar needs the opposite view, totals by date, so this keeps its own
//! small ledger. Dates are local calendar dates, taken when a listen ends, so a day
//! in the calendar is the day the listener lived through rather than a UTC slice.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use chrono::{Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::model::track::Track;
use crate::recommendations::history::Outcome;

#[cfg(not(test))]
const CACHE_FILE: &str = "listening-diary.json";
/// The diary's own format version rather than the library's `CACHE_VERSION`: a
/// library cache can be thrown away and fetched again, but a diary cannot.
const VERSION: u16 = 1;
/// Days kept: two years and a little, so a full year is always on hand.
const MAX_DAYS: usize = 800;
/// Months kept: two years, plus the month in progress and the one before it.
const MAX_MONTHS: usize = 26;
/// Artists kept per month. The calendar shows ten; the rest is room for one to climb.
const MAX_ARTISTS: usize = 200;
/// The shortest listen that counts as a play, the bar streaming services use.
const MIN_LISTEN_MS: u64 = 30_000;
/// How often recorded plays are written out. A crash costs at most this much.
const SAVE_EVERY: Duration = Duration::from_secs(60);
const TOP_ARTISTS: usize = 10;
const DAY_FORMAT: &str = "%Y-%m-%d";
const MONTH_FORMAT: &str = "%Y-%m";

/// Plays and time listened, for a day, a month or an artist within a month.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tally {
    pub plays: u32,
    pub listened_ms: u64,
}

impl Tally {
    fn add(&mut self, listened_ms: u64) {
        self.plays = self.plays.saturating_add(1);
        self.listened_ms = self.listened_ms.saturating_add(listened_ms);
    }

    /// Whole minutes, rounded, so a day of short listens does not read as zero.
    fn minutes(&self) -> u32 {
        (self.listened_ms.saturating_add(30_000) / 60_000).min(u64::from(u32::MAX)) as u32
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Month {
    /// Kept apart from `artists`, which is trimmed and credits a play to every
    /// performer on it, so neither would sum to the month's real total.
    total: Tally,
    #[serde(default)]
    artists: HashMap<String, Tally>,
}

/// Keys are `YYYY-MM-DD` and `YYYY-MM`, which sort as dates do.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Book {
    #[serde(default)]
    days: BTreeMap<String, Tally>,
    #[serde(default)]
    months: BTreeMap<String, Month>,
}

#[derive(Serialize)]
struct StoredRef<'a> {
    version: u16,
    #[serde(flatten)]
    book: &'a Book,
}

#[derive(Deserialize)]
struct Stored {
    version: u16,
    #[serde(flatten)]
    book: Book,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CalendarDay {
    pub date: String,
    pub plays: u32,
    pub minutes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ArtistTotal {
    pub name: String,
    pub minutes: u32,
    pub plays: u32,
}

/// The `listening.calendar` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Calendar {
    pub today: String,
    pub days: Vec<CalendarDay>,
    pub month: String,
    pub month_minutes: u32,
    pub month_plays: u32,
    pub top_artists: Vec<ArtistTotal>,
}

/// The diary, in memory and, outside tests, on disk.
#[derive(Default)]
pub struct ListeningDiary {
    book: RwLock<Book>,
    /// Where the diary lives. `None` keeps it in memory only.
    path: Option<PathBuf>,
    /// Set by a recorded play, cleared by a save, so shutdown only writes when needed.
    dirty: AtomicBool,
    last_save: Mutex<Option<Instant>>,
    /// Background saves can overlap; this keeps their writes in order.
    saving: Mutex<()>,
}

/// The process-wide diary, loaded from disk the first time it is asked for.
pub fn shared() -> Arc<ListeningDiary> {
    // Tests get an independent memory-only diary, so they never read or write the user's.
    #[cfg(test)]
    {
        Arc::new(ListeningDiary::default())
    }

    #[cfg(not(test))]
    {
        static SHARED: std::sync::OnceLock<Arc<ListeningDiary>> = std::sync::OnceLock::new();
        SHARED
            .get_or_init(|| Arc::new(ListeningDiary::at(crate::config::cache_path(CACHE_FILE))))
            .clone()
    }
}

/// Write any plays recorded since the last save, for shutdown.
pub fn flush() {
    let diary = shared();
    if diary.dirty.load(Ordering::Acquire) {
        diary.save();
    }
}

impl ListeningDiary {
    /// A diary kept at `path`, starting from whatever is already there.
    pub fn at(path: PathBuf) -> Self {
        Self {
            book: RwLock::new(load(&path)),
            path: Some(path),
            ..Self::default()
        }
    }

    /// Note a finished listen, if it was long enough to count, and save now and then.
    pub fn record(self: &Arc<Self>, track: &Track, outcome: Outcome, listened_ms: u64) {
        if self.record_on(track, outcome, listened_ms, Local::now().date_naive()) {
            self.maybe_save();
        }
    }

    /// Note a listen that ended on `day`. A listen counts once it reaches thirty
    /// seconds, or when it played to the end, so a short interlude still counts.
    /// Returns whether it was counted.
    fn record_on(&self, track: &Track, outcome: Outcome, listened_ms: u64, day: NaiveDate) -> bool {
        if listened_ms < MIN_LISTEN_MS && outcome != Outcome::Completed {
            return false;
        }
        let mut book = self.book.write().unwrap();
        book.days
            .entry(day.format(DAY_FORMAT).to_string())
            .or_default()
            .add(listened_ms);
        let month_key = day.format(MONTH_FORMAT).to_string();
        let month = book.months.entry(month_key).or_default();
        month.total.add(listened_ms);
        for name in performers(track) {
            month.artists.entry(name).or_default().add(listened_ms);
        }
        trim_artists(&mut month.artists);
        trim(&mut book);
        drop(book);
        self.dirty.store(true, Ordering::Release);
        true
    }

    /// The calendar for the `days` days ending today.
    pub fn calendar(&self, days: usize) -> Calendar {
        self.calendar_on(days, Local::now().date_naive())
    }

    fn calendar_on(&self, days: usize, today: NaiveDate) -> Calendar {
        let first = today
            .checked_sub_days(Days::new(days.saturating_sub(1) as u64))
            .unwrap_or(NaiveDate::MIN);
        let (first, last) = (
            first.format(DAY_FORMAT).to_string(),
            today.format(DAY_FORMAT).to_string(),
        );
        let month_key = today.format(MONTH_FORMAT).to_string();
        let book = self.book.read().unwrap();
        let days = book
            .days
            .range(first..=last.clone())
            .filter(|(_, tally)| tally.plays > 0)
            .map(|(date, tally)| CalendarDay {
                date: date.clone(),
                plays: tally.plays,
                minutes: tally.minutes(),
            })
            .collect();
        let month = book.months.get(&month_key);
        let total = month.map(|month| month.total).unwrap_or_default();
        let mut artists: Vec<_> = month
            .map(|month| month.artists.iter().collect())
            .unwrap_or_default();
        artists.sort_by(|(a_name, a), (b_name, b)| {
            b.listened_ms
                .cmp(&a.listened_ms)
                .then(b.plays.cmp(&a.plays))
                .then(a_name.cmp(b_name))
        });
        Calendar {
            today: last,
            days,
            month: month_key,
            month_minutes: total.minutes(),
            month_plays: total.plays,
            top_artists: artists
                .into_iter()
                .take(TOP_ARTISTS)
                .map(|(name, tally)| ArtistTotal {
                    name: name.clone(),
                    minutes: tally.minutes(),
                    plays: tally.plays,
                })
                .collect(),
        }
    }

    /// Save, but no more often than `SAVE_EVERY`, and off the playback thread.
    fn maybe_save(self: &Arc<Self>) {
        if self.path.is_none() {
            return;
        }
        {
            let mut last = self.last_save.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < SAVE_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        let diary = self.clone();
        std::thread::spawn(move || diary.save());
    }

    /// Write the diary out, replacing whatever is on disk.
    pub fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let _saving = self.saving.lock().unwrap();
        self.dirty.store(false, Ordering::Release);
        let bytes = {
            let book = self.book.read().unwrap();
            serde_json::to_vec(&StoredRef {
                version: VERSION,
                book: &book,
            })
        };
        let result = bytes
            .map_err(std::io::Error::other)
            .and_then(|bytes| write_atomically(path, &bytes));
        if let Err(error) = result {
            self.dirty.store(true, Ordering::Release);
            log::error!("could not write listening diary {path:?}: {error}");
        }
    }
}

/// Every performer credited on a track, once each. A feature counts as listening
/// to the featured artist too, which is how a listener thinks of it.
fn performers(track: &Track) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in track.artists.iter().map(|name| name.trim()) {
        if !name.is_empty() && !names.iter().any(|known| known == name) {
            names.push(name.to_owned());
        }
    }
    names
}

/// Drop the oldest days and months once the diary outgrows its budget.
fn trim(book: &mut Book) {
    while book.days.len() > MAX_DAYS {
        book.days.pop_first();
    }
    while book.months.len() > MAX_MONTHS {
        book.months.pop_first();
    }
}

/// Drop the least listened artists once a month outgrows its budget.
fn trim_artists(artists: &mut HashMap<String, Tally>) {
    while artists.len() > MAX_ARTISTS {
        let Some(least) = artists
            .iter()
            .min_by(|(a_name, a), (b_name, b)| {
                a.listened_ms
                    .cmp(&b.listened_ms)
                    .then(a.plays.cmp(&b.plays))
                    .then(b_name.cmp(a_name))
            })
            .map(|(name, _)| name.clone())
        else {
            return;
        };
        artists.remove(&least);
    }
}

/// Read a diary, keeping only entries whose keys are real dates. A file that cannot
/// be read as a diary is moved aside rather than overwritten by the next save.
fn load(path: &Path) -> Book {
    let Ok(bytes) = std::fs::read(path) else {
        return Book::default();
    };
    let mut book = match serde_json::from_slice::<Stored>(&bytes) {
        Ok(stored) if stored.version == VERSION => stored.book,
        Ok(stored) => {
            log::warn!(
                "listening diary has version {}; keeping it aside",
                stored.version
            );
            set_aside(path);
            return Book::default();
        }
        Err(error) => {
            log::error!("could not read listening diary {path:?}: {error}");
            set_aside(path);
            return Book::default();
        }
    };
    book.days
        .retain(|day, _| NaiveDate::parse_from_str(day, DAY_FORMAT).is_ok());
    book.months
        .retain(|month, _| NaiveDate::parse_from_str(&format!("{month}-01"), DAY_FORMAT).is_ok());
    for month in book.months.values_mut() {
        trim_artists(&mut month.artists);
    }
    trim(&mut book);
    book
}

fn set_aside(path: &Path) {
    let aside = path.with_extension(format!("json.unreadable-{}", std::process::id()));
    if let Err(error) = std::fs::rename(path, &aside) {
        log::error!("could not move unreadable listening diary aside: {error}");
    }
}

/// Write through a temporary file and rename it into place, so a crash mid-write
/// leaves the previous diary rather than half of a new one.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("json.{}-{id}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(artists: &[&str]) -> Track {
        let mut track = crate::builder::test_track("spotify:track:diary", "a", "b", 180_000);
        track.artists = artists.iter().map(|name| (*name).to_owned()).collect();
        track
    }

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, DAY_FORMAT).unwrap()
    }

    #[test]
    fn a_listen_counts_after_thirty_seconds_or_when_it_completes() {
        let diary = ListeningDiary::default();
        let day = date("2026-10-18");
        let solo = track(&["Solo"]);
        assert!(!diary.record_on(&solo, Outcome::Neutral, 29_999, day));
        assert!(!diary.record_on(&solo, Outcome::EarlySkip, 10_000, day));
        assert!(diary.record_on(&solo, Outcome::EarlySkip, 30_000, day));
        // A short interlude that played to the end still counts.
        assert!(diary.record_on(&solo, Outcome::Completed, 20_000, day));

        let calendar = diary.calendar_on(7, day);
        assert_eq!(
            calendar.days,
            vec![CalendarDay {
                date: "2026-10-18".into(),
                plays: 2,
                minutes: 1,
            }]
        );
        assert_eq!(calendar.month_plays, 2);
        assert!(diary.dirty.load(Ordering::Acquire));
    }

    #[test]
    fn listens_land_in_their_own_day_and_month() {
        let diary = ListeningDiary::default();
        let pair = track(&["Lead", "Feature", "Lead"]);
        diary.record_on(&pair, Outcome::Completed, 180_000, date("2026-09-30"));
        diary.record_on(&pair, Outcome::Completed, 240_000, date("2026-10-01"));
        diary.record_on(
            &track(&["Lead"]),
            Outcome::Neutral,
            60_000,
            date("2026-10-01"),
        );

        let calendar = diary.calendar_on(371, date("2026-10-18"));
        assert_eq!(calendar.today, "2026-10-18");
        assert_eq!(calendar.month, "2026-10");
        assert_eq!(
            calendar.days,
            vec![
                CalendarDay {
                    date: "2026-09-30".into(),
                    plays: 1,
                    minutes: 3,
                },
                CalendarDay {
                    date: "2026-10-01".into(),
                    plays: 2,
                    minutes: 5,
                },
            ]
        );
        // September's listen stays in September.
        assert_eq!((calendar.month_plays, calendar.month_minutes), (2, 5));
        assert_eq!(
            calendar.top_artists,
            vec![
                ArtistTotal {
                    name: "Lead".into(),
                    minutes: 5,
                    plays: 2,
                },
                ArtistTotal {
                    name: "Feature".into(),
                    minutes: 4,
                    plays: 1,
                },
            ]
        );

        // The window ends today and reaches back exactly `days` days.
        let week = diary.calendar_on(7, date("2026-10-07"));
        assert_eq!(week.days.len(), 1);
        assert_eq!(week.days[0].date, "2026-10-01");
        assert!(diary.calendar_on(7, date("2026-10-08")).days.is_empty());
    }

    #[test]
    fn the_calendar_json_has_the_documented_shape() {
        let diary = ListeningDiary::default();
        diary.record_on(
            &track(&["Artist"]),
            Outcome::Completed,
            90_000,
            date("2026-10-18"),
        );
        let value = serde_json::to_value(diary.calendar_on(371, date("2026-10-18"))).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "today": "2026-10-18",
                "days": [{"date": "2026-10-18", "plays": 1, "minutes": 2}],
                "month": "2026-10",
                "month_minutes": 2,
                "month_plays": 1,
                "top_artists": [{"name": "Artist", "minutes": 2, "plays": 1}],
            })
        );
    }

    #[test]
    fn the_diary_stays_within_its_budget() {
        let diary = ListeningDiary::default();
        let start = date("2020-01-01");
        for offset in 0..(MAX_DAYS as u64 + 10) {
            let day = start.checked_add_days(Days::new(offset)).unwrap();
            diary.record_on(&track(&["Artist"]), Outcome::Completed, 60_000, day);
        }
        let book = diary.book.read().unwrap();
        assert_eq!(book.days.len(), MAX_DAYS);
        assert!(!book.days.contains_key("2020-01-01"));
        assert_eq!(book.months.len(), MAX_MONTHS);
        assert!(!book.months.contains_key("2020-01"));
        drop(book);

        let diary = ListeningDiary::default();
        let day = date("2026-10-18");
        diary.record_on(&track(&["Favourite"]), Outcome::Completed, 600_000, day);
        for index in 0..MAX_ARTISTS + 5 {
            let name = format!("Artist {index}");
            diary.record_on(&track(&[&name]), Outcome::Completed, 60_000, day);
        }
        let book = diary.book.read().unwrap();
        let artists = &book.months["2026-10"].artists;
        assert_eq!(artists.len(), MAX_ARTISTS);
        assert!(artists.contains_key("Favourite"));
        // The month total is not trimmed with its artists.
        assert_eq!(book.months["2026-10"].total.plays, MAX_ARTISTS as u32 + 6);
    }

    #[test]
    fn a_saved_diary_loads_back_and_an_unreadable_one_is_kept_aside() {
        let dir = std::env::temp_dir().join(format!(
            "resonance-diary-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("listening-diary.json");

        let diary = ListeningDiary::at(path.clone());
        diary.record_on(
            &track(&["Artist"]),
            Outcome::Completed,
            90_000,
            date("2026-10-18"),
        );
        diary.save();
        assert!(!diary.dirty.load(Ordering::Acquire));
        let loaded = ListeningDiary::at(path.clone());
        assert_eq!(*loaded.book.read().unwrap(), *diary.book.read().unwrap());

        std::fs::write(&path, b"not json").unwrap();
        let fresh = ListeningDiary::at(path.clone());
        assert_eq!(*fresh.book.read().unwrap(), Book::default());
        assert!(!path.exists());
        let aside = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(aside, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
