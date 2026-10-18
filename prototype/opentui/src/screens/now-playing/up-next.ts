import { BoxRenderable, MouseButton, RGBA, StyledText } from "@opentui/core";
import { formatTime, type ParsedStatus } from "../../status.js";
import type { ThemePalette } from "../../theme.js";
import type { ScreenContext } from "../../workspace/contracts.js";
import { blendHex } from "./motion-colors.js";
import { queueKeys, type PlayerMotion } from "./motion.js";
import type { Toned } from "./toned.js";

export interface UpNextView { status: ParsedStatus | null; colors: Readonly<ThemePalette>; motion: PlayerMotion; now: number; reduced: boolean }

/** The classic player's Up Next card: the next fifteen songs, sliding up as each one starts, or a radio prompt when empty. */
export function createUpNext(ctx: ScreenContext, ui: Toned, actions: { startRadio(): void }) {
  const { text, row, button } = ui;
  const root = new BoxRenderable(ctx.renderer, { id: "np-up-next-card", height: 24, width: 42, flexGrow: 1, minWidth: 0, border: true, borderStyle: "rounded", paddingX: 2, paddingY: 1, flexDirection: "column" });
  const queueHeading = row(root, "np-queue-heading", 2, { justifyContent: "space-between" });
  text(queueHeading, "queue-label", "UP NEXT", { width: 12 }, "dim");
  button(queueHeading, "open-queue", "Queue →", 9, () => ctx.navigate("queue"));
  const queueBody = new BoxRenderable(ctx.renderer, { id: "np-queue-body", flexGrow: 1, minHeight: 0, flexDirection: "column", gap: 0, overflow: "hidden" }); root.add(queueBody);
  const queueItems = Array.from({ length: 15 }, (_, index) => {
    const item = new BoxRenderable(ctx.renderer, { id: `np-up-next-${index}`, height: 1, width: "100%", flexShrink: 0, flexDirection: "row", gap: 1, onMouseDown: event => { if (event.button === MouseButton.LEFT) ctx.navigate("queue"); } });
    queueBody.add(item);
    const number = text(item, `queue-number-${index}`, String(index + 1).padStart(2, "0"), { width: 2 }, "dim");
    return { root: item, number, title: text(item, `queue-title-${index}`, "", { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }), duration: text(item, `queue-duration-${index}`, "", { width: 5, textAlign: "right" }, "muted") };
  });
  const leavingRow = new BoxRenderable(ctx.renderer, { id: "np-queue-leaving", position: "absolute", top: 0, left: 0, height: 1, width: "100%", visible: false, flexDirection: "row", gap: 1 }); queueBody.add(leavingRow);
  const leavingNumber = text(leavingRow, "leaving-number", "01", { width: 2 }, "accent");
  const leavingTitle = text(leavingRow, "leaving-title", "", { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }, "accentBright");
  const leavingDuration = text(leavingRow, "leaving-duration", "", { width: 5, textAlign: "right" }, "muted");
  const queueEmpty = text(queueBody, "queue-empty", "Nothing queued yet", { width: "100%", height: 4 }, "muted");
  const emptyRadio = new BoxRenderable(ctx.renderer, { id: "np-empty-radio", width: "100%", height: 3, border: true, borderStyle: "rounded", alignItems: "center", justifyContent: "center", onMouseDown: event => { if (event.button === MouseButton.LEFT) { actions.startRadio(); event.preventDefault(); } } });
  queueBody.add(emptyRadio);
  text(emptyRadio, "empty-radio-label", "✧ Start radio · Shift+R", { width: "100%", textAlign: "center" }, "accentBright", "cover");
  const queueFoot = text(root, "queue-foot", "", { width: "100%", height: 2 }, "dim");

  function paint({ status, colors, motion, now, reduced }: UpNextView) {
    const p = status?.playable ?? null;
    const radioPulse = reduced ? 0 : motion.button("radio", now);
    emptyRadio.borderColor = blendHex(colors.coverBorder, colors.accent, radioPulse);
    const upNext = status?.prototype?.up_next ?? [];
    const keys = queueKeys(upNext);
    queueItems.forEach((item, index) => {
      const track = upNext[index]; item.root.visible = !!track;
      // Native terminal positions are integers; round explicitly so the first
      // frames retain the previous row position before moving up one cell.
      item.root.translateY = reduced ? 0 : Math.round(motion.queueOffset(now));
      item.root.opacity = reduced ? 1 : 1 - motion.queueOffset(now) * 0.25;
      if (track) {
        const highlight = reduced ? 0 : motion.refill(keys[index]!, now);
        const background = blendHex(colors.panel, colors.cover, highlight * 0.8);
        item.root.backgroundColor = background;
        item.number.bg = item.duration.bg = background;
        item.number.fg = blendHex(colors.dim, colors.accent, highlight);
        item.title.content = new StyledText([
          { __isChunk: true, text: track.title, fg: RGBA.fromHex(colors.text), bg: RGBA.fromHex(background) },
          { __isChunk: true, text: track.artists.length ? ` · ${track.artists.join(" · ")}` : "", fg: RGBA.fromHex(colors.muted), bg: RGBA.fromHex(background) },
        ]);
        item.duration.content = formatTime(track.duration);
      }
    });
    const offset = reduced ? 0 : motion.queueOffset(now);
    leavingRow.visible = !!motion.departing && offset > 0;
    if (motion.departing && leavingRow.visible) {
      const background = blendHex(colors.panel, colors.cover, offset * 0.75);
      leavingRow.backgroundColor = background; leavingRow.opacity = offset;
      for (const node of [leavingNumber, leavingTitle, leavingDuration]) node.bg = background;
      leavingTitle.content = motion.departing.title; leavingDuration.content = formatTime(motion.departing.duration);
    }
    queueEmpty.visible = !upNext.length;
    queueEmpty.content = status?.prototype?.radio_active ? "Finding fresh tracks…\n\nYour radio station is active." : "Nothing queued yet\n\nStart radio from this song\nto keep the music going.";
    emptyRadio.visible = !upNext.length && !!p && p.type !== "Episode" && !status?.prototype?.radio_active;
    const upcoming = `${Math.min(15, upNext.length)}${upNext.length > 15 ? "+" : ""} upcoming · 2 open queue`;
    queueFoot.content = status?.prototype?.radio_active ? `✧ Continuous radio\n${upNext.length ? upcoming : "Finding fresh tracks…"}` : upNext.length ? upcoming : "✧ Shift+R starts radio";
  }
  function recolor(colors: Readonly<ThemePalette>) {
    root.backgroundColor = colors.panel; root.borderColor = colors.border;
    emptyRadio.backgroundColor = colors.cover; emptyRadio.borderColor = colors.coverBorder;
  }
  return { root, paint, recolor };
}
