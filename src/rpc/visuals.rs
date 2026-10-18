//! `artwork.cover` and `listening.calendar`: art for any result row, and the
//! listening calendar drawn from the diary.
use super::{Result, invalid, string};
use crate::artwork::{self, ArtworkCache};
use crate::listening_diary::ListeningDiary;
use serde_json::{Value, json};

const CALENDAR_MIN_DAYS: u64 = 7;
const CALENDAR_MAX_DAYS: u64 = 400;
/// Fifty-three weeks: a full year of week columns, whatever weekday today is.
const CALENDAR_DEFAULT_DAYS: u64 = 371;

/// The cover at `url` as the same cell grid `player.artwork` returns.
///
/// The URL comes from a client rather than from Spotify metadata, so it is held to
/// the Spotify CDNs before the cache is even asked. A foreign URL is an unavailable
/// cover, not an error, so a row with odd art simply draws without it.
pub(super) fn cover(cache: &ArtworkCache, p: &Value) -> Result<Value> {
    let url = string(p, "url")?;
    let width = super::dimension(p, "width", artwork::DEFAULT_WIDTH, artwork::MAX_WIDTH)?;
    let height = super::dimension(p, "height", artwork::DEFAULT_HEIGHT, artwork::MAX_HEIGHT)?;
    let unavailable = |reason: &str| json!({"available":false,"url":url,"width":width,"height":height,"reason":reason});
    if let Err(error) = artwork::check_cover_url(url) {
        return Ok(unavailable(error.reason()));
    }
    Ok(
        match cache.get_or_fetch_with_image(url, width, height, false) {
            Ok(artwork) => json!({
                "available": true,
                "url": url,
                "width": width,
                "height": height,
                "pixels": artwork.pixels,
            }),
            Err(error) => unavailable(error.reason()),
        },
    )
}

