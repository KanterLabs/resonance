import type { StyledText } from "@opentui/core";
import { PixelCanvas } from "../screens/now-playing/pixels.js";
import type { RpcApi } from "./contracts.js";
import { THUMBNAIL } from "./surface.js";

/**
 * The engine answers at most 16 requests at once per connection and turns the
 * rest away. Cover downloads can be slow, so thumbnails take at most a few of
 * those places and playback commands are never crowded out.
 */
const MAX_LOADING = 3;
let loading = 0;
const waiting: Array<() => void> = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (loading >= MAX_LOADING) await new Promise<void>(resolve => waiting.push(resolve));
  loading++;
  try { return await work(); }
  finally { loading--; waiting.shift()?.(); }
}

/** Fetch a Spotify CDN cover at thumbnail size and draw it as half-block lines. */
export async function coverThumbnail(api: RpcApi, url: string): Promise<StyledText[] | null> {
  const result = await limited(() => api.call<{ available?: boolean; width?: number; height?: number; pixels?: string[] }>("artwork.cover", { url, width: THUMBNAIL.width, height: THUMBNAIL.height }));
  if (!result.available || !Array.isArray(result.pixels) || typeof result.width !== "number" || typeof result.height !== "number") return null;
  if (result.pixels.length !== result.width * result.height * 2 || result.pixels.some(pixel => !/^#[0-9a-f]{6}$/i.test(pixel))) return null;
  const canvas = new PixelCanvas(THUMBNAIL.width, THUMBNAIL.height * 2, "#000000");
  canvas.image(0, 0, THUMBNAIL.width, THUMBNAIL.height * 2, { width: result.width, height: result.height * 2, pixels: result.pixels });
  return canvas.lines();
}
