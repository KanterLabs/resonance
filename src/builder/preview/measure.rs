//! Turning a downloaded preview into a measurement.

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::Preview;
use crate::audio_tap::fold_tempo;
use crate::builder::deezer::DeezerTrack;
use crate::builder::{fingerprint, offline};
use crate::model::track::Track;
use crate::recommendations::engine::song_key;

/// Deezer's tempo agreed with an independent source for 78 of 80 benchmark tracks.
const DEEZER_TEMPO_CONFIDENCE: f32 = 0.9;
/// The tap's tempo on a preview agreed only 57% of the time, so it needs to be surer of
/// itself than on a full listen before it is kept.
const MIN_PREVIEW_TEMPO_CONFIDENCE: f32 = 0.8;

/// Measure `track` from the preview Deezer found for it.
pub fn measure(track: &Track, found: &DeezerTrack, mp3: &[u8], now: i64) -> Preview {
    let fingerprint = decode(mp3).and_then(|(mono, rate)| analyse(track, found, &mono, rate, now));
    Preview {
        song_key: song_key(track),
        deezer_id: Some(found.id),
        fingerprint,
        deezer_bpm: found.bpm,
        deezer_gain: found.gain,
        checked_at: now,
    }
}

/// A record that Deezer had nothing usable for `track`.
#[cfg_attr(test, allow(dead_code))]
pub fn unmeasured(track: &Track, now: i64) -> Preview {
    Preview {
        song_key: song_key(track),
        deezer_id: None,
        fingerprint: None,
        deezer_bpm: None,
        deezer_gain: None,
        checked_at: now,
    }
}

fn analyse(
    track: &Track,
    found: &DeezerTrack,
    mono: &[f32],
    rate: u32,
    now: i64,
) -> Option<fingerprint::Fingerprint> {
    let readings = offline::analyze(mono, rate)?;
    let mut measured = fingerprint::from_samples(track, &readings, now)?;
    match found.bpm {
        Some(bpm) => {
            measured.tempo = Some((fold_tempo(bpm) * 10.0).round() / 10.0);
            measured.tempo_confidence = DEEZER_TEMPO_CONFIDENCE;
        }
        None if measured.tempo_confidence < MIN_PREVIEW_TEMPO_CONFIDENCE => measured.tempo = None,
        None => {}
    }
    Some(measured)
}

/// Decode an MP3 to mono samples and its sample rate.
fn decode(mp3: &[u8]) -> Option<(Vec<f32>, u32)> {
    let source = MediaSourceStream::new(
        Box::new(std::io::Cursor::new(without_id3(mp3).to_vec())),
        Default::default(),
    );
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let mut format = probed.format;
    let stream = format.default_track()?;
    let id = stream.id;
    let rate = stream.codec_params.sample_rate?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&stream.codec_params, &DecoderOptions::default())
        .ok()?;
    let mut mono = Vec::new();
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // The end of the stream arrives as an unexpected end of file.
            Err(DecodeError::IoError(_)) => break,
            Err(_) => return None,
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // A damaged frame is skipped, as a player would.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(_) => return None,
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let samples =
            buffer.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if samples.capacity() < decoded.capacity() * channels {
            *samples = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        samples.copy_interleaved_ref(decoded);
        mono.extend(
            samples
                .samples()
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
    }
    (!mono.is_empty()).then_some((mono, rate))
}

