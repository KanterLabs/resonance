import { RGBA, StyledText, type TextChunk } from "@opentui/core";

export interface CrateRecord { title: string; artists: string[]; color: string | null }
export interface CrateColors { text: string; muted: string; dim: string; empty: string; background: string }

/** The average of a cover's pixels, for colouring its spine. */
export function coverColor(pixels: readonly string[]): string | null {
  const valid = pixels.filter(pixel => /^#[0-9a-f]{6}$/i.test(pixel));
  if (!valid.length) return null;
  const sum = [0, 0, 0];
  for (const pixel of valid) for (let channel = 0; channel < 3; channel++) sum[channel]! += parseInt(pixel.slice(1 + channel * 2, 3 + channel * 2), 16);
  return `#${sum.map(total => Math.round(total / valid.length).toString(16).padStart(2, "0")).join("")}`;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  const characters = [...text];
  return characters.length <= width ? text : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/**
 * The queue as a crate of records seen from above: each record shows its
 * spine in its cover's colour. The playing record is pulled forward, out of
 * line with the rest, so the eye finds it first.
 */
export function crateLines(playing: CrateRecord | null, upcoming: readonly CrateRecord[], width: number, rows: number, colors: CrateColors): StyledText[] {
  const chunk = (text: string, fg: string, bg = colors.background): TextChunk => ({ __isChunk: true, text, fg: RGBA.fromHex(fg), bg: RGBA.fromHex(bg) });
  const record = (item: CrateRecord, forward: boolean) => {
    const spine = item.color ?? colors.empty;
    const lead = forward ? "" : " ";
    const room = Math.max(4, width - lead.length - 5);
    const artist = item.artists.length ? ` · ${item.artists.join(", ")}` : "";
    const title = clip(item.title, room);
    const rest = clip(artist, Math.max(0, room - [...title].length));
    return new StyledText([
      chunk(lead, colors.text),
      chunk(forward ? "████" : "███", spine),
      chunk(forward ? " " : "  ", colors.text),
      chunk(title, forward ? colors.text : colors.muted),
      chunk(rest, colors.dim),
    ]);
  };
  const lines: StyledText[] = [new StyledText([chunk("IN THE CRATE", colors.dim)])];
  if (playing) lines.push(record(playing, true));
  for (const item of upcoming) {
    if (lines.length >= rows) break;
    lines.push(record(item, false));
  }
  if (!upcoming.length && lines.length < rows) lines.push(new StyledText([chunk(" nothing queued", colors.dim)]));
  return lines.slice(0, rows);
}
