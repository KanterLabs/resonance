import { BoxRenderable, MouseButton, RGBA, StyledText, TextAttributes, TextRenderable, type TextChunk } from "@opentui/core";
import { formatTime, playableAlbum, playableArtists, playableTitle, type AudioFrame, type ParsedStatus } from "../../status.js";
import type { ThemeName, ThemePalette } from "../../theme.js";
import type { ScreenContext } from "../../workspace/contracts.js";
import { coverColor, crateLines, type CrateRecord } from "./crate.js";
import { blendHex } from "./motion-colors.js";
import { TURNTABLE_MAX_ROWS, TURNTABLE_MIN_ROWS, TURNTABLE_ORANGE, turntableLines, turntableWidth } from "./turntable.js";
import { meterTarget, Needle, vuMeterLines } from "./vu-meter.js";
import { waveformBar, waveformColumns } from "./waveform-bar.js";

export const SPEC_WIDTH = 32;
const CRATE_WIDTH = 30;
const GAP = 4;
const VU_ROWS = 4;
/** Rows the spec sheet needs with and without its meter. */
const SPEC_ROWS = 19;
/** Lift, swap and set down: a little under a second. */
const SWAP_MS = 1000;
const FRAME_MS = 40;
/** A song map fills in during the first listen; look again this often until it has. */
const MAP_REFRESH_MS = 8000;

export interface DeckState {
  status: ParsedStatus | null;
  position: number;
  theme: ThemeName;
  colors: Readonly<ThemePalette>;
  /** The playing cover, two pixel rows per artwork row, or null. */
  cover: { width: number; height: number; pixels: readonly string[] } | null;
  repeat: string;
  shuffle: boolean | undefined;
}

interface Swap { startedAt: number; cover: DeckState["cover"]; progress: number | null }

/** Whether the deck fits, and which of its optional parts fit beside it. */
export function deckLayout(space: { width: number; height: number }) {
  const rows = Math.min(TURNTABLE_MAX_ROWS, space.height - 2);
  const fits = rows >= TURNTABLE_MIN_ROWS && turntableWidth(rows) + GAP + SPEC_WIDTH <= space.width;
  return {
    fits, rows,
    meter: fits && Math.min(space.height - 2, TURNTABLE_MAX_ROWS + 2) >= SPEC_ROWS,
    crate: fits && turntableWidth(rows) + GAP + SPEC_WIDTH + GAP + CRATE_WIDTH <= space.width,
  };
}

/**
 * The turntable view: a drawn record player beside a short spec sheet with a
 * VU meter and a waveform progress bar, and the queue as a crate of records
 * when there is room. It runs its own frame clock while it moves, so the
 * rest of Now Playing does not redraw at animation rate.
 */
