import { BoxRenderable, MouseButton, RGBA, StyledText, TextAttributes } from "@opentui/core";
import type { ScreenFactory } from "../../workspace/contracts.js";
import { formatTime, initials, playableTitle, playableArtists, playableAlbum, positionAt } from "../../status.js";
import { paletteForTheme } from "../../theme.js";
import { blendHex } from "./motion-colors.js";
import { PlayerMotion, playingBars } from "./motion.js";
import { createQuickSearch } from "./quick-search.js";
import { createPlaylistPicker } from "./playlist-picker.js";
import { supportsImageArtwork } from "./glass-artwork.js";
import { createDeckView, deckLayout } from "./deck-view.js";
import { ambientProgress, audioSpectrum } from "./glyphs.js";
import { createCover } from "./cover.js";
import { createToned } from "./toned.js";
import { createUpNext } from "./up-next.js";
import { createPlayerActions, type PlayerState } from "./player-actions.js";

export { ambientProgress, artworkLines, audioSpectrum, type Artwork } from "./glyphs.js";

export const createNowPlayingScreen: ScreenFactory = (ctx) => {
  let status = ctx.status();
  let receivedAt = Date.now();
  let positionBase = status ? positionAt(status, receivedAt) : 0;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerCadence = 0;
  const noBorders: [] = [];
  const motion = new PlayerMotion();
  const state: PlayerState = { repeat: "unknown", shuffle: undefined, saved: new Set() };
  let theme = ctx.theme();
  let colors = paletteForTheme(theme);
  let displayedBands: number[] = [];
  const ui = createToned(ctx, () => colors);
  const root = new BoxRenderable(ctx.renderer, { id: "np-root", width: "100%", height: "100%", minHeight: 0, flexDirection: "column", justifyContent: "center", alignItems: "center" });
  const quickSearch = createQuickSearch(ctx, root);
  const playlistPicker = createPlaylistPicker(ctx, root);
  const columns = new BoxRenderable(ctx.renderer, { id: "np-columns", width: "100%", maxWidth: 132, flexDirection: "row", gap: 3, justifyContent: "center", minWidth: 0 });
  root.add(columns);
  const card = new BoxRenderable(ctx.renderer, { id: "np-player-card", height: 24, width: 82, flexShrink: 0, border: true, borderStyle: "rounded", paddingX: 2, paddingY: 1, flexDirection: "column" });
  const upNext = createUpNext(ctx, ui, { startRadio: () => void startRadio() });
  columns.add(card); columns.add(upNext.root);
  const { text, row, button } = ui;
  const heading = row(card, "np-heading", 2, { justifyContent: "space-between" });
  text(heading, "heading-label", "NOW PLAYING", { width: 14 }, "dim");
  const mode = text(heading, "mode", "", { width: 24, textAlign: "right" }, "teal");
  const hero = row(card, "np-hero", 10, { gap: 3 });
  const cover = createCover(ctx, { uri, colors: () => colors, theme: () => theme, changed: () => syncTimer(), tinted: color => { card.borderColor = blendHex(colors.border, color, 0.18); } });
  hero.add(cover.root);
  const metadata = new BoxRenderable(ctx.renderer, { id: "np-metadata", flexGrow: 1, minWidth: 0, height: "100%", flexDirection: "column", justifyContent: "center", gap: 1 }); hero.add(metadata);
  const title = text(metadata, "title", "", { width: "100%", height: 2, wrapMode: "word", attributes: TextAttributes.BOLD });
  const artist = text(metadata, "artist", "", { width: "100%" }, "muted");
  const album = text(metadata, "album", "", { width: "100%" }, "dim");
  const ambient = text(metadata, "ambient", "", { width: "100%", height: 2 }, "accent");
  const timeline = text(card, "timeline", "", { width: "100%", onMouseDown: event => {
    if (event.button !== MouseButton.LEFT || !status?.playable) return;
    const value = Math.round(Math.max(0, Math.min(1, (event.x - timeline.x) / Math.max(1, timeline.width - 1))) * status.playable.duration);
    void player("seek", `Seeked to ${formatTime(value)}`, value); event.preventDefault();
  } }, "accent");
  const timeRow = row(card, "np-times", 1, { justifyContent: "space-between" });
  const elapsed = text(timeRow, "elapsed", "", { width: 8 }, "muted");
  const remaining = text(timeRow, "remaining", "", { width: 16, textAlign: "right" }, "dim");
  const transport = row(card, "np-transport", 3, { justifyContent: "center", gap: 2 });
  button(transport, "previous", "│◀ Previous", 13, () => void player("previous", "Previous requested"));
  const playChip = new BoxRenderable(ctx.renderer, { id: "np-play-chip", width: 15, height: 3, flexShrink: 0, border: true, borderStyle: "rounded", justifyContent: "center", alignItems: "center", onMouseDown: event => { if (event.button === MouseButton.LEFT) { void player("play_pause", "Playback toggled"); event.preventDefault(); } } });
  transport.add(playChip);
  const playButton = text(playChip, "play", "▶ Play", { width: 13, textAlign: "center" }, "accentBright", "cover");
  playButton.attributes = TextAttributes.BOLD;
  button(transport, "next", "Next ▶│", 11, () => void player("next", "Next requested"));
  button(transport, "stop", "■ Stop", 8, () => void player("stop", "Playback stopped"));
  const options = row(card, "np-options", 1, { justifyContent: "center", gap: 1 });
  const repeatButton = button(options, "repeat", "Repeat", 15, () => void cycleRepeat());
  const shuffleButton = button(options, "shuffle", "Shuffle", 15, () => void toggleShuffle());
  const savedButton = button(options, "save", "♡ Save", 11, () => void toggleSaved());
  const radioButton = button(options, "radio", "✧ Radio  ⇧R", 16, () => void startRadio(), true);
  const utility = row(card, "np-volume", 1, { justifyContent: "space-between" });
  const seekControls = row(utility, "np-seek-controls", 1, { width: 18 });
  button(seekControls, "seek-back", "[ −5s", 8, () => void seek(-5000));
  button(seekControls, "seek-forward", "] +5s", 8, () => void seek(5000));
  button(utility, "search", "/ Search", 10, () => quickSearch.open(), true);
  const volumeControls = row(utility, "np-volume-controls", 1, { width: 31, justifyContent: "center" });
  button(volumeControls, "quieter", "−", 3, () => void changeVolume(-5));
  const detail = text(volumeControls, "detail", "", { width: 21, textAlign: "center" }, "muted");
  button(volumeControls, "louder", "+", 3, () => void changeVolume(5));
  const navigation = row(card, "np-navigation", 1, { justifyContent: "center", gap: 1 });
  button(navigation, "queue", "Queue →", 9, () => ctx.navigate("queue"));
  button(navigation, "radio-page", "Radio →", 9, () => ctx.navigate("radio"));
  button(navigation, "share", "Y Share", 9, () => void shareCurrent());
  button(navigation, "add-to-playlist", "P Playlist", 12, () => addToPlaylist());
  button(navigation, "motion", "Motion", 8, () => ctx.setReducedMotion(!ctx.reducedMotion()));
  button(navigation, "style", "V Deck", 8, () => toggleStyle());

  // The turntable view: a drawn record player beside a short spec sheet.
  let style = ctx.nowPlayingStyle?.() ?? "classic";
  const deck = createDeckView(ctx, () => ({
    status, position: currentPosition(), theme, colors, repeat: state.repeat, shuffle: state.shuffle,
    cover: (() => { const pixels = cover.pixels(Date.now()); return pixels ? { width: cover.width, height: cover.height * 2, pixels } : null; })(),
  }), {
    playPause: () => void player("play_pause", "Playback toggled"),
    seek: value => void player("seek", `Seeked to ${formatTime(value)}`, value),
  });
  root.add(deck.root);

  function currentPosition() { return Math.min(status?.playable?.duration ?? 0, positionBase + (status?.mode.kind === "playing" ? Math.max(0, Date.now() - receivedAt) : 0)); }
  function uri() { const p = status?.playable; return p?.uri ?? (p?.id ? `spotify:${p.type === "Episode" ? "episode" : "track"}:${p.id}` : undefined); }
  function notice(message: string) { if (!disposed) ctx.notify(message); }
  function addToPlaylist() {
    const identity = uri();
    if (!identity || !status?.playable) { notice("Nothing is playing to add to a playlist"); return; }
    playlistPicker.open({ uri: identity, title: playableTitle(status.playable) });
  }
  const { player, seek, changeVolume, cycleRepeat, toggleShuffle, toggleSaved, startRadio, shareCurrent } = createPlayerActions(ctx, {
    status: () => status, uri, position: currentPosition, disposed: () => disposed, notice,
    pulse: feedback => { motion.pulse(feedback, Date.now()); render(); syncTimer(); },
    applied: () => render(),
  }, state);
  function render() {
    if (disposed) return;
    const now = Date.now(); const reduced = ctx.reducedMotion();
    if (reduced) motion.settle();
    const p = status?.playable ?? null;
    const position = currentPosition(); const duration = p?.duration ?? 0;
    const compact = ctx.renderer.height < 30;
    const sideBySide = ctx.renderer.width >= 112 && !compact;
    const available = Math.min(132, ctx.renderer.width - 4);
    const playerWidth = sideBySide ? Math.max(68, available - 47) : Math.min(82, available);
    card.width = playerWidth;
    if (sideBySide) upNext.root.width = available - playerWidth - 3;
    card.height = compact ? Math.max(15, ctx.renderer.height - 7) : 24;
    card.paddingY = compact ? 0 : 1;
    upNext.root.visible = sideBySide; upNext.root.height = card.height; columns.height = card.height;
    heading.height = compact ? 1 : 2; hero.height = compact ? 6 : 10; metadata.gap = compact ? 0 : 1;
    title.height = compact ? 1 : 2; album.visible = !compact; ambient.height = compact ? 1 : 2;
    transport.height = compact ? 1 : 3; playChip.height = compact ? 1 : 3;
    // An empty side list stays borderless when OpenTUI's color setter runs;
    // `false` would be promoted back to a full border by that setter.
    playChip.border = compact ? noBorders : true; navigation.visible = !compact;
    const deckSpace = { height: root.height > 0 ? root.height : ctx.renderer.height - 7, width: root.width > 0 ? root.width : ctx.renderer.width - 4 };
    const turntable = style === "turntable" && deckLayout(deckSpace).fits;
    columns.visible = !turntable;
    cover.resize(compact && !turntable ? 6 : 10);
    cover.setInitials(initials(p)); artist.content = playableArtists(p); album.content = playableAlbum(p);
    artist.fg = blendHex(colors.panel, colors.muted, reduced ? 1 : motion.trackProgress(now, 110));
    album.fg = blendHex(colors.panel, colors.dim, reduced ? 1 : motion.trackProgress(now, 150));
    mode.content = `${status?.mode.kind === "playing" ? "●" : "○"} ${status?.mode.kind.toUpperCase() ?? "READY"}${status?.prototype?.radio_active ? "  ·  RADIO" : ""}`;
    const spectrumWidth = Math.max(12, playerWidth - cover.width - 11); const audio = status?.prototype?.audio;
    if (audio) {
      const active = status?.mode.kind === "playing" && audio.level > 0; const target = active ? audio.bands : audio.bands.map(() => 0);
      if (ctx.reducedMotion() || !active || displayedBands.length !== target.length) displayedBands = [...target];
      ambient.content = compact ? audioSpectrum(displayedBands, spectrumWidth) : `${active ? "Audio spectrum" : "Audio spectrum · silence"}\n${audioSpectrum(displayedBands, spectrumWidth)}`;
    } else ambient.content = compact ? "" : `${ctx.reducedMotion() ? "Reduced motion" : "Playback progress"}\n${ambientProgress(position, duration, spectrumWidth)}`;
    title.content = new StyledText([
      { __isChunk: true, text: `${playingBars(status?.mode.kind === "playing", audio ? displayedBands : undefined, audio?.level, now, reduced)}  `, fg: RGBA.fromHex(colors.teal), bg: RGBA.fromHex(colors.panel) },
      { __isChunk: true, text: playableTitle(p), fg: RGBA.fromHex(blendHex(colors.panel, colors.text, reduced ? 1 : motion.trackProgress(now, 40))), bg: RGBA.fromHex(colors.panel) },
    ]);
    const trackWidth = Math.max(12, playerWidth - 6);
    const filled = duration > 0 ? Math.min(trackWidth, Math.floor(trackWidth * position / duration)) : 0;
    timeline.content = new StyledText([
      { __isChunk: true, text: "━".repeat(filled), fg: RGBA.fromHex(colors.accent), bg: RGBA.fromHex(colors.panel) },
      { __isChunk: true, text: "─".repeat(trackWidth - filled), fg: RGBA.fromHex(colors.progressTrack), bg: RGBA.fromHex(colors.panel) },
    ]);
    elapsed.content = formatTime(position); remaining.content = `−${formatTime(Math.max(0, duration - position))} / ${formatTime(duration)}`;
    playButton.content = status?.mode.kind === "playing" ? "Ⅱ Pause" : "▶ Play";
    repeatButton.content = `Repeat: ${state.repeat}`; shuffleButton.content = `Shuffle: ${state.shuffle === undefined ? "—" : state.shuffle ? "on" : "off"}`;
    savedButton.content = state.saved.has(uri() ?? "") ? "♥ Saved" : "♡ Save";
    const playPulse = reduced ? 0 : motion.button("play", now);
    const playBackground = blendHex(colors.cover, colors.queueCurrent, playPulse * 0.7);
    playChip.backgroundColor = playButton.bg = playBackground;
    playChip.borderColor = blendHex(colors.coverBorder, colors.accent, playPulse * 0.8);
    for (const [key, node] of [["save", savedButton], ["radio", radioButton]] as const) {
      const pulse = reduced ? 0 : motion.button(key, now);
      node.bg = blendHex(colors.panel, colors.cover, pulse * 0.8);
      node.fg = blendHex(key === "radio" ? colors.accentBright : colors.muted, colors.accentBright, pulse);
    }
    detail.content = `Volume ${status?.prototype ? `${status.prototype.volume_percent}%` : "—"}`;
    upNext.paint({ status, colors, motion, now, reduced });
    void cover.load();
    // Geometry can arrive after the image response (notably Sixel), and a
    // resize can change the physical cell ratio without changing art cells.
    cover.updateNative();
    cover.paint(now);
    deck.update(deckSpace, turntable);
  }
  function toggleStyle() {
    style = style === "turntable" ? "classic" : "turntable";
    ctx.setNowPlayingStyle?.(style);
    render(); syncTimer();
    notice(style === "classic" ? "Classic player · v for the turntable" : deck.root.visible ? "Turntable · v for the classic player" : "Turntable needs a larger window; showing the classic player");
  }
  function syncTimer() {
    const now = Date.now(); const reduced = ctx.reducedMotion();
    const finite = !reduced && (motion.active(now) || cover.fading(now));
    const playing = status?.mode.kind === "playing";
    // Short transitions get 25 frames/sec. Once settled, measured audio uses
    // 12.5 frames/sec and the playback-only icon needs just 6.25 frames/sec.
    // The deck keeps its own frame clock; behind it the card only needs the clock.
    const cadence = disposed ? 0 : reduced ? playing ? 1000 : 0 : finite ? 40 : playing ? deck.root.visible ? 1000 : status?.prototype?.audio ? 80 : 160 : 0;
    if (timer && cadence === timerCadence) return;
    if (timer) { clearInterval(timer); timer = undefined; }
    timerCadence = cadence;
    if (cadence) timer = setInterval(() => {
      if (disposed || !root.visible || !root.parent) { if (timer) clearInterval(timer); timer = undefined; return; }
      const audio = status?.prototype?.audio;
      if (audio) displayedBands = audio.bands.map((band, index) => { const value = audio.level > 0 ? band : 0; const previous = displayedBands[index] ?? 0; return value <= 0 ? 0 : previous + (value - previous) * 0.35; });
      render();
      syncTimer();
    }, cadence);
  }
  async function loadMetadata() {
    const identity = uri();
    try {
      const result = await ctx.api.call<{ repeat?: string; shuffle?: boolean; saved?: boolean | null; current?: { uri?: string } | null }>("player.status");
      if (disposed || identity !== uri()) return;
      if (result.repeat) state.repeat = result.repeat === "playlist" ? "all" : result.repeat;
      if (typeof result.shuffle === "boolean") state.shuffle = result.shuffle;
      if (identity && result.current?.uri === identity && typeof result.saved === "boolean") result.saved ? state.saved.add(identity) : state.saved.delete(identity);
      render();
    } catch (error) { if (identity) notice(`Playback details unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function applyTheme() {
    colors = paletteForTheme(theme); ui.recolor();
    card.backgroundColor = colors.panel; card.borderColor = colors.border; upNext.recolor(colors);
    playChip.backgroundColor = colors.cover; playChip.borderColor = colors.coverBorder;
  }
  const unsubscribe = ctx.onStatus(value => { const previous = uri(); const now = Date.now(); motion.observe(status, value, now, ctx.reducedMotion()); status = value; receivedAt = now; positionBase = positionAt(value, receivedAt); render(); syncTimer(); if (uri() !== previous) void loadMetadata(); });
  const onResize = () => render(); ctx.renderer.on("resize", onResize);
  ctx.renderer.on("capabilities", onResize);
  let graphicsReady = supportsImageArtwork(ctx.renderer);
  const onFrame = () => {
    const ready = supportsImageArtwork(ctx.renderer);
    if (ready !== graphicsReady) { graphicsReady = ready; render(); }
    else if (ready) cover.updateNative();
  };
  // Pixel geometry can arrive asynchronously without a resize event. The
  // native source key makes this cheap once geometry has settled.
  ctx.renderer.on("frame", onFrame);
  applyTheme(); render(); syncTimer(); void loadMetadata();
  return {
    root, title: "Now Playing", editing: () => quickSearch.isOpen() || playlistPicker.isOpen(),
    handleKey(key) {
      if (quickSearch.isOpen()) return quickSearch.handleKey(key);
      if (playlistPicker.isOpen()) return playlistPicker.handleKey(key);
      const name = key.name ?? key.sequence ?? ""; if (key.ctrl || key.meta) return false;
      if (name === "/" || name === "slash" || key.sequence === "/") { quickSearch.open(); return true; }
      if (name === "space" || name === " ") { void player("play_pause", "Playback toggled"); return true; }
      if (name === ",") { void player("previous", "Previous requested"); return true; }
      if (name === ".") { void player("next", "Next requested"); return true; }
      if (name === "[" || name === "leftbracket" || key.sequence === "[") { void seek(-5000); return true; }
      if (name === "]" || name === "rightbracket" || key.sequence === "]") { void seek(5000); return true; }
      if (name === "-" || name === "minus" || key.sequence === "-") { void changeVolume(-5); return true; }
      if (name === "+" || name === "plus" || key.sequence === "+") { void changeVolume(5); return true; }
      if (name === "R" || (name === "r" && key.shift)) { void startRadio(); return true; }
      if (name === "r") { void cycleRepeat(); return true; }
      if (name === "s") { void toggleShuffle(); return true; }
      if (name === "f") { void toggleSaved(); return true; }
      if (name === "y") { void shareCurrent(); return true; }
      if (name === "p") { addToPlaylist(); return true; }
      if (name === "v") { toggleStyle(); return true; }
      return false;
    },
    async refresh() { render(); syncTimer(); await Promise.all([loadMetadata(), cover.load(true)]); },
    setTheme(value) { theme = value; applyTheme(); cover.updateNative(); quickSearch.setTheme(value); playlistPicker.setTheme(value); render(); },
    dispose() { if (disposed) return; disposed = true; cover.dispose(); if (timer) clearInterval(timer); unsubscribe(); ctx.renderer.off("resize", onResize); ctx.renderer.off("capabilities", onResize); ctx.renderer.off("frame", onFrame); quickSearch.dispose(); playlistPicker.dispose(); deck.dispose(); root.destroyRecursively(); },
  };
};
