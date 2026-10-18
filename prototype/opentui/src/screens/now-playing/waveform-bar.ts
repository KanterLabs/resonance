import { RGBA, StyledText, type TextChunk } from "@opentui/core";

const EIGHTHS = " ▁▂▃▄▅▆▇█";

export interface WaveformColors { played: string; playhead: string; ahead: string; unheard: string; background: string }

/**
 * Fold a song map's loudness lane into `width` columns, each 0..1 against the
 * song's own loudest moment, or null where no part of the column was heard.
 */
export function waveformColumns(levels: ReadonlyArray<number | null>, width: number): Array<number | null> {
  const peak = levels.reduce<number>((max, value) => value !== null && value > max ? value : max, 0);
  return Array.from({ length: width }, (_, column) => {
    const from = Math.floor(column * levels.length / width), to = Math.max(from + 1, Math.floor((column + 1) * levels.length / width));
    let best: number | null = null;
    for (let index = from; index < to && index < levels.length; index++) {
      const value = levels[index];
      if (value !== null && value !== undefined && (best === null || value > best)) best = value;
    }
    return best === null ? null : peak > 0 ? best / peak : 0;
  });
}

/**
 * A two-row progress bar drawn as the song's own loudness: played columns in
 * the deck's orange, the rest quieter, unheard stretches as a flat baseline.
 */
export function waveformBar(columns: ReadonlyArray<number | null>, progress: number, colors: WaveformColors): [StyledText, StyledText] {
  const head = Math.min(columns.length - 1, Math.max(0, Math.floor(progress * columns.length)));
  const top: TextChunk[] = [], bottom: TextChunk[] = [];
  const push = (chunks: TextChunk[], text: string, fg: string) => {
    const last = chunks.at(-1);
    if (last && last.fg && (last as { hex?: string }).hex === fg) { last.text += text; return; }
    chunks.push({ __isChunk: true, text, fg: RGBA.fromHex(fg), bg: RGBA.fromHex(colors.background), hex: fg } as TextChunk & { hex: string });
  };
  columns.forEach((value, column) => {
    const fg = column === head ? colors.playhead : column < head ? colors.played : value === null ? colors.unheard : colors.ahead;
    if (value === null) { push(top, " ", fg); push(bottom, column === head ? "▲" : "▁", fg); return; }
    const eighths = Math.max(1, Math.round(value * 16));
    push(top, EIGHTHS[Math.max(0, eighths - 8)]!, fg);
    push(bottom, EIGHTHS[Math.min(8, eighths)]!, fg);
  });
  const clean = (chunks: TextChunk[]) => new StyledText(chunks.map(({ __isChunk, text, fg, bg }) => ({ __isChunk, text, fg, bg })));
  return [clean(top), clean(bottom)];
}
