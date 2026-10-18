import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import type { HighResolutionArtwork } from "./glass-artwork.js";

/** Text drawings for the classic player: progress, spectrum and half-block covers. */
export function ambientProgress(position: number, duration: number, width = 36): string {
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  return Array.from({ length: width }, (_, i) => i < Math.floor(width * fraction) ? "━" : "─").join("");
}

/** Only measured audio animates the spectrum; silence stays flat. */
export function audioSpectrum(bands: readonly number[], width = 36): string {
  const chars = "▁▂▃▄▅▆▇█";
  if (!bands.length) return "─".repeat(width);
  return Array.from({ length: width }, (_, index) => {
    const value = Math.min(1, Math.max(0, bands[Math.floor(index * bands.length / width)] ?? 0));
    return value <= 0 ? "─" : chars[Math.min(7, Math.floor(value * 8))];
  }).join("");
}

export interface Artwork { available: boolean; uri: string; width: number; height: number; pixels?: string[]; image?: HighResolutionArtwork }

/** Each cell combines two image pixels without depending on terminal image protocols. */
export function artworkLines(value: Artwork): StyledText[] | null {
  const { width, height, pixels } = value;
  if (!value.available || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 40 || height < 1 || height > 20 || !pixels || pixels.length !== width * height * 2 || pixels.some(pixel => !/^#[a-f\d]{6}$/i.test(pixel))) return null;
  return Array.from({ length: height }, (_, y) => new StyledText(Array.from({ length: width }, (_, x): TextChunk => ({
    __isChunk: true, text: "▀", fg: RGBA.fromHex(pixels[y * 2 * width + x]!), bg: RGBA.fromHex(pixels[(y * 2 + 1) * width + x]!),
  }))));
}