export function createDeckView(ctx: ScreenContext, state: () => DeckState, actions: { playPause(): void; seek(ms: number): void }) {
  const root = new BoxRenderable(ctx.renderer, { id: "np-turntable", visible: false, flexDirection: "row", gap: GAP, alignItems: "center", flexShrink: 0 });
  const art = new BoxRenderable(ctx.renderer, { id: "np-turntable-art", flexDirection: "column", flexShrink: 0, onMouseDown: event => { if (event.button === MouseButton.LEFT) { actions.playPause(); event.preventDefault(); } } });
  const spec = new BoxRenderable(ctx.renderer, { id: "np-turntable-spec", width: SPEC_WIDTH, flexDirection: "column", flexShrink: 0 });
  const crate = new BoxRenderable(ctx.renderer, { id: "np-turntable-crate", width: CRATE_WIDTH, flexDirection: "column", flexShrink: 0, visible: false });
  root.add(art); root.add(spec); root.add(crate);
  const lines = (parent: BoxRenderable, id: string, count: number, width: number, options: ConstructorParameters<typeof TextRenderable>[1] = {}) => Array.from({ length: count }, (_, index) => {
    const node = new TextRenderable(ctx.renderer, { id: `np-turntable-${id}-${index}`, content: "", width, height: 1, flexShrink: 0, truncate: true, selectable: false, ...options });
    parent.add(node); return node;
  });
  let gaps = 0;
  const gap = () => { const node = new BoxRenderable(ctx.renderer, { id: `np-turntable-gap-${gaps++}`, width: "100%", height: 1, flexShrink: 0 }); spec.add(node); return node; };
  const meter = new BoxRenderable(ctx.renderer, { id: "np-turntable-meter", width: SPEC_WIDTH, height: VU_ROWS, flexDirection: "column", flexShrink: 0 });
  spec.add(meter);
  const meterRows = lines(meter, "meter", VU_ROWS, SPEC_WIDTH);
  const meterGap = gap();
  const [title, artist, album] = lines(spec, "info", 3, SPEC_WIDTH);
  title!.attributes = TextAttributes.BOLD;
  gap();
  const seekAt = (node: TextRenderable) => (event: { button: number; x: number; preventDefault(): void }) => {
    const duration = state().status?.playable?.duration ?? 0;
    if (event.button !== MouseButton.LEFT || !duration) return;
    actions.seek(Math.round(Math.max(0, Math.min(1, (event.x - node.x) / (SPEC_WIDTH - 1))) * duration)); event.preventDefault();
  };
  const wave = lines(spec, "wave", 2, SPEC_WIDTH);
  for (const node of wave) node.onMouseDown = seekAt(node);
  const [times] = lines(spec, "times", 1, SPEC_WIDTH);
  gap();
  const facts = lines(spec, "fact", 4, SPEC_WIDTH);
  gap();
  const [hint] = lines(spec, "hint", 1, SPEC_WIDTH);
  const crateRows = lines(crate, "crate", TURNTABLE_MAX_ROWS, CRATE_WIDTH);
  const deckRows: TextRenderable[] = [];

  const needle = new Needle();
  let level = 0, tempoLocked = false, strobe = 0;
  let lastFrame = Date.now(), timer: ReturnType<typeof setInterval> | undefined, disposed = false;
  let unsubscribeAudio: (() => void) | undefined;
  let swap: Swap | null = null, lastUri: string | undefined, lastCover: DeckState["cover"] = null, lastProgress: number | null = null;
  let map: { uri: string; levels: Array<number | null>; heard: number; at: number } | null = null, mapPending = false;
  const crateColors = new Map<string, string | null>(); let crateFetching = false;
  let layout = deckLayout({ width: 0, height: 0 });

  function onAudio(frame: AudioFrame) {
    level = frame.live ? frame.level : 0;
    tempoLocked = frame.live && frame.tempo !== null;
  }
  function uriOf(status: ParsedStatus | null) {
    const p = status?.playable;
    return p?.uri ?? (p?.id ? `spotify:${p.type === "Episode" ? "episode" : "track"}:${p.id}` : undefined);
  }
  async function loadMap(uri: string) {
    if (mapPending) return;
    mapPending = true;
    try {
      const result = await ctx.api.call<{ uri: string; heard?: number; level?: Array<number | null> }>("song.map", { uri });
      if (disposed || uri !== uriOf(state().status) || !Array.isArray(result.level)) return;
      map = { uri, levels: result.level.map(value => typeof value === "number" ? value : null), heard: typeof result.heard === "number" ? result.heard : 0, at: Date.now() };
    } catch { if (!disposed) map = { uri, levels: [], heard: 1, at: Date.now() }; }
    finally { mapPending = false; }
  }
  async function loadCrateColors(urls: string[]) {
    if (crateFetching) return;
    const missing = urls.filter(url => !crateColors.has(url));
    if (!missing.length) return;
    crateFetching = true;
    try {
      for (const url of missing.slice(0, 6)) {
        try {
          const result = await ctx.api.call<{ available?: boolean; pixels?: string[] }>("artwork.cover", { url, width: 2, height: 1 });
          crateColors.set(url, result.available && Array.isArray(result.pixels) ? coverColor(result.pixels) : null);
        } catch { crateColors.set(url, null); }
        if (disposed) return;
      }
    } finally { crateFetching = false; }
  }
  const chunk = (text: string, fg: string, bg: string): TextChunk => ({ __isChunk: true, text, fg: RGBA.fromHex(fg), bg: RGBA.fromHex(bg) });

  function paint(now = Date.now()) {
    if (disposed || !root.visible) return;
    const { status, position, theme, colors, cover, repeat, shuffle } = state();
    const reduced = ctx.reducedMotion();
    const seconds = (now - lastFrame) / 1000; lastFrame = now;
    const p = status?.playable ?? null, playing = status?.mode.kind === "playing";
    const duration = p?.duration ?? 0, uri = uriOf(status);
    const progress = p && duration > 0 ? Math.min(1, position / duration) : null;
    if (uri !== lastUri) {
      // A change of song lifts the arm, swaps the record and sets it down again.
      if (lastUri && uri && !reduced) swap = { startedAt: now, cover: lastCover, progress: lastProgress };
      lastUri = uri; map = null;
    }
    if (uri && p?.type !== "Episode" && !mapPending && (!map || map.uri !== uri || (playing && map.heard < 0.98 && now - map.at > MAP_REFRESH_MS))) void loadMap(uri);

    let phase = swap ? (now - swap.startedAt) / SWAP_MS : 1;
    if (phase >= 1) { swap = null; phase = 1; }
    const lift = swap ? phase < 0.25 ? phase / 0.25 : phase < 0.75 ? 1 : 1 - (phase - 0.75) / 0.25 : 0;
    const slide = swap ? phase < 0.25 || phase >= 0.75 ? 0 : phase < 0.5 ? (phase - 0.25) / 0.25 : 1 - (phase - 0.5) / 0.25 : 0;
    const oldRecord = !!swap && phase < 0.5;
    const drawnCover = oldRecord ? swap!.cover : cover;
    if (!swap) { lastCover = cover; lastProgress = progress; }

    // Strobe dots stand still while the beat tracker holds a tempo, and drift while it searches.
    if (playing && !reduced && !tempoLocked) strobe = (strobe + seconds * 0.35) % 1;
    const rotation = reduced || !p ? 0 : (position / 1000 * 0.9) % (Math.PI * 2);
    const deck = turntableLines({
      rows: layout.rows, theme, background: colors.background, cover: drawnCover,
      progress: oldRecord ? swap!.progress : progress, rotation, playing, strobe, lift, slide,
    });
    const width = turntableWidth(layout.rows);
    while (deckRows.length > deck.length) { const node = deckRows.pop()!; art.remove(node); node.destroy(); }
    deck.forEach((line, index) => {
      let node = deckRows[index];
      if (!node) { node = new TextRenderable(ctx.renderer, { id: `np-turntable-row-${index}`, content: line, width, height: 1, flexShrink: 0, selectable: false }); deckRows.push(node); art.add(node); }
      else { node.width = width; node.content = line; }
    });

    meter.visible = meterGap.visible = layout.meter;
    if (layout.meter) {
      const value = needle.step(playing ? meterTarget(level || (status?.prototype?.audio?.level ?? 0)) : 0, seconds, reduced);
      vuMeterLines(value, SPEC_WIDTH, VU_ROWS, theme, colors.background).forEach((line, index) => { meterRows[index]!.content = line; });
    }
    title!.content = playableTitle(p); artist!.content = playableArtists(p); album!.content = playableAlbum(p);
    title!.fg = colors.text; artist!.fg = colors.muted; album!.fg = colors.dim;
    for (const node of [title!, artist!, album!, times!, hint!]) node.bg = colors.background;
    const columns = waveformColumns(map && map.uri === uri ? map.levels : [], SPEC_WIDTH);
    const bar = waveformBar(columns, progress ?? 0, { played: TURNTABLE_ORANGE, playhead: colors.text, ahead: blendHex(colors.background, colors.muted, 0.55), unheard: colors.progressTrack, background: colors.background });
    wave[0]!.content = bar[0]; wave[1]!.content = bar[1];
    const elapsedText = formatTime(position), totalText = formatTime(duration);
    times!.content = elapsedText + " ".repeat(Math.max(1, SPEC_WIDTH - elapsedText.length - totalText.length)) + totalText; times!.fg = colors.dim;
    const radio = !!status?.prototype?.radio_active, next = status?.prototype?.up_next?.[0];
    const rows: Array<[string, string]> = [
      ["state", `${status?.mode.kind ?? "ready"}${radio ? " · radio" : ""}`],
      ["volume", status?.prototype ? `${status.prototype.volume_percent}%` : "—"],
      ["mode", `repeat ${repeat} · shuffle ${shuffle === undefined ? "—" : shuffle ? "on" : "off"}`],
      ["next", next ? next.title : radio ? "finding tracks…" : "nothing queued"],
    ];
    rows.forEach(([label, value], index) => { facts[index]!.content = new StyledText([chunk(label.padEnd(8), colors.dim, colors.background), chunk(value, colors.text, colors.background)]); });
    hint!.content = "v classic · / search · ? help"; hint!.fg = colors.dim;

    crate.visible = layout.crate;
    if (layout.crate) {
      const upcoming = status?.prototype?.up_next ?? [];
      void loadCrateColors([p?.cover_url, ...upcoming.slice(0, 12).map(track => track.cover_url)].filter((url): url is string => !!url));
      const playingColor = cover ? coverColor(cover.pixels) : p?.cover_url ? crateColors.get(p.cover_url) ?? null : null;
      const nowPlaying: CrateRecord | null = p ? { title: playableTitle(p), artists: p.type === "Episode" ? [] : p.artists, color: playingColor } : null;
      const records = upcoming.map(track => ({ title: track.title, artists: track.artists, color: track.cover_url ? crateColors.get(track.cover_url) ?? null : null }));
      const drawn = crateLines(nowPlaying, records, CRATE_WIDTH, layout.rows, { text: colors.text, muted: colors.muted, dim: colors.dim, empty: colors.progressTrack, background: colors.background });
      crateRows.forEach((node, index) => { node.visible = index < drawn.length; if (drawn[index]) node.content = drawn[index]!; });
    }
    syncTimer(playing);
  }
  function syncTimer(playing: boolean) {
    const moving = root.visible && !ctx.reducedMotion() && (playing || !!swap || Math.abs(needle.value) > 0.005);
    if (moving && !timer) { lastFrame = Date.now(); timer = setInterval(() => { if (!root.parent) stopTimer(); else paint(); }, FRAME_MS); }
    else if (!moving) stopTimer();
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = undefined; }
  return {
    root,
    /** Show or hide the deck for this space; returns whether it is showing. */
    update(space: { width: number; height: number }, wanted: boolean): boolean {
      layout = deckLayout(space);
      const show = wanted && layout.fits;
      root.visible = show;
      if (show && !unsubscribeAudio) unsubscribeAudio = ctx.onAudio?.(onAudio);
      if (!show) { unsubscribeAudio?.(); unsubscribeAudio = undefined; stopTimer(); }
      else paint();
      return show;
    },
    dispose() { disposed = true; stopTimer(); unsubscribeAudio?.(); unsubscribeAudio = undefined; },
  };
}
