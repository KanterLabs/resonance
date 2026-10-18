import { BoxRenderable, InputRenderable, LayoutEvents, MouseButton, TextRenderable, type Renderable } from "@opentui/core";
import { paletteForTheme, type ThemeName, type ThemePalette } from "../../theme.js";
import type { Page, Row, ScreenContext, ScreenKey } from "../../workspace/contracts.js";

/**
 * "Add to playlist" for the playing song. Like quick search it is a detached
 * overlay on Now Playing: type to filter, Enter adds, Esc closes. Typing a
 * name nobody matches offers to create that playlist with the song in it.
 */
export interface PlaylistPickerController {
  open(track: { uri: string; title: string }): void;
  isOpen(): boolean;
  handleKey(key: ScreenKey): boolean;
  setTheme(theme?: ThemeName): void;
  dispose(): void;
}

export interface PickerChoice { kind: "playlist" | "create"; id?: string; title: string }

const MAX_ROWS = 10;
const PAGE = 200;
const MAX_PLAYLISTS = 1000;

/** Playlists this account can change, last used first, narrowed by every word of the query. */
export function pickerChoices(playlists: readonly Row[], query: string, lastUsed?: string): PickerChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const editable = playlists.filter(row => row.meta?.can_edit !== false && row.meta?.editable !== false);
  const ordered = lastUsed ? [...editable.filter(row => row.id === lastUsed), ...editable.filter(row => row.id !== lastUsed)] : editable;
  const matches: PickerChoice[] = ordered
    .filter(row => words.every(word => row.title.toLowerCase().includes(word)))
    .map(row => ({ kind: "playlist", id: row.id, title: row.title }));
  const name = query.trim();
  if (name && !matches.some(choice => choice.title.toLowerCase() === name.toLowerCase())) matches.push({ kind: "create", title: name });
  return matches;
}

let lastUsed: string | undefined;

