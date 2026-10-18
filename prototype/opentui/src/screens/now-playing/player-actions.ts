import { formatTime, type ParsedStatus } from "../../status.js";
import type { Params, ScreenContext } from "../../workspace/contracts.js";

/** What Now Playing knows beyond the status stream: repeat, shuffle and which items are saved. */
export interface PlayerState { repeat: string; shuffle: boolean | undefined; saved: Set<string> }

export interface ActionHost {
  status(): ParsedStatus | null;
  uri(): string | undefined;
  position(): number;
  disposed(): boolean;
  notice(message: string): void;
  /** Start a button's press animation before the engine answers. */
  pulse(feedback: string): void;
  /** Repaint after the engine accepted a change. */
  applied(): void;
}

/** Now Playing's engine commands. One runs at a time; each reports its outcome as a notice. */
export function createPlayerActions(ctx: ScreenContext, host: ActionHost, state: PlayerState) {
  let pending = false;
  async function mutate(method: string, params: Params, message: string, acknowledged?: () => void, feedback?: string) {
    if (pending || host.disposed()) return;
    pending = true;
    if (feedback && !ctx.reducedMotion()) host.pulse(feedback);
    try { await ctx.api.call(method, params); if (!host.disposed()) { acknowledged?.(); host.notice(message); host.applied(); } }
    catch (error) { host.notice(`Unable to apply: ${error instanceof Error ? error.message : String(error)}`); }
    finally { pending = false; }
  }
  function player(action: string, message: string, value?: unknown, acknowledged?: () => void) { return mutate("player.action", { action, ...(value === undefined ? {} : { value }) }, message, acknowledged, action === "play_pause" ? "play" : undefined); }
  function seek(delta: number) {
    const playable = host.status()?.playable;
    if (!playable) { host.notice("Choose a track or episode before seeking"); return; }
    const target = Math.max(0, Math.min(playable.duration, host.position() + delta));
    return player("seek", `Seeked to ${formatTime(target)}`, Math.round(target));
  }
  function changeVolume(delta: number) {
    const prototype = host.status()?.prototype;
    if (!prototype) { host.notice("Volume is unavailable until playback status arrives"); return; }
    const value = Math.max(0, Math.min(100, prototype.volume_percent + delta));
    return player("volume", `Volume set to ${value}%`, value);
  }
  function cycleRepeat() { const value = state.repeat === "off" || state.repeat === "unknown" ? "all" : state.repeat === "all" ? "track" : "off"; return player("repeat", `Repeat ${value}`, value, () => { state.repeat = value; }); }
  function toggleShuffle() { const value = !state.shuffle; return player("shuffle", `Shuffle ${value ? "on" : "off"}`, value, () => { state.shuffle = value; }); }
  function toggleSaved() {
    const identity = host.uri(); if (!identity) { host.notice("Choose an item before saving"); return; }
    const value = !state.saved.has(identity);
    return mutate("library.action", { action: value ? "save" : "unsave", kind: host.status()?.playable?.type === "Episode" ? "episode" : "track", uri: identity }, value ? "Saved to your library" : "Removed from your library", () => { value ? state.saved.add(identity) : state.saved.delete(identity); }, "save");
  }
  function startRadio() {
    const identity = host.uri(); if (!identity || host.status()?.playable?.type === "Episode") { host.notice("Choose a track to start radio"); return; }
    return mutate("radio.action", { action: "start", uri: identity }, "Radio started from this track", undefined, "radio");
  }
  async function shareCurrent() {
    const identity = host.uri(); if (!identity) { host.notice("Choose an item before sharing"); return; }
    if (host.disposed() || pending) return;
    pending = true;
    try { const result = await ctx.api.call<{ url: string }>("share", { uri: identity }); if (typeof result.url !== "string" || !result.url) throw new Error("Share link unavailable"); if (!host.disposed()) host.notice(result.url); }
    catch (error) { host.notice(`Unable to share: ${error instanceof Error ? error.message : String(error)}`); }
    finally { pending = false; }
  }
  return { player, seek, changeVolume, cycleRepeat, toggleShuffle, toggleSaved, startRadio, shareCurrent };
}