/// Plays and minutes per day for the last `days` days, and this month's totals.
pub(super) fn calendar(diary: &ListeningDiary, p: &Value) -> Result<Value> {
    let days = match p.get("days") {
        None | Some(Value::Null) => CALENDAR_DEFAULT_DAYS,
        Some(value) => value
            .as_u64()
            .filter(|days| (CALENDAR_MIN_DAYS..=CALENDAR_MAX_DAYS).contains(days))
            .ok_or_else(|| {
                invalid(format!(
                    "days must be an integer from {CALENDAR_MIN_DAYS} to {CALENDAR_MAX_DAYS}"
                ))
            })?,
    };
    Ok(json!(diary.calendar(days as usize)))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture_track, service};
    use super::*;
    use crate::model::{
        artist::Artist, episode::Episode, playable::Playable, playlist::Playlist, show::Show,
    };

    const COVER: &str = "https://i.scdn.co/image/row-cover";

    #[test]
    fn rows_carry_a_cover_only_when_there_is_one() {
        let mut track = fixture_track("CoverTrack", "Cover", 0);
        assert!(super::super::track(&track).get("cover_url").is_none());
        track.cover_url = Some(COVER.into());
        assert_eq!(super::super::track(&track)["cover_url"], COVER);
        track.cover_url = Some("  ".into());
        assert!(super::super::track(&track).get("cover_url").is_none());

        let mut album: crate::model::album::Album = serde_json::from_value(json!({
            "id":"CoverAlbum","title":"Album","artists":["Artist"],"artist_ids":[],
            "year":"2026","cover_url":COVER,"url":null,"tracks":null,"added_at":null
        }))
        .unwrap();
        assert_eq!(super::super::album(&album)["cover_url"], COVER);
        album.cover_url = None;
        assert!(super::super::album(&album).get("cover_url").is_none());

        let mut artist = Artist::new("CoverArtist".into(), "Artist".into());
        assert!(super::super::artist(&artist).get("cover_url").is_none());
        artist.cover_url = Some(COVER.into());
        assert_eq!(super::super::artist(&artist)["cover_url"], COVER);

        let mut playlist = Playlist {
            id: "CoverPlaylist".into(),
            name: "Playlist".into(),
            owner_id: "owner".into(),
            owner_name: None,
            snapshot_id: "snapshot".into(),
            num_tracks: 0,
            tracks: None,
            collaborative: false,
            cover_url: None,
        };
        assert!(super::super::playlist(&playlist).get("cover_url").is_none());
        playlist.cover_url = Some(COVER.into());
        assert_eq!(super::super::playlist(&playlist)["cover_url"], COVER);

        let episode = Episode {
            id: "CoverEpisode".into(),
            uri: "spotify:episode:CoverEpisode".into(),
            duration: 1000,
            name: "Episode".into(),
            description: String::new(),
            release_date: "2026-10-18".into(),
            cover_url: Some(COVER.into()),
            added_at: None,
            list_index: 0,
        };
        assert_eq!(super::super::episode(&episode)["cover_url"], COVER);
        // Queue rows are built from the same row builders.
        assert_eq!(
            super::super::playable(&Playable::Episode(episode.clone()))["cover_url"],
            COVER
        );
        let show = Show {
            id: "CoverShow".into(),
            uri: "spotify:show:CoverShow".into(),
            name: "Show".into(),
            description: String::new(),
            cover_url: None,
            episodes: None,
        };
        assert!(super::super::show(&show).get("cover_url").is_none());

        // An artist or playlist cached before covers were kept still loads.
        let old: Artist = serde_json::from_value(json!({
            "id":"Old","name":"Old","url":null,"tracks":null,"is_followed":true
        }))
        .unwrap();
        assert!(old.cover_url.is_none());
    }

    #[test]
    fn cover_returns_the_cached_grid_for_a_spotify_url() {
        let service = service();
        let pixels: Vec<String> = ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF"]
            .into_iter()
            .map(String::from)
            .collect();
        service
            .artwork
            .remember_for_test(COVER, 2, 1, pixels.clone());
        let result = service
            .dispatch("artwork.cover", &json!({"url":COVER,"width":2,"height":1}))
            .unwrap();
        assert_eq!(
            result,
            json!({"available":true,"url":COVER,"width":2,"height":1,"pixels":pixels})
        );
    }

    #[test]
    fn cover_refuses_a_foreign_url_without_asking_the_cache_or_the_network() {
        let service = service();
        let foreign = "https://example.com/image/row-cover";
        // Even a cached grid under the foreign URL is not served.
        service
            .artwork
            .remember_for_test(foreign, 1, 1, vec!["#010203".into()]);
        let result = service
            .dispatch(
                "artwork.cover",
                &json!({"url":foreign,"width":1,"height":1}),
            )
            .unwrap();
        assert_eq!(
            result,
            json!({"available":false,"url":foreign,"width":1,"height":1,
                   "reason":"unsupported_cover_url"})
        );
        for (url, reason) in [
            ("http://i.scdn.co/image/row-cover", "unsupported_cover_url"),
            (
                "https://i.scdn.co.example.com/image/x",
                "unsupported_cover_url",
            ),
            ("not a url", "invalid_cover_url"),
        ] {
            let result = service
                .dispatch("artwork.cover", &json!({ "url": url }))
                .unwrap();
            assert_eq!(result["available"], false, "{url}");
            assert_eq!(result["reason"], reason, "{url}");
            assert_eq!(result["width"], artwork::DEFAULT_WIDTH);
            assert_eq!(result["height"], artwork::DEFAULT_HEIGHT);
        }
    }

    #[test]
    fn cover_requires_a_url_and_bounded_dimensions() {
        let service = service();
        for params in [
            json!({}),
            json!({"url":""}),
            json!({"url":"  "}),
            json!({"url":7}),
            json!({"url":COVER,"width":0}),
            json!({"url":COVER,"height":artwork::MAX_HEIGHT + 1}),
        ] {
            let error = service.dispatch("artwork.cover", &params).unwrap_err();
            assert_eq!(error.code, "invalid_params", "{params}");
        }
    }

    #[test]
    fn calendar_has_its_shape_and_bounded_days() {
        let service = service();
        let result = service.dispatch("listening.calendar", &json!({})).unwrap();
        let today = result["today"].as_str().unwrap();
        assert_eq!(today.len(), 10);
        assert_eq!(result["month"], today[..7]);
        assert_eq!(result["days"], json!([]));
        assert_eq!(result["month_minutes"], 0);
        assert_eq!(result["month_plays"], 0);
        assert_eq!(result["top_artists"], json!([]));
        assert!(
            service
                .dispatch("listening.calendar", &json!({"days":7}))
                .is_ok()
        );
        assert!(
            service
                .dispatch("listening.calendar", &json!({"days":400}))
                .is_ok()
        );
        for days in [json!(6), json!(401), json!("30"), json!(-1)] {
            let error = service
                .dispatch("listening.calendar", &json!({ "days": days }))
                .unwrap_err();
            assert_eq!(error.code, "invalid_params");
        }
    }
}