export function createPlaylistPicker(ctx: ScreenContext, parent: BoxRenderable): PlaylistPickerController {
  let disposed = false;
  let openState = false;
  let colors: Readonly<ThemePalette> = paletteForTheme(ctx.theme());
  let layer: BoxRenderable | undefined;
  let panel: BoxRenderable | undefined;
  let heading: TextRenderable | undefined;
  let input: InputRenderable | undefined;
  let status: TextRenderable | undefined;
  let footer: TextRenderable | undefined;
  let rowViews: TextRenderable[] = [];
  let track: { uri: string; title: string } | undefined;
  let playlists: Row[] = [];
  let choices: PickerChoice[] = [];
  let selected = 0;
  let firstVisible = 0;
  let query = "";
  let message = "";
  let messageError = false;
  let loaded = false;
  let busy = false;
  let generation = 0;
  let previousFocus: Renderable | null = null;
  // Spotify allows duplicates, so a second add of the same song asks first.
  const added = new Set<string>();
  let confirmDuplicate: string | undefined;

  function requestRender() { if (!disposed) ctx.renderer.requestRender(); }
  function size() {
    const width = Math.max(1, parent.width || ctx.renderer.width);
    const height = Math.max(1, parent.height || ctx.renderer.height);
    // Grow with the list (at least three rows) until the window runs out.
    const rows = Math.max(1, Math.min(MAX_ROWS, Math.max(3, choices.length), height - 2 - 8));
    return { width: Math.max(1, Math.min(width, Math.max(32, Math.min(64, width - 4)))), height: Math.min(Math.max(1, height - 2), rows + 8), rows };
  }

  function refilter() {
    choices = pickerChoices(playlists, query, lastUsed);
    selected = Math.max(0, Math.min(selected, choices.length - 1));
    confirmDuplicate = undefined;
    adjustWindow();
    if (loaded && !busy) { message = choices.length ? "" : "No playlists you can edit · type a name to create one"; messageError = false; }
    paint();
  }

  function adjustWindow() {
    const visible = size().rows;
    if (selected < firstVisible) firstVisible = selected;
    else if (selected >= firstVisible + visible) firstVisible = selected - visible + 1;
    firstVisible = Math.max(0, Math.min(firstVisible, Math.max(0, choices.length - visible)));
  }

  function paint() {
    if (disposed || !panel) return;
    const view = size();
    panel.width = view.width; panel.height = view.height;
    panel.backgroundColor = colors.panelRaised; panel.borderColor = colors.accent;
    if (heading) { heading.fg = colors.text; heading.bg = colors.panelRaised; heading.content = `ADD TO PLAYLIST · ${track?.title ?? ""}`; }
    if (input) { input.textColor = input.focusedTextColor = colors.text; input.backgroundColor = input.focusedBackgroundColor = colors.panel; input.placeholderColor = colors.muted; }
    if (status) {
      status.fg = messageError ? colors.red : colors.muted; status.bg = colors.panelRaised;
      status.content = message || (loaded ? `${choices.filter(choice => choice.kind === "playlist").length} playlists` : "Loading playlists…");
    }
    if (footer) { footer.fg = colors.dim; footer.bg = colors.panelRaised; }
    rowViews.forEach((node, slot) => {
      const index = firstVisible + slot;
      const choice = choices[index];
      node.visible = !!choice && slot < view.rows;
      if (!choice) return;
      const chosen = index === selected;
      node.bg = chosen ? colors.queueCurrent : colors.panelRaised;
      node.fg = choice.kind === "create" ? colors.accentBright : colors.text;
      const mark = choice.id === lastUsed ? "  · last used" : "";
      node.content = `${chosen ? "›" : " "} ${choice.kind === "create" ? `+ New playlist “${choice.title}”` : choice.title.replace(/[\r\n\t]/g, " ")}${mark}`;
    });
    requestRender();
  }

  async function load(request: number) {
    const rows: Row[] = [];
    try {
      for (let offset = 0; offset < MAX_PLAYLISTS; offset += PAGE) {
        const page = await ctx.api.call<Page>("library.list", { kind: "playlists", offset, limit: PAGE });
        if (disposed || request !== generation) return;
        rows.push(...page.items.filter(row => row.kind === "playlist" && row.id));
        if (!page.has_more || !page.items.length) break;
      }
      playlists = rows; loaded = true; message = ""; messageError = false;
      refilter();
    } catch (error) {
      if (disposed || request !== generation) return;
      loaded = true; message = `Playlists unavailable: ${error instanceof Error ? error.message : String(error)}`; messageError = true;
      paint();
    }
  }

  async function choose(index = selected) {
    const choice = choices[index];
    if (!choice || !track || busy || !openState) return;
    const song = track;
    const key = `${choice.id}:${song.uri}`;
    if (choice.kind === "playlist" && added.has(key) && confirmDuplicate !== key) {
      confirmDuplicate = key; message = `Already added to ${choice.title} · Enter again to add another copy`; messageError = false; paint();
      return;
    }
    busy = true; message = choice.kind === "create" ? `Creating ${choice.title}…` : `Adding to ${choice.title}…`; messageError = false; paint();
    const request = generation;
    try {
      let id = choice.id;
      if (choice.kind === "create") id = (await ctx.api.call<{ id?: string }>("playlist.action", { action: "create", name: choice.title })).id;
      if (!id) throw new Error("the new playlist has no id");
      await ctx.api.call("playlist.action", { action: "add", id, uri: song.uri });
      lastUsed = id; added.add(`${id}:${song.uri}`);
      if (disposed) return;
      ctx.notify(`Added ${song.title} to ${choice.title}`);
      if (request === generation) close();
    } catch (error) {
      if (disposed || request !== generation) return;
      message = `Couldn't add: ${error instanceof Error ? error.message : String(error)}`; messageError = true; paint();
    } finally { busy = false; }
  }

  function build() {
    const view = size();
    layer = new BoxRenderable(ctx.renderer, { id: "np-playlist-picker-layer", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 100, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" });
    panel = new BoxRenderable(ctx.renderer, { id: "np-playlist-picker", width: view.width, height: view.height, minWidth: 1, minHeight: 1, maxWidth: "100%", maxHeight: "100%", border: true, borderStyle: "rounded", paddingX: 1, paddingY: 1, flexDirection: "column" });
    const line = (id: string) => new TextRenderable(ctx.renderer, { id, content: "", height: 1, width: "100%", flexShrink: 0, truncate: true, selectable: false });
    heading = line("np-playlist-picker-heading");
    input = new InputRenderable(ctx.renderer, { id: "np-playlist-picker-input", value: "", width: "100%", flexShrink: 0, placeholder: "Filter or name a new playlist…" });
    status = line("np-playlist-picker-status");
    const list = new BoxRenderable(ctx.renderer, { id: "np-playlist-picker-rows", width: "100%", flexGrow: 1, minHeight: 1, flexShrink: 1, overflow: "hidden", flexDirection: "column" });
    footer = line("np-playlist-picker-footer");
    footer.content = "↑↓ choose · Enter add · Esc close";
    rowViews = Array.from({ length: MAX_ROWS }, (_, slot) => {
      const node = line(`np-playlist-picker-row-${slot}`);
      node.onMouseDown = event => {
        if (event.button !== MouseButton.LEFT) return;
        const index = firstVisible + slot;
        if (index === selected) void choose(index); else { selected = index; confirmDuplicate = undefined; paint(); }
        event.preventDefault();
      };
      list.add(node);
      return node;
    });
    panel.add(heading); panel.add(input); panel.add(status); panel.add(list); panel.add(footer);
    input.on("input", value => { query = String(value); selected = 0; firstVisible = 0; refilter(); });
    layer.add(panel); parent.add(layer);
    paint();
    input.focus();
  }

  function close(restoreFocus = true) {
    if (!openState) return;
    openState = false; ++generation; busy = false;
    input?.removeAllListeners(); input?.blur();
    const owned = layer;
    layer = panel = undefined; heading = status = footer = undefined; input = undefined; rowViews = [];
    if (owned) { if (owned.parent === parent) parent.remove(owned); if (!owned.isDestroyed) owned.destroyRecursively(); }
    if (restoreFocus && previousFocus && !previousFocus.isDestroyed) previousFocus.focus();
    previousFocus = null;
    requestRender();
  }

  function move(delta: number) {
    if (!choices.length) return;
    selected = Math.max(0, Math.min(choices.length - 1, selected + delta));
    confirmDuplicate = undefined; adjustWindow(); paint();
  }

  const onResize = () => { if (openState) { adjustWindow(); paint(); } };
  ctx.renderer.on("resize", onResize);
  parent.on(LayoutEvents.RESIZED, onResize);

  return {
    open(value) {
      if (disposed) return;
      if (openState) { input?.focus(); return; }
      openState = true; track = value; query = ""; selected = 0; firstVisible = 0;
      message = ""; messageError = false; loaded = false; confirmDuplicate = undefined; choices = [];
      previousFocus = ctx.renderer.currentFocusedRenderable;
      build();
      void load(++generation);
    },
    isOpen: () => openState,
    handleKey(key) {
      if (disposed || !openState) return false;
      const name = (key.name ?? key.sequence ?? "").toLowerCase();
      if (name === "escape") { close(); return true; }
      if (key.ctrl || key.meta) return false;
      if (name === "up") { move(-1); return true; }
      if (name === "down") { move(1); return true; }
      if (name === "pageup") { move(-size().rows); return true; }
      if (name === "pagedown") { move(size().rows); return true; }
      if (name === "return" || name === "enter") { void choose(); return true; }
      const value = key.sequence ?? key.name ?? "";
      if ((value.length === 1 && value >= " " && value !== "\u007f") || ["backspace", "delete", "left", "right", "home", "end", "tab"].includes(name)) return false;
      return true;
    },
    setTheme(next = ctx.theme()) { if (disposed) return; colors = paletteForTheme(next); paint(); },
    dispose() {
      if (disposed) return;
      close(false);
      disposed = true;
      ctx.renderer.off("resize", onResize);
      parent.off(LayoutEvents.RESIZED, onResize);
    },
  };
}
