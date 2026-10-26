import { expect, test } from "bun:test";
import { curveCells, digitLevel, insertPoint, removePoint, setPoint, slidePoint, slotColumn, slotMarker } from "../src/screens/arcs/curve.js";
import { ArcHistory } from "../src/screens/arcs/history.js";
import { COMPACT_LEGENDS, LEGENDS, lengthLabel, normalizeRecipe, seedsLabel, toggleLength, type ArcDraft, type ArcSlot } from "../src/screens/arcs/model.js";
import { ARC_STUDIO_KEYS } from "../src/screens/help/model.js";

const flat = [{ x: 0, energy: 0.5 }, { x: 1, energy: 0.5 }];
const track = (energy: number, target = energy, measure: ArcSlot["measure"] = "measured") => ({ energy, target, measure });

test("slots spread across the chart's columns", () => {
  expect(slotColumn(0, 2, 20)).toBe(0);
  expect(slotColumn(1, 2, 20)).toBe(19);
  expect(slotColumn(0, 1, 20)).toBe(10);
  expect([0, 1, 2, 3, 4].map(i => slotColumn(i, 5, 20))).toEqual([0, 5, 10, 14, 19]);
});

test("tracks are drawn where their energy landed, outliers and guesses marked", () => {
  const cells = curveCells(flat, [track(0.95), track(0.1, 0.5), track(0.5, 0.5, "estimated")], 21, 4);
  expect(cells[0]![0]).toEqual({ ch: "●", tone: "track" });
  expect(cells[3]![10]).toEqual({ ch: "●", tone: "off" });
  expect(cells[1]![20]).toEqual({ ch: "○", tone: "estimate" });
  // Selecting a track colours it as selected.
  expect(curveCells(flat, [track(0.95), track(0.5)], 21, 4, 1)[1]![20]!.tone).toBe("selected");
});

test("when tracks share a column the worst fit is shown, unless one is selected", () => {
  // With two columns, the second and third tracks share the right-hand one.
  const slots = [track(0.5), track(0.5), track(0.9, 0.5)];
  const shared = curveCells(flat, slots, 2, 4);
  expect(shared[0]![1]).toEqual({ ch: "●", tone: "off" });
  const picked = curveCells(flat, slots, 2, 4, 1);
  expect(picked[1]![1]!.tone).toBe("selected");
  expect(picked[0]![1]!.tone).toBe("area");
});

test("the marker row points at the selected slot", () => {
  expect(slotMarker(5, 20, 0).indexOf("▲")).toBe(0);
  expect(slotMarker(5, 20, 2).indexOf("▲")).toBe(10);
  expect(slotMarker(5, 20, 4).indexOf("▲")).toBe(19);
  expect(slotMarker(5, 20, -1)).not.toContain("▲");
});

test("digits set a point's level directly", () => {
  expect(digitLevel("1")).toBe(0.1);
  expect(digitLevel("9")).toBe(0.9);
  expect(digitLevel("0")).toBe(1);
  expect(digitLevel("x")).toBeNull();
  expect(setPoint(flat, 1, 0.9)[1]!.energy).toBe(0.9);
  expect(setPoint(flat, 0, 4)[0]!.energy).toBe(1);
});

test("points slide between their neighbours, and endpoints stay put", () => {
  const curve = [{ x: 0, energy: 0.2 }, { x: 0.5, energy: 0.8 }, { x: 1, energy: 0.2 }];
  expect(slidePoint(curve, 1, 0.05)[1]!.x).toBe(0.55);
  expect(slidePoint(curve, 1, 0.9)[1]!.x).toBe(0.95);
  expect(slidePoint(curve, 1, -0.9)[1]!.x).toBe(0.05);
  expect(slidePoint(curve, 0, 0.3)[0]!.x).toBe(0);
  expect(slidePoint(curve, 2, -0.3)[2]!.x).toBe(1);
});

