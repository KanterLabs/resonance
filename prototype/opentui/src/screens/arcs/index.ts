import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { Row, ScreenFactory, ScreenKey } from "../../workspace/contracts.js";
import { createSurface } from "../../workspace/surface.js";
import { paletteForTheme, type ThemePalette } from "../../theme.js";
import type { ParsedStatus } from "../../status.js";
import { ArcsController } from "./controller.js";
import { COMPACT_LEGENDS, LEGENDS, adjustLength, adjustPoint, curveRows, lengthLabel, markerRow, mixLabel, nextPreset, presetLabel, slotExplanation, slotRow, summary, whyLine, type Legend, type SeedRow } from "./model.js";

const GUTTER = 7;
/** How long an action's confirmation holds the bottom line before the selection's "why" returns. */
const STATUS_HOLD_MS = 4000;

function seedFromStatus(status: ParsedStatus | null): SeedRow | null {
  const playable = status?.playable;
  if (!playable || playable.type === "Episode" || !playable.uri) return null;
  return { uri: playable.uri, title: playable.title, artists: playable.artists };
}

export const createArcsScreen: ScreenFactory = (ctx, params = {}) => {
  const surface = createSurface(ctx, "Arc Studio", LEGENDS.empty[0]);
  let colors = paletteForTheme(ctx.theme());
  let editing = false;
  let point = 0;
  let detail = false;
  let listKey = "";
  let disposed = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** The arc row to land on when a swap or seed search returns to the arc. */
  let returnTo: string | undefined;

  const legend2 = new TextRenderable(ctx.renderer, { id: "arcs-legend-2", content: LEGENDS.empty[1], height: 1, flexShrink: 0, truncate: true, wrapMode: "none", selectable: false, fg: colors.muted, bg: "transparent" });
  surface.root.add(legend2, 2);
  const curveHeight = () => ctx.renderer.height >= 36 ? 4 : ctx.renderer.height >= 28 ? 3 : 2;
  const chartWidth = () => Math.max(16, Math.min(80, Math.min(136, ctx.renderer.width) - 8 - GUTTER));
  const panel = new BoxRenderable(ctx.renderer, { id: "arcs-panel", width: "100%", flexShrink: 0, minWidth: 0, flexDirection: "column", marginTop: 1 });
  const texts: Array<{ node: TextRenderable; tone: keyof ThemePalette }> = [];
  const line = (id: string, tone: keyof ThemePalette = "text", bold = false) => {
    const node = new TextRenderable(ctx.renderer, { id: `arcs-${id}`, content: "", height: 1, flexShrink: 0, truncate: true, wrapMode: "none", selectable: false, fg: colors[tone], bg: "transparent", attributes: bold ? TextAttributes.BOLD : undefined });
    panel.add(node); texts.push({ node, tone }); return node;
  };
  const fromLine = line("from", "text", true);
  const controlsLine = line("controls", "muted");
  const curveLines = Array.from({ length: 4 }, (_, i) => line(`curve-${i}`, "accent"));
  const markers = line("markers", "accentBright");
  const totals = line("summary", "muted");
  surface.body.add(panel, 0);

  const controller = new ArcsController(ctx.api, () => render());
  controller.setCurrent(seedFromStatus(ctx.status()));
  const unsubscribe = ctx.onStatus(status => { controller.setCurrent(seedFromStatus(status)); render(); });

  function legend(): Legend {
    if (controller.mode === "alternatives") return "swap";
    if (controller.mode === "search") return "seed";
    if (editing) return "edit";
    return controller.draft?.slots.length ? "arc" : "empty";
  }

  function rows(): Row[] {
    if (controller.mode === "alternatives") return controller.alternatives.map((slot, i) => ({ ...slotRow(slot, `alt-${i}`), title: `↻ ${slot.title}` }));
    if (controller.mode === "search") return controller.results.map(row => ({ ...row, id: `seed-${row.id}`, title: `+ ${row.title}` }));
    return controller.draft?.slots.map(slot => slotRow(slot)) ?? [];
  }

  function selectedSlot() {
    const row = surface.selected();
    if (controller.mode === "alternatives") return row ? controller.alternatives[Number(row.id.slice(4))] : undefined;
    const slot = row?.meta?.slot;
    return controller.mode === "draft" && typeof slot === "number" ? controller.draft?.slots[slot] : undefined;
  }

  function render() {
    if (disposed) return;
    const recipe = controller.recipe;
    const width = chartWidth();
    const height = curveHeight();
    const seeds = controller.seeds();
    const playing = controller.current;
    fromLine.content = seeds.length
      ? `From   ${seeds[0]!.title}${seeds[0]!.artists.length ? ` — ${seeds[0]!.artists.join(", ")}` : ""}${seeds.length > 1 ? `  (+${seeds.length - 1} more)` : ""}`
      : playing ? `From   ${playing.title} — ${playing.artists.join(", ")}  (playing now)` : "From   nothing yet: play a song, or press / to choose one";
    const roomy = Math.min(136, ctx.renderer.width) - 8 >= 96;
    controlsLine.content = roomy
      ? `Shape  ◀ ${presetLabel(controller.presets, recipe.preset)} ▶   Length − ${lengthLabel(recipe.length)} +   Mix ${mixLabel(recipe.discovery)}`
      : `Shape  ◀ ${presetLabel(controller.presets, recipe.preset)} ▶  ${lengthLabel(recipe.length)}  mix ${mixLabel(recipe.discovery)}`;
    const chart = curveRows(recipe.curve, width, height);
    curveLines.forEach((node, i) => {
      node.visible = i < height;
      node.content = i < height ? `${i === 0 ? "high" : i === height - 1 ? "low" : ""}`.padEnd(GUTTER) + chart[i] : "";
    });
    markers.visible = editing;
    markers.content = editing ? "".padEnd(GUTTER) + markerRow(recipe.curve, width, point, true) + `  point ${point + 1}/${recipe.curve.length} · energy ${Math.round(recipe.curve[point]!.energy * 100)}%` : "";
    const draft = controller.draft;
    totals.content = draft ? summary(draft) + (controller.newlyMeasured ? ` · ${controller.newlyMeasured} more song${controller.newlyMeasured === 1 ? "" : "s"} measured, u refresh` : "") : controller.busy ? "Building…" : "";
    panel.height = height + 3 + (editing ? 1 : 0);
    for (const { node, tone } of texts) node.fg = colors[tone];
    for (const node of curveLines) node.fg = editing ? colors.accentBright : colors.accent;

    const [first, second] = (roomy ? LEGENDS : COMPACT_LEGENDS)[legend()];
    surface.hint.content = first; legend2.content = second;
    surface.hint.fg = colors.accentBright; legend2.fg = colors.muted;

    const next = rows();
    const key = `${controller.mode}|${next.map(row => `${row.id}:${row.title}:${row.detail}`).join("|")}`;
    if (key !== listKey) {
      listKey = key;
      const prefer = controller.mode === "draft" ? returnTo : undefined;
      surface.setRows(next, prefer, activate);
      if (prefer) returnTo = undefined;
    }
    surface.heading.content = controller.busy ? "Arc Studio · working…" : controller.mode === "alternatives" ? `Arc Studio / swap track ${controller.alternativeSlot + 1}` : controller.mode === "search" ? "Arc Studio / add a starting song" : "Arc Studio";

    const fresh = Date.now() - controller.statusAt < STATUS_HOLD_MS;
    const selected = selectedSlot();
    if (controller.error || (fresh && controller.status)) {
      surface.setMessage(controller.status, controller.error);
      clearTimeout(holdTimer);
      if (!controller.error) holdTimer = setTimeout(render, STATUS_HOLD_MS);
    } else if (selected) surface.setMessage(detail ? slotExplanation(selected) : whyLine(selected));
    else surface.setMessage(controller.status);
    ctx.renderer.requestRender();
  }

  function activate(row: Row) {
    if (controller.mode === "alternatives" && row.uri) void controller.choose(row.uri);
    else if (controller.mode === "search" && row.uri) controller.addSeed({ uri: row.uri, title: row.title.replace(/^\+ /, ""), artists: row.subtitle ? row.subtitle.split(/\s*[,·]\s*/) : [] });
    else { const slot = row.meta?.slot; if (typeof slot === "number") void controller.play(slot); }
  }

  function editKey(name: string): boolean {
    const recipe = controller.recipe;
    if (name === "escape" || name === "return" || name === "enter" || name === "e") { editing = false; render(); return true; }
    if (name === "left" || name === "right") { point = Math.max(0, Math.min(recipe.curve.length - 1, point + (name === "right" ? 1 : -1))); render(); return true; }
    if (name === "up" || name === "down") { controller.edit({ curve: adjustPoint(recipe.curve, point, name === "up" ? 0.1 : -0.1), preset: null }); return true; }
    return true; // Keep edit mode modal so stray letters do not change the arc.
  }

  const handleKey = (key: ScreenKey) => {
    if (surface.editing()) return surface.handleKey(key);
    if (key.ctrl) return false;
    const name = (key.name ?? key.sequence ?? "").toLowerCase();
    const sequence = key.sequence ?? "";
    if (editing) return editKey(name);
    if (key.meta) return false;
    if (controller.mode !== "draft") {
      if (name === "escape" || name === "backspace") { controller.back(); return true; }
      if (name === "return" || name === "enter") { const row = surface.selected(); if (row) activate(row); return true; }
      const moved = surface.handleKey(key);
      if (moved) render();
      return moved;
    }
    const recipe = controller.recipe;
    const slot = selectedSlot();
    switch (name) {
      case "return": case "enter": { const row = surface.selected(); if (row) activate(row); else void controller.build(); return true; }
      case "left": case "right": {
        const preset = nextPreset(controller.presets, recipe.preset, name === "right" ? 1 : -1);
        point = Math.min(point, preset.curve.length - 1);
        controller.edit({ curve: preset.curve.map(p => ({ ...p })), preset: preset.id });
        return true;
      }
      case "e": editing = true; point = Math.min(point, recipe.curve.length - 1); render(); return true;
      case "-": case "_": controller.edit({ length: adjustLength(recipe.length, -1) }); return true;
      case "+": case "=": controller.edit({ length: adjustLength(recipe.length, 1) }); return true;
      case "[": case "]": controller.edit({ discovery: Math.max(0, Math.min(100, recipe.discovery + (name === "]" ? 10 : -10))) }); return true;
      case "g": controller.remix(); return true;
      case "u": void controller.build(); return true;
      case "c": void controller.useCurrent(); return true;
      case "/": returnTo = surface.selected()?.id; surface.prompt("Search for a starting song", "", value => { if (value.trim()) void controller.search(value.trim()); }); return true;
      case "backspace": case "delete": controller.removeSeed(); return true;
      case "p": void controller.play(0); return true;
      case "r": if (slot) { returnTo = `slot-${slot.slot}`; void controller.reroll(slot.slot); } return true;
      case "k": if (slot) void controller.pin(slot.slot); return true;
      case "x": if (slot) void controller.ban(slot.slot); return true;
      case "i": detail = !detail; render(); return true;
      case "s": {
        if (!controller.draft?.slots.length) { surface.setMessage("Build an arc before saving it", true); return true; }
        const title = controller.seeds()[0]?.title;
        surface.prompt(controller.draft.playlist_id ? "Update the saved playlist (name)" : "Save as a private playlist named", title ? `${title} arc` : "Resonance arc", value => { if (value.trim()) void controller.save(value.trim()); });
        return true;
      }
      default: {
        if (sequence === "+" || sequence === "-") return handleKey({ ...key, name: sequence });
        const moved = surface.handleKey(key);
        if (moved) { controller.statusAt = 0; render(); }
        return moved;
      }
    }
  };

  render();
  void controller.load(params.fromCurrent === true);
  return {
    root: surface.root, title: "Arc Studio", handleKey,
    editing: () => surface.editing() || editing,
    refresh: async () => { await controller.load(); },
    setTheme(theme) { colors = paletteForTheme(theme); surface.setTheme(theme); listKey = ""; render(); },
    dispose() { if (disposed) return; disposed = true; clearTimeout(holdTimer); unsubscribe(); controller.dispose(); surface.dispose(); },
  };
};
