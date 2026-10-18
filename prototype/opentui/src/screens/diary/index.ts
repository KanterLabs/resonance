import { BoxRenderable, RGBA, StyledText, TextAttributes, TextRenderable, type TextChunk } from "@opentui/core";
import { blendHex } from "../now-playing/motion-colors.js";
import { paletteForTheme, type ThemePalette } from "../../theme.js";
import type { ScreenFactory } from "../../workspace/contracts.js";
import { calendarGrid, formatMinutes, intensityScale, monthName, type Calendar } from "./model.js";

const LINES = 24;
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

/** A year of listening as a heatmap, and this month's most played artists. */
export const createDiaryScreen: ScreenFactory = (ctx) => {
  let palette: Readonly<ThemePalette> = paletteForTheme(ctx.theme());
  let calendar: Calendar | null = null;
  let message = "Loading your listening diary…";
  let failed = false, disposed = false, generation = 0;
  const root = new BoxRenderable(ctx.renderer, { id: "diary", width: "100%", height: "100%", minWidth: 0, minHeight: 0, flexDirection: "column", border: true, borderStyle: "rounded", paddingX: 1, backgroundColor: palette.panel, borderColor: palette.border });
  const heading = new TextRenderable(ctx.renderer, { id: "diary-heading", content: "Listening diary", height: 1, flexShrink: 0, truncate: true, selectable: false, attributes: TextAttributes.BOLD });
  const hint = new TextRenderable(ctx.renderer, { id: "diary-hint", content: "A year of listening, one square a day • r refresh", height: 1, flexShrink: 0, truncate: true, selectable: false });
  root.add(heading); root.add(hint);
  const lines = Array.from({ length: LINES }, (_, index) => {
    const node = new TextRenderable(ctx.renderer, { id: `diary-line-${index}`, content: "", height: 1, flexShrink: 0, truncate: true, wrapMode: "none", selectable: false });
    root.add(node); return node;
  });
  const chunk = (text: string, fg: string): TextChunk => ({ __isChunk: true, text, fg: RGBA.fromHex(fg), bg: RGBA.fromHex(palette.panel) });

  function paint() {
    if (disposed) return;
    root.backgroundColor = palette.panel; root.borderColor = palette.border;
    heading.fg = palette.text; heading.bg = palette.panel; hint.fg = palette.muted; hint.bg = palette.panel;
    const out: StyledText[] = [];
    if (!calendar) out.push(new StyledText([chunk(message, failed ? palette.red : palette.muted)]));
    else {
      const width = Math.max(30, (root.width > 0 ? root.width : ctx.renderer.width - 4) - 4);
      const weeks = Math.max(8, Math.min(53, Math.floor((width - 5) / 2)));
      const grid = calendarGrid(calendar, weeks), level = intensityScale(grid);
      const shades = [palette.progressTrack, ...[0.3, 0.55, 0.8, 1].map(amount => blendHex(palette.progressTrack, palette.accent, amount))];
      out.push(new StyledText([
        chunk(`${grid.total.plays.toLocaleString()} plays`, palette.text),
        chunk(` · ${formatMinutes(grid.total.minutes)} over ${grid.total.days} days in the last ${weeks} weeks`, palette.muted),
      ]));
      out.push(new StyledText([]));
      // Month names sit over the week each month starts in.
      let header = "     ";
      for (const month of grid.months) {
        const column = 5 + month.week * 2;
        if (column >= header.length) header = header.padEnd(column) + month.label;
      }
      out.push(new StyledText([chunk(header.slice(0, 5 + weeks * 2), palette.dim)]));
      grid.cells.forEach((row, day) => {
        out.push(new StyledText([chunk(WEEKDAYS[day]!.padEnd(5), palette.dim), ...row.map(minutes => chunk(minutes === null ? "  " : "■ ", shades[level(minutes)]!))]));
      });
      out.push(new StyledText([chunk("     less ", palette.dim), ...shades.map(shade => chunk("■ ", shade)), chunk("more", palette.dim)]));
      out.push(new StyledText([]));
      out.push(new StyledText([
        chunk(monthName(calendar.month), palette.text),
        chunk(` · ${formatMinutes(calendar.month_minutes)} · ${calendar.month_plays.toLocaleString()} plays`, palette.muted),
      ]));
      const artists = calendar.top_artists.slice(0, Math.max(0, LINES - out.length));
      const top = Math.max(1, ...artists.map(artist => artist.minutes));
      const nameWidth = Math.min(24, Math.max(8, ...artists.map(artist => [...artist.name].length)));
      const barWidth = Math.max(6, Math.min(30, width - nameWidth - 12));
      artists.forEach((artist, index) => {
        const name = [...artist.name].length > nameWidth ? `${[...artist.name].slice(0, nameWidth - 1).join("")}…` : artist.name.padEnd(nameWidth);
        const filled = Math.max(1, Math.round(barWidth * artist.minutes / top));
        out.push(new StyledText([
          chunk(`${String(index + 1).padStart(2)}  `, palette.dim), chunk(`${name}  `, index === 0 ? palette.text : palette.muted),
          chunk("█".repeat(filled), index === 0 ? palette.accentBright : palette.accent), chunk(`  ${formatMinutes(artist.minutes)}`, palette.dim),
        ]));
      });
      if (!artists.length) out.push(new StyledText([chunk("Nothing played yet this month.", palette.muted)]));
    }
    lines.forEach((node, index) => { node.content = out[index] ?? ""; node.bg = palette.panel; });
  }
  async function refresh() {
    const current = ++generation;
    message = "Loading your listening diary…"; failed = false; if (!calendar) paint();
    try {
      const value = await ctx.api.call<Calendar>("listening.calendar", { days: 371 });
      if (disposed || current !== generation) return;
      calendar = value && Array.isArray(value.days) ? value : null;
      if (!calendar) { message = "The engine sent an unreadable diary."; failed = true; }
    } catch (error) {
      if (disposed || current !== generation) return;
      message = `Diary unavailable: ${error instanceof Error ? error.message : String(error)} • r retry`; failed = true;
    }
    paint();
  }
  const onResize = () => paint();
  ctx.renderer.on("resize", onResize);
  paint(); void refresh();
  return {
    root, title: "Diary",
    handleKey(key) {
      if (key.ctrl || key.meta) return false;
      if (key.name?.toLowerCase() === "r") { void refresh(); return true; }
      return false;
    },
    refresh,
    setTheme(theme) { palette = paletteForTheme(theme); paint(); },
    dispose() { if (disposed) return; disposed = true; ctx.renderer.off("resize", onResize); root.destroyRecursively(); },
  };
};
