import { RGBA, StyledText, type TextChunk } from "@opentui/core";

/**
 * How finely a cell is divided. `half` is the upper-half block every terminal
 * draws: two pixels a cell, one above the other. The rest split a cell into a
 * 2×2, 2×3 or 2×4 grid of block mosaics and give each cell two colours, so a
 * drawing keeps its size and gains up to four times the pixels.
 */
export type PixelMode = "half" | "quadrant" | "sextant" | "octant";
const GRID: Record<PixelMode, readonly [number, number]> = { half: [1, 2], quadrant: [2, 2], sextant: [2, 3], octant: [2, 4] };
const MODES = Object.keys(GRID) as PixelMode[];

/**
 * Pick the finest mosaic the terminal draws itself rather than from a font.
 * VTE (GNOME Terminal, Ptyxis) has drawn octants since 0.78 and sextants since
 * 0.76; Ghostty draws octants and kitty and WezTerm sextants. Anything else
 * keeps half blocks. `RESONANCE_PIXELS` overrides the guess.
 */
export function detectPixelMode(env: Record<string, string | undefined> = process.env): PixelMode {
  const wanted = env.RESONANCE_PIXELS?.trim().toLowerCase();
  if (wanted && (MODES as string[]).includes(wanted)) return wanted as PixelMode;
  const vte = Number(env.VTE_VERSION ?? 0), program = env.TERM_PROGRAM?.toLowerCase();
  if (vte >= 7800 || program === "ghostty") return "octant";
  if (vte >= 7600 || env.KITTY_WINDOW_ID || program === "wezterm") return "sextant";
  return "half";
}
let mode = detectPixelMode();
export const pixelMode = (): PixelMode => mode;
export function setPixelMode(next: PixelMode): void { mode = next; }
/** Sub-pixels per cell, across and down. */
export const pixelGrid = (which: PixelMode = mode): readonly [number, number] => GRID[which];