/// The audio after any ID3v2 tag. Deezer's previews start with an empty tag that symphonia's
/// probe cannot read, and nothing in the tag is needed.
fn without_id3(mp3: &[u8]) -> &[u8] {
    let Some(header) = mp3.get(..10).filter(|header| header.starts_with(b"ID3")) else {
        return mp3;
    };
    // The size is four 7 bit bytes, and does not count the header or an optional footer.
    let size = header[6..10]
        .iter()
        .fold(0usize, |size, byte| (size << 7) | usize::from(byte & 0x7f));
    let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
    mp3.get(10 + size + footer..).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::test_track;

    const TONE: &[u8] = include_bytes!("../fixtures/tone-3s.mp3");

    fn found(bpm: Option<f32>) -> DeezerTrack {
        DeezerTrack {
            id: 7,
            duration_s: 200,
            bpm,
            gain: Some(-8.0),
            preview: String::new(),
        }
    }

    /// `seconds` of a 120 BPM kick over a quiet tone, at 44.1 kHz.
    fn kicks(seconds: f32) -> Vec<f32> {
        let rate = 44_100.0;
        let length = (seconds * rate) as usize;
        let mut audio: Vec<f32> = (0..length)
            .map(|index| 0.05 * (std::f32::consts::TAU * 440.0 * index as f32 / rate).sin())
            .collect();
        for start in (0..length).step_by(22_050) {
            for offset in 0..2000.min(length - start) {
                audio[start + offset] += 0.8
                    * (std::f32::consts::TAU * 60.0 * offset as f32 / rate).sin()
                    * (-(offset as f32) / 400.0).exp();
            }
        }
        audio
    }

    #[test]
    fn an_mp3_decodes_to_mono_at_its_rate() {
        let (mono, rate) = decode(TONE).unwrap();
        assert_eq!(rate, 44_100);
        let seconds = mono.len() as f32 / rate as f32;
        assert!((2.9..3.2).contains(&seconds), "{seconds} s");
        // ffmpeg's test tone peaks at about -21 dBFS.
        assert!(mono.iter().any(|sample| sample.abs() > 0.05));
    }

    #[test]
    fn a_leading_id3_tag_is_skipped() {
        // Deezer's previews open with an ID3v2.4 tag that declares no contents.
        let mut tagged = b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();
        tagged.extend_from_slice(TONE);
        assert_eq!(without_id3(&tagged).len(), TONE.len());
        let (mono, _) = decode(&tagged).unwrap();
        assert_eq!(mono.len(), decode(TONE).unwrap().0.len());

        let mut sized = b"ID3\x03\x00\x00\x00\x00\x01\x01".to_vec();
        sized.extend(std::iter::repeat_n(0u8, 129));
        sized.extend_from_slice(b"audio");
        assert_eq!(without_id3(&sized), b"audio");
    }

    #[test]
    fn garbage_does_not_decode() {
        assert!(decode(b"not an mp3 at all").is_none());
    }

    #[test]
    fn a_preview_too_short_to_trust_is_kept_as_unmeasured() {
        let track = test_track("spotify:track:a", "a", "a", 200_000);
        let preview = measure(&track, &found(None), TONE, 10);
        assert_eq!(preview.deezer_id, Some(7));
        assert_eq!(preview.fingerprint, None);
        assert_eq!(preview.checked_at, 10);
    }

    #[test]
    fn a_preview_measures_without_edges_and_prefers_deezer_tempo() {
        let track = test_track("spotify:track:a", "a", "a", 200_000);
        let measured = analyse(&track, &found(Some(174.0)), &kicks(30.0), 44_100, 0).unwrap();
        assert!(!measured.edges);
        assert!(measured.energy > 0.0);
        // 174 folds into the tap's range as 87.
        assert_eq!(measured.tempo, Some(87.0));
        assert_eq!(measured.tempo_confidence, DEEZER_TEMPO_CONFIDENCE);

        let own = analyse(&track, &found(None), &kicks(30.0), 44_100, 0).unwrap();
        let tempo = own.tempo.expect("a clean beat is confident");
        assert!((tempo - 120.0).abs() < 5.0, "{tempo}");
    }

    #[test]
    fn an_unsure_tempo_from_a_preview_is_dropped() {
        let track = test_track("spotify:track:a", "a", "a", 200_000);
        // A steady tone has no beat to find.
        let tone: Vec<f32> = (0..44_100 * 25)
            .map(|index| 0.3 * (std::f32::consts::TAU * 220.0 * index as f32 / 44_100.0).sin())
            .collect();
        let measured = analyse(&track, &found(None), &tone, 44_100, 0).unwrap();
        assert_eq!(measured.tempo, None);
    }
}
