import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mountWorkspace } from "../src/workspace/app.js";
import { DemoApi } from "../src/workspace/demo.js";
import type { Params, RpcApi } from "../src/workspace/contracts.js";
import type { AudioFrame } from "../src/status.js";

/** The demo engine, with every call recorded. */
function recorded(demo = new DemoApi()) {
  const calls: Array<{ method: string; params?: Params }> = [];
  const api: RpcApi = { call<T>(method: string, params?: Params) { calls.push({ method, params }); return demo.call<T>(method, params); } };
  return { demo, api, calls };
}
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test("the workspace keeps one audio feed open while anyone listens and fans frames out", async () => {
  const native = await createTestRenderer({ width: 100, height: 30 });
  const { api, calls } = recorded();
  const app = mountWorkspace(native.renderer, { api, theme: "dark", reducedMotion: true, nowPlayingStyle: "classic", idleAfterMs: 0 });
  try {
    const seen: number[] = [];
    const first = app.context.onAudio!(frame => seen.push(frame.level));
    const second = app.context.onAudio!(frame => seen.push(frame.level * 10));
    const frame: AudioFrame = { live: true, bands: [], level: 0.5, pulse: 0, beats: 1, tempo: 120 };
    app.setAudio(frame);
    expect(seen).toEqual([0.5, 5]);
    first(); second();
    await settle();
    expect(calls.filter(call => call.method.startsWith("audio.")).map(call => call.method)).toEqual(["audio.subscribe", "audio.unsubscribe"]);
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("the turntable opens the feed and asks for the song's shape", async () => {
  const native = await createTestRenderer({ width: 150, height: 40 });
  const { demo, api, calls } = recorded();
  const app = mountWorkspace(native.renderer, { api, theme: "light", reducedMotion: true, idleAfterMs: 0 });
  try {
    app.setStatus(demo.status);
    for (let i = 0; i < 3; i++) { await native.renderOnce(); await settle(5); }
    expect(native.renderer.root.findDescendantById("np-turntable")!.visible).toBe(true);
    expect(calls.some(call => call.method === "audio.subscribe")).toBe(true);
    expect(calls.some(call => call.method === "song.map" && call.params?.uri === demo.status.playable!.uri)).toBe(true);
    expect(calls.some(call => call.method === "artwork.cover")).toBe(true);
    app.navigate("queue");
    await settle();
    expect(calls.filter(call => call.method.startsWith("audio.")).map(call => call.method)).toEqual(["audio.subscribe", "audio.unsubscribe"]);
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("idle appears after quiet playback, and the waking key does nothing else", async () => {
  const native = await createTestRenderer({ width: 100, height: 34 });
  const { demo, api } = recorded();
  const app = mountWorkspace(native.renderer, { api, theme: "dark", reducedMotion: true, nowPlayingStyle: "classic", idleAfterMs: 1 });
  try {
    if (demo.status.mode.kind !== "playing") await demo.call("player.action", { action: "play_pause" });
    app.setStatus(demo.status);
    const idle = native.renderer.root.findDescendantById("idle")!;
    expect(idle.visible).toBe(false);
    await settle(1150);
    expect(idle.visible).toBe(true);
    await native.renderOnce();
    expect(native.captureCharFrame()).toContain("The Colour of Air");
    await native.mockInput.typeText("2");
    expect(idle.visible).toBe(false);
    expect(app.route).toBe("now-playing");
    await app.command("idle");
    expect(idle.visible).toBe(true);
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("the diary draws a year heatmap and this month's artists", async () => {
  const native = await createTestRenderer({ width: 120, height: 36 });
  const { api, calls } = recorded();
  const app = mountWorkspace(native.renderer, { api, theme: "dark", reducedMotion: true, idleAfterMs: 0 });
  try {
    await native.mockInput.typeText("h");
    expect(app.route).toBe("diary");
    await settle(); await native.renderOnce();
    const frame = native.captureCharFrame();
    expect(calls.some(call => call.method === "listening.calendar")).toBe(true);
    expect(frame).toContain("Listening diary");
    expect(frame).toContain("■");
    expect(frame).toContain("Lumen Field");
    expect(frame).toContain("less");
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("search rows show a cover thumbnail beside two lines of text", async () => {
  const native = await createTestRenderer({ width: 120, height: 30 });
  const { api, calls } = recorded();
  const app = mountWorkspace(native.renderer, { api, theme: "light", reducedMotion: true, idleAfterMs: 0 });
  try {
    app.navigate("search", { query: "colour" });
    for (let i = 0; i < 4; i++) { await settle(20); await native.renderOnce(); }
    expect(calls.some(call => call.method === "artwork.cover" && call.params?.width === 4 && call.params?.height === 2)).toBe(true);
    const surface = native.renderer.root.findDescendantById("workspace-content")!.getChildren()[0]!;
    expect(native.renderer.root.findDescendantById(`${surface.id}-row-0-cover`)?.height).toBe(2);
    const frame = native.captureCharFrame();
    expect(frame).toContain("The Colour of Air");
    expect(frame).toContain("▀");
  } finally { app.dispose(); native.renderer.destroy(); }
});
