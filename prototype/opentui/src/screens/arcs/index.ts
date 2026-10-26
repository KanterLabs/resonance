import { BoxRenderable, RGBA, StyledText, TextAttributes, TextRenderable, type TextChunk } from "@opentui/core";
import type { Row, ScreenFactory, ScreenKey } from "../../workspace/contracts.js";
import { createSurface } from "../../workspace/surface.js";
import { paletteForTheme, type ThemePalette } from "../../theme.js";
import type { ParsedStatus } from "../../status.js";
import { ArcsController } from "./controller.js";
import { curveCells, digitLevel, insertPoint, removePoint, setPoint, slidePoint, slotMarker, type Tone } from "./curve.js";
import { COMPACT_LEGENDS, LEGENDS, adjustLength, adjustPoint, lengthLabel, markerRow, mixLabel, nextPreset, presetLabel, seedsLabel, slotExplanation, slotRow, summary, toggleLength, whyLine, type Legend, type SeedRow } from "./model.js";

const GUTTER = 7;
/** How long an action's confirmation holds the bottom line before the selection's "why" returns. */
const STATUS_HOLD_MS = 4000;
/** From this height the studio has room for a status line of its own. */
const TALL = 30;
/** Keys that look around without changing anything, so they leave an audition playing. */
const LOOKING = new Set(["up", "down", "pageup", "pagedown", "home", "end", "i", "a", "escape"]);

