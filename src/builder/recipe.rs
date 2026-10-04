//! What an arc is asked to be: its seeds, the energy it should follow, and how long it runs.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub const RECIPE_VERSION: u16 = 1;
pub const MAX_SEEDS: usize = 5;
pub const MIN_POINTS: usize = 2;
pub const MAX_POINTS: usize = 12;
pub const MIN_TRACKS: usize = 5;
pub const MAX_TRACKS: usize = 100;
pub const MIN_MINUTES: u32 = 20;
pub const MAX_MINUTES: u32 = 300;

/// One drawn point of the energy curve. `x` is the position through the arc and `energy`
/// the level wanted there, both from 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CurvePoint {
    pub x: f64,
    pub energy: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Length {
    Tracks(usize),
    Minutes(u32),
}

/// A track held in place. A pin without a slot goes wherever its energy fits the curve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub uri: String,
    #[serde(default)]
    pub slot: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Recipe {
    #[serde(default = "version")]
    pub version: u16,
    #[serde(default)]
    pub seeds: Vec<String>,
    #[serde(default = "default_curve")]
    pub curve: Vec<CurvePoint>,
    #[serde(default = "default_length")]
    pub length: Length,
    /// The radio discovery dial, 0 (familiar) to 100 (new to you).
    #[serde(default = "default_discovery")]
    pub discovery: u8,
    #[serde(default)]
    pub pins: Vec<Pin>,
    /// Banned URIs and song keys.
    #[serde(default)]
    pub bans: BTreeSet<String>,
    #[serde(default)]
    pub rng_seed: u64,
    #[serde(default)]
    pub preset: Option<String>,
}

fn version() -> u16 {
    RECIPE_VERSION
}
fn default_length() -> Length {
    Length::Tracks(18)
}
fn default_discovery() -> u8 {
    30
}
fn default_curve() -> Vec<CurvePoint> {
    Preset::RiseAndFall.curve()
}