test("points can be added up to twelve and removed down to two", () => {
  const added = insertPoint(flat, 0);
  expect(added.curve.map(point => point.x)).toEqual([0, 0.5, 1]);
  expect(added.curve[1]!.energy).toBe(0.5);
  expect(added.index).toBe(1);
  // From the last point, the new one goes before it.
  expect(insertPoint(flat, 1).index).toBe(1);
  let curve = flat;
  for (let i = 0; i < 20; i++) curve = insertPoint(curve, 0).curve;
  expect(curve.length).toBeLessThanOrEqual(12);
  const twelve = Array.from({ length: 12 }, (_, i) => ({ x: i / 11, energy: 0.5 }));
  expect(insertPoint(twelve, 3).curve).toHaveLength(12);

  const three = [{ x: 0, energy: 0.2 }, { x: 0.5, energy: 0.8 }, { x: 1, energy: 0.3 }];
  const first = removePoint(three, 0);
  expect(first.curve).toEqual([{ x: 0, energy: 0.8 }, { x: 1, energy: 0.3 }]);
  const last = removePoint(three, 2);
  expect(last.curve.at(-1)).toEqual({ x: 1, energy: 0.8 });
  expect(last.index).toBe(1);
  expect(removePoint(flat, 0).curve).toHaveLength(2);
});

test("length switches between tracks and minutes using the current arc", () => {
  const draft = { slots: new Array(12).fill(null), duration_ms: 47 * 60_000 } as unknown as ArcDraft;
  expect(toggleLength({ tracks: 18 }, draft)).toEqual({ minutes: 50 });
  expect(toggleLength({ minutes: 50 }, draft)).toEqual({ tracks: 12 });
  expect(toggleLength({ tracks: 18 })).toEqual({ minutes: 60 });
  expect(toggleLength({ minutes: 60 })).toEqual({ tracks: 18 });
  expect(toggleLength({ tracks: 3 }, { ...draft, duration_ms: 5 * 60_000 })).toEqual({ minutes: 20 });
  expect(lengthLabel({ tracks: 12 }, draft)).toBe("12 tracks (47m)");
  expect(lengthLabel({ minutes: 50 }, draft)).toBe("50 min (12 tracks)");
  expect(lengthLabel({ minutes: 50 })).toBe("50 min");
});

test("the seed header names as many starting songs as fit", () => {
  const seeds = ["Teardrop", "Windowlicker", "Pyramid Song"].map(title => ({ uri: title, title, artists: [] }));
  expect(seedsLabel(seeds, 80)).toBe("Teardrop · Windowlicker · Pyramid Song");
  expect(seedsLabel(seeds, 30)).toBe("Teardrop · Windowlicker  +1");
  expect(seedsLabel(seeds, 5)).toBe("Teardrop  +2");
  expect(seedsLabel([], 40)).toBe("");
});

test("every legend fits its width, and Help lists every studio key", () => {
  for (const legend of Object.values(COMPACT_LEGENDS)) expect([...legend].length).toBeLessThanOrEqual(76);
  for (const legend of Object.values(LEGENDS)) expect([...legend].length).toBeLessThanOrEqual(124);
  const help = ARC_STUDIO_KEYS.map(([, , keys]) => keys).join(" ");
  for (const key of ["z undo", "Z redo", "S save as a new", "⇧↑↓", "m tracks or minutes", "f list starting songs", "a audition", "n add point", "d delete point"]) expect(help).toContain(key);
});

test("history undoes and redoes in order, and a new change ends redo", () => {
  const recipe = normalizeRecipe(undefined);
  const history = new ArcHistory();
  history.record({ label: "remove A", recipe, uris: ["a", "b"] });
  history.record({ label: "move B", recipe, uris: ["b"] });
  const undone = history.undo({ recipe, uris: ["c"] });
  expect(undone).toEqual({ label: "move B", recipe, uris: ["b"] });
  expect(history.canRedo).toBe(true);
  expect(history.redo({ recipe, uris: ["b"] })).toEqual({ label: "move B", recipe, uris: ["c"] });
  history.undo({ recipe, uris: ["c"] });
  history.record({ label: "keep D", recipe, uris: ["b"] });
  expect(history.canRedo).toBe(false);
  // A failed restore puts the step back.
  const step = history.undo({ recipe, uris: ["d"] })!;
  history.revert("undo", step);
  expect(history.canRedo).toBe(false);
  expect(history.undo({ recipe, uris: ["d"] })?.label).toBe("keep D");
});
