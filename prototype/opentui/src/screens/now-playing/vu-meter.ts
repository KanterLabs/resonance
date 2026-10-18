import type { StyledText } from "@opentui/core";
import type { ThemeName } from "../../theme.js";
import { blendHex } from "./motion-colors.js";
import { PixelCanvas } from "./pixels.js";
import { TURNTABLE_ORANGE } from "./turntable.js";

const FACES = {
  light: { face: "#f4f1e8", rim: "#d2cfc8", tick: "#77766f", needle: "#1d1d1f", pivot: "#5a5955" },
  dark: { face: "#17181b", rim: "#2c2d31", tick: "#8f8e88", needle: "#eceae4", pivot: "#9c9b97" },
} as const;
/** The needle sweeps 50° either side of vertical. */
const SWEEP = (50 * Math.PI) / 180;
/** The last stretch of the scale, drawn in the deck's orange. */
const RED_ZONE = 0.72;

/** Map the tap's 0..1 level onto the meter so ordinary music sits mid-scale. */
export function meterTarget(level: number): number {
  return Math.max(0, Math.min(1.08, Math.pow(Math.max(0, level), 0.6) * 1.15));
}

/**
 * A needle with mass: a lightly damped spring, so it rises quickly, swings a
 * touch past a loud hit and settles, the way a moving-coil meter does.
 */
export class Needle {
  value = 0;
  private velocity = 0;
  step(target: number, seconds: number, reduced = false): number {
    if (reduced) { this.value = target; this.velocity = 0; return this.value; }
    // Integrate in short slices so a late frame cannot make the spring explode.
    let left = Math.min(0.25, Math.max(0, seconds));
    while (left > 0) {
      const dt = Math.min(left, 1 / 120);
      const acceleration = 180 * (target - this.value) - 15 * this.velocity;
      this.velocity += acceleration * dt; this.value += this.velocity * dt; left -= dt;
    }
    this.value = Math.max(-0.05, Math.min(1.12, this.value));
    return this.value;
  }
}

/** A Braun-style meter face `columns` cells wide and `rows` cells tall. */
export function vuMeterLines(value: number, columns: number, rows: number, theme: ThemeName, background: string): StyledText[] {
  const width = Math.max(8, columns), height = Math.max(4, rows * 2);
  const colors = FACES[theme];
  const canvas = new PixelCanvas(width, height, background);
  canvas.rect(0, 0, width, height, colors.rim);
  canvas.rect(1, 1, width - 2, height - 2, colors.face);
  // The pivot sits just below the face, and the scale is a wide ellipse, so a
  // short meter still gets a long sweep.
  const px = (width - 1) / 2, py = height - 0.5, rx = (width - 4) / 2 / Math.sin(SWEEP), ry = height - 2.5;
  const at = (t: number, inset = 0): [number, number] => {
    const angle = -SWEEP + 2 * SWEEP * t;
    return [px + (rx - inset) * Math.sin(angle), py - (ry - inset * ry / rx) * Math.cos(angle)];
  };
  const steps = Math.max(9, Math.round(width * 0.8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, color = t >= RED_ZONE ? TURNTABLE_ORANGE : colors.tick;
    canvas.put(...at(t), color);
    if (i % Math.max(1, Math.round(steps / 10)) === 0) canvas.put(...at(t, 1.2), color);
  }
  const [tipX, tipY] = at(Math.max(-0.04, Math.min(1.08, value)), -0.4);
  const length = Math.ceil(Math.hypot(tipX - px, tipY - py) * 2);
  for (let i = 0; i <= length; i++) {
    const x = px + (tipX - px) * i / length, y = py + (tipY - py) * i / length;
    // Keep the needle on the glass, inside the rim.
    if (x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2) canvas.put(x, y, colors.needle);
  }
  canvas.rect(px - 1, height - 2, 3, 1, blendHex(colors.face, colors.pivot, 0.8));
  return canvas.lines();
}
