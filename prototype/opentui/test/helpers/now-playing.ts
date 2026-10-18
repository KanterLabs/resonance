import { createTestRenderer } from "@opentui/core/testing";
import { createNowPlayingScreen, type Artwork } from "../../src/screens/now-playing/index.js";
import { demoStatus, type ParsedStatus } from "../../src/status.js";
import type { NowPlayingStyle, ScreenContext, Params } from "../../src/workspace/contracts.js";

/** Shared fixtures for the Now Playing tests: a test renderer, a scripted engine and demo statuses. */
export type ArtworkResolver = (params: Params) => Artwork | Promise<Artwork>;
export type RpcResponder = (method: string, params?: Params) => unknown | Promise<unknown>;

export interface FixtureOptions {
  width?: number;
  height?: number;
  status?: ParsedStatus;
  reducedMotion?: boolean;
  artwork?: ArtworkResolver;
  respond?: RpcResponder;
  nativeArtwork?: boolean | "sixel";
  /** Offer the Now Playing style preference, as the workspace does. */
  style?: NowPlayingStyle;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

export function trackStatus(index = 0, positionMs = 82_000): ParsedStatus {
  const status = demoStatus(index, positionMs);
  const playable = status.playable;
  if (playable) status.playable = { ...playable, uri: `spotify:track:demo${index + 1}` };
  return status;
}

export function unavailableArtwork(params: Params = {}): Artwork {
  return {
    available: false,
    uri: typeof params.uri === "string" ? params.uri : "",
    width: typeof params.width === "number" ? params.width : 20,
    height: typeof params.height === "number" ? params.height : 10,
  };
}

export function coloredArtwork(uri: string, width: number, height: number): Artwork {
  const pixels = Array.from({ length: width * height * 2 }, (_, index) => {
    if (index < width) return "#112233";
    if (index < width * 2) return "#445566";
    return index % 2 === 0 ? "#778899" : "#aabbcc";
  });
  return { available: true, uri, width, height, pixels };
}

export async function settle(f: { renderOnce(): Promise<void> }) {
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.renderOnce();
}

export function nativeRgb(renderer: { currentRenderBuffer: { width: number; buffers: { fg: Uint16Array; bg: Uint16Array } } }, x: number, y: number, channel: "fg" | "bg") {
  const buffer = renderer.currentRenderBuffer;
  const values = buffer.buffers[channel];
  const offset = (y * buffer.width + x) * 4;
  return [values[offset]! & 0xff, values[offset + 1]! & 0xff, values[offset + 2]! & 0xff];
}

export function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "chunks" in value && Array.isArray((value as { chunks?: unknown }).chunks)) {
    return ((value as { chunks: Array<{ text?: unknown }> }).chunks).map(chunk => String(chunk.text ?? "")).join("");
  }
  return "";
}

export async function fixtureCtx(options: FixtureOptions = {}) {
  const setup = await createTestRenderer({ width: options.width ?? 96, height: options.height ?? 34, useMouse: true });
  if (options.nativeArtwork) Object.defineProperty(setup.renderer, "capabilities", { get: () => ({ kitty_graphics: options.nativeArtwork === true, sixel: options.nativeArtwork === "sixel", multiplexer: "none", image_protocol: "auto" }) });
  let status: ParsedStatus = options.status ?? trackStatus();
  let listener: ((s: ParsedStatus) => void) | undefined;
  const calls: { method: string; params?: Params }[] = [];
  const notices: string[] = [];
  let fail = false;
  let reduced = options.reducedMotion ?? true;
  let unsubscribed = false;
  let style = options.style;
  const styles: NowPlayingStyle[] = [];
  const ctx: ScreenContext = {
    renderer: setup.renderer,
    api: {
      async call<T>(method: string, params?: Params) {
        calls.push({ method, params });
        if (fail && method !== "player.artwork") throw new Error("engine offline");
        if (method === "player.artwork") return await (options.artwork?.(params ?? {}) ?? unavailableArtwork(params)) as T;
        if (options.respond) return await options.respond(method, params) as T;
        if (method === "player.status") return { repeat: "off", shuffle: false, saved: false, current: { uri: "spotify:track:demo1" } } as T;
        if (method === "share") return { url: "https://open.spotify.com/track/demo1" } as T;
        return { applied: true } as T;
      },
    },
    theme: () => "light",
    setTheme() {},
    reducedMotion: () => reduced,
    setReducedMotion(value) { reduced = value; },
    status: () => status,
    onStatus(value) { listener = value; return () => { listener = undefined; unsubscribed = true; }; },
    navigate() {},
    notify(message) { notices.push(message); },
    ...(style ? { nowPlayingStyle: () => style!, setNowPlayingStyle(value: NowPlayingStyle) { style = value; styles.push(value); } } : {}),
  };
  const screen = createNowPlayingScreen(ctx);
  setup.renderer.root.add(screen.root);
  return {
    ...setup,
    screen,
    calls,
    notices,
    styles,
    motion(value: boolean) { reduced = value; screen.refresh(); },
    update(value: ParsedStatus) { status = value; listener?.(value); },
    fail() { fail = true; },
    unsubscribed: () => unsubscribed,
    close() { screen.dispose(); setup.renderer.destroy(); },
  };
}

