import type { AudioFrame } from "../status.js";

/**
 * Fictional, deterministic stand-ins for the engine's measured data, so the
 * offline preview can show the turntable, crate, footer map, idle screen and
 * calendar. Every value is derived from a string hash or the clock; nothing
 * here is real listening data.
 */
function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}
const unit = (seed: number, step: number) => ((Math.sin(seed * 0.0001 + step * 12.9898) * 43758.5453) % 1 + 1) % 1;

export const demoCoverUrl = (id: string) => `https://i.scdn.co/image/offline-demo-${id}`;

/** A two-tone cover: a hue from the URL with a soft diagonal gradient. */
export function demoCover(url: string, width: number, height: number): string[] {
  const seed = hash(url), hue = seed % 360;
  const rgb = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return `#${[f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
  };
  return Array.from({ length: width * height * 2 }, (_, index) => {
    const x = index % width, y = Math.floor(index / width);
    const t = (x / Math.max(1, width - 1) + y / Math.max(1, height * 2 - 1)) / 2;
    return rgb((hue + t * 40) % 360, 0.55, 0.32 + t * 0.3);
  });
}

/** A song shape with an intro, two loud stretches and an outro. */
export function demoSongMap(uri: string, buckets = 200): Array<number | null> {
  const seed = hash(uri);
  return Array.from({ length: buckets }, (_, index) => {
    const t = index / buckets;
    const body = t < 0.08 ? t / 0.08 * 0.45 : t > 0.92 ? (1 - t) / 0.08 * 0.5 : 0.55 + 0.3 * Math.sin(t * Math.PI * 2 + seed % 7);
    return Math.round(Math.max(0.05, Math.min(1, body + (unit(seed, index) - 0.5) * 0.18)) * 1000) / 1000;
  });
}

export function demoEnergy(uri: string | undefined): number | null {
  return uri ? Math.round((0.2 + unit(hash(uri), 3) * 0.7) * 100) / 100 : null;
}

/** A gently pumping level with a steady 112 BPM beat. */
export function demoAudioFrame(nowMs: number, playing: boolean): AudioFrame {
  const beat = nowMs / (60_000 / 112);
  const pulse = playing ? Math.pow(1 - (beat % 1), 3) : 0;
  const level = playing ? Math.min(1, 0.38 + 0.18 * Math.sin(nowMs / 1700) + pulse * 0.25) : 0;
  return { live: playing, bands: Array.from({ length: 16 }, (_, i) => playing ? Math.max(0, level * (1 - i / 20) + 0.1 * Math.sin(nowMs / 300 + i)) : 0), level, pulse, beats: Math.floor(beat), tempo: playing ? 112 : null };
}

const isoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** A plausible year of listening: busier evenings and weekends, some quiet weeks. */
export function demoCalendar(days: number, today = new Date()) {
  const result: Array<{ date: string; plays: number; minutes: number }> = [];
  for (let back = days - 1; back >= 0; back--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const seed = hash(isoDate(date));
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const quiet = Math.floor(back / 7) % 9 === 4;
    const plays = quiet ? 0 : Math.round(unit(seed, 1) * (weekend ? 34 : 20) - 4);
    if (plays > 0) result.push({ date: isoDate(date), plays, minutes: Math.round(plays * (3.1 + unit(seed, 2))) });
  }
  const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const monthDays = result.filter(day => day.date.startsWith(month));
  const artists = ["Lumen Field", "Glass Harbor", "Night Orchard", "Paper Satellites", "Velvet Static", "Low Tide Choir"];
  const monthMinutes = monthDays.reduce((sum, day) => sum + day.minutes, 0);
  return {
    today: isoDate(today), days: result, month,
    month_minutes: monthMinutes, month_plays: monthDays.reduce((sum, day) => sum + day.plays, 0),
    top_artists: artists.map((name, index) => ({ name, minutes: Math.round(monthMinutes * (0.3 / (index + 1))), plays: Math.round(monthDays.length * 2.4 / (index + 1)) })),
  };
}
