import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ambientProgress, audioSpectrum } from "../src/screens/now-playing/index.js";
import { mountWorkspace } from "../src/workspace/app.js";
import type { Params } from "../src/workspace/contracts.js";
import { trackStatus, unavailableArtwork, settle, textValue, fixtureCtx } from "./helpers/now-playing.js";

test("actions publish one notification through ctx.notify and preserve exact RPC vocabulary", async () => {
  const f = await fixtureCtx();
  try {
    await f.renderOnce();
    expect(f.screen.editing?.()).toBe(false);
    f.screen.handleKey({ name: "space" }); await settle(f);
    f.screen.handleKey({ name: "]" }); await settle(f);
    f.screen.handleKey({ name: "+" }); await settle(f);
    f.screen.handleKey({ name: "r", shift: true }); await settle(f);
    f.screen.handleKey({ name: "f" }); await settle(f);
    expect(f.calls).toContainEqual({ method: "player.action", params: { action: "play_pause" } });
    expect(f.calls.find(call => call.params?.action === "seek")?.params?.value).toBeGreaterThanOrEqual(87_000);
    expect(f.calls).toContainEqual({ method: "player.action", params: { action: "volume", value: 73 } });
    expect(f.calls).toContainEqual({ method: "radio.action", params: { action: "start", uri: "spotify:track:demo1" } });
    expect(f.calls).toContainEqual({ method: "library.action", params: { action: "save", kind: "track", uri: "spotify:track:demo1" } });
    expect(f.notices).toContain("Playback toggled");
    expect(f.notices.filter(notice => notice === "Playback toggled")).toHaveLength(1);

    f.fail();
    f.screen.handleKey({ name: "space" });
    await settle(f);
    expect(f.notices.at(-1)).toBe("Unable to apply: engine offline");
    expect(f.notices.filter(notice => notice === "Unable to apply: engine offline")).toHaveLength(1);
    expect(f.screen.handleKey({ name: "x" })).toBe(false);
  } finally { f.close(); }
});

test("compact controls keep their IDs, show symbol-only volume buttons, and remain inside the card", async () => {
  const f = await fixtureCtx({ width: 80, height: 24 });
  try {
    await f.renderOnce();
    const frame = f.captureCharFrame();
    const card = f.screen.root.findDescendantById("np-player-card")!;
    const volume = f.screen.root.findDescendantById("np-volume-controls")!;
    const detail = f.screen.root.findDescendantById("np-detail")!;
    const quieter = f.screen.root.findDescendantById("np-quieter")!;
    const louder = f.screen.root.findDescendantById("np-louder")!;
    expect(frame).toContain("The Colour of Air");
    expect(frame).toContain("Pause");
    expect(frame).toContain("+5s");
    expect(frame).toContain("/ Search");
    expect(textValue((quieter as { content?: unknown }).content)).toBe("−");
    expect(textValue((louder as { content?: unknown }).content)).toBe("+");
    expect(frame).not.toContain("Quieter");
    expect(frame).not.toContain("Louder");
    expect(detail.parent?.id).toBe("np-volume-controls");
    expect(volume.x).toBeGreaterThanOrEqual(card.x);
    expect(volume.x + volume.width).toBeLessThanOrEqual(card.x + card.width);
    expect(detail.x + detail.width).toBeLessThanOrEqual(volume.x + volume.width);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(80);
    expect(card.y + card.height).toBeLessThanOrEqual(24);
    const quickSearch = f.screen.root.findDescendantById("np-search")!;
    await f.mockMouse.click(quickSearch.x + 2, quickSearch.y);
    expect(f.screen.editing?.()).toBe(true);
    expect(f.screen.handleKey({ name: "escape" })).toBe(true);
    expect(f.screen.editing?.()).toBe(false);
    expect(f.screen.root.findDescendantById("np-play")!.y).toBe(f.screen.root.findDescendantById("np-previous")!.y);
    const playChip = f.screen.root.findDescendantById("np-play-chip")!;
    expect((playChip as unknown as { border: unknown }).border).toEqual([]);
    expect(frame.split("\n")[playChip.y + 1]).not.toMatch(/[╰╯]/);
  } finally { f.close(); }
  expect(ambientProgress(5, 10, 10)).toBe("━━━━━─────");
});

