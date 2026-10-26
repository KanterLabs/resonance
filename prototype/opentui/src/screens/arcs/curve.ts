import { curveRows, sampleCurve, type ArcSlot, type CurvePoint } from "./model.js";

/** How a chart cell is coloured: the curve's area, or a track drawn on it. */
export type Tone = "area" | "track" | "off" | "estimate" | "selected";
export interface Cell { ch: string; tone: Tone }

/** How far a track may sit from the curve before it is drawn as an outlier. */
export const OFF_CURVE = 0.2;
export const MIN_POINTS = 2;
export const MAX_POINTS = 12;
/** The closest two curve points may sit, as a share of the arc. */
const MIN_GAP = 0.05;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The chart column a slot sits in, matching where the curve is sampled for it. */
export function slotColumn(slot: number, count: number, width: number): number {
  const columns = Math.max(2, Math.floor(width));
  return count <= 1 ? Math.round((columns - 1) / 2) : Math.round(slot / (count - 1) * (columns - 1));
}

const known = (slot: Pick<ArcSlot, "measure">) => slot.measure === "measured" || slot.measure === "previewed";
const miss = (slot: Pick<ArcSlot, "energy" | "target">) => Math.abs(slot.energy - slot.target);

/**
 * The curve as an area chart with each track drawn where its energy landed: `●` when its
 * energy was measured, `○` when it is a guess. When tracks share a column the selected one
 * wins, then the one furthest from the curve, so outliers are never hidden.
 */
export function curveCells(curve: CurvePoint[], slots: Pick<ArcSlot, "energy" | "target" | "measure">[], width: number, height: number, selected = -1): Cell[][] {
  const cells = curveRows(curve, width, height).map(row => [...row].map((ch): Cell => ({ ch, tone: "area" })));
  const columns = cells[0]?.length ?? 0;
  const owner = new Map<number, number>();
  slots.forEach((slot, i) => {
    const column = slotColumn(i, slots.length, columns);
    const held = owner.get(column);
    if (held === undefined || i === selected || (held !== selected && miss(slot) > miss(slots[held]!))) owner.set(column, i);
  });
  for (const [column, i] of owner) {
    const slot = slots[i]!;
    const row = height - 1 - clamp(Math.floor(clamp(slot.energy, 0, 1) * height), 0, height - 1);
    const tone: Tone = i === selected ? "selected" : miss(slot) > OFF_CURVE ? "off" : known(slot) ? "track" : "estimate";
    cells[row]![column] = { ch: known(slot) ? "●" : "○", tone };
  }
  return cells;
}

/** A row with `▲` under the selected slot's column. */
export function slotMarker(count: number, width: number, selected: number): string {
  const columns = Math.max(2, Math.floor(width));
  const cells = new Array<string>(columns).fill(" ");
  if (selected >= 0 && selected < count) cells[slotColumn(selected, count, columns)] = "▲";
  return cells.join("");
}

/** How well the tracks follow the curve, 0 to 1. */
export function meanFit(slots: Pick<ArcSlot, "curve_fit">[]): number {
  return slots.length ? slots.reduce((sum, slot) => sum + slot.curve_fit, 0) / slots.length : 0;
}

/** The level a digit sets a curve point to: `1`–`9` are 10–90%, `0` is 100%. */
export function digitLevel(digit: string): number | null {
  if (!/^[0-9]$/.test(digit)) return null;
  return digit === "0" ? 1 : Number(digit) / 10;
}

export function setPoint(curve: CurvePoint[], index: number, level: number): CurvePoint[] {
  return curve.map((point, i) => i === index ? { ...point, energy: round2(clamp(level, 0, 1)) } : { ...point });
}

/** Slide a point earlier or later, keeping it between its neighbours. Endpoints stay put. */
export function slidePoint(curve: CurvePoint[], index: number, delta: number): CurvePoint[] {
  const copy = curve.map(point => ({ ...point }));
  if (index <= 0 || index >= curve.length - 1) return copy;
  const low = curve[index - 1]!.x + MIN_GAP, high = curve[index + 1]!.x - MIN_GAP;
  if (low > high) return copy;
  copy[index]!.x = round2(clamp(curve[index]!.x + delta, low, high));
  return copy;
}

/** Add a point halfway to the next one, on the drawn curve so the shape does not change. */
export function insertPoint(curve: CurvePoint[], index: number): { curve: CurvePoint[]; index: number } {
  const copy = curve.map(point => ({ ...point }));
  if (curve.length >= MAX_POINTS || curve.length < 2) return { curve: copy, index };
  const left = Math.min(index, curve.length - 2);
  const a = curve[left]!, b = curve[left + 1]!;
  if (b.x - a.x < MIN_GAP * 2) return { curve: copy, index };
  const x = round2((a.x + b.x) / 2);
  copy.splice(left + 1, 0, { x, energy: round2(sampleCurve(curve, x)) });
  return { curve: copy, index: left + 1 };
}

/** Remove a point. The curve keeps at least two, and always spans the whole arc. */
export function removePoint(curve: CurvePoint[], index: number): { curve: CurvePoint[]; index: number } {
  const copy = curve.map(point => ({ ...point }));
  if (curve.length <= MIN_POINTS) return { curve: copy, index };
  copy.splice(index, 1);
  copy[0]!.x = 0;
  copy[copy.length - 1]!.x = 1;
  return { curve: copy, index: Math.min(index, copy.length - 1) };
}