export type Color = string | number;
const parsed = new Map<string, number>();
/** A colour as 0xrrggbb; unreadable colours are black. */
export function rgb(color: Color): number {
  if (typeof color === "number") return color;
  let value = parsed.get(color);
  if (value === undefined) {
    value = /^#[0-9a-f]{6}$/i.test(color) ? parseInt(color.slice(1), 16) : 0;
    if (parsed.size > 4096) parsed.clear();
    parsed.set(color, value);
  }
  return value;
}
/** Blend two colours without the string round trip, for per-pixel work. */
export function mix(from: Color, to: Color, amount: number): number {
  const a = rgb(from), b = rgb(to), t = Math.max(0, Math.min(1, amount));
  const channel = (shift: number) => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
const rgba = (color: number) => RGBA.fromInts((color >> 16) & 255, (color >> 8) & 255, color & 255, 255);

// Bit k of a mask is sub-pixel k of the cell, left to right and then down.
const QUADRANTS = [..." ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"];
const SEXTANTS = Array.from({ length: 64 }, (_, mask) =>
  mask === 0 ? " " : mask === 63 ? "█" : mask === 21 ? "▌" : mask === 42 ? "▐" : String.fromCodePoint(0x1fb00 + mask - 1 - (mask > 21 ? 1 : 0) - (mask > 42 ? 1 : 0)));
/** Octant patterns Unicode already had under other names; U+1CD00 onward covers the rest in mask order. */
const OCTANT_ELSEWHERE: Record<number, string> = {
  0x00: " ", 0xff: "█", 0x0f: "▀", 0xf0: "▄", 0x55: "▌", 0xaa: "▐", 0x05: "▘", 0x0a: "▝", 0x50: "▖", 0xa0: "▗",
  0xa5: "▚", 0x5a: "▞", 0xf5: "▙", 0x5f: "▛", 0xaf: "▜", 0xfa: "▟", 0x03: "\u{1fb82}", 0xc0: "▂", 0x3f: "\u{1fb85}", 0xfc: "▆",
  0x01: "\u{1cea8}", 0x02: "\u{1ceab}", 0x40: "\u{1cea3}", 0x80: "\u{1cea0}", 0x14: "\u{1fbe6}", 0x28: "\u{1fbe7}",
};
const OCTANTS = (() => { let next = 0x1cd00; return Array.from({ length: 256 }, (_, mask) => OCTANT_ELSEWHERE[mask] ?? String.fromCodePoint(next++)); })();
const GLYPHS: Record<Exclude<PixelMode, "half">, readonly string[]> = { quadrant: QUADRANTS, sextant: SEXTANTS, octant: OCTANTS };
/** The mosaic glyph for a mask, for tools that need to read frames back. */
export const mosaicGlyphs = (which: Exclude<PixelMode, "half">): readonly string[] => GLYPHS[which];

const distance = (a: number, b: number) => {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
  return 3 * dr * dr + 4 * dg * dg + 2 * db * db;
};
const channel = (color: number, index: number) => (color >> (16 - index * 8)) & 255;
const WEIGHTS = [3, 4, 2];
/** Average of the colours on one side of a split, weighted by how many sub-pixels hold each. */
function average(colors: number[], weights: number[], side: number, set: number): number {
  let total = 0; const sums = [0, 0, 0];
  colors.forEach((color, index) => {
    if (((set >> index) & 1) !== side) return;
    total += weights[index]!;
    for (let c = 0; c < 3; c++) sums[c]! += channel(color, c) * weights[index]!;
  });
  return (Math.round(sums[0]! / total) << 16) | (Math.round(sums[1]! / total) << 8) | Math.round(sums[2]! / total);
}
/**
 * Two colours for one cell. With a handful of distinct colours, try every way
 * of dividing them and keep the one that strays least from the drawing, so a
 * small dot on a rim cannot tint the plinth around it. Busier cells, such as
 * gradients and cover art, settle on averages from their two most different
 * sub-pixels.
 * Returns the foreground mask with both colours.
 */
function split(cell: number[], count: number): [number, number, number] {
  const colors: number[] = [], weights: number[] = [], index: number[] = [];
  for (let k = 0; k < count; k++) {
    let at = colors.indexOf(cell[k]!);
    if (at < 0) { at = colors.length; colors.push(cell[k]!); weights.push(0); }
    weights[at]!++; index.push(at);
  }
  if (colors.length === 1) return [0, colors[0]!, colors[0]!];
  let set = 0;
  if (colors.length <= 5) {
    // Colour 0 stays on side 0; every other colour goes either way. Each side
    // keeps one of its own colours, the one nearest the rest, so a flat area
    // stays exactly its colour and only the odd sub-pixel gives way.
    let least = Infinity, chosen: [number, number] = [colors[0]!, colors[0]!];
    for (let candidate = 2; candidate < 1 << colors.length; candidate += 2) {
      let error = 0; const picks: number[] = [];
      for (let side = 0; side < 2; side++) {
        let best = Infinity, pick = 0;
        colors.forEach((color, i) => {
          if (((candidate >> i) & 1) !== side) return;
          let cost = 0;
          colors.forEach((other, j) => { if (((candidate >> j) & 1) === side) cost += weights[j]! * distance(color, other); });
          if (cost < best) { best = cost; pick = color; }
        });
        error += best; picks.push(pick);
      }
      if (error < least) { least = error; set = candidate; chosen = [picks[1]!, picks[0]!]; }
    }
    return orient(cell, count, colors, index, set, chosen[0], chosen[1]);
  } else {
    let a = 0, b = 1, far = -1;
    for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
      const d = distance(colors[i]!, colors[j]!);
      if (d > far) { far = d; a = i; b = j; }
    }
    let back = colors[a]!, fore = colors[b]!;
    for (let pass = 0; pass < 2; pass++) {
      set = 0;
      colors.forEach((color, i) => { if (distance(color, fore) < distance(color, back)) set |= 1 << i; });
      if (!set || set === (1 << colors.length) - 1) return [0, cell[0]!, cell[0]!];
      back = average(colors, weights, 0, set); fore = average(colors, weights, 1, set);
    }
  }
  return orient(cell, count, colors, index, set, average(colors, weights, 1, set), average(colors, weights, 0, set));
}
/** Turn a split of the distinct colours into a sub-pixel mask, the first sub-pixel always in the foreground. */
function orient(cell: number[], count: number, colors: number[], index: number[], set: number, fore: number, back: number): [number, number, number] {
  let mask = 0;
  for (let k = 0; k < count; k++) if ((set >> index[k]!) & 1) mask |= 1 << k;
  return mask & 1 ? [mask, fore, back] : [~mask & ((1 << count) - 1), back, fore];
}