test("mouse controls use acknowledged actions and failed repeat preserves its state", async () => {
  const f = await fixtureCtx();
  try {
    await f.renderOnce();
    await settle(f);
    const previous = f.screen.root.findDescendantById("np-previous")!;
    await f.mockMouse.click(previous.x + 2, previous.y);
    await settle(f);
    expect(f.calls).toContainEqual({ method: "player.action", params: { action: "previous" } });
    f.screen.handleKey({ name: "s" }); await settle(f);
    expect(f.captureCharFrame()).toContain("Shuffle: on");
    f.fail();
    f.screen.handleKey({ name: "r" });
    await settle(f);
    expect(f.captureCharFrame()).toContain("Repeat: off");
    expect(f.notices.at(-1)).toBe("Unable to apply: engine offline");
  } finally { f.close(); }
});

test("timeline clicks seek to bounded start and end positions", async () => {
  const f = await fixtureCtx();
  try {
    await f.renderOnce();
    const timeline = f.screen.root.findDescendantById("np-timeline")!;
    await f.mockMouse.click(timeline.x, timeline.y);
    await settle(f);
    const seeks = () => f.calls.filter(call => call.method === "player.action" && call.params?.action === "seek");
    expect(seeks().at(-1)?.params?.value).toBe(0);

    await f.mockMouse.click(timeline.x + timeline.width - 1, timeline.y);
    await settle(f);
    expect(seeks().at(-1)?.params?.value).toBe(232_000);
  } finally { f.close(); }
});

test("real sampled bands replace playback progress and silence remains flat", async () => {
  const f = await fixtureCtx();
  const sampled = trackStatus();
  sampled.prototype!.audio = { bands: [0, 1], level: 0.6, pulse: 0.5, tempo: null };
  try {
    f.update(sampled); await f.renderOnce();
    let frame = f.captureCharFrame();
    expect(frame).toContain("Audio spectrum");
    expect(frame).not.toContain("Playback progress");
    expect(frame).toContain("████████");
    f.motion(false);
    f.update({ ...sampled, prototype: { ...sampled.prototype!, audio: { bands: [1, 0], level: 0.6, pulse: 0, tempo: null } } });
    await new Promise(resolve => setTimeout(resolve, 110)); await f.renderOnce();
    frame = f.captureCharFrame(); expect(frame).toMatch(/[▂▃▄▅▆▇]{3}/);
    f.motion(true);
    f.update({ ...sampled, prototype: { ...sampled.prototype!, audio: { bands: [1, 1], level: 0, pulse: 0, tempo: null } } });
    await f.renderOnce(); frame = f.captureCharFrame();
    expect(frame).toContain("Audio spectrum · silence");
    expect(frame).not.toContain("████");
    f.update({ ...sampled, mode: { kind: "paused", positionMs: 82_000 } });
    await f.renderOnce(); expect(f.captureCharFrame()).toContain("Audio spectrum · silence");
    expect(audioSpectrum([0, 0.5, 1], 3)).toBe("─▅█");
  } finally { f.close(); }
});

test("189x34 centers bounded player and side queue cards", async () => {
  const f = await fixtureCtx({ width: 189, height: 34 });
  try {
    await f.renderOnce();
    const columns = f.screen.root.findDescendantById("np-columns")!;
    const card = f.screen.root.findDescendantById("np-player-card")!;
    const queue = f.screen.root.findDescendantById("np-up-next-card")!;
    expect(card.visible).toBe(true);
    expect(queue.visible).toBe(true);
    expect(columns.width).toBe(132);
    expect(Math.abs(columns.x - (189 - columns.width) / 2)).toBeLessThanOrEqual(1);
    expect(card.x).toBe(columns.x);
    expect(queue.x).toBe(card.x + card.width + 3);
    for (const panel of [card, queue]) {
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.y).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(189);
      expect(panel.y + panel.height).toBeLessThanOrEqual(34);
    }
  } finally { f.close(); }
});

