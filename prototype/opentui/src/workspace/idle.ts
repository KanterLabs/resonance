import { BoxRenderable, RGBA, StyledText, TextAttributes, TextRenderable, type CliRenderer, type TextChunk } from "@opentui/core";
import { artworkLines, type Artwork } from "../screens/now-playing/index.js";
import { artworkTint, blendHex } from "../screens/now-playing/motion-colors.js";
import { playableArtists, playableTitle, type AudioFrame, type ParsedStatus } from "../status.js";
import { paletteForTheme, type ThemeName } from "../theme.js";
import type { RpcApi } from "./contracts.js";

/** How long without a key press, while music plays, before the idle screen appears. */
export const IDLE_AFTER_MS = 3 * 60_000;
const LEVELS = " ▁▂▃▄▅▆▇█";
/** One slow breath of the background colour. */
const DRIFT_MS = 14_000;

interface IdleDeps {
  renderer: CliRenderer;
  api: RpcApi;
  status(): ParsedStatus | null;
  theme(): ThemeName;
  reducedMotion(): boolean;
  onAudio?(listener: (frame: AudioFrame) => void): () => void;
}

/**
 * A full-screen resting view: the cover large, the song, a spectrum and the
 * clock, over a background that breathes slowly in the cover's colour. Any
 * key or click hands the workspace back.
 */
export function createIdleScreen(deps: IdleDeps) {
  const root = new BoxRenderable(deps.renderer, { id: "idle", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 100, visible: false, flexDirection: "column", alignItems: "center", justifyContent: "center" });
  const text = (id: string, options: ConstructorParameters<typeof TextRenderable>[1] = {}) => {
    const node = new TextRenderable(deps.renderer, { id: `idle-${id}`, content: "", height: 1, flexShrink: 0, truncate: true, selectable: false, textAlign: "center", ...options });
    root.add(node); return node;
  };
  const clock = text("clock");
  const spacer = () => root.add(new BoxRenderable(deps.renderer, { height: 1, width: 1, flexShrink: 0 }));
  spacer();
  const cover = new BoxRenderable(deps.renderer, { id: "idle-cover", flexDirection: "column", flexShrink: 0 });
  root.add(cover);
  spacer();
  const title = text("title", { attributes: TextAttributes.BOLD });
  const artist = text("artist");
  spacer();
  const spectrum = text("spectrum");
  let coverRows: TextRenderable[] = [];
  let artwork: { uri: string; size: number; lines: StyledText[]; tint: string | null } | null = null;
  let loading = "", bands: number[] = [];
  let timer: ReturnType<typeof setInterval> | undefined, unsubscribe: (() => void) | undefined;
  const startedAt = Date.now();

  const uriOf = () => { const p = deps.status()?.playable; return p?.uri ?? (p?.id ? `spotify:${p.type === "Episode" ? "episode" : "track"}:${p.id}` : undefined); };
  const size = () => Math.max(6, Math.min(20, deps.renderer.height - 10, Math.floor(deps.renderer.width / 2) - 2));

  async function loadCover(uri: string, rows: number) {
    const key = `${uri}:${rows}`;
    if (loading === key) return;
    loading = key;
    try {
      const value = await deps.api.call<Artwork>("player.artwork", { uri, width: rows * 2, height: rows });
      const lines = artworkLines(value);
      if (loading === key && lines && value.pixels) artwork = { uri, size: rows, lines, tint: artworkTint(value.pixels) };
    } catch { /* The idle screen simply goes without a cover. */ }
    finally { if (loading === key) loading = ""; }
  }
  function paint() {
    if (!root.visible) return;
    const palette = paletteForTheme(deps.theme()), p = deps.status()?.playable ?? null, uri = uriOf(), rows = size();
    if (uri && (!artwork || artwork.uri !== uri || artwork.size !== rows)) void loadCover(uri, rows);
    const current = artwork && artwork.uri === uri ? artwork : null;
    const tint = current?.tint ?? palette.accent;
    const breath = deps.reducedMotion() ? 0.5 : 0.5 + 0.5 * Math.sin((Date.now() - startedAt) / DRIFT_MS * Math.PI * 2);
    const background = blendHex(palette.background, tint, 0.06 + 0.1 * breath);
    root.backgroundColor = background;
    const now = new Date();
    clock.content = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    title.content = playableTitle(p); artist.content = playableArtists(p);
    for (const [node, fg] of [[clock, palette.muted], [title, palette.text], [artist, palette.muted]] as const) { node.fg = fg; node.bg = background; node.width = rows * 2 + 4; }
    const lines = current?.lines ?? [];
    while (coverRows.length > lines.length) { const node = coverRows.pop()!; cover.remove(node); node.destroy(); }
    lines.forEach((line, index) => {
      let node = coverRows[index];
      if (!node) { node = new TextRenderable(deps.renderer, { id: `idle-cover-${index}`, content: line, width: rows * 2, height: 1, flexShrink: 0, selectable: false }); coverRows.push(node); cover.add(node); }
      else { node.content = line; node.width = rows * 2; }
    });
    const width = rows * 2;
    const playing = deps.status()?.mode.kind === "playing";
    const chunks: TextChunk[] = Array.from({ length: width }, (_, column) => {
      const value = playing && bands.length ? bands[Math.floor(column * bands.length / width)] ?? 0 : 0;
      const shade = blendHex(background, tint, 0.45 + 0.55 * value);
      return { __isChunk: true, text: LEVELS[Math.max(1, Math.round(value * 8))]!, fg: RGBA.fromHex(shade), bg: RGBA.fromHex(background) };
    });
    spectrum.content = new StyledText(chunks); spectrum.width = width;
    deps.renderer.requestRender();
  }
  return {
    root,
    get visible() { return root.visible; },
    show() {
      if (root.visible) return;
      root.visible = true;
      unsubscribe = deps.onAudio?.(frame => { bands = frame.live ? frame.bands : []; });
      timer = setInterval(paint, deps.reducedMotion() ? 1000 : 100);
      paint();
    },
    hide() {
      if (!root.visible) return;
      root.visible = false;
      if (timer) clearInterval(timer); timer = undefined;
      unsubscribe?.(); unsubscribe = undefined; bands = [];
      deps.renderer.requestRender();
    },
    dispose() { if (timer) clearInterval(timer); timer = undefined; unsubscribe?.(); unsubscribe = undefined; },
  };
}