function seedFromStatus(status: ParsedStatus | null): SeedRow | null {
  const playable = status?.playable;
  if (!playable || playable.type === "Episode" || !playable.uri) return null;
  return { uri: playable.uri, title: playable.title, artists: playable.artists };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

export const createArcsScreen: ScreenFactory = (ctx, params = {}) => {
  const surface = createSurface(ctx, "Arc Studio", LEGENDS.empty);
  let colors = paletteForTheme(ctx.theme());
  let editing = false;
  let point = 0;
  let detail = false;
  let listKey = "";
  let disposed = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** The arc row to land on when a swap or seed search returns to the arc. */
  let returnTo: string | undefined;

  const curveHeight = () => ctx.renderer.height >= 36 ? 4 : ctx.renderer.height >= 28 ? 3 : 2;
  const chartWidth = () => Math.max(16, Math.min(80, Math.min(136, ctx.renderer.width) - 8 - GUTTER));
  const tall = () => ctx.renderer.height >= TALL;
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
  const statusLine = line("status", "muted");
  surface.body.add(panel, 0);

  const controller = new ArcsController(ctx.api, () => render());
  controller.setCurrent(seedFromStatus(ctx.status()));
  const unsubscribe = ctx.onStatus(status => { controller.setCurrent(seedFromStatus(status)); render(); });

  function legend(): Legend {
    if (controller.mode === "alternatives") return "swap";
    if (controller.mode === "search") return "seed";
    if (controller.mode === "seeds") return "seeds";
    if (editing) return "edit";
    return controller.draft?.slots.length ? "arc" : "empty";
  }

  function rows(): Row[] {
    if (controller.mode === "alternatives") return controller.alternatives.map((slot, i) => ({ ...slotRow(slot, `alt-${i}`), title: `↻ ${slot.title}` }));
    if (controller.mode === "search") return controller.results.map(row => ({ ...row, id: `seed-${row.id}`, title: `+ ${row.title}` }));
    if (controller.mode === "seeds") return controller.seeds().map(seed => ({ id: `start-${seed.uri}`, kind: "track", title: `✦ ${seed.title}`, subtitle: seed.artists.join(", "), uri: seed.uri }));
    return controller.draft?.slots.map(slot => slotRow(slot)) ?? [];
  }

  function selectedSlot() {
    const row = surface.selected();
    if (controller.mode === "alternatives") return row ? controller.alternatives[Number(row.id.slice(4))] : undefined;
    const slot = row?.meta?.slot;
    return controller.mode === "draft" && typeof slot === "number" ? controller.draft?.slots[slot] : undefined;
  }

  /** The arc slot the chart should point at: the selected track, or the one being swapped. */
  function chartSelection(): number {
    if (controller.mode === "alternatives") return controller.alternativeSlot;
    return controller.mode === "draft" ? selectedSlot()?.slot ?? -1 : -1;
  }

  function toneColor(tone: Tone): string {
    switch (tone) {
      case "area": return editing ? colors.accentBright : colors.accent;
      case "track": return colors.text;
      case "estimate": return colors.muted;
      case "off": return colors.amber;
      case "selected": return colors.teal;
    }
  }

  function chartLine(label: string, cells: { ch: string; tone: Tone }[]): StyledText {
    const chunks: TextChunk[] = [{ __isChunk: true, text: label.padEnd(GUTTER), fg: RGBA.fromHex(colors.muted) }];
    let run = "", tone: Tone | null = null;
    const flush = () => { if (run && tone) chunks.push({ __isChunk: true, text: run, fg: RGBA.fromHex(toneColor(tone)) }); };
    for (const cell of cells) {
      if (cell.tone !== tone) { flush(); run = ""; tone = cell.tone; }
      run += cell.ch;
    }
    flush();
    return new StyledText(chunks);
  }

  function auditionText(): string {
    const audition = controller.audition;
    if (!audition) return "";
    const left = Math.max(0, Math.ceil((audition.until - Date.now()) / 1000));
    return `♪ auditioning ${audition.title} · ${left}s · a or Esc to stop`;
  }

  function heading(): string {
    const base = controller.mode === "alternatives" ? `Arc Studio / swap track ${controller.alternativeSlot + 1}`
      : controller.mode === "search" ? "Arc Studio / add a starting song"
      : controller.mode === "seeds" ? "Arc Studio / starting songs" : "Arc Studio";
    const waiting = controller.pendingLabel;
    const save = controller.saveState();
    const tail = controller.busy || waiting ? `working…${waiting ? ` then ${waiting}` : ""}`
      : save === "saved" ? `saved to ${controller.savedName ?? "its playlist"}`
      : save === "unsaved" ? "unsaved changes" : "";
    return tail ? `${base} · ${tail}` : base;
  }

  function render() {
    if (disposed) return;
    const recipe = controller.recipe;
    const width = chartWidth();
    const height = curveHeight();
    const seeds = controller.seeds();
    const playing = controller.current;
    const roomy = Math.min(136, ctx.renderer.width) - 8 >= 96;
    const draft = controller.draft;
    fromLine.content = seeds.length
      ? `From   ${seedsLabel(seeds, Math.max(20, Math.min(136, ctx.renderer.width) - 16))}`
      : playing ? `From   ${playing.title} — ${playing.artists.join(", ")}  (playing now)` : "From   nothing yet: play a song, or press / to choose one";
    controlsLine.content = roomy
      ? `Shape  ◀ ${presetLabel(controller.presets, recipe.preset)} ▶   Length − ${lengthLabel(recipe.length, draft)} +   Mix ${mixLabel(recipe.discovery)}`
      : `Shape  ◀ ${presetLabel(controller.presets, recipe.preset)} ▶  ${lengthLabel(recipe.length)}  mix ${mixLabel(recipe.discovery)}`;

    // The arc's tracks sit on the curve, except while the curve itself is being reshaped.
    const selected = chartSelection();
    const cells = curveCells(recipe.curve, editing ? [] : draft?.slots ?? [], width, height, selected);
    curveLines.forEach((node, i) => {
      node.visible = i < height;
      node.content = i < height ? chartLine(i === 0 ? "high" : i === height - 1 ? "low" : "", cells[i]!) : "";
    });
    const slot = selected >= 0 ? draft?.slots[selected] : undefined;
    if (editing) {
      markers.visible = true;
      markers.content = "".padEnd(GUTTER) + markerRow(recipe.curve, width, point, true) + `  point ${point + 1}/${recipe.curve.length} · energy ${percent(recipe.curve[point]!.energy)}`;
    } else if (slot && draft && height >= 3) {
      markers.visible = true;
      markers.content = "".padEnd(GUTTER) + slotMarker(draft.slots.length, width, selected) + `  track ${selected + 1} · target ${percent(slot.target)} · energy ${percent(slot.energy)}`;
    } else { markers.visible = false; markers.content = ""; }

    totals.content = draft ? summary(draft) + (controller.newlyMeasured ? ` · ${controller.newlyMeasured} more song${controller.newlyMeasured === 1 ? "" : "s"} measured, u refresh` : "") : controller.busy ? "Building…" : "";
    for (const { node, tone } of texts) node.fg = colors[tone];
    markers.fg = colors.accentBright;

    const roomForStatus = tall();
    const audition = auditionText();
    statusLine.visible = roomForStatus;
    statusLine.content = roomForStatus ? audition || controller.status : "";
    statusLine.fg = controller.error && !audition ? colors.red : audition ? colors.teal : colors.muted;
    panel.height = height + 3 + (markers.visible ? 1 : 0) + (roomForStatus ? 1 : 0);

    surface.hint.content = (roomy ? LEGENDS : COMPACT_LEGENDS)[legend()];
    surface.hint.fg = colors.accentBright;

    const next = rows();
    const key = `${controller.mode}|${next.map(row => `${row.id}:${row.title}:${row.detail}`).join("|")}`;
    if (key !== listKey) {
      listKey = key;
      const focus = controller.focusSlot;
      const prefer = controller.mode === "draft" ? (focus !== null ? `slot-${focus}` : returnTo) : undefined;
      surface.setRows(next, prefer, activate);
      if (controller.mode === "draft") { returnTo = undefined; controller.focusSlot = null; }
    }
    surface.heading.content = heading();

    const why = selectedSlot();
    const explain = why ? (detail ? slotExplanation(why) : whyLine(why)) : "";
    if (roomForStatus) {
      clearTimeout(holdTimer);
      surface.setMessage(explain);
    } else {
      const fresh = Date.now() - controller.statusAt < STATUS_HOLD_MS;
      if (audition) surface.setMessage(audition);
      else if (controller.error || (fresh && controller.status)) {
        surface.setMessage(controller.status, controller.error);
        clearTimeout(holdTimer);
        if (!controller.error) holdTimer = setTimeout(render, STATUS_HOLD_MS);
      } else surface.setMessage(explain || controller.status);
    }
    ctx.renderer.requestRender();
  }

  function activate(row: Row) {
    if (controller.mode === "alternatives" && row.uri) void controller.choose(row.uri);
    else if (controller.mode === "search" && row.uri) controller.addSeed({ uri: row.uri, title: row.title.replace(/^\+ /, ""), artists: row.subtitle ? row.subtitle.split(/\s*[,·]\s*/) : [] });
    else if (controller.mode === "draft") { const slot = row.meta?.slot; if (typeof slot === "number") void controller.play(slot); }
  }

  function editCurve(curve: typeof controller.recipe.curve) { controller.edit({ curve, preset: null }, "curve edit"); }

  function finishEditing() { editing = false; controller.endBurst(); render(); }

  function editKey(key: ScreenKey, name: string): boolean {
    const recipe = controller.recipe;
    const sequence = key.sequence ?? "";
    if (name === "escape" || name === "return" || name === "enter" || name === "e") { finishEditing(); return true; }
    if ((name === "left" || name === "right") && key.shift) { editCurve(slidePoint(recipe.curve, point, name === "right" ? 0.05 : -0.05)); return true; }
    if (name === "left" || name === "right") { point = Math.max(0, Math.min(recipe.curve.length - 1, point + (name === "right" ? 1 : -1))); render(); return true; }
    if (name === "up" || name === "down") { editCurve(adjustPoint(recipe.curve, point, name === "up" ? 0.1 : -0.1)); return true; }
    const level = digitLevel(sequence);
    if (level !== null) { editCurve(setPoint(recipe.curve, point, level)); return true; }
    if (name === "n") { const added = insertPoint(recipe.curve, point); point = added.index; editCurve(added.curve); return true; }
    if (name === "d" || name === "delete") { const removed = removePoint(recipe.curve, point); point = removed.index; editCurve(removed.curve); return true; }
    return true; // Keep edit mode modal so stray letters do not change the arc.
  }

  function promptSave(asNew: boolean) {
    if (!controller.draft?.slots.length) { surface.setMessage("Build an arc before saving it", true); return; }
    const title = controller.seeds()[0]?.title;
    const fallback = title ? `${title} arc` : "Resonance arc";
    const update = !asNew && !!controller.draft.playlist_id;
    const label = asNew ? "Save as a new private playlist named"
      : update ? (controller.savedName ? `Update "${controller.savedName}" (rename here)` : "Update the saved playlist (name)")
      : "Save as a private playlist named";
    surface.prompt(label, update ? controller.savedName ?? fallback : fallback, value => { if (value.trim()) void controller.save(value.trim(), asNew); });
  }

  /** Keys while picking a swap, a search result, or a starting song. */
  function pickKey(key: ScreenKey, name: string): boolean {
    const row = surface.selected();
    if (name === "escape" || (name === "backspace" && controller.mode !== "seeds")) { controller.back(); return true; }
    if (name === "a" && row?.uri && controller.mode !== "seeds") { void controller.listen(row.uri, row.title.replace(/^[↻+] /, "")); return true; }
    if (controller.mode === "seeds") {
      if ((name === "x" || name === "delete" || name === "backspace") && row?.uri) { controller.removeSeedAt(row.uri); return true; }
      if (name === "c") { controller.addCurrentSeed(); return true; }
      if (name === "/") { searchPrompt(); return true; }
      if (name === "return" || name === "enter") return true;
    }
    if (name === "return" || name === "enter") { if (row) activate(row); return true; }
    const moved = surface.handleKey(key);
    if (moved) render();
    return moved;
  }

  function searchPrompt() {
    if (controller.mode === "draft") returnTo = surface.selected()?.id;
    surface.prompt("Search for a starting song", "", value => { if (value.trim()) void controller.search(value.trim()); });
  }

  const handleKey = (key: ScreenKey) => {
    if (surface.editing()) return surface.handleKey(key);
    if (key.ctrl) return false;
    const name = (key.name ?? key.sequence ?? "").toLowerCase();
    const sequence = key.sequence ?? "";
    if (editing) return editKey(key, name);
    if (key.meta) return false;
    if (controller.audition) {
      // Esc ends an audition before it leaves anything; changing the arc ends it too.
      if (name === "escape") { void controller.stopListening(); return true; }
      if (!LOOKING.has(name)) void controller.stopListening();
    }
    if (controller.mode !== "draft") return pickKey(key, name);
    const recipe = controller.recipe;
    const slot = selectedSlot();
    if ((name === "up" || name === "down") && key.shift) { if (slot) void controller.move(slot.slot, name === "up" ? -1 : 1); return true; }
    if (sequence === "<" || sequence === ">") { if (slot) void controller.move(slot.slot, sequence === "<" ? -1 : 1); return true; }
    if (sequence === "Z") { void controller.redo(); return true; }
    if (sequence === "S") { promptSave(true); return true; }
    switch (name) {
      case "return": case "enter": { const row = surface.selected(); if (row) activate(row); else void controller.build(); return true; }
      case "left": case "right": {
        const preset = nextPreset(controller.presets, recipe.preset, name === "right" ? 1 : -1);
        point = Math.min(point, preset.curve.length - 1);
        controller.edit({ curve: preset.curve.map(p => ({ ...p })), preset: preset.id }, "shape change");
        return true;
      }
      case "e": editing = true; controller.holdBurst = true; point = Math.min(point, recipe.curve.length - 1); render(); return true;
      case "-": case "_": controller.edit({ length: adjustLength(recipe.length, -1) }, "length change"); return true;
      case "+": case "=": controller.edit({ length: adjustLength(recipe.length, 1) }, "length change"); return true;
      case "m": controller.edit({ length: toggleLength(recipe.length, controller.draft) }, "length change"); return true;
      case "[": case "]": controller.edit({ discovery: Math.max(0, Math.min(100, recipe.discovery + (name === "]" ? 10 : -10))) }, "mix change"); return true;
      case "g": controller.remix(); return true;
      case "u": void controller.build(); return true;
      case "c": void controller.useCurrent(); return true;
      case "f": controller.showSeeds(); return true;
      case "z": void controller.undo(); return true;
      case "/": searchPrompt(); return true;
      case "backspace": case "delete": controller.removeSeed(); return true;
      case "p": void controller.play(null); return true;
      case "a": if (slot) void controller.listen(slot.uri, slot.title); return true;
      case "r": if (slot) { returnTo = `slot-${slot.slot}`; void controller.reroll(slot.slot); } return true;
      case "k": if (slot) void controller.pin(slot.slot); return true;
      case "x": if (slot) void controller.ban(slot.slot); return true;
      case "i": detail = !detail; render(); return true;
      case "s": promptSave(false); return true;
      case "escape": return false;
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
