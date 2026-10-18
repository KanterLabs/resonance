import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, type Renderable, type StyledText } from "@opentui/core";
import { paletteForTheme, type ThemeName } from "../theme.js";
import type { Row, ScreenContext, ScreenKey } from "./contracts.js";

export interface Surface {
  root: BoxRenderable;
  body: BoxRenderable;
  heading: TextRenderable;
  hint: TextRenderable;
  setMessage(message: string, error?: boolean): void;
  setRows(rows: Row[], selectedId?: string, onActivate?: (row: Row) => void): void;
  selected(): Row | undefined;
  move(delta: number): void;
  select(index: number): void;
  handleKey(key: ScreenKey): boolean;
  setLines(lines: string[]): void;
  setTheme(theme: ThemeName): void;
  prompt(label: string, initial: string, onSubmit: (value: string) => void, options?: { onChange?: (value: string) => void; onCancel?: () => void; reserveSpace?: boolean }): void;
  confirm(label: string, onConfirm: () => void): void;
  editing(): boolean;
  dispose(): void;
}

export interface SurfaceOptions {
  /**
   * Draw a small cover before each row that has a `cover_url`, making rows two
   * lines tall. Resolves to the cover's drawn lines, or null without one.
   */
  thumbnail?: (url: string) => Promise<StyledText[] | null>;
}
/** Thumbnail size in cells: four columns by two rows, so four by four pixels. */
export const THUMBNAIL = { width: 4, height: 2 } as const;

interface RowParts { label: TextRenderable; sub?: TextRenderable; thumb?: TextRenderable[] }

