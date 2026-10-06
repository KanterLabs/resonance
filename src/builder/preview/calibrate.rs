//! Putting preview energy on the scale of listened energy.
//!
//! A preview is usually the chorus, so it runs louder than the whole track. Once enough songs
//! have been both previewed and played, a straight line fitted through those pairs maps one
//! onto the other. Until then a preview takes the listened energy at the same rank.

use std::collections::HashMap;

use crate::builder::fingerprint::Fingerprint;

/// Songs measured both ways before a fitted line is trusted.
const MIN_PAIRS: usize = 20;
/// Measurements on each side before ranks are matched.
const MIN_RANKED: usize = 20;

#[derive(Clone, Debug, PartialEq)]
pub enum Calibration {
    Linear {
        slope: f32,
        offset: f32,
    },
    /// Preview and listened energies, each sorted.
    Ranked {
        previews: Vec<f32>,
        listened: Vec<f32>,
    },
    Unchanged,
}

impl Calibration {
    /// `pairs` are (preview, listened) raw energies of songs measured both ways; `previews`
    /// and `listened` are every raw energy of each kind.
    pub fn fit(pairs: &[(f32, f32)], previews: &[f32], listened: &[f32]) -> Self {
        if let Some((slope, offset)) = line(pairs) {
            let error = pairs
                .iter()
                .map(|(preview, heard)| (slope * preview + offset - heard).abs())
                .sum::<f32>()
                / pairs.len() as f32;
            log::debug!(
                "arc previews: listened ≈ {slope:.3}·preview + {offset:.3} over {} songs, mean error {error:.3}",
                pairs.len()
            );
            return Self::Linear { slope, offset };
        }
        if previews.len() >= MIN_RANKED && listened.len() >= MIN_RANKED {
            let sorted = |values: &[f32]| {
                let mut values = values.to_vec();
                values.sort_by(f32::total_cmp);
                values
            };
            return Self::Ranked {
                previews: sorted(previews),
                listened: sorted(listened),
            };
        }
        Self::Unchanged
    }

    pub fn apply(&self, raw: f32) -> f32 {
        match self {
            Self::Linear { slope, offset } => (slope * raw + offset).clamp(0.0, 1.0),
            Self::Ranked { previews, listened } => {
                let rank = previews.partition_point(|other| *other < raw) as f32
                    / (previews.len() - 1).max(1) as f32;
                let position = rank.clamp(0.0, 1.0) * (listened.len() - 1) as f32;
                let low = position.floor() as usize;
                let high = (low + 1).min(listened.len() - 1);
                let blend = position - low as f32;
                listened[low] * (1.0 - blend) + listened[high] * blend
            }
            Self::Unchanged => raw,
        }
    }

    /// `previews` with their energy calibrated.
    pub fn apply_all(
        &self,
        mut previews: HashMap<String, Fingerprint>,
    ) -> HashMap<String, Fingerprint> {
        for fingerprint in previews.values_mut() {
            fingerprint.energy = self.apply(fingerprint.energy);
        }
        previews
    }
}

/// The least squares line through `pairs`, when there are enough and they rise together.
fn line(pairs: &[(f32, f32)]) -> Option<(f32, f32)> {
    if pairs.len() < MIN_PAIRS {
        return None;
    }
    let n = pairs.len() as f32;
    let mean_x = pairs.iter().map(|(x, _)| x).sum::<f32>() / n;
    let mean_y = pairs.iter().map(|(_, y)| y).sum::<f32>() / n;
    let (covariance, variance) = pairs.iter().fold((0.0, 0.0), |(c, v), (x, y)| {
        (c + (x - mean_x) * (y - mean_y), v + (x - mean_x).powi(2))
    });
    if variance <= f32::EPSILON {
        return None;
    }
    let slope = covariance / variance;
    // A flat or falling line means the pairs are noise, not a scale to map onto.
    (slope > 0.0).then_some((slope, mean_y - slope * mean_x))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enough_pairs_fit_a_line() {
        let pairs: Vec<(f32, f32)> = (0..30)
            .map(|index| {
                let preview = 0.5 + index as f32 / 100.0;
                (preview, preview * 0.8 + 0.02)
            })
            .collect();
        let calibration = Calibration::fit(&pairs, &[], &[]);
        assert!((calibration.apply(0.7) - 0.58).abs() < 1e-4);
    }

    #[test]
    fn noise_does_not_fit_a_line() {
        let pairs: Vec<(f32, f32)> = (0..30)
            .map(|index| (0.5 + index as f32 / 100.0, 0.9 - index as f32 / 100.0))
            .collect();
        assert_eq!(Calibration::fit(&pairs, &[], &[]), Calibration::Unchanged);
    }

    #[test]
    fn without_pairs_a_preview_takes_the_listened_energy_at_its_rank() {
        let previews: Vec<f32> = (0..21).map(|index| 0.6 + index as f32 / 100.0).collect();
        let listened: Vec<f32> = (0..21).map(|index| 0.4 + index as f32 / 100.0).collect();
        let calibration = Calibration::fit(&[], &previews, &listened);
        assert!((calibration.apply(0.6) - 0.4).abs() < 1e-4);
        assert!((calibration.apply(0.7) - 0.5).abs() < 1e-4);
        assert!((calibration.apply(0.8) - 0.6).abs() < 1e-4);
        assert!((calibration.apply(2.0) - 0.6).abs() < 1e-4);
    }

    #[test]
    fn too_little_to_go_on_leaves_energy_as_measured() {
        assert_eq!(
            Calibration::fit(&[(0.5, 0.5)], &[0.5], &[0.5]),
            Calibration::Unchanged
        );
        assert_eq!(Calibration::Unchanged.apply(0.63), 0.63);
    }
}