/**
 * A small raster for terminal pixel art. Drawing happens in base pixels,
 * square-ish and half a cell tall, so a picture is the same size in every
 * mode; finer modes simply sample each shape at more points. A base pixel `i`
 * is centred on coordinate `i`. Shared by the turntable, the VU meter and
 * the search thumbnails.
 */
export class PixelCanvas {
  /** Sub-pixels per base pixel, across and down. */
  readonly sx: number;
  readonly sy: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly data: Int32Array;
  /** Base-pixel area outside which nothing is painted, or null for the whole canvas. */
  clip: { x: number; y: number; width: number; height: number } | null = null;

  constructor(readonly width: number, readonly height: number, background: Color, readonly mode: PixelMode = pixelMode()) {
    const [gx, gy] = GRID[mode];
    this.sx = gx; this.sy = gy / 2;
    this.columns = width * gx; this.rows = Math.ceil(height / 2) * gy;
    this.data = new Int32Array(this.columns * this.rows).fill(rgb(background));
  }
  /** The smallest dot this canvas can draw, in base pixels. */
  get fine(): number { return 1 / this.sx; }

  /** Sub-pixel indices whose centres fall in the base interval [from, to). */
  private span(from: number, to: number, scale: number, limit: number): [number, number] {
    const start = Math.max(0, Math.ceil((from + 0.5) * scale - 0.5 - 1e-9));
    return [start, Math.min(limit, Math.ceil((to + 0.5) * scale - 0.5 - 1e-9))];
  }
  private paintArea(x0: number, y0: number, x1: number, y1: number, paint: (bx: number, by: number) => Color | null): void {
    if (this.clip) {
      x0 = Math.max(x0, this.clip.x - 0.5); y0 = Math.max(y0, this.clip.y - 0.5);
      x1 = Math.min(x1, this.clip.x + this.clip.width - 0.5); y1 = Math.min(y1, this.clip.y + this.clip.height - 0.5);
    }
    const [i0, i1] = this.span(x0, x1, this.sx, this.columns), [j0, j1] = this.span(y0, y1, this.sy, this.rows);
    for (let j = j0; j < j1; j++) {
      const by = (j + 0.5) / this.sy - 0.5;
      for (let i = i0; i < i1; i++) {
        const color = paint((i + 0.5) / this.sx - 0.5, by);
        if (color !== null) this.data[j * this.columns + i] = rgb(color);
      }
    }
  }

