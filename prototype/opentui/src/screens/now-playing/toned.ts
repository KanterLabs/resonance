import { BoxRenderable, MouseButton, TextRenderable } from "@opentui/core";
import type { ThemePalette } from "../../theme.js";
import type { ScreenContext } from "../../workspace/contracts.js";

export type Tone = keyof ThemePalette;
type TextOptions = ConstructorParameters<typeof TextRenderable>[1];
type BoxOptions = ConstructorParameters<typeof BoxRenderable>[1];

/** Text, rows and buttons for the classic player that remember their palette tones, so a theme change recolors them all. */
export function createToned(ctx: ScreenContext, colors: () => Readonly<ThemePalette>) {
  const texts: Array<{ node: TextRenderable; tone: Tone; background: Tone }> = [];
  function text(parent: BoxRenderable, id: string, content = "", options: TextOptions = {}, tone: Tone = "text", background: Tone = "panel") {
    const palette = colors();
    const node = new TextRenderable(ctx.renderer, { id: `np-${id}`, content, height: 1, flexShrink: 0, truncate: true, selectable: false, fg: palette[tone], bg: palette[background], ...options });
    texts.push({ node, tone, background }); parent.add(node); return node;
  }
  function row(parent: BoxRenderable, id: string, height = 1, options: BoxOptions = {}) {
    const node = new BoxRenderable(ctx.renderer, { id, width: "100%", height, flexShrink: 0, flexDirection: "row", alignItems: "center", ...options }); parent.add(node); return node;
  }
  function button(parent: BoxRenderable, id: string, label: string, width: number, action: () => void, accent = false) {
    return text(parent, id, label, { width, textAlign: "center", height: 1, onMouseDown: event => { if (event.button === MouseButton.LEFT) { action(); event.preventDefault(); } } }, accent ? "accentBright" : "muted");
  }
  function recolor() {
    const palette = colors();
    for (const item of texts) { item.node.fg = palette[item.tone]; item.node.bg = palette[item.background]; }
  }
  return { text, row, button, recolor };
}

export type Toned = ReturnType<typeof createToned>;
