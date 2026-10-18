import type { EnergyStatus } from "../status.js";

const LEVELS = "▁▂▃▄▅▆▇█";
export type EnergyTone = "past" | "current" | "rising" | "falling" | "steady" | "ahead" | "label";

/** How far the next song's energy must move from this one's to count as a change. */
const STEP = 0.08;

const bar = (value: number | null) => value === null ? "·" : LEVELS[Math.min(7, Math.max(0, Math.round(value * 7)))]!;

/**
 * The session's energy as one line: songs already played, the playing one
 * picked out, then what is coming. The next song is coloured by whether it
 * will lift or calm things, and named in a word at the end.
 * Returns null when too little has been measured to say anything.
 */
export function energyMap(energy: EnergyStatus | null | undefined, maxPast = 8, maxAhead = 10): Array<[string, EnergyTone]> | null {
  if (!energy) return null;
  const known = [energy.current, ...energy.up_next].filter(value => value !== null).length;
  if (known < 3) return null;
  const segments: Array<[string, EnergyTone]> = [];
  const past = energy.previous.slice(-maxPast);
  if (past.length) segments.push([past.map(bar).join(""), "past"]);
  segments.push([bar(energy.current), "current"]);
  const [next, ...rest] = energy.up_next.slice(0, maxAhead);
  let word = "";
  if (next !== undefined) {
    const tone: EnergyTone = next === null || energy.current === null ? "steady" : next > energy.current + STEP ? "rising" : next < energy.current - STEP ? "falling" : "steady";
    segments.push([bar(next), tone]);
    word = tone === "rising" ? "lifts" : tone === "falling" ? "calms" : next === null ? "" : "holds";
  }
  if (rest.length) segments.push([rest.map(bar).join(""), "ahead"]);
  if (word) segments.push([` next ${word}`, "label"]);
  return segments;
}
