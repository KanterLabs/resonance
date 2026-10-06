import type { Row } from "../../workspace/contracts.js";

export interface CurvePoint { x: number; energy: number }
export type Length = { tracks: number } | { minutes: number };
export interface Pin { uri: string; slot?: number | null }
export interface Recipe {
  version?: number;
  seeds: string[];
  curve: CurvePoint[];
  length: Length;
  discovery: number;
  pins: Pin[];
  bans: string[];
  rng_seed: number;
  preset?: string | null;
}
export type Measure = "measured" | "previewed" | "heard" | "estimated" | "unmeasured";
export interface ArcSlot {
  slot: number;
  uri: string;
  title: string;
  artists: string[];
  album?: string | null;
  duration_ms: number;
  target: number;
  energy: number;
  measure: Measure;
  tempo?: number | null;
  score: number;
  affinity: number;
  curve_fit: number;
  transition: number;
  penalty: number;
  reasons: string[];
  pinned: boolean;
  seed: boolean;
}
export interface ArcDraft {
  recipe: Recipe;
  slots: ArcSlot[];
  targets: number[];
  confidence: number;
  measured: number;
  previewed?: number;
  heard?: number;
  estimated: number;
  unmeasured: number;
  pool_size: number;
  duration_ms: number;
  notes: string[];
  playlist_id?: string | null;
}
export interface Preset { id: string; label: string; curve: CurvePoint[] }
/** `builder.coverage`: how much of the cached library arcs have measured. */
export interface Coverage {
  fingerprinted?: number;
  catalog_measured?: number;
  catalog_previewed?: number;
  catalog_tracks?: number;
  preview_lookup?: boolean;
  preview_pending?: number;
}
export interface SeedRow { uri: string; title: string; artists: string[] }
export interface ArcState {
  presets?: Preset[];
  recipe?: Recipe;
  draft?: ArcDraft | null;
  fingerprinted?: number;
  current?: SeedRow | null;
  seeds?: SeedRow[];
}

const points = (levels: number[]): CurvePoint[] => levels.map((energy, i) => ({ x: i / (levels.length - 1), energy }));
/** Mirrors the engine's presets so the screen can draw before the engine answers. */
export const DEFAULT_PRESETS: Preset[] = [
  { id: "rise_and_fall", label: "Rise & Fall", curve: points([0.2, 0.35, 0.55, 0.75, 0.85, 0.7, 0.45, 0.25]) },
  { id: "steady_focus", label: "Steady Focus", curve: points([0.4, 0.42, 0.45, 0.45, 0.45, 0.45, 0.42, 0.4]) },
  { id: "build_to_peak", label: "Build to Peak", curve: points([0.2, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.95]) },
  { id: "wind_down", label: "Wind Down", curve: points([0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.2, 0.12]) },
  { id: "run", label: "Run", curve: points([0.45, 0.7, 0.85, 0.88, 0.88, 0.88, 0.85, 0.6]) },
];
export function defaultRecipe(): Recipe {
  return { seeds: [], curve: DEFAULT_PRESETS[0]!.curve.map(point => ({ ...point })), length: { tracks: 18 }, discovery: 30, pins: [], bans: [], rng_seed: 0, preset: "rise_and_fall" };
}
export function normalizeRecipe(value: unknown): Recipe {
  const base = defaultRecipe();
  if (!value || typeof value !== "object") return base;
  const raw = value as Partial<Recipe>;
  const curve = Array.isArray(raw.curve) && raw.curve.length >= 2 && raw.curve.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.energy)) ? raw.curve.map(p => ({ x: p.x, energy: p.energy })) : base.curve;
  const length = raw.length && typeof raw.length === "object" && ("tracks" in raw.length || "minutes" in raw.length) ? raw.length : base.length;
  return {
    ...base,
    seeds: Array.isArray(raw.seeds) ? raw.seeds.filter((s): s is string => typeof s === "string") : [],
    curve, length,
    discovery: Number.isFinite(raw.discovery) ? Math.max(0, Math.min(100, raw.discovery!)) : base.discovery,
    pins: Array.isArray(raw.pins) ? raw.pins : [],
    bans: Array.isArray(raw.bans) ? raw.bans : [],
    rng_seed: Number.isFinite(raw.rng_seed) ? raw.rng_seed! : 0,
    preset: typeof raw.preset === "string" ? raw.preset : null,
  };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Monotone cubic interpolation, matching the engine so the drawn curve is what is solved. */
