import type { StyledText } from "@opentui/core";
import type { ThemeName } from "../../theme.js";
import { blendHex } from "./motion-colors.js";
import { mix, PixelCanvas, type PixelMode } from "./pixels.js";

/**
 * A top-down record player in the manner of a Braun PS 500: white plinth,
 * aluminium platter, black disc and one orange control. It is laid out in
 * square-ish pixels two to a cell, and sampled finer where the terminal draws
 * block mosaics.
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
  /**
   * Strobe dot phase around the platter edge, 0..1, or null to hide them. A
   * fixed phase reads as dots standing still, as on a deck running at speed.
   */
  strobe?: number | null;
  /** 0 with the stylus in the groove, 1 with the arm back on its rest. */
  lift?: number;
  /** 0 with the record on the platter, 1 with it slid fully off to the left. */
  slide?: number;
  /** Mosaic to draw with; the terminal's best by default. */
  mode?: PixelMode;
}

export const TURNTABLE_MIN_ROWS = 12;
export const TURNTABLE_MAX_ROWS = 20;
export const TURNTABLE_ORANGE = "#e8642c";

const DECKS = {
  light: { plinth: "#f8f7f3", shadow: "#d2cfc8", platter: "#c3c2be", arm: "#a3a29d", head: "#e9e8e3", pivot: "#c7c6c1", pivotTop: "#8a8984", weight: "#5a5955", label: "#d8d4cc" },
  dark: { plinth: "#232427", shadow: "#0c0d0f", platter: "#6f6e6a", arm: "#b5b4b0", head: "#e2e1dc", pivot: "#3a3b3e", pivotTop: "#9c9b97", weight: "#55565a", label: "#4a4844" },
} as const;
const STROBE = { light: "#77766f", dark: "#c9c8c2" } as const;
const MAT = "#2b2b2e";
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
  const canvas = new PixelCanvas(width, height, frame.background, frame.mode);
  // Fine canvases get hairline details; half blocks keep whole pixels.
  const fine = canvas.fine < 1;

  const plinthHeight = height - 1, plinthWidth = width - 1, k = plinthHeight / 38;
  canvas.rect(1, plinthHeight, plinthWidth, 1, deck.shadow);
  canvas.rect(plinthWidth, 1, 1, plinthHeight, deck.shadow);
  canvas.rect(0, 0, plinthWidth, plinthHeight, deck.plinth);

  const cx = 17 * k, cy = 19 * k, radius = 15 * k, label = 5.5 * k;
  canvas.disc(cx, cy, radius + 1.5 * k, () => deck.platter);
  if (frame.strobe !== null && frame.strobe !== undefined) {
    const dots = 32, ring = radius + 0.9 * k;
    for (let i = 0; i < dots; i++) {
      const angle = (i + frame.strobe) / dots * Math.PI * 2;
      canvas.put(cx + ring * Math.cos(angle), cy + ring * Math.sin(angle), STROBE[frame.theme], fine ? 0.6 : 1);
    }
  }
  const slide = Math.max(0, Math.min(1, frame.slide ?? 0));
  const spindle = fine ? 0.55 : 0.8;
  if (slide > 0) canvas.disc(cx, cy, radius - 0.5, r => r < spindle ? "#d8d8dc" : MAT);
  // The record leaves to the left, clear of the arm on the right.
  const rx = cx - slide * (cx + radius + 2);
  const cos = Math.cos(frame.rotation), sin = Math.sin(frame.rotation);
  // Fine canvases show the quiet bands between tracks instead of a groove texture, which would shimmer.
  const gaps = [0.5, 0.68, 0.84].map(at => label + 0.9 + (radius - label - 1.9) * at);
  canvas.disc(rx, cy, radius, (r, angle, dx, dy) => {
    if (r < spindle) return "#d8d8dc";
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
    if (r < label + 0.9) return mix(VINYL, "#000000", 0.3);
    let color = fine
      ? mix(VINYL, "#ffffff", gaps.some(gap => Math.abs(r - gap) < 0.22) ? 0.07 : 0)
      : mix(VINYL, Math.floor(r * 1.3) % 2 ? "#ffffff" : "#000000", 0.035);
    color = mix(color, SHEEN, Math.pow(Math.max(0, Math.cos(2 * (angle - 0.8))), 8) * 0.5 * (r / radius));
    return r > radius - 1 ? mix(color, "#ffffff", 0.08) : color;
  });

  const pivotX = 38 * k, pivotY = 6 * k, armLength = 22 * k;
  // Parked beside the platter on its rest.
  const restX = pivotX + 0.6 * k, restY = pivotY + armLength;
  canvas.rect(restX - 1, restY + 1.5, 3, 1.5, deck.pivot);
  let tipX = restX, tipY = restY;
  if (frame.progress !== null) {
    // The stylus sits where the playhead is, travelling from edge to label.
    const needle = radius - 1.5 * k - (radius - 8 * k) * Math.max(0, Math.min(1, frame.progress));
    const distance = Math.hypot(pivotX - cx, pivotY - cy);
    const along = (needle * needle - armLength * armLength + distance * distance) / (2 * distance);
    const across = Math.sqrt(Math.max(0, needle * needle - along * along));
    const ux = (pivotX - cx) / distance, uy = (pivotY - cy) / distance;
    const bx = cx + along * ux, by = cy + along * uy;
    // The arm can reach that groove at two points; the lower one is the one a
    // pivot at the top right swings to.
    const [grooveX, grooveY] = by - across * ux > by + across * ux ? [bx + across * uy, by - across * ux] : [bx - across * uy, by + across * ux];
    // Swing between groove and rest around the pivot, so a lift reads as an arc.
    const lift = Math.max(0, Math.min(1, frame.lift ?? 0));
    const from = Math.atan2(grooveY - pivotY, grooveX - pivotX), to = Math.atan2(restY - pivotY, restX - pivotX);
    const angle = from + (to - from) * lift;
    tipX = pivotX + armLength * Math.cos(angle); tipY = pivotY + armLength * Math.sin(angle);
  }
  const backX = pivotX + (pivotX - tipX) * 0.22, backY = pivotY + (pivotY - tipY) * 0.22;
  const reach = Math.hypot(tipX - pivotX, tipY - pivotY) || 1, ax = (tipX - pivotX) / reach, ay = (tipY - pivotY) / reach;
  if (fine) {
    // Counterweight and headshell turn with the arm.
    canvas.line(pivotX, pivotY, backX, backY, deck.arm, 0.8);
    canvas.line(backX - ax * 0.9, backY - ay * 0.9, backX + ax * 0.6, backY + ay * 0.6, deck.weight, 2.6);
    canvas.disc(pivotX, pivotY, 2.6 * Math.max(1, k * 0.8), r => r < 1.1 ? deck.pivotTop : r > 2.2 * Math.max(1, k * 0.8) ? mix(deck.pivot, "#000000", 0.25) : deck.pivot);
    canvas.line(pivotX, pivotY, tipX - ax * 1.2, tipY - ay * 1.2, deck.arm, 0.8);
    canvas.line(tipX - ax * 1.4, tipY - ay * 1.4, tipX + ax * 0.9, tipY + ay * 0.9, deck.head, 1.8);
    // The finger lift, a small tab off the headshell.
    canvas.line(tipX - ax * 0.6, tipY - ay * 0.6, tipX - ax * 0.6 - ay * 1.6, tipY - ay * 0.6 + ax * 1.6, deck.head, 0.5);
  } else {
    canvas.line(pivotX, pivotY, backX, backY, deck.arm);
    canvas.rect(backX - 1, backY - 1, 3, 3, deck.weight);
    canvas.disc(pivotX, pivotY, 2.6 * Math.max(1, k * 0.8), r => r < 1.3 ? deck.pivotTop : deck.pivot);
    canvas.line(pivotX, pivotY, tipX, tipY, deck.arm);
    canvas.rect(tipX - 1, tipY - 1, 2, 3, deck.head);
  }
  canvas.rect(37 * k, 31 * k, 3 * k, 3 * k, frame.playing ? TURNTABLE_ORANGE : blendHex(deck.plinth, TURNTABLE_ORANGE, 0.45));
  return canvas.lines();
}