  /** A dot `size` base pixels across, never smaller than one sub-pixel. */
  put(x: number, y: number, color: Color, size = 1): void {
    const half = size / 2;
    let [i0, i1] = this.span(x - half, x + half, this.sx, this.columns), [j0, j1] = this.span(y - half, y + half, this.sy, this.rows);
    if (i1 <= i0) { i0 = Math.round((x + 0.5) * this.sx - 0.5); i1 = i0 + 1; }
    if (j1 <= j0) { j0 = Math.round((y + 0.5) * this.sy - 0.5); j1 = j0 + 1; }
    const value = rgb(color);
    for (let j = Math.max(0, j0); j < Math.min(this.rows, j1); j++) for (let i = Math.max(0, i0); i < Math.min(this.columns, i1); i++) {
      if (this.clip && !this.inClip((i + 0.5) / this.sx - 0.5, (j + 0.5) / this.sy - 0.5)) continue;
      this.data[j * this.columns + i] = value;
    }
  }
  private inClip(bx: number, by: number): boolean {
    const c = this.clip!;
    return bx >= c.x - 0.5 && by >= c.y - 0.5 && bx < c.x + c.width - 0.5 && by < c.y + c.height - 0.5;
  }
  /** Fill base pixels `x`..`x + w - 1` by `y`..`y + h - 1`; fractions paint the sub-pixels they cover. */
  rect(x: number, y: number, w: number, h: number, color: Color): void {
    this.paintArea(x - 0.5, y - 0.5, x + w - 0.5, y + h - 0.5, () => color);
  }
  /** Paint every sample within `radius`; `paint` may return null to leave one alone. */
  disc(cx: number, cy: number, radius: number, paint: (r: number, angle: number, dx: number, dy: number) => Color | null): void {
    this.paintArea(cx - radius - 0.5, cy - radius - 0.5, cx + radius + 0.5, cy + radius + 0.5, (bx, by) => {
      const dx = bx - cx, dy = by - cy, r = Math.hypot(dx, dy);
      return r > radius ? null : paint(r, Math.atan2(dy, dx), dx, dy);
    });
  }
  /** A stroke `thickness` base pixels wide with round ends. */
  line(x0: number, y0: number, x1: number, y1: number, color: Color, thickness = 1): void {
    const half = Math.max(thickness, this.fine) / 2, lx = x1 - x0, ly = y1 - y0, length = lx * lx + ly * ly;
    this.paintArea(Math.min(x0, x1) - half, Math.min(y0, y1) - half, Math.max(x0, x1) + half + 1e-6, Math.max(y0, y1) + half + 1e-6, (bx, by) => {
      const t = length ? Math.max(0, Math.min(1, ((bx - x0) * lx + (by - y0) * ly) / length)) : 0;
      return Math.hypot(bx - x0 - lx * t, by - y0 - ly * t) <= half ? color : null;
    });
  }
  /** Sample a cover into base pixels `x0`.. by `y0`.., nearest neighbour. */
  image(x0: number, y0: number, w: number, h: number, cover: { width: number; height: number; pixels: readonly string[] }): void {
    if (cover.pixels.length !== cover.width * cover.height) return;
    this.paintArea(x0 - 0.5, y0 - 0.5, x0 + w - 0.5, y0 + h - 0.5, (bx, by) => {
      const sx = Math.min(cover.width - 1, Math.max(0, Math.floor((bx - x0 + 0.5) * cover.width / w)));
      const sy = Math.min(cover.height - 1, Math.max(0, Math.floor((by - y0 + 0.5) * cover.height / h)));
      return cover.pixels[sy * cover.width + sx]!;
    });
  }
  /** One StyledText per terminal row, with runs of identical colours merged. */
  lines(): StyledText[] {
    const [gx, gy] = GRID[this.mode], count = gx * gy, cell: number[] = Array(count).fill(0);
    const glyphs = this.mode === "half" ? null : GLYPHS[this.mode];
    return Array.from({ length: Math.ceil(this.height / 2) }, (_, row) => {
      const chunks: TextChunk[] = [];
      let run = "", fg = 0, bg = 0;
      const flush = () => { if (run) chunks.push({ __isChunk: true, text: run, fg: rgba(fg), bg: rgba(bg) }); };
      for (let x = 0; x < this.width; x++) {
        for (let k = 0; k < count; k++) cell[k] = this.data[(row * gy + Math.floor(k / gx)) * this.columns + x * gx + (k % gx)]!;
        let glyph: string, fore: number, back: number;
        if (!glyphs) { glyph = "▀"; fore = cell[0]!; back = cell[1]!; }
        else { const [mask, a, b] = split(cell, count); glyph = glyphs[mask]!; fore = a; back = b; }
        if (run && fore === fg && back === bg) { run += glyph; continue; }
        flush(); run = glyph; fg = fore; bg = back;
      }
      flush();
      return new StyledText(chunks);
    });
  }
}
