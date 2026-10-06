import { expect, test } from "bun:test";
import { DEFAULT_PRESETS, adjustLength, adjustPoint, curveRows, markerRow, nextPreset, normalizeRecipe, sampleCurve, slotRow, sparkline, summary, whyLine, type ArcDraft, type ArcSlot } from "../src/screens/arcs/model.js";

const slot: ArcSlot = { slot: 1, uri: "spotify:track:a", title: "Teardrop", artists: ["Massive Attack"], album: "Mezzanine", duration_ms: 330_000, target: 0.4, energy: 0.38, measure: "measured", tempo: 77, score: 0.8, affinity: 0.9, curve_fit: 0.95, transition: 0.7, penalty: 0, reasons: ["pinned", "shares 3 playlists with the seed", "energy 0.38 ≈ target 0.40"], pinned: true, seed: false };

test("curve sampling passes through points without overshooting", () => {
  const curve = [{ x: 0, energy: 0.1 }, { x: 0.5, energy: 0.9 }, { x: 1, energy: 0.9 }];
  expect(sampleCurve(curve, 0.5)).toBeCloseTo(0.9);
  for (let i = 0; i <= 50; i++) { const value = sampleCurve(curve, i / 50); expect(value).toBeGreaterThanOrEqual(0.1); expect(value).toBeLessThanOrEqual(0.9 + 1e-9); }
});

test("curve rows draw an area chart sized to the request", () => {
  const rows = curveRows(DEFAULT_PRESETS[2]!.curve, 20, 3);
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.length === 20)).toBe(true);
  // Build to Peak is quiet on the left and full on the right.
  expect(rows[0]!.at(0)).toBe(" ");
  expect(rows[2]!.at(-1)).toBe("█");
  expect(markerRow(DEFAULT_PRESETS[0]!.curve, 20, 0, true).startsWith("▲")).toBe(true);
  expect(sparkline([0, 0.5, 1])).toBe("▁▄█");
});

test("editing helpers stay in range and cycle presets", () => {
  const curve = adjustPoint([{ x: 0, energy: 0.95 }, { x: 1, energy: 0.05 }], 0, 0.1);
  expect(curve[0]!.energy).toBe(1);
  expect(adjustPoint(curve, 1, -0.1)[1]!.energy).toBe(0);
  expect(nextPreset(DEFAULT_PRESETS, "run").id).toBe("rise_and_fall");
  expect(nextPreset(DEFAULT_PRESETS, null).id).toBe("rise_and_fall");
  expect(adjustLength({ tracks: 99 }, 1)).toEqual({ tracks: 100 });
  expect(adjustLength({ minutes: 20 }, -1)).toEqual({ minutes: 20 });
});

test("recipes from the engine are normalized defensively", () => {
  const recipe = normalizeRecipe({ seeds: ["a", 3], curve: [{ x: 0, energy: 0.2 }], discovery: 400, length: { minutes: 60 } });
  expect(recipe.seeds).toEqual(["a"]);
  expect(recipe.curve).toHaveLength(8);
  expect(recipe.discovery).toBe(100);
  expect(recipe.length).toEqual({ minutes: 60 });
  expect(normalizeRecipe(null).preset).toBe("rise_and_fall");
});

test("slot rows stay compact and the why line explains placement", () => {
  const row = slotRow(slot);
  expect(row.title).toBe("02 ◆ Teardrop");
  expect(row.detail).toBe("77 BPM · kept");
  expect(slotRow({ ...slot, pinned: false, measure: "estimated", tempo: null }).detail).toBe("est.");
  expect(slotRow({ ...slot, pinned: false, measure: "heard", tempo: null }).detail).toBe("heard");
  expect(slotRow({ ...slot, pinned: false, measure: "previewed", tempo: 87 }).detail).toBe("87 BPM · prev.");
  expect(slotRow({ ...slot, pinned: false }).title).toBe("02 ▃ Teardrop");
  expect(whyLine(slot)).toBe("Why Teardrop: kept in place · shares 3 playlists with the seed · energy 0.38 ≈ target 0.40");
  const draft: ArcDraft = { recipe: normalizeRecipe(undefined), slots: [slot], targets: [0.4], confidence: 0.72, measured: 1, estimated: 0, unmeasured: 0, pool_size: 40, duration_ms: 330_000, notes: [], playlist_id: null };
  expect(summary(draft)).toBe("1 track · 6m · confidence 72% · energy known for 1 of 1");
  expect(summary({ ...draft, slots: [{ ...slot, measure: "unmeasured" }, slot, { ...slot, measure: "unmeasured" }] })).toContain("energy known for 1 of 3: play the arc");
  expect(slotRow({ ...slot, pinned: false, measure: "unmeasured" }).title).toBe("02 · Teardrop");
});