impl Default for Recipe {
    fn default() -> Self {
        Self {
            version: RECIPE_VERSION,
            seeds: Vec::new(),
            curve: default_curve(),
            length: default_length(),
            discovery: default_discovery(),
            pins: Vec::new(),
            bans: BTreeSet::new(),
            rng_seed: 0,
            preset: Some(Preset::RiseAndFall.id().to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    RiseAndFall,
    SteadyFocus,
    BuildToPeak,
    WindDown,
    Run,
}

impl Preset {
    pub const ALL: [Self; 5] = [
        Self::RiseAndFall,
        Self::SteadyFocus,
        Self::BuildToPeak,
        Self::WindDown,
        Self::Run,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::RiseAndFall => "rise_and_fall",
            Self::SteadyFocus => "steady_focus",
            Self::BuildToPeak => "build_to_peak",
            Self::WindDown => "wind_down",
            Self::Run => "run",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::RiseAndFall => "Rise & Fall",
            Self::SteadyFocus => "Steady Focus",
            Self::BuildToPeak => "Build to Peak",
            Self::WindDown => "Wind Down",
            Self::Run => "Run",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|preset| preset.id() == id)
    }

    pub fn curve(self) -> Vec<CurvePoint> {
        let levels: [f64; 8] = match self {
            Self::RiseAndFall => [0.2, 0.35, 0.55, 0.75, 0.85, 0.7, 0.45, 0.25],
            Self::SteadyFocus => [0.4, 0.42, 0.45, 0.45, 0.45, 0.45, 0.42, 0.4],
            Self::BuildToPeak => [0.2, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.95],
            Self::WindDown => [0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.2, 0.12],
            Self::Run => [0.45, 0.7, 0.85, 0.88, 0.88, 0.88, 0.85, 0.6],
        };
        let last = (levels.len() - 1) as f64;
        levels
            .iter()
            .enumerate()
            .map(|(index, &energy)| CurvePoint {
                x: index as f64 / last,
                energy,
            })
            .collect()
    }
}

impl Recipe {
    /// Bring a recipe from a frontend into range. Errors are only for recipes that cannot be
    /// repaired without guessing what was meant.
    pub fn normalize(&mut self) -> Result<(), String> {
        self.version = RECIPE_VERSION;
        let mut seen = BTreeSet::new();
        self.seeds.retain(|seed| seen.insert(seed.clone()));
        if self.seeds.len() > MAX_SEEDS {
            return Err(format!("an arc takes at most {MAX_SEEDS} seeds"));
        }
        if self
            .curve
            .iter()
            .any(|point| !point.x.is_finite() || !point.energy.is_finite())
        {
            return Err("curve points must be finite numbers".into());
        }
        if !(MIN_POINTS..=MAX_POINTS).contains(&self.curve.len()) {
            return Err(format!("a curve needs {MIN_POINTS} to {MAX_POINTS} points"));
        }
        for point in &mut self.curve {
            point.x = point.x.clamp(0.0, 1.0);
            point.energy = point.energy.clamp(0.0, 1.0);
        }
        self.curve.sort_by(|a, b| a.x.total_cmp(&b.x));
        self.curve.dedup_by(|a, b| (a.x - b.x).abs() < 1e-9);
        if self.curve.len() < MIN_POINTS {
            return Err("curve points must be at distinct positions".into());
        }
        self.length = match self.length {
            Length::Tracks(n) => Length::Tracks(n.clamp(MIN_TRACKS, MAX_TRACKS)),
            Length::Minutes(m) => Length::Minutes(m.clamp(MIN_MINUTES, MAX_MINUTES)),
        };
        self.discovery = self.discovery.min(100);
        let mut pinned = BTreeSet::new();
        self.pins.retain(|pin| pinned.insert(pin.uri.clone()));
        Ok(())
    }

    /// The energy wanted at each of `slots` evenly spaced positions.
    pub fn targets(&self, slots: usize) -> Vec<f64> {
        match slots {
            0 => Vec::new(),
            1 => vec![sample(&self.curve, 0.5)],
            _ => (0..slots)
                .map(|slot| sample(&self.curve, slot as f64 / (slots - 1) as f64))
                .collect(),
        }
    }
}

/// Monotone cubic (Fritsch–Carlson) interpolation, so the curve passes through every drawn
/// point without overshooting between them.
pub fn sample(points: &[CurvePoint], x: f64) -> f64 {
    let Some(first) = points.first() else {
        return 0.5;
    };
    let last = points[points.len() - 1];
    if points.len() == 1 || x <= first.x {
        return first.energy;
    }
    if x >= last.x {
        return last.energy;
    }
    let n = points.len();
    let slopes: Vec<f64> = points
        .windows(2)
        .map(|pair| (pair[1].energy - pair[0].energy) / (pair[1].x - pair[0].x))
        .collect();
    let mut tangents = vec![0.0; n];
    tangents[0] = slopes[0];
    tangents[n - 1] = slopes[n - 2];
    for i in 1..n - 1 {
        tangents[i] = if slopes[i - 1] * slopes[i] <= 0.0 {
            0.0
        } else {
            (slopes[i - 1] + slopes[i]) / 2.0
        };
    }
    for i in 0..n - 1 {
        if slopes[i] == 0.0 {
            tangents[i] = 0.0;
            tangents[i + 1] = 0.0;
            continue;
        }
        let a = tangents[i] / slopes[i];
        let b = tangents[i + 1] / slopes[i];
        let norm = a * a + b * b;
        if norm > 9.0 {
            let scale = 3.0 / norm.sqrt();
            tangents[i] = scale * a * slopes[i];
            tangents[i + 1] = scale * b * slopes[i];
        }
    }
    let i = points
        .windows(2)
        .position(|pair| x <= pair[1].x)
        .unwrap_or(n - 2);
    let (p0, p1) = (points[i], points[i + 1]);
    let h = p1.x - p0.x;
    let t = (x - p0.x) / h;
    let (t2, t3) = (t * t, t * t * t);
    let value = (2.0 * t3 - 3.0 * t2 + 1.0) * p0.energy
        + (t3 - 2.0 * t2 + t) * h * tangents[i]
        + (-2.0 * t3 + 3.0 * t2) * p1.energy
        + (t3 - t2) * h * tangents[i + 1];
    value.clamp(0.0, 1.0)
}
