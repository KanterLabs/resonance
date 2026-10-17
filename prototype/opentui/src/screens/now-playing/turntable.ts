import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import type { ThemeName } from "../../theme.js";
import { blendHex } from "./motion-colors.js";

/**
 * A top-down record player in the manner of a Braun PS 500: white plinth,
 * aluminium platter, black disc and one orange control. Every terminal cell
 * is an upper-half block, so each cell carries two square-ish pixels.
 */
export interface TurntableCover { width: number; height: number; pixels: readonly string[] }
export interface TurntableFrame {
  /** Terminal rows; the plinth is drawn two pixels per row. */
  rows: number;
  theme: ThemeName;
  /** Colour around the plinth, normally the workspace background. */
  background: string;
  cover?: TurntableCover | null;
  /** Fraction of the track played; null parks the tonearm on its rest. */
  progress: number | null;
  /** Label angle in radians, so the cover visibly turns while playing. */
  rotation: number;
  playing: boolean;
}

export const TURNTABLE_MIN_ROWS = 12;
export const TURNTABLE_MAX_ROWS = 20;
export const TURNTABLE_ORANGE = "#e8642c";

const DECKS = {
  light: { plinth: "#f8f7f3", shadow: "#d2cfc8", platter: "#c3c2be", arm: "#a3a29d", head: "#e9e8e3", pivot: "#c7c6c1", pivotTop: "#8a8984", weight: "#5a5955", label: "#d8d4cc" },
  dark: { plinth: "#232427", shadow: "#0c0d0f", platter: "#6f6e6a", arm: "#b5b4b0", head: "#e2e1dc", pivot: "#3a3b3e", pivotTop: "#9c9b97", weight: "#55565a", label: "#4a4844" },
} as const;
const VINYL = "#1a1a1c";
const SHEEN = "#b9b9c2";

/** The plinth keeps the PS 500's 44:38 proportions plus a one-cell shadow. */
export function turntableWidth(rows: number): number {
  return Math.round((rows * 2 - 1) * 44 / 38) + 1;
}