let serial = 0;
// Native text layout handles cell widths and truncation, including wide glyphs.
const singleLine = (value: string) => value.replace(/[\r\n\t]/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export function createSurface(ctx: ScreenContext, title: string, hintText: string, options: SurfaceOptions = {}): Surface {
  const id = `surface-${++serial}`;
  let palette = paletteForTheme(ctx.theme());
  let disposed = false;
  let rows: Row[] = [];
  let index = -1;
  let rowNodes: BoxRenderable[] = [];
  let rowParts: RowParts[] = [];
  const thumbnails = new Map<string, StyledText[] | null | "pending">();
  let textNodes: TextRenderable[] = [];
  let activate: ((row: Row) => void) | undefined;
  let messageError = false;
  let lastClick: { id: string; at: number } | undefined;
  let overlay: BoxRenderable | undefined;
  let input: InputRenderable | undefined;
  let overlayLabel: TextRenderable | undefined;
  let confirmAction: (() => void) | undefined;
  let cancelPrompt: (() => void) | undefined;
  let previousFocus: Renderable | null = null;

  const root = new BoxRenderable(ctx.renderer, { id, width: "100%", height: "100%", minWidth: 0, minHeight: 0, flexDirection: "column", border: true, borderStyle: "rounded", paddingX: 1, backgroundColor: palette.panel, borderColor: palette.border });
  const heading = new TextRenderable(ctx.renderer, { id: `${id}-heading`, content: singleLine(title), height: 1, flexShrink: 0, fg: palette.text, bg: "transparent", truncate: true, selectable: false });
  const hint = new TextRenderable(ctx.renderer, { id: `${id}-hint`, content: singleLine(hintText), height: 1, flexShrink: 0, fg: palette.muted, bg: "transparent", truncate: true, selectable: false });
  const body = new BoxRenderable(ctx.renderer, { id: `${id}-body`, flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" });
  const scroll = new ScrollBoxRenderable(ctx.renderer, { id: `${id}-scroll`, visible: false, flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false, scrollY: true, contentOptions: { flexDirection: "column" }, scrollbarOptions: { visible: false } });
  const message = new TextRenderable(ctx.renderer, { id: `${id}-message`, content: "", height: 1, flexShrink: 0, visible: false, fg: palette.muted, bg: "transparent", truncate: true, selectable: false });
  root.add(heading); root.add(hint); root.add(body); root.add(message); body.add(scroll);

  function clearContent() {
    for (const child of rowNodes) { scroll.remove(child); child.destroyRecursively(); }
    rowNodes = []; rowParts = []; lastClick = undefined;
  }
  function paintThumbnail(i: number) {
    const parts = rowParts[i], url = rows[i]?.cover_url;
    if (!parts?.thumb) return;
    const drawn = url ? thumbnails.get(url) : null;
    parts.thumb.forEach((node, line) => {
      if (Array.isArray(drawn) && drawn[line]) { node.content = drawn[line]!; node.bg = "transparent"; }
      else { node.content = " ".repeat(THUMBNAIL.width); node.bg = palette.cover; }
    });
  }
  function requestThumbnails() {
    const load = options.thumbnail;
    if (!load) return;
    for (const url of new Set(rows.map(row => row.cover_url).filter((url): url is string => !!url))) {
      if (thumbnails.has(url)) continue;
      thumbnails.set(url, "pending");
      load(url).then(drawn => { thumbnails.set(url, drawn); }, () => { thumbnails.set(url, null); }).finally(() => {
        if (disposed) return;
        rows.forEach((row, i) => { if (row.cover_url === url) paintThumbnail(i); });
      });
    }
  }
  function paintSelection() {
    rowNodes.forEach((node, i) => {
      node.backgroundColor = i === index ? palette.queueCurrent : palette.panel;
      const { label, sub } = rowParts[i]!, row = rows[i]!;
      label.fg = i === index ? palette.text : palette.muted;
      const subtitle = `${row.subtitle ? singleLine(row.subtitle) : ""}${row.detail ? `${row.subtitle ? "  " : ""}${singleLine(row.detail)}` : ""}`;
      if (sub) {
        // Two-line rows: the title above, who and where below it.
        label.content = `${i === index ? "›" : " "} ${singleLine(row.title)}${row.saved ? " [saved]" : ""}`;
        sub.content = `  ${subtitle}`; sub.fg = palette.dim;
      } else label.content = `${i === index ? "›" : " "} ${singleLine(row.title)}${row.saved ? " [saved]" : ""}${row.subtitle ? ` · ${singleLine(row.subtitle)}` : ""}${row.detail ? `  ${singleLine(row.detail)}` : ""}`;
      paintThumbnail(i);
    });
  }
  function select(next: number) {
    if (disposed || !rows.length) { index = -1; return; }
    index = Math.max(0, Math.min(rows.length - 1, Math.trunc(next)));
    paintSelection();
    scroll.scrollChildIntoView(rowNodes[index]!.id);
  }
  function closeOverlay(restore = true, canceled = false) {
    if (!overlay) return;
    const onCancel = cancelPrompt;
    input?.removeAllListeners();
    root.remove(overlay); overlay.destroyRecursively();
    overlay = undefined; input = undefined; overlayLabel = undefined; confirmAction = undefined; cancelPrompt = undefined;
    body.paddingTop = 0;
    if (restore && previousFocus && !previousFocus.isDestroyed) previousFocus.focus();
    previousFocus = null;
    if (canceled) onCancel?.();
  }
  function openOverlay(label: string) {
    closeOverlay(true, true);
    previousFocus = ctx.renderer.currentFocusedRenderable;
    overlay = new BoxRenderable(ctx.renderer, { id: `${id}-overlay`, position: "absolute", left: 0, right: 0, top: 2, height: 5, minWidth: 0, border: true, borderStyle: "rounded", paddingX: 1, flexDirection: "column", zIndex: 10, backgroundColor: palette.panelRaised, borderColor: palette.accent });
    overlayLabel = new TextRenderable(ctx.renderer, { content: singleLine(label), height: 1, truncate: true, selectable: false, fg: palette.text, bg: "transparent" });
    overlay.add(overlayLabel); root.add(overlay);
  }
  const surface: Surface = {
    root, body, heading, hint,
    setMessage(value, error = false) { if (disposed) return; messageError = error; message.content = singleLine(value); message.visible = value.length > 0; message.fg = error ? palette.red : palette.muted; },
    setRows(next, selectedId, onActivate) {
      if (disposed) return;
      const stableId = selectedId ?? rows[index]?.id;
      const oldIndex = index;
      clearContent(); rows = [...next]; activate = onActivate; scroll.visible = true;
      rows.forEach((row, i) => {
        const thumbs = !!options.thumbnail;
        const node = new BoxRenderable(ctx.renderer, { id: `${id}-row-${i}`, height: thumbs ? THUMBNAIL.height : 1, flexShrink: 0, minWidth: 0, ...(thumbs ? { flexDirection: "row" as const, gap: 1 } : {}), backgroundColor: palette.panel, onMouseDown(event) {
          if (event.button !== 0 || overlay) return;
          select(i);
          const now = Date.now();
          if (lastClick?.id === row.id && now - lastClick.at < 400) { lastClick = undefined; activate?.(row); }
          else lastClick = { id: row.id, at: now };
          event.preventDefault();
        } });
        const text = (parent: BoxRenderable) => { const label = new TextRenderable(ctx.renderer, { width: "100%", height: 1, content: "", truncate: true, wrapMode: "none", selectable: false, fg: palette.text, bg: "transparent" }); parent.add(label); return label; };
        if (thumbs) {
          const cover = new BoxRenderable(ctx.renderer, { id: `${id}-row-${i}-cover`, width: THUMBNAIL.width, height: THUMBNAIL.height, flexShrink: 0, flexDirection: "column" });
          const words = new BoxRenderable(ctx.renderer, { flexGrow: 1, minWidth: 0, height: THUMBNAIL.height, flexDirection: "column" });
          node.add(cover); node.add(words);
          const thumb = Array.from({ length: THUMBNAIL.height }, () => { const line = new TextRenderable(ctx.renderer, { width: THUMBNAIL.width, height: 1, content: "", selectable: false }); cover.add(line); return line; });
          rowParts.push({ label: text(words), sub: text(words), thumb });
        } else rowParts.push({ label: text(node) });
        rowNodes.push(node); scroll.add(node);
      });
      const found = rows.findIndex(row => row.id === stableId);
      select(found >= 0 ? found : Math.max(0, oldIndex));
      requestThumbnails();
    },
    selected: () => rows[index],
    move(delta) { select(index + delta); }, select,
    handleKey(key) {
      if (disposed) return false;
      const name = key.name?.toLowerCase();
      if (overlay) {
        if (name === "escape") { closeOverlay(true, true); return true; }
        if (confirmAction) {
          if (name === "y" && !key.ctrl && !key.meta) { const action = confirmAction; closeOverlay(); action(); }
          else if (name === "n" || name === "return" || name === "enter") closeOverlay();
          return true;
        }
        return false; // Let focused InputRenderable process text, navigation and Enter.
      }
      if (key.ctrl || key.meta) return false;
      const page = Math.max(1, scroll.viewport.height || 10);
      switch (name) {
        case "up": surface.move(-1); return true;
        case "down": surface.move(1); return true;
        case "pageup": surface.move(-page); return true;
        case "pagedown": surface.move(page); return true;
        case "home": select(0); return true;
        case "end": select(rows.length - 1); return true;
        default: return false;
      }
    },
    setLines(lines) {
      if (disposed) return;
      for (const child of textNodes) { scroll.remove(child); child.destroyRecursively(); }
      textNodes = []; scroll.visible = true;
      lines.forEach((line, i) => {
        const node = new TextRenderable(ctx.renderer, { content: singleLine(line), height: 1, flexShrink: 0, truncate: true, selectable: false, fg: palette.text, bg: "transparent" });
        textNodes.push(node); scroll.add(node, i);
      });
    },
    setTheme(theme) {
      if (disposed) return;
      palette = paletteForTheme(theme); root.backgroundColor = palette.panel; root.borderColor = palette.border;
      heading.fg = palette.text; hint.fg = palette.muted; message.fg = messageError ? palette.red : palette.muted;
      paintSelection(); textNodes.forEach(node => node.fg = palette.text);
      if (overlay) { overlay.backgroundColor = palette.panelRaised; overlay.borderColor = palette.accent; }
      if (overlayLabel) overlayLabel.fg = palette.text;
      if (input) { input.textColor = palette.text; input.backgroundColor = palette.panelRaised; input.focusedTextColor = palette.text; input.focusedBackgroundColor = palette.panelRaised; input.placeholderColor = palette.muted; }
    },
    prompt(label, initial, onSubmit, options) {
      if (disposed) return;
      openOverlay(`${label} · Enter to submit · Esc to cancel`);
      if (options?.reserveSpace) body.paddingTop = 5;
      input = new InputRenderable(ctx.renderer, { id: `${id}-input`, value: initial, width: "100%", textColor: palette.text, backgroundColor: palette.panelRaised, focusedTextColor: palette.text, focusedBackgroundColor: palette.panelRaised, placeholderColor: palette.muted });
      input.on("enter", (value: string) => { closeOverlay(); onSubmit(value); });
      if (options?.onChange) input.on("input", (value: string) => options.onChange!(value));
      cancelPrompt = options?.onCancel;
      overlay!.add(input); input.focus();
    },
    confirm(label, onConfirm) {
      if (disposed) return;
      openOverlay(`${label} [y/N] · Esc to cancel`); confirmAction = onConfirm;
      input = new InputRenderable(ctx.renderer, { id: `${id}-confirm-input`, width: "100%", placeholder: "Press y to confirm", textColor: palette.text, backgroundColor: palette.panelRaised, focusedTextColor: palette.text, focusedBackgroundColor: palette.panelRaised, placeholderColor: palette.muted });
      overlay!.add(input); input.focus();
    },
    editing: () => !!overlay,
    dispose() { if (disposed) return; closeOverlay(false); disposed = true; root.destroyRecursively(); rows = []; rowNodes = []; rowParts = []; textNodes = []; activate = undefined; thumbnails.clear(); },
  };
  return surface;
}
