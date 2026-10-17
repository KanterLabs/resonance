import type { Route, ScreenKey } from "./contracts.js";

export const WORKSPACE_BINDINGS: Record<string, string> = {
  "1": "focus now-playing", "2": "focus queue", "3": "focus library", "4": "focus search",
  "5": "focus playlists", "6": "focus podcasts", "7": "focus radio", "8": "focus settings",
  "9": "focus cast", "0": "focus arcs", b: "focus browse", "?": "help", ":": "command palette",
  Space: "playpause", "Ctrl+Right": "next", "Ctrl+Left": "previous or restart",
  "Ctrl+Up": "volume +5%", "Ctrl+Down": "volume -5%", "Alt+Left": "seek -10s", "Alt+Right": "seek +10s", "Ctrl+z": "undo skip",
  "Shift+r": "radio", l: "toggle appearance", q: "quit", "Ctrl+c": "quit",
};
export const PLAYBACK_SHORTCUTS: Record<string, { action: string; value?: number }> = {
  "Ctrl+Right": { action: "next" }, "Ctrl+Left": { action: "previous_or_restart" },
  "Ctrl+Up": { action: "volume_relative", value: 5 }, "Ctrl+Down": { action: "volume_relative", value: -5 },
  "Alt+Left": { action: "seek_relative", value: -10_000 }, "Alt+Right": { action: "seek_relative", value: 10_000 },
  "Ctrl+z": { action: "undo_skip" },
};
export function keyBindingName(key: ScreenKey): string {
  const name = (key.name ?? key.sequence ?? "").toLowerCase();
  const aliases: Record<string, string> = { space: "Space", " ": "Space", return: "Enter", enter: "Enter", escape: "Esc", up: "Up", down: "Down", left: "Left", right: "Right", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End", backspace: "Backspace", delete: "Delete", tab: "Tab" };
  const base = aliases[name] ?? (/^f\d+$/.test(name) ? name.toUpperCase() : name);
  return `${key.ctrl ? "Ctrl+" : ""}${key.meta ? "Alt+" : ""}${key.shift ? "Shift+" : ""}${key.super ? "Super+" : ""}${key.hyper ? "Hyper+" : ""}${base}`;
}
export function routeForCommand(command: string): { route: Route; params?: Record<string, unknown> } | null {
  const trimmed = command.trim();
  if (trimmed === "help") return { route: "help" };
  if (trimmed === "prototype" || trimmed === "nowplaying") return { route: "now-playing" };
  if (trimmed === "arc" || trimmed === "arc current") return { route: "arcs", params: { fromCurrent: true } };
  if (trimmed === "arcs") return { route: "arcs" };
  const targets: Record<string, Route> = { playing: "now-playing", nowplaying: "now-playing", "now-playing": "now-playing", queue: "queue", library: "library", search: "search", browse: "browse", playlists: "playlists", podcasts: "podcasts", radio: "radio", arcs: "arcs", arc: "arcs", settings: "settings", cast: "cast", help: "help" };
  const focus = /^focus\s+(\S+)$/.exec(trimmed);
  if (focus && targets[focus[1]!]) return { route: targets[focus[1]!] };
  const search = /^search\s+(.+)$/.exec(trimmed);
  if (search) return { route: "search", params: { query: search[1] } };
  return null;
}
