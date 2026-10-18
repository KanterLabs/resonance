import { RGBA, StyledText, type TextChunk } from "@opentui/core";

/**
 * A small raster drawn as upper-half blocks: each terminal cell carries two
 * square-ish pixels, the top one as the glyph colour and the bottom as the
 * background. Shared by the turntable, the VU meter and the idle screen.
 */
export class PixelCanvas {
  readonly pixels: string[];
  constructor(readonly width: number, readonly height: number, background: string) {
    this.pixels = Array.from({ length: width * height }, () => background);
  }
  put(x: number, y: number, color: string): void {
    const px = Math.round(x), py = Math.round(y);
    if (px >= 0 && py >= 0 && px < this.width && py < this.height) this.pixels[py * this.width + px] = color;
  }
  get(x: number, y: number): string | undefined {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.pixels[y * this.width + x] : undefined;
  }
  rect(x: number, y: number, w: number, h: number, color: string): void {
    for (let px = Math.round(x); px < Math.round(x + w); px++) for (let py = Math.round(y); py < Math.round(y + h); py++) this.put(px, py, color);
  }
  /** Paint every pixel within `radius`; `paint` may return null to leave one alone. */
  disc(cx: number, cy: number, radius: number, paint: (r: number, angle: number, dx: number, dy: number) => string | null): void {
    for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px++) for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py++) {
      const dx = px - cx, dy = py - cy, r = Math.hypot(dx, dy);
      if (r > radius) continue;
      const color = paint(r, Math.atan2(dy, dx), dx, dy);
      if (color) this.put(px, py, color);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, color: string): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i++) this.put(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, color);
  }
  /** Sample a cover (two pixel rows per artwork row) into a rectangle, nearest neighbour. */
  image(x0: number, y0: number, w: number, h: number, cover: { width: number; height: number; pixels: readonly string[] }): void {
    if (cover.pixels.length !== cover.width * cover.height) return;
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const sx = Math.min(cover.width - 1, Math.floor((x + 0.5) * cover.width / w));
      const sy = Math.min(cover.height - 1, Math.floor((y + 0.5) * cover.height / h));
      this.put(x0 + x, y0 + y, cover.pixels[sy * cover.width + sx]!);
    }
  }
  /** One StyledText per terminal row, with runs of identical cells merged. */
  lines(): StyledText[] {
    return Array.from({ length: Math.ceil(this.height / 2) }, (_, row) => {
      const chunks: TextChunk[] = [];
      let run = "", top = "", bottom = "";
      const flush = () => { if (run) chunks.push({ __isChunk: true, text: run, fg: RGBA.fromHex(top), bg: RGBA.fromHex(bottom) }); };
      for (let x = 0; x < this.width; x++) {
        const upper = this.pixels[row * 2 * this.width + x]!;
        const lower = this.pixels[(row * 2 + 1) * this.width + x] ?? upper;
        if (run && upper === top && lower === bottom) { run += "▀"; continue; }
        flush(); run = "▀"; top = upper; bottom = lower;
      }
      flush();
      return new StyledText(chunks);
    });
  }
}
