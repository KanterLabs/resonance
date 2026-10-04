import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { Row, ScreenFactory, ScreenKey } from "../../workspace/contracts.js";
import { createSurface } from "../../workspace/surface.js";
import { paletteForTheme, type ThemePalette } from "../../theme.js";
import type { ParsedStatus } from "../../status.js";
import { ArcsController } from "./controller.js";
import { FOCUS_ORDER, adjustLength, adjustPoint, curveRows, dial, lengthLabel, markerRow, nextPreset, presetLabel, slotExplanation, slotRow, sparkline, summary, type Focus, type SeedRow } from "./model.js";

const HINT = "Tab focus · Enter build · p preset · ←→↑↓ shape · r reroll · k pin · x ban · i why · P play · s save · / add seed · + playing · - remove";
const GUTTER = 8;

function seedFromStatus(status: ParsedStatus | null): SeedRow | null {
  const playable = status?.playable;
  if (!playable || playable.type === "Episode" || !playable.uri) return null;
  return { uri: playable.uri, title: playable.title, artists: playable.artists };
}

export const createArcsScreen: ScreenFactory = (ctx, params = {}) => {
  const surface = createSurface(ctx, "Arcs", HINT);
  let colors = paletteForTheme(ctx.theme());
  let focus: Focus = "curve";
  let point = 0;
  let explain = false;
  let listKey = "";
  let disposed = false;

  const curveHeight = () => ctx.renderer.height >= 36 ? 5 : ctx.renderer.height >= 28 ? 3 : 2;
  const chartWidth = () => Math.max(16, Math.min(72, Math.min(136, ctx.renderer.width) - 8 - GUTTER));
  const panel = new BoxRenderable(ctx.renderer, { id: "arcs-panel", width: "100%", flexShrink: 0, minWidth: 0, flexDirection: "column" });
  const texts: Array<{ node: TextRenderable; tone: keyof ThemePalette }> = [];
  const line = (id: string, tone: keyof ThemePalette = "text", bold = false) => {
    const node = new TextRenderable(ctx.renderer, { id: `arcs-${id}`, content: "", height: 1, flexShrink: 0, truncate: true, wrapMode: "none", selectable: false, fg: colors[tone], bg: "transparent", attributes: bold ? TextAttributes.BOLD : undefined });
    panel.add(node); texts.push({ node, tone }); return node;
  };
  const seedsLine = line("seeds");
  const curveLines = Array.from({ length: 5 }, (_, i) => line(`curve-${i}`, "accent"));
  const markers = line("markers", "muted");
  const landed = line("landed", "teal");
  const dials = line("dials", "muted");
  const totals = line("summary", "muted");
  surface.body.add(panel, 0);

  const controller = new ArcsController(ctx.api, () => render());
  controller.setCurrent(seedFromStatus(ctx.status()));
  const unsubscribe = ctx.onStatus(status => { controller.setCurrent(seedFromStatus(status)); if (!controller.recipe.seeds.length) render(); });

  const focusTone = (section: Focus): keyof ThemePalette => focus === section ? "accentBright" : "muted";
  function paintTones() {
    for (const { node, tone } of texts) node.fg = colors[tone];
    for (const node of curveLines) node.fg = focus === "curve" ? colors.accentBright : colors.accent;
    markers.fg = colors[focusTone("curve")];
    dials.fg = colors[focusTone("dials")];
  }

  function rows(): Row[] {
    if (controller.mode === "alternatives") return controller.alternatives.map((slot, i) => ({ ...slotRow(slot, `alt-${i}`), title: `↻ ${slot.title}` }));
    if (controller.mode === "search") return controller.results.map(row => ({ ...row, id: `seed-${row.id}`, title: `+ ${row.title}` }));
    return controller.draft?.slots.map(slot => slotRow(slot)) ?? [];
  }

  function render() {
    if (disposed) return;
    const recipe = controller.recipe;
    const width = chartWidth();
    const height = curveHeight();
    const seeds = controller.seeds();
    seedsLine.content = `Seeds   ${seeds.length ? seeds.map(seed => seed.title).join(" · ") : controller.current ? `${controller.current.title} (playing now)` : "none yet · press / to search or + for the playing song"}`;
    const chart = curveRows(recipe.curve, width, height);
    curveLines.forEach((node, i) => { node.visible = i < height; node.content = i < height ? `${i === 0 ? "Energy" : i === height - 1 ? "  arc" : ""}`.padEnd(GUTTER) + chart[i] : ""; });
    markers.content = " ".repeat(GUTTER) + markerRow(recipe.curve, width, point, focus === "curve") + `  ${presetLabel(controller.presets, recipe.preset)}`;
    const draft = controller.draft;
    if (draft?.slots.length) {
      const energies = Array.from({ length: width }, (_, c) => draft.slots[Math.min(draft.slots.length - 1, Math.floor(c * draft.slots.length / width))]!.energy);
      landed.content = "Landed".padEnd(GUTTER) + sparkline(energies);
    } else landed.content = "Landed".padEnd(GUTTER) + "build to see where each track lands";
    dials.content = `Dials   Discovery ${dial(recipe.discovery)} ${recipe.discovery} · Length ${lengthLabel(recipe.length)} · Measured tracks ${controller.fingerprinted.toLocaleString("en-US")}`;
    totals.content = draft ? summary(draft) : "No arc yet";
    panel.height = height + 5;
    paintTones();

    const next = rows();
    const key = `${controller.mode}|${next.map(row => `${row.id}:${row.title}:${row.detail}`).join("|")}`;
    if (key !== listKey) { listKey = key; surface.setRows(next, undefined, activate); }
    surface.heading.content = controller.busy ? "Arcs · working…" : controller.mode === "alternatives" ? `Arcs / replace slot ${controller.alternativeSlot + 1}` : controller.mode === "search" ? "Arcs / add a seed" : "Arcs";
    const selected = selectedSlot();
    if (explain && selected) surface.setMessage(slotExplanation(selected));
    else surface.setMessage(controller.status, controller.error);
    ctx.renderer.requestRender();
  }

  function selectedSlot() {
    const meta = surface.selected()?.meta;
    if (controller.mode === "alternatives") { const index = Number(surface.selected()?.id.slice(4)); return controller.alternatives[index]; }
    return controller.mode === "draft" && typeof meta?.slot === "number" ? controller.draft?.slots[meta.slot] : undefined;
  }

  function activate(row: Row) {
    if (controller.mode === "alternatives" && row.uri) void controller.choose(row.uri);
    else if (controller.mode === "search" && row.uri) controller.addSeed({ uri: row.uri, title: row.title.replace(/^\+ /, ""), artists: row.subtitle ? row.subtitle.split(/\s*[,·]\s*/) : [] });
    else { explain = !explain; render(); }
  }

  function setFocus(next: Focus) { focus = next; render(); }

  const handleKey = (key: ScreenKey) => {
    if (surface.editing()) return surface.handleKey(key);
    if (key.ctrl || key.meta) return false;
    const raw = key.name ?? key.sequence ?? "";
    const name = raw.toLowerCase();
    const recipe = controller.recipe;
    if (name === "escape") {
      if (controller.back()) return true;
      if (explain) { explain = false; render(); return true; }
      return false;
    }
    if (name === "tab") {
      const step = key.shift ? -1 : 1;
      setFocus(FOCUS_ORDER[(FOCUS_ORDER.indexOf(focus) + step + FOCUS_ORDER.length) % FOCUS_ORDER.length]!);
      return true;
    }
    if (controller.mode !== "draft") {
      if (name === "return" || name === "enter") { const row = surface.selected(); if (row) activate(row); return true; }
      return surface.handleKey(key);
    }
    if (name === "return" || name === "enter") { void controller.build(); return true; }
    if (name === "p") {
      if (key.shift || raw === "P") { void controller.play(); return true; }
      const preset = nextPreset(controller.presets, recipe.preset);
      point = Math.min(point, preset.curve.length - 1);
      controller.edit({ curve: preset.curve.map(p => ({ ...p })), preset: preset.id });
      return true;
    }
    if (name === "s") {
      if (!controller.draft?.slots.length) { surface.setMessage("Build an arc before saving it", true); return true; }
      const title = controller.seeds()[0]?.title;
      surface.prompt(controller.draft.playlist_id ? "Update saved playlist" : "Save arc as playlist", title ? `${title} arc` : "Resonance arc", value => { if (value.trim()) void controller.save(value.trim()); });
      return true;
    }
    if (name === "/") { surface.prompt("Search for a seed song", "", value => { if (value.trim()) void controller.search(value.trim()); }); return true; }
    if (name === "+" || name === "=") { controller.addCurrentSeed(); return true; }
    if (name === "-") { controller.removeSeed(); return true; }
    if (name === "]" || name === "[") { controller.edit({ length: adjustLength(recipe.length, name === "]" ? 1 : -1) }); return true; }
    if (focus === "curve") {
      if (name === "left" || name === "right") { point = Math.max(0, Math.min(recipe.curve.length - 1, point + (name === "right" ? 1 : -1))); render(); return true; }
      if (name === "up" || name === "down") { controller.edit({ curve: adjustPoint(recipe.curve, point, (name === "up" ? 1 : -1) * (key.shift ? 0.05 : 0.1)), preset: null }); return true; }
    }
    if (focus === "dials") {
      if (name === "left" || name === "right") { controller.edit({ discovery: Math.max(0, Math.min(100, recipe.discovery + (name === "right" ? 10 : -10))) }); return true; }
      if (name === "up" || name === "down") { controller.edit({ length: adjustLength(recipe.length, name === "up" ? 1 : -1) }); return true; }
    }
    if (focus === "draft") {
      const slot = selectedSlot();
      if (name === "r") { if (slot) void controller.reroll(slot.slot); return true; }
      if (name === "k") { if (slot) void controller.pin(slot.slot); return true; }
      if (name === "x") { if (slot) void controller.ban(slot.slot); return true; }
      if (name === "i") { explain = !explain; render(); return true; }
      if (surface.handleKey(key)) { if (explain) render(); return true; }
    }
    return false;
  };

  render();
  void controller.load(params.fromCurrent === true);
  return {
    root: surface.root, title: "Arcs", handleKey,
    editing: () => surface.editing(),
    refresh: async () => { await controller.load(); },
    setTheme(theme) { colors = paletteForTheme(theme); surface.setTheme(theme); listKey = ""; render(); },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); controller.dispose(); surface.dispose(); },
  };
};