export function turntableLines(frame: TurntableFrame): StyledText[] {
  const rows = Math.max(TURNTABLE_MIN_ROWS, Math.min(TURNTABLE_MAX_ROWS, Math.round(frame.rows)));
  const width = turntableWidth(rows), height = rows * 2;
  const deck = DECKS[frame.theme];
  const pixels: string[] = Array.from({ length: width * height }, () => frame.background);
  const put = (x: number, y: number, color: string) => {
    const px = Math.round(x), py = Math.round(y);
    if (px >= 0 && py >= 0 && px < width && py < height) pixels[py * width + px] = color;
  };
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let px = Math.round(x); px < Math.round(x + w); px++) for (let py = Math.round(y); py < Math.round(y + h); py++) put(px, py, color);
  };
  const disc = (cx: number, cy: number, radius: number, paint: (r: number, angle: number, dx: number, dy: number) => string) => {
    for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px++) for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py++) {
      const dx = px - cx, dy = py - cy, r = Math.hypot(dx, dy);
      if (r <= radius) put(px, py, paint(r, Math.atan2(dy, dx), dx, dy));
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, color: string) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i++) put(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, color);
  };

  const plinthHeight = height - 1, plinthWidth = width - 1, k = plinthHeight / 38;
  rect(1, plinthHeight, plinthWidth, 1, deck.shadow);
  rect(plinthWidth, 1, 1, plinthHeight, deck.shadow);
  rect(0, 0, plinthWidth, plinthHeight, deck.plinth);

  const cx = 17 * k, cy = 19 * k, radius = 15 * k, label = 5.5 * k;
  disc(cx, cy, radius + 1.5 * k, () => deck.platter);
  const cos = Math.cos(frame.rotation), sin = Math.sin(frame.rotation);
  disc(cx, cy, radius, (r, angle, dx, dy) => {
    if (r < 0.8) return "#d8d8dc";
    if (r < label) {
      // Rotate the sample point, not the disc, so the label turns cleanly.
      const u = 0.5 + (dx * cos + dy * sin) / (2 * label), v = 0.5 + (dy * cos - dx * sin) / (2 * label);
      const cover = frame.cover;
      if (cover && cover.pixels.length === cover.width * cover.height) {
        const x = Math.min(cover.width - 1, Math.max(0, Math.floor(u * cover.width)));
        const y = Math.min(cover.height - 1, Math.max(0, Math.floor(v * cover.height)));
        return cover.pixels[y * cover.width + x]!;
      }
      return Math.hypot(u - 0.78, v - 0.5) < 0.12 ? TURNTABLE_ORANGE : deck.label;
    }
    if (r < label + 0.9) return blendHex(VINYL, "#000000", 0.3);
    let color = blendHex(VINYL, Math.floor(r * 1.3) % 2 ? "#ffffff" : "#000000", 0.035);
    color = blendHex(color, SHEEN, Math.pow(Math.max(0, Math.cos(2 * (angle - 0.8))), 8) * 0.5 * (r / radius));
    return r > radius - 1 ? blendHex(color, "#ffffff", 0.08) : color;
  });

  const pivotX = 38 * k, pivotY = 6 * k, armLength = 22 * k;
  let tipX: number, tipY: number;
  if (frame.progress === null) {
    // Parked beside the platter on its rest.
    tipX = pivotX + 0.6 * k; tipY = pivotY + armLength;
    rect(tipX - 1, tipY + 1.5, 3, 1.5, deck.pivot);
  } else {
    // The stylus sits where the playhead is, travelling from edge to label.
    const needle = radius - 1.5 * k - (radius - 8 * k) * Math.max(0, Math.min(1, frame.progress));
    const distance = Math.hypot(pivotX - cx, pivotY - cy);
    const along = (needle * needle - armLength * armLength + distance * distance) / (2 * distance);
    const across = Math.sqrt(Math.max(0, needle * needle - along * along));
    const ux = (pivotX - cx) / distance, uy = (pivotY - cy) / distance;
    const bx = cx + along * ux, by = cy + along * uy;
    // The arm can reach that groove at two points; the lower one is the one a
    // pivot at the top right swings to.
    [tipX, tipY] = by - across * ux > by + across * ux ? [bx + across * uy, by - across * ux] : [bx - across * uy, by + across * ux];
  }
  const backX = pivotX + (pivotX - tipX) * 0.22, backY = pivotY + (pivotY - tipY) * 0.22;
  line(pivotX, pivotY, backX, backY, deck.arm);
  rect(backX - 1, backY - 1, 3, 3, deck.weight);
  disc(pivotX, pivotY, 2.6 * Math.max(1, k * 0.8), r => r < 1.3 ? deck.pivotTop : deck.pivot);
  line(pivotX, pivotY, tipX, tipY, deck.arm);
  rect(tipX - 1, tipY - 1, 2, 3, deck.head);
  rect(37 * k, 31 * k, 3 * k, 3 * k, frame.playing ? TURNTABLE_ORANGE : blendHex(deck.plinth, TURNTABLE_ORANGE, 0.45));

  return Array.from({ length: rows }, (_, row) => {
    const chunks: TextChunk[] = [];
    let run = "", top = "", bottom = "";
    const flush = () => { if (run) chunks.push({ __isChunk: true, text: run, fg: RGBA.fromHex(top), bg: RGBA.fromHex(bottom) }); };
    for (let x = 0; x < width; x++) {
      const upper = pixels[row * 2 * width + x]!, lower = pixels[(row * 2 + 1) * width + x]!;
      if (run && upper === top && lower === bottom) { run += "▀"; continue; }
      flush(); run = "▀"; top = upper; bottom = lower;
    }
    flush();
    return new StyledText(chunks);
  });
}
