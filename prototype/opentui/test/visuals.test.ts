import { expect, test } from "bun:test";
import { coverColor, crateLines } from "../src/screens/now-playing/crate.js";
import { calendarGrid, formatMinutes, intensityScale, monthName, type Calendar } from "../src/screens/diary/model.js";
import { deckLayout } from "../src/screens/now-playing/deck-view.js";
import { turntableLines, type TurntableFrame } from "../src/screens/now-playing/turntable.js";
import { detectPixelMode, PixelCanvas } from "../src/screens/now-playing/pixels.js";
import { meterTarget, Needle, vuMeterLines } from "../src/screens/now-playing/vu-meter.js";
import { waveformBar, waveformColumns } from "../src/screens/now-playing/waveform-bar.js";
import { parseAudioFrame, parseStatus } from "../src/status.js";
import { energyMap } from "../src/workspace/energy-map.js";

const text = (line: { chunks: Array<{ text: string }> }) => line.chunks.map(chunk => chunk.text).join("");
const signature = (lines: Array<{ chunks: Array<{ text: string; fg?: { toInts(): number[] }; bg?: { toInts(): number[] } }> }>) =>
  lines.map(line => line.chunks.map(chunk => `${chunk.text.length}:${chunk.fg?.toInts()}:${chunk.bg?.toInts()}`).join("|")).join("\n");

test("the turntable strobe, arm lift and record slide each change the drawing", () => {
  const base: TurntableFrame = { rows: 19, theme: "dark", background: "#080a10", progress: 0.4, rotation: 0, playing: true, strobe: 0 };
  const drawn = signature(turntableLines(base));
  expect(signature(turntableLines({ ...base, strobe: 0.5 }))).not.toBe(drawn);
  expect(signature(turntableLines({ ...base, strobe: null }))).not.toBe(drawn);
  expect(signature(turntableLines({ ...base, lift: 1 }))).not.toBe(drawn);
  // Fully lifted, the arm rests where a parked arm does.
  expect(signature(turntableLines({ ...base, lift: 1, strobe: null }))).toBe(signature(turntableLines({ ...base, progress: null, strobe: null })));
  expect(signature(turntableLines({ ...base, slide: 0.5 }))).not.toBe(drawn);
});

test("the pixel mode follows what the terminal draws itself", () => {
  expect(detectPixelMode({})).toBe("half");
  expect(detectPixelMode({ VTE_VERSION: "8204" })).toBe("octant");
  expect(detectPixelMode({ VTE_VERSION: "7600" })).toBe("sextant");
  expect(detectPixelMode({ VTE_VERSION: "7000" })).toBe("half");
  expect(detectPixelMode({ TERM_PROGRAM: "ghostty" })).toBe("octant");
  expect(detectPixelMode({ KITTY_WINDOW_ID: "1" })).toBe("sextant");
  expect(detectPixelMode({ VTE_VERSION: "8204", RESONANCE_PIXELS: "Quadrant" })).toBe("quadrant");
  expect(detectPixelMode({ VTE_VERSION: "8204", RESONANCE_PIXELS: "nonsense" })).toBe("octant");
});

test("fine canvases pick a mosaic glyph and two colours per cell", () => {
  const glyphs = (mode: "quadrant" | "sextant" | "octant", draw: (canvas: PixelCanvas) => void) => {
    const canvas = new PixelCanvas(2, 2, "#000000", mode); draw(canvas);
    const [line] = canvas.lines();
    return { text: text(line!), colors: line!.chunks.map(chunk => [chunk.fg!.toInts().slice(0, 3).join(), chunk.bg!.toInts().slice(0, 3).join()]) };
  };
  // Half a base pixel is one sub-pixel across: the left half of the first cell.
  expect(glyphs("octant", canvas => canvas.rect(0, 0, 0.5, 2, "#ffffff")).text).toBe("▌ ");
  expect(glyphs("quadrant", canvas => canvas.rect(0, 0, 0.5, 2, "#ffffff")).text).toBe("▌ ");
  // The top left sub-pixel alone has an octant of its own.
  const dot = glyphs("octant", canvas => canvas.put(-0.25, -0.25, "#ff0000", 0.5));
  expect(dot.text).toBe("\u{1cea8} ");
  expect(dot.colors[0]).toEqual(["255,0,0", "0,0,0"]);
  // A pattern with no older name comes from the octant block.
  expect(glyphs("octant", canvas => { canvas.put(-0.25, -0.25, "#ffffff", 0.5); canvas.put(0.25, 0.25, "#ffffff", 0.5); }).text).toBe(`${String.fromCodePoint(0x1cd04)} `);
  expect(glyphs("sextant", canvas => canvas.rect(0, 0, 1, 0.6, "#ffffff")).text).toBe(`${String.fromCodePoint(0x1fb02)} `);
  // Three flat colours settle into the two that describe the cell best, and keep their exact values.
  const three = glyphs("octant", canvas => { canvas.rect(0, 0, 0.5, 2, "#ffffff"); canvas.rect(0.5, 0, 0.5, 1, "#f0f0f0"); });
  expect([...three.text][0]).toBe("▛");
  expect(three.colors[0]).toEqual(["255,255,255", "0,0,0"]);
  // A lone dot on the edge of a flat area does not tint the area.
  const edge = glyphs("octant", canvas => { canvas.rect(-0.5, -0.5, 1, 1.5, "#ffffff"); canvas.put(-0.25, 0.75, "#888888", 0.5); });
  expect(edge.colors[0]!).toContain("255,255,255");
});

