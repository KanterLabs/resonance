import { BoxRenderable, ImageRenderable, TextRenderable, TextAttributes, type StyledText } from "@opentui/core";
import type { ScreenContext } from "../../workspace/contracts.js";
import { paletteForTheme, type ThemeName, type ThemePalette } from "../../theme.js";
import { artworkTint, blendHex, blendPixels } from "./motion-colors.js";
import { MOTION, ease } from "./motion.js";
import { glassArtwork, letterboxNativeArtwork, supportsImageArtwork } from "./glass-artwork.js";
import { artworkLines, type Artwork } from "./glyphs.js";

export interface CoverSource {
  uri(): string | undefined;
  colors(): Readonly<ThemePalette>;
  theme(): ThemeName;
  /** Called when a cover arrives or starts fading, so the screen can re-time its frames. */
  changed(): void;
  /** Called after each paint with the cover's current accent, for tinting nearby chrome. */
  tinted?(color: string): void;
}

/**
 * The classic player's cover tile. It loads artwork for the playing item,
 * cross-fades between covers, and prefers a native terminal image when the
 * terminal supports one, falling back to half-block pixels.
 */
export function createCover(ctx: ScreenContext, source: CoverSource) {
  const noBorders: [] = [];
  let width = 20;
  let height = 10;
  let key = "";
  let generation = 0;
  let lines: StyledText[] | null = null;
  let value: Artwork | null = null;
  let from: string[] | null = null;
  let at = -Infinity;
  let painted: readonly string[] | null = null;
  let tintFrom: string | null = null;
  let tintTo: string | null = null;
  let tintAt = -Infinity;
  let nativeUri: string | undefined;
  let nativeKey = "";
  let disposed = false;
  const nodes: TextRenderable[] = [];
  const root = new BoxRenderable(ctx.renderer, { id: "np-cover-box", width: 22, height: 10, border: ["left", "right"], flexShrink: 0, flexDirection: "column", justifyContent: "center", alignItems: "center" });
  const fallback = new TextRenderable(ctx.renderer, { id: "np-cover", content: "", width: "100%", height: 1, flexShrink: 0, truncate: true, selectable: false, textAlign: "center", attributes: TextAttributes.BOLD });
  root.add(fallback);
  const image = new ImageRenderable(ctx.renderer, { id: "np-cover-image", visible: false, width, height, flexShrink: 0, fit: "fit", protocol: "auto", onLoad: () => { if (!disposed) paint(); }, onError: () => { if (!disposed) { nativeUri = undefined; paint(); } } });
  root.add(image);

  function pixels(now: number): string[] | null {
    const target = value?.pixels;
    const colors = source.colors();
    if (target) {
      const progress = ctx.reducedMotion() ? 1 : ease((now - at) / MOTION.cover);
      return progress >= 1 ? target : blendPixels(from, target, progress, colors.cover);
    }
    // Fade an outgoing cover while the cache responds. No extra artwork RPCs.
    if (!ctx.reducedMotion() && from?.length === width * height * 2 && now - at < 180) {
      return blendPixels(null, from, 1 - ease((now - at) / 180), colors.cover);
    }
    return null;
  }
  function tint(now: number): string {
    const accent = source.colors().accent;
    return blendHex(tintFrom ?? accent, tintTo ?? accent, ctx.reducedMotion() ? 1 : ease((now - tintAt) / MOTION.tint));
  }
  function paint(now = Date.now(), force = false) {
    const colors = source.colors();
    const native = supportsImageArtwork(ctx.renderer) && nativeUri === source.uri() && !!image.image;
    image.visible = native;
    image.width = width; image.height = height;
    image.opacity = ctx.reducedMotion() ? 1 : ease((now - at) / MOTION.cover);
    root.border = native ? noBorders : ["left", "right"];
    const current = pixels(now);
    if (force || current !== painted) {
      painted = current;
      lines = current ? artworkLines({ available: true, uri: source.uri() ?? "", width, height, pixels: current }) : null;
      while (nodes.length > (lines?.length ?? 0)) { const node = nodes.pop()!; root.remove(node); node.destroy(); }
      lines?.forEach((line, index) => {
        let node = nodes[index];
        if (!node) { node = new TextRenderable(ctx.renderer, { id: `np-art-${index}`, content: line, width, height: 1, flexShrink: 0, selectable: false }); nodes.push(node); root.add(node); }
        else { node.width = width; node.content = line; }
      });
    }
    for (const node of nodes) node.visible = !native;
    fallback.visible = !native && !lines;
    fallback.fg = colors.accent; fallback.bg = colors.cover;
    const color = tint(now);
    root.backgroundColor = blendHex(colors.cover, color, 0.08);
    root.borderColor = blendHex(colors.coverBorder, color, 0.48);
    source.tinted?.(color);
  }
  function updateNative() {
    const theme = source.theme();
    const resolution = ctx.renderer.resolution;
    const next = `${value?.uri ?? ""}:${theme}:${width}x${height}:${ctx.renderer.width}x${ctx.renderer.height}:${resolution?.width ?? 0}x${resolution?.height ?? 0}:${supportsImageArtwork(ctx.renderer)}`;
    if (next === nativeKey) return;
    nativeKey = next;
    const decoded = value?.image && supportsImageArtwork(ctx.renderer) ? glassArtwork(value.image, theme) : null;
    const background = paletteForTheme(theme).cover;
    const rgb = (hex: string): [number, number, number, number] => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).concat(255) as [number, number, number, number];
    const inset = decoded ? letterboxNativeArtwork(decoded, ctx.renderer, width, height, rgb(background)) : null;
    const chosen = inset ?? decoded;
    nativeUri = chosen ? value?.uri : undefined;
    image.source = chosen ?? undefined;
    inset?.dispose();
    decoded?.dispose(); // ImageRenderable synchronously retains its own reference.
  }
  async function load(force = false) {
    const identity = source.uri(); const highResolution = supportsImageArtwork(ctx.renderer);
    const next = `${identity ?? ""}:${width}:${height}:${highResolution}`;
    if (!force && next === key) return;
    const now = Date.now();
    from = pixels(now); value = null; at = now;
    nativeUri = undefined; nativeKey = ""; image.source = undefined;
    tintFrom = tint(now); tintTo = null; tintAt = now;
    key = next; const request = ++generation; paint(now); source.changed();
    if (!identity) return;
    try {
      const result = await ctx.api.call<Artwork>("player.artwork", { uri: identity, width, height, ...(highResolution ? { format: "png" } : {}) });
      if (disposed || request !== generation || identity !== source.uri()) return;
      if (result.uri === identity && result.width === width && result.height === height && artworkLines(result)) {
        const loadedAt = Date.now();
        from = pixels(loadedAt); value = result; at = loadedAt;
        tintFrom = tint(loadedAt); tintTo = artworkTint(result.pixels!); tintAt = loadedAt;
        updateNative();
      }
      paint(); source.changed();
    } catch { /* A missing cover must never interrupt playback or navigation. */ }
  }

  return {
    root,
    get width() { return width; },
    get height() { return height; },
    /** Resize the art to `rows` cells high (two pixels per cell, square on screen). */
    resize(rows: number) {
      if (height === rows && width === rows * 2) return;
      height = rows; width = rows * 2; root.width = width + 2; root.height = height;
    },
    setInitials(content: string) { fallback.content = content; },
    pixels, tint, paint, updateNative, load,
    /** Whether a cover or tint fade is still running. */
    fading: (now: number) => now - at < MOTION.cover || now - tintAt < MOTION.tint,
    dispose() { disposed = true; ++generation; },
  };
}