export function sampleCurve(curve: CurvePoint[], x: number): number {
  if (!curve.length) return 0.5;
  const pts = [...curve].sort((a, b) => a.x - b.x);
  const first = pts[0]!, last = pts[pts.length - 1]!;
  if (pts.length === 1 || x <= first.x) return first.energy;
  if (x >= last.x) return last.energy;
  const n = pts.length;
  const slopes = pts.slice(0, -1).map((p, i) => (pts[i + 1]!.energy - p.energy) / (pts[i + 1]!.x - p.x));
  const tangents = new Array<number>(n).fill(0);
  tangents[0] = slopes[0]!; tangents[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i++) tangents[i] = slopes[i - 1]! * slopes[i]! <= 0 ? 0 : (slopes[i - 1]! + slopes[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = tangents[i]! / slopes[i]!, b = tangents[i + 1]! / slopes[i]!, norm = a * a + b * b;
    if (norm > 9) { const scale = 3 / Math.sqrt(norm); tangents[i] = scale * a * slopes[i]!; tangents[i + 1] = scale * b * slopes[i]!; }
  }
  let i = pts.findIndex((_, j) => j < n - 1 && x <= pts[j + 1]!.x);
  if (i < 0) i = n - 2;
  const p0 = pts[i]!, p1 = pts[i + 1]!, h = p1.x - p0.x, t = (x - p0.x) / h, t2 = t * t, t3 = t2 * t;
  const value = (2 * t3 - 3 * t2 + 1) * p0.energy + (t3 - 2 * t2 + t) * h * tangents[i]! + (-2 * t3 + 3 * t2) * p1.energy + (t3 - t2) * h * tangents[i + 1]!;
  return clamp(value, 0, 1);
}

const BLOCKS = " ▁▂▃▄▅▆▇█";
/** An area chart of the curve, `height` rows tall, top row first. */
export function curveRows(curve: CurvePoint[], width: number, height: number): string[] {
  const columns = Math.max(2, Math.floor(width));
  const levels = Array.from({ length: columns }, (_, c) => sampleCurve(curve, c / (columns - 1)) * height * 8);
  return Array.from({ length: height }, (_, row) => {
    const floor = (height - 1 - row) * 8;
    return levels.map(level => BLOCKS[clamp(Math.round(level - floor), 0, 8)]!).join("");
  });
}
/** Markers under the chart for each control point; the selected one is filled. */
export function markerRow(curve: CurvePoint[], width: number, selected: number, focused: boolean): string {
  const columns = Math.max(2, Math.floor(width));
  const cells = new Array<string>(columns).fill(" ");
  curve.forEach((point, i) => { cells[Math.round(point.x * (columns - 1))] = i === selected && focused ? "▲" : i === selected ? "△" : "·"; });
  return cells.join("");
}
/** One block per slot, showing the energy each slot actually landed on. */
export function sparkline(values: number[]): string {
  return values.map(value => BLOCKS[clamp(Math.round(value * 8), 1, 8)]!).join("");
}
export function energyBlock(value: number): string { return BLOCKS[clamp(Math.round(value * 8), 1, 8)]!; }

export function adjustPoint(curve: CurvePoint[], index: number, delta: number): CurvePoint[] {
  return curve.map((point, i) => i === index ? { ...point, energy: Math.round(clamp(point.energy + delta, 0, 1) * 100) / 100 } : { ...point });
}
export function nextPreset(presets: Preset[], current: string | null | undefined, step = 1): Preset {
  const list = presets.length ? presets : DEFAULT_PRESETS;
  const index = list.findIndex(preset => preset.id === current);
  return list[((index < 0 ? -1 : index) + step + list.length) % list.length]!;
}
export function presetLabel(presets: Preset[], id: string | null | undefined): string {
  return (presets.length ? presets : DEFAULT_PRESETS).find(preset => preset.id === id)?.label ?? "Custom";
}
export function lengthLabel(length: Length): string {
  return "tracks" in length ? `${length.tracks} tracks` : `${length.minutes} min`;
}
export function adjustLength(length: Length, step: number): Length {
  if ("tracks" in length) return { tracks: clamp(length.tracks + step * 2, 5, 100) };
  return { minutes: clamp(length.minutes + step * 10, 20, 300) };
}
export function dial(value: number, width = 10): string {
  const filled = clamp(Math.round(value / 100 * width), 0, width);
  return "▮".repeat(filled) + "▯".repeat(width - filled);
}
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
export function slotDetail(slot: ArcSlot): string {
  const learned: Record<Measure, string> = { measured: "", previewed: "prev.", heard: "heard", estimated: "est.", unmeasured: "new" };
  const tags = [slot.tempo ? `${Math.round(slot.tempo)} BPM` : "", learned[slot.measure], slot.pinned ? "kept" : "", slot.seed ? "seed" : ""].filter(Boolean);
  return tags.join(" · ");
}
export function slotRow(slot: ArcSlot, id = `slot-${slot.slot}`): Row {
  const mark = slot.pinned ? "◆" : slot.seed ? "✦" : slot.measure === "unmeasured" ? "·" : energyBlock(slot.energy);
  return { id, kind: "track", title: `${String(slot.slot + 1).padStart(2, "0")} ${mark} ${slot.title}`, subtitle: slot.artists.join(", "), detail: slotDetail(slot), uri: slot.uri, duration_ms: slot.duration_ms, meta: { slot: slot.slot } };
}
/** Why a track sits where it does, in plain words. */
export function whyLine(slot: ArcSlot): string {
  const reasons = slot.reasons.filter(reason => reason !== "pinned" && reason !== "seed");
  const tags = [slot.pinned ? "kept in place" : "", slot.seed ? "one of your starting songs" : ""].filter(Boolean);
  return `Why ${slot.title}: ${[...tags, ...reasons].join(" · ") || "fits the arc"}`;
}
export function slotExplanation(slot: ArcSlot): string {
  return `${whyLine(slot)} · fit ${Math.round(slot.curve_fit * 100)}% · flow ${Math.round(slot.transition * 100)}% · match ${Math.round(slot.affinity * 100)}%`;
}
export function mixLabel(discovery: number): string {
  return `familiar ${dial(discovery, 8)} new`;
}
export type Legend = "arc" | "edit" | "swap" | "seed" | "empty";
/** Narrow-terminal legends: the same keys in fewer words, so nothing is cut off at 80 columns. */
export const COMPACT_LEGENDS: Record<Legend, [string, string]> = {
  arc: ["↑↓ pick  ⏎ play here  p play  r swap  k keep  x remove  s save", "←→ shape  e curve  −+ length  [] mix  g remix  / add  c playing"],
  edit: ["Curve: ←→ point  ↑↓ raise/lower  ⏎/Esc done", "The arc rebuilds as you edit"],
  swap: ["Swap: ↑↓ pick  ⏎ use it  Esc keep current", ""],
  seed: ["Add song: ↑↓ pick  ⏎ add  Esc back", ""],
  empty: ["Play a song, then press c to build an arc", "/ search for a starting song  ·  ←→ shape"],
};
export const LEGENDS: Record<Legend, [string, string]> = {
  arc: ["↑↓ pick  ⏎ play from here  p play all  r swap  k keep  x remove  s save", "←→ shape  e edit curve  −/+ length  [/] mix  g remix  / add song  c from playing  ⌫ drop song"],
  edit: ["Editing curve: ←→ choose point  ↑↓ raise/lower", "⏎ or Esc done  ·  the arc rebuilds as you edit"],
  swap: ["Swap: ↑↓ pick a replacement  ⏎ use it", "Esc keep the current track"],
  seed: ["Add a starting song: ↑↓ pick  ⏎ add", "Esc back to the arc"],
  empty: ["Play a song, then press c to build an arc from it", "/ search for a starting song  ·  ←→ choose a shape first if you like"],
};
export function summary(draft: ArcDraft): string {
  const count = draft.slots.length;
  const known = draft.slots.filter(slot => slot.measure !== "unmeasured").length;
  const head = `${count} track${count === 1 ? "" : "s"} · ${formatDuration(draft.duration_ms)}`;
  if (count && known * 2 < count) return `${head} · energy known for ${known} of ${count}: play the arc and each song teaches the shape`;
  return `${head} · confidence ${Math.round(draft.confidence * 100)}% · energy known for ${known} of ${count}`;
}
