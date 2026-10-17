import { expect, test } from "bun:test";
import { TURNTABLE_ORANGE, turntableLines, turntableWidth, type TurntableFrame } from "../src/screens/now-playing/turntable.js";

const base: TurntableFrame = { rows: 19, theme: "light", background: "#eef3f9", progress: 0.4, rotation: 0, playing: true };
const colors = (frame: TurntableFrame) => turntableLines(frame).flatMap(line => line.chunks.flatMap(chunk => [chunk.fg!.toInts().join(), chunk.bg!.toInts().join()]));
const rgb = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).concat(255).join();
const signature = (frame: TurntableFrame) => turntableLines(frame).map(line => line.chunks.map(chunk => `${chunk.text.length}:${chunk.fg!.toInts()}:${chunk.bg!.toInts()}`).join("|")).join("\n");

test("the deck fills a fixed grid of half-block cells", () => {
  expect(turntableWidth(19)).toBe(44);
  const lines = turntableLines(base);
  expect(lines).toHaveLength(19);
  for (const line of lines) {
    const text = line.chunks.map(chunk => chunk.text).join("");
    expect([...text]).toHaveLength(44);
    expect(text.replaceAll("▀", "")).toBe("");
  }
  expect(turntableLines({ ...base, rows: 4 })).toHaveLength(12);
  expect(turntableLines({ ...base, rows: 40 })).toHaveLength(20);
});

test("the cover is printed on the label and the label turns", () => {
  expect(colors({ ...base, cover: { width: 4, height: 4, pixels: Array(16).fill("#ff0000") } })).toContain(rgb("#ff0000"));
  expect(colors(base)).not.toContain(rgb("#ff0000"));
  expect(signature({ ...base, rotation: Math.PI })).not.toBe(signature(base));
});

test("the tonearm follows the playhead and parks without a track", () => {
  const start = signature({ ...base, progress: 0 }), end = signature({ ...base, progress: 1 }), parked = signature({ ...base, progress: null });
  expect(new Set([start, end, parked]).size).toBe(3);
});

test("the orange control dims while paused and both themes draw", () => {
  const covered = { ...base, cover: { width: 1, height: 1, pixels: ["#203040"] } };
  expect(colors(covered)).toContain(rgb(TURNTABLE_ORANGE));
  expect(colors({ ...covered, playing: false })).not.toContain(rgb(TURNTABLE_ORANGE));
  expect(signature({ ...base, theme: "dark", background: "#080a10" })).not.toBe(signature(base));
});