test("the fine turntable keeps its size and gains detail", () => {
  const base: TurntableFrame = { rows: 19, theme: "dark", background: "#080a10", progress: 0.4, rotation: 0, playing: true, strobe: 0 };
  const half = turntableLines(base), fine = turntableLines({ ...base, mode: "octant" });
  expect(fine).toHaveLength(half.length);
  for (const line of fine) expect([...text(line)]).toHaveLength([...text(half[0]!)].length);
  expect(fine.some(line => [...text(line)].some(glyph => glyph.codePointAt(0)! >= 0x1cd00))).toBe(true);
  expect(signature(turntableLines({ ...base, mode: "octant", strobe: 0.5 }))).not.toBe(signature(fine));
  const meter = vuMeterLines(0.5, 32, 4, "dark", "#000000", "octant");
  for (const line of meter) expect([...text(line)]).toHaveLength(32);
  expect(signature(vuMeterLines(0.9, 32, 4, "dark", "#000000", "octant"))).not.toBe(signature(meter));
});

test("the VU needle rises fast, overshoots a little and settles", () => {
  const needle = new Needle();
  let peak = 0;
  for (let i = 0; i < 60; i++) peak = Math.max(peak, needle.step(0.6, 1 / 30));
  expect(peak).toBeGreaterThan(0.6);
  expect(peak).toBeLessThan(0.8);
  expect(Math.abs(needle.value - 0.6)).toBeLessThan(0.02);
  expect(new Needle().step(0.5, 1 / 30, true)).toBe(0.5);
  expect(meterTarget(0)).toBe(0);
  expect(meterTarget(1)).toBeLessThanOrEqual(1.08);
  const lines = vuMeterLines(0.5, 32, 4, "light", "#ffffff");
  expect(lines).toHaveLength(4);
  for (const line of lines) expect([...text(line)]).toHaveLength(32);
  expect(signature(vuMeterLines(0.9, 32, 4, "light", "#ffffff"))).not.toBe(signature(lines));
});

test("the waveform folds a song map into columns against its own peak", () => {
  const columns = waveformColumns([0.2, 0.4, null, null, 0.1, 0.4], 3);
  expect(columns).toEqual([1, null, 1]);
  expect(waveformColumns([], 4)).toEqual([null, null, null, null]);
  const [top, bottom] = waveformBar([1, 0.25, null, 0.5], 0.5, { played: "#e8642c", playhead: "#ffffff", ahead: "#888888", unheard: "#333333", background: "#000000" });
  expect([...text(top)]).toHaveLength(4);
  expect(text(bottom)).toBe("█▄▲█");
  expect(text(top)).toBe("█   ");
});

test("crate spines take the cover's average colour and the playing record leads", () => {
  expect(coverColor(["#000000", "#ffffff"])).toBe("#808080");
  expect(coverColor(["bad"])).toBeNull();
  const colors = { text: "#ffffff", muted: "#aaaaaa", dim: "#666666", empty: "#333333", background: "#000000" };
  const lines = crateLines({ title: "Now", artists: ["A"], color: "#ff0000" }, [{ title: "A very long upcoming title that cannot fit", artists: ["B"], color: null }], 24, 6, colors);
  expect(text(lines[0]!)).toBe("IN THE CRATE");
  expect(text(lines[1]!).startsWith("████ Now")).toBe(true);
  expect(text(lines[2]!).startsWith(" ███  A very")).toBe(true);
  expect([...text(lines[2]!)].length).toBeLessThanOrEqual(24);
  expect(text(crateLines(null, [], 24, 6, colors)[1]!)).toContain("nothing queued");
});