test("fifteen compact upcoming songs retain durations and never overlap radio status", async () => {
  for (const width of [112, 189]) {
    const live = trackStatus();
    live.prototype!.radio_active = true;
    live.prototype!.up_next = Array.from({ length: 16 }, (_, index) => ({
      ...live.prototype!.up_next[0]!,
      title: index === 14 ? "Fifteenth track" : index === 15 ? "Hidden sixteenth song" : `Song ${index + 1} 雨の音 with a long title`,
      artists: ["An artist with a long name"],
      duration: 181_000 + index * 1000,
    }));
    const f = await fixtureCtx({ width, height: 34, status: live });
    try {
      for (const theme of ["light", "dark"] as const) {
        f.screen.setTheme(theme); await f.renderOnce();
        const frame = f.captureCharFrame();
        expect(frame).toContain("Fifteenth track");
        expect(frame).toContain("15+ upcoming");
        expect(frame).toContain("Continuous radio");
        expect(frame).not.toContain("Hidden sixteenth song");
        const footer = f.screen.root.findDescendantById("np-queue-foot")!;
        const card = f.screen.root.findDescendantById("np-up-next-card")!;
        for (let index = 0; index < 15; index++) {
          const entry = f.screen.root.findDescendantById(`np-up-next-${index}`)!;
          const duration = f.screen.root.findDescendantById(`np-queue-duration-${index}`)!;
          expect(entry.height).toBe(1);
          expect(entry.y + entry.height).toBeLessThanOrEqual(footer.y);
          expect(duration.x + duration.width).toBeLessThan(card.x + card.width);
          expect(frame.split("\n")[duration.y]).toContain(`3:${String(index + 1).padStart(2, "0")}`);
          if (index > 0) expect(entry.y).toBe(f.screen.root.findDescendantById(`np-up-next-${index - 1}`)!.y + 1);
        }
      }
      f.update({ ...live, prototype: { ...live.prototype!, up_next: live.prototype!.up_next.slice(0, 2) } });
      await f.renderOnce();
      expect(f.captureCharFrame()).not.toContain("Fifteenth track");
      expect(f.captureCharFrame()).toContain("2 upcoming");
    } finally { f.close(); }
  }
});

test("full workspace at 80x24 keeps Now Playing controls within the terminal bounds", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const app = mountWorkspace(setup.renderer, {
    theme: "light",
    reducedMotion: true,
    nowPlayingStyle: "classic",
    api: { async call<T>(method: string, params?: Params) {
      if (method === "player.artwork") return unavailableArtwork(params) as T;
      return (method === "player.status" ? { repeat: "off", shuffle: false } : {}) as T;
    } },
  });
  app.setStatus(trackStatus());
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("The Colour of Air");
    expect(frame).toContain("Volume 68%");
    expect(frame).toContain("−");
    expect(frame).toContain("+");
    const card = setup.renderer.root.findDescendantById("np-player-card")!;
    const controls = setup.renderer.root.findDescendantById("np-volume-controls")!;
    const detail = setup.renderer.root.findDescendantById("np-detail")!;
    expect(detail.parent?.id).toBe("np-volume-controls");
    for (const node of [card, controls, detail]) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(80);
      expect(node.y + node.height).toBeLessThanOrEqual(24);
    }
    expect(controls.x).toBeGreaterThanOrEqual(card.x);
    expect(controls.x + controls.width).toBeLessThanOrEqual(card.x + card.width);
  } finally { app.dispose(); setup.renderer.destroy(); }
});

test("share shortcut reports backend URL, missing items, and RPC errors through notifications", async () => {
  const f = await fixtureCtx();
  try {
    expect(f.screen.handleKey({ name: "y" })).toBe(true);
    await settle(f);
    expect(f.calls).toContainEqual({ method: "share", params: { uri: "spotify:track:demo1" } });
    expect(f.notices).toContain("https://open.spotify.com/track/demo1");
    f.fail();
    f.screen.handleKey({ name: "y" });
    await settle(f);
    expect(f.notices.at(-1)).toBe("Unable to share: engine offline");
    f.update({ mode: { kind: "stopped" }, playable: null, prototype: null });
    await f.renderOnce();
    f.screen.handleKey({ name: "y" });
    expect(f.notices.at(-1)).toBe("Choose an item before sharing");
    expect(f.calls.filter(call => call.method === "share")).toHaveLength(2);
  } finally { f.close(); }
});
