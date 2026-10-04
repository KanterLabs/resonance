//! How well one track leads into the next.

use super::fingerprint::Fingerprint;

/// Score, 0 to 1, for playing `next` straight after `previous`, with a short reason when one
/// part of the score stands out. Unknown measurements score neutrally rather than badly.
pub fn transition(
    previous: Option<&Fingerprint>,
    next: Option<&Fingerprint>,
    share_playlist: bool,
) -> (f64, Option<String>) {
    let (tempo, tempo_reason) = tempo_fit(
        previous.and_then(|fingerprint| fingerprint.tempo),
        next.and_then(|fingerprint| fingerprint.tempo),
    );
    let edge = match (previous, next) {
        (Some(a), Some(b)) => 1.0 - (a.outro_energy - b.intro_energy).abs().min(1.0) as f64,
        _ => 0.5,
    };
    let brightness = match (previous, next) {
        (Some(a), Some(b)) => 1.0 - (a.brightness - b.brightness).abs().min(1.0) as f64,
        _ => 0.5,
    };
    let context = if share_playlist { 1.0 } else { 0.4 };
    let score = 0.4 * tempo + 0.3 * edge + 0.1 * brightness + 0.2 * context;
    let reason = tempo_reason.or_else(|| {
        if edge >= 0.9 && previous.is_some() && next.is_some() {
            Some("smooth handoff from the last track's ending".to_string())
        } else if share_playlist {
            Some("shares a playlist with the previous track".to_string())
        } else {
            None
        }
    });
    (score.clamp(0.0, 1.0), reason)
}

/// 1.0 within 4%, falling to 0 at 15%. Double and half time count as matching, since a
/// listener hears 70 and 140 BPM as the same pulse.
pub fn tempo_fit(previous: Option<f32>, next: Option<f32>) -> (f64, Option<String>) {
    let (Some(a), Some(b)) = (previous, next) else {
        return (0.5, None);
    };
    if a <= 0.0 || b <= 0.0 {
        return (0.5, None);
    }
    let difference = [b, b * 2.0, b / 2.0]
        .iter()
        .map(|candidate| ((candidate - a) / a).abs())
        .fold(f32::INFINITY, f32::min) as f64;
    let score = if difference <= 0.04 {
        1.0
    } else if difference >= 0.15 {
        0.0
    } else {
        1.0 - (difference - 0.04) / 0.11
    };
    let reason = (score >= 0.75).then(|| format!("{b:.0} BPM after {a:.0}"));
    (score, reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(tempo: Option<f32>, intro: f32, outro: f32) -> Fingerprint {
        Fingerprint {
            song_key: String::new(),
            energy: 0.5,
            dynamics: 0.2,
            brightness: 0.5,
            tempo,
            tempo_confidence: 0.9,
            intro_energy: intro,
            outro_energy: outro,
            listened_ms: 60_000,
            measured_at: 0,
        }
    }

    #[test]
    fn matching_tempos_score_fully_and_drift_falls_off() {
        assert_eq!(tempo_fit(Some(120.0), Some(122.0)).0, 1.0);
        assert_eq!(tempo_fit(Some(120.0), Some(150.0)).0, 0.0);
        let middle = tempo_fit(Some(120.0), Some(131.0)).0;
        assert!(middle > 0.0 && middle < 1.0);
    }

    #[test]
    fn double_and_half_time_match() {
        assert_eq!(tempo_fit(Some(70.0), Some(140.0)).0, 1.0);
        assert_eq!(tempo_fit(Some(140.0), Some(70.0)).0, 1.0);
    }

    #[test]
    fn unknown_tempo_is_neutral() {
        assert_eq!(tempo_fit(None, Some(120.0)), (0.5, None));
        assert_eq!(transition(None, None, false).1, None);
    }

    #[test]
    fn a_soft_ending_prefers_a_soft_start() {
        let fade = fingerprint(None, 0.6, 0.1);
        let soft = fingerprint(None, 0.1, 0.6);
        let loud = fingerprint(None, 0.9, 0.6);
        assert!(
            transition(Some(&fade), Some(&soft), false).0
                > transition(Some(&fade), Some(&loud), false).0
        );
    }
}