test("the deck lays out its meter and crate only where they fit", () => {
  expect(deckLayout({ width: 70, height: 10 }).fits).toBe(false);
  const small = deckLayout({ width: 76, height: 17 });
  expect(small).toMatchObject({ fits: true, meter: false, crate: false });
  expect(deckLayout({ width: 150, height: 34 })).toMatchObject({ fits: true, meter: true, crate: true, rows: 20 });
});

test("the footer energy map marks the next song as lifting, calming or holding", () => {
  expect(energyMap(null)).toBeNull();
  expect(energyMap({ current: 0.5, previous: [], up_next: [null, null] })).toBeNull();
  const rising = energyMap({ current: 0.3, previous: [0.1, 0.2], up_next: [0.6, 0.7, null] })!;
  expect(rising.map(([, tone]) => tone)).toEqual(["past", "current", "rising", "ahead", "label"]);
  expect(rising.at(-1)![0]).toBe(" next lifts");
  expect(energyMap({ current: 0.7, previous: [], up_next: [0.3, 0.2] })!.at(-1)![0]).toBe(" next calms");
  expect(energyMap({ current: 0.5, previous: [], up_next: [0.52, 0.2] })!.at(-1)![0]).toBe(" next holds");
});

test("the diary grid ends on today's week with Monday on top and quartile shades", () => {
  const calendar: Calendar = {
    today: "2026-10-15", month: "2026-10", month_minutes: 0, month_plays: 0, top_artists: [],
    days: [{ date: "2026-10-12", plays: 3, minutes: 10 }, { date: "2026-10-15", plays: 9, minutes: 40 }, { date: "2026-10-01", plays: 1, minutes: 5 }, { date: "2025-01-01", plays: 99, minutes: 999 }],
  };
  const grid = calendarGrid(calendar, 3);
  // 2026-10-15 is a Thursday: index 3 in the last column, with the rest of that week still ahead.
  expect(grid.cells[3]![2]).toBe(40);
  expect(grid.cells[0]![2]).toBe(10);
  expect(grid.cells[4]![2]).toBeNull();
  expect(grid.cells[3]![0]).toBe(5);
  expect(grid.total).toEqual({ minutes: 55, plays: 13, days: 3 });
  expect(grid.months).toEqual([{ week: 0, label: "Oct" }]);
  expect(calendarGrid(calendar, 8).months.map(month => month.label)).toEqual(["Aug", "Sep", "Oct"]);
  const level = intensityScale(grid);
  expect(level(0)).toBe(0); expect(level(null)).toBe(0);
  expect(level(5)).toBe(1); expect(level(40)).toBe(3);
  expect(formatMinutes(42)).toBe("42 min"); expect(formatMinutes(90)).toBe("1.5 h"); expect(formatMinutes(1200)).toBe("20 h");
  expect(monthName("2026-10")).toBe("October 2026");
});

test("audio frames and status energy parse defensively", () => {
  expect(parseAudioFrame('{"audio":{"live":true,"bands":[0.5,2],"level":0.4,"pulse":0.1,"beats":7,"tempo":120}}')).toEqual({ live: true, bands: [0.5, 1], level: 0.4, pulse: 0.1, beats: 7, tempo: 120 });
  expect(parseAudioFrame('{"audio":{"bands":[]}}')).toBeNull();
  expect(parseAudioFrame("not json")).toBeNull();
  expect(parseAudioFrame('{"mode":"Stopped"}')).toBeNull();
  const status = parseStatus({ mode: "Stopped", playable: null, prototype: { position_ms: 0, up_next: [], energy: { current: 0.4, previous: [0.1, "x"], up_next: [2, null] } } })!;
  expect(status.prototype!.energy).toEqual({ current: 0.4, previous: [0.1, null], up_next: [1, null] });
  expect(parseStatus({ mode: "Stopped", playable: null, prototype: { position_ms: 0, up_next: [], energy: null } })!.prototype!.energy).toBeUndefined();
});
