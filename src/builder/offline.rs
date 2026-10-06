//! The audio tap's analysis, run over decoded audio instead of live playback.
//!
//! Arcs measure Deezer previews this way. The readings go through the same level, band and
//! beat code the tap uses while a track plays, on a clock driven by the audio itself, so a
//! preview measured in a few milliseconds lands on the same scale as a fingerprint.

use std::time::Duration;

use super::fingerprint::{BANDS, Sample};
use crate::audio_tap::{BeatDetector, SAMPLE_RATE, WINDOW, bands_of, level_of};

/// How often a reading is taken, matching the live sampler.
const STEP_MS: u64 = 100;
/// Audio played into the beat detector before measuring, a couple of its memory spans.
const WARM_UP: Duration = Duration::from_secs(4);

/// Readings every 100 ms of `mono`, as the live sampler would have taken them, or None when
/// the audio is not at the rate the tap's filters are tuned for or is shorter than a window.
pub fn analyze(mono: &[f32], rate: u32) -> Option<Vec<Sample>> {
    if rate != SAMPLE_RATE as u32 || mono.len() < WINDOW {
        return None;
    }
    let mut beat = BeatDetector::default();
    warm_up(&mut beat, mono, rate);
    let mut readings = Vec::with_capacity(mono.len() / (rate as usize / 10) + 1);
    let mut stereo = Vec::with_capacity(WINDOW * 2);
    let mut next_ms = STEP_MS;
    let mut end = 0;
    // The tap is fed packet by packet, and so is this: a packet is one window of audio.
    for packet in mono.as_chunks::<WINDOW>().0 {
        end += WINDOW;
        stereo.clear();
        stereo.extend(packet.iter().flat_map(|sample| [f64::from(*sample); 2]));
        let at = Duration::from_secs_f64(end as f64 / f64::from(rate));
        beat.feed(&stereo, at);
        let at_ms = at.as_millis() as u64;
        if at_ms >= next_ms {
            let window = &mono[end - WINDOW..end];
            readings.push(Sample {
                level: level_of(window),
                bands: Some(bands_of(window, BANDS)),
                tempo: beat.tempo(),
                position_ms: at_ms,
                elapsed_ms: STEP_MS,
            });
            next_ms += STEP_MS;
        }
    }
    Some(readings)
}

/// Play the opening seconds into the detector once and forget the beats it heard. Its running
/// average starts from silence, so without this the first seconds of any audio read as a run
/// of beats at the fastest rate it allows, and on a 30 s preview that run can set the tempo.
fn warm_up(beat: &mut BeatDetector, mono: &[f32], rate: u32) {
    let frames = (WARM_UP.as_secs_f64() * f64::from(rate)) as usize;
    let mut stereo = Vec::with_capacity(WINDOW * 2);
    for (index, packet) in mono[..frames.min(mono.len())]
        .as_chunks::<WINDOW>()
        .0
        .iter()
        .enumerate()
    {
        stereo.clear();
        stereo.extend(packet.iter().flat_map(|sample| [f64::from(*sample); 2]));
        let at = Duration::from_secs_f64(((index + 1) * WINDOW) as f64 / f64::from(rate));
        beat.feed(&stereo, at);
    }
    beat.forget_beats();
}

#[cfg(test)]
mod tests {
    use super::analyze;

    const RATE: u32 = 44_100;

    /// `seconds` of a quiet 440 Hz tone with a decaying 60 Hz kick every `60 / bpm` seconds.
    fn kicks(bpm: f32, seconds: f32) -> Vec<f32> {
        let length = (seconds * RATE as f32) as usize;
        let mut audio: Vec<f32> = (0..length)
            .map(|index| 0.05 * (std::f32::consts::TAU * 440.0 * index as f32 / RATE as f32).sin())
            .collect();
        let gap = (60.0 / bpm * RATE as f32) as usize;
        for start in (0..length).step_by(gap) {
            for offset in 0..2000.min(length - start) {
                let t = offset as f32 / RATE as f32;
                audio[start + offset] += 0.8
                    * (std::f32::consts::TAU * 60.0 * t).sin()
                    * (-(offset as f32) / 400.0).exp();
            }
        }
        audio
    }

    #[test]
    fn a_steady_beat_reads_as_its_tempo() {
        let readings = analyze(&kicks(120.0, 30.0), RATE).unwrap();
        let tempo = readings.last().and_then(|reading| reading.tempo).unwrap();
        // Beats are timed to the packet they land in, about 23 ms, so a few percent of slack.
        assert!((tempo - 120.0).abs() / 120.0 < 0.04, "read {tempo} BPM");
    }

    #[test]
    fn readings_come_every_tenth_of_a_second() {
        let readings = analyze(&kicks(100.0, 10.0), RATE).unwrap();
        assert!((99..=100).contains(&readings.len()), "{}", readings.len());
        // Readings land on packet boundaries, so each gap is 100 ms give or take a packet.
        assert!(
            readings
                .windows(2)
                .all(|pair| { (70..=130).contains(&(pair[1].position_ms - pair[0].position_ms)) })
        );
        assert!(
            readings
                .iter()
                .all(|reading| reading.bands.as_ref().unwrap().len() == 16)
        );
    }

    #[test]
    fn a_louder_recording_reads_louder() {
        let quiet: Vec<f32> = kicks(120.0, 5.0)
            .iter()
            .map(|sample| sample * 0.1)
            .collect();
        let level = |audio: &[f32]| {
            let readings = analyze(audio, RATE).unwrap();
            readings.iter().map(|reading| reading.level).sum::<f32>() / readings.len() as f32
        };
        assert!(level(&quiet) < level(&kicks(120.0, 5.0)));
    }

    #[test]
    fn other_sample_rates_and_scraps_are_refused() {
        assert!(analyze(&kicks(120.0, 5.0), 48_000).is_none());
        assert!(analyze(&[0.0; 100], RATE).is_none());
    }

    #[test]
    fn a_steady_tone_has_no_tempo() {
        let tone: Vec<f32> = (0..RATE as usize * 20)
            .map(|index| 0.3 * (std::f32::consts::TAU * 220.0 * index as f32 / RATE as f32).sin())
            .collect();
        let readings = analyze(&tone, RATE).unwrap();
        assert!(readings.iter().all(|reading| reading.tempo.is_none()));
    }
}
