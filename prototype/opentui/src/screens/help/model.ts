import type { Row } from "../../workspace/contracts.js";

export const GLOBAL_SHORTCUTS = [
  ["1", "Now Playing"], ["2", "Queue"], ["3", "Library"], ["4", "Search"],
  ["5", "Playlists"], ["6", "Podcasts"], ["7", "Radio"], ["8", "Settings"],
  ["9", "Cast"], ["0", "Arcs playlist builder"], ["b", "Browse"], ["h", "Listening diary"], ["?", "Help"], [":", "Command palette"],
] as const;

export function helpRows(bindings: Record<string, string>): Row[] {
  return [
    { id: "command", kind: "action", title: "Run Resonance command", subtitle: ": or Enter · existing CLI commands and aliases" },
    ...GLOBAL_SHORTCUTS.map(([key, title]) => ({ id: `global:${key}`, kind: "shortcut", title: `${key}  ${title}`, subtitle: "Workspace shortcut" })),
    { id: "arc", kind: "shortcut", title: "0  Arc Studio: playlists shaped like a mood", subtitle: "Builds from the playing song · ↑↓ pick · ⏎ play from here · ←→ shape · −/+ length · [/] mix · r swap · k keep · x remove · g remix · e edit curve · s save" },
    { id: "now-playing-style", kind: "shortcut", title: "v  Turntable or classic Now Playing", subtitle: "The choice is remembered · click the deck to play or pause" },
    { id: "quick-search", kind: "shortcut", title: "/  Quick search in Now Playing", subtitle: "Type a song · ↑/↓ select · Enter play now · Ctrl+N play next · Ctrl+E queue · Esc close" },
    { id: "playback", kind: "shortcut", title: "Global playback controls (outside text inputs)", subtitle: "Ctrl+← previous/restart · Ctrl+→ next · Ctrl+↑/↓ volume ±5% · Alt+←/→ seek ±10s · Ctrl+Z undo last skip" },
    ...Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)).map(([key, command]) => ({ id: `binding:${key}`, kind: "binding", title: key, subtitle: command })),
  ];
}
