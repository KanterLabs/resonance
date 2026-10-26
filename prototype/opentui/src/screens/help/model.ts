import type { Row } from "../../workspace/contracts.js";

export const GLOBAL_SHORTCUTS = [
  ["1", "Now Playing"], ["2", "Queue"], ["3", "Library"], ["4", "Search"],
  ["5", "Playlists"], ["6", "Podcasts"], ["7", "Radio"], ["8", "Settings"],
  ["9", "Cast"], ["0", "Arcs playlist builder"], ["b", "Browse"], ["h", "Listening diary"], ["?", "Help"], [":", "Command palette"],
] as const;

/** Every Arc Studio key. The studio's own legend shows only the most used. */
export const ARC_STUDIO_KEYS = [
  ["arc", "0  Arc Studio: playlists shaped like a mood", "Builds from the playing song · Esc back to Now Playing"],
  ["arc-tracks", "Arc Studio · tracks", "↑↓ pick · ⏎ play from here · p play all · r swap · k keep · x remove · ⇧↑↓ or < > move · a audition · i score details"],
  ["arc-undo", "Arc Studio · undo and save", "z undo · Z redo · s save or update · S save as a new playlist"],
  ["arc-shape", "Arc Studio · shape", "←→ shape · e edit curve · −/+ length · m tracks or minutes · [/] familiar or new · g remix · u use new measurements"],
  ["arc-seeds", "Arc Studio · starting songs", "/ add a song · f list starting songs (x removes one) · c start over from the playing song · ⌫ drop the last"],
  ["arc-curve", "Arc Studio · editing the curve", "←→ choose point · ↑↓ raise/lower · 1–9 sets 10–90%, 0 sets 100% · ⇧←→ slide · n add point · d delete point · ⏎/Esc done"],
  ["arc-swap", "Arc Studio · swapping a track", "↑↓ pick · a audition · ⏎ use it, kept in place · Esc keep the current track"],
] as const;

export function helpRows(bindings: Record<string, string>): Row[] {
  return [
    { id: "command", kind: "action", title: "Run Resonance command", subtitle: ": or Enter · existing CLI commands and aliases" },
    ...GLOBAL_SHORTCUTS.map(([key, title]) => ({ id: `global:${key}`, kind: "shortcut", title: `${key}  ${title}`, subtitle: "Workspace shortcut" })),
    ...ARC_STUDIO_KEYS.map(([id, title, subtitle]) => ({ id, kind: "shortcut", title, subtitle })),
    { id: "now-playing-style", kind: "shortcut", title: "v  Turntable or classic Now Playing", subtitle: "The choice is remembered · click the deck to play or pause" },
    { id: "quick-search", kind: "shortcut", title: "/  Quick search in Now Playing", subtitle: "Type a song · ↑/↓ select · Enter play now · Ctrl+N play next · Ctrl+E queue · Esc close" },
    { id: "add-to-playlist", kind: "shortcut", title: "p  Add the playing song to a playlist", subtitle: "From Now Playing · type to filter or name a new playlist · ↑/↓ select · Enter add · Esc close" },
    { id: "playback", kind: "shortcut", title: "Global playback controls (outside text inputs)", subtitle: "Ctrl+← previous/restart · Ctrl+→ next · Ctrl+↑/↓ volume ±5% · Alt+←/→ seek ±10s · Ctrl+Z undo last skip" },
    ...Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)).map(([key, command]) => ({ id: `binding:${key}`, kind: "binding", title: key, subtitle: command })),
  ];
}
