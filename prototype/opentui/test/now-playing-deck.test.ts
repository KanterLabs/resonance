import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mountWorkspace } from "../src/workspace/app.js";
import type { Params } from "../src/workspace/contracts.js";
import { trackStatus, unavailableArtwork, coloredArtwork, settle, fixtureCtx } from "./helpers/now-playing.js";

test("the turntable view draws the deck with a spec sheet and v switches styles", async () => {
  const f = await fixtureCtx({ width: 120, height: 34, style: "turntable", artwork: params => coloredArtwork(String(params.uri), Number(params.width), Number(params.height)) });
  try {
    await settle(f);
    const deck = f.screen.root.findDescendantById("np-turntable")!;
    expect(deck.visible).toBe(true);
    expect(f.screen.root.findDescendantById("np-columns")!.visible).toBe(false);
    expect(f.screen.root.findDescendantById("np-turntable-row-0")).toBeTruthy();
    const frame = f.captureCharFrame();
    expect(f.screen.root.findDescendantById("np-turntable-meter")!.visible).toBe(true);
    expect(frame).toContain("IN THE CRATE");
    expect(frame).toContain("volume");
    expect(frame).toContain("v classic");
    expect(frame).toContain("▀");
    expect(f.calls.some(call => call.method === "player.artwork" && call.params?.width === 20 && call.params?.height === 10)).toBe(true);

    f.screen.handleKey({ name: "v" });
    await settle(f);
    expect(deck.visible).toBe(false);
    expect(f.screen.root.findDescendantById("np-columns")!.visible).toBe(true);
    expect(f.styles).toEqual(["classic"]);
    expect(f.notices.at(-1)).toContain("Classic player");

    f.screen.handleKey({ name: "v" });
    await settle(f);
    expect(deck.visible).toBe(true);
    expect(f.styles).toEqual(["classic", "turntable"]);
  } finally { f.close(); }
});

test("a window too small for the turntable keeps the classic player", async () => {
  const f = await fixtureCtx({ width: 70, height: 20, style: "turntable" });
  try {
    await settle(f);
    expect(f.screen.root.findDescendantById("np-turntable")!.visible).toBe(false);
    expect(f.screen.root.findDescendantById("np-columns")!.visible).toBe(true);
  } finally { f.close(); }
});

test("contexts without the style preference keep the classic player", async () => {
  const f = await fixtureCtx({ width: 120, height: 34 });
  try {
    await settle(f);
    expect(f.screen.root.findDescendantById("np-turntable")!.visible).toBe(false);
    expect(f.screen.root.findDescendantById("np-columns")!.visible).toBe(true);
  } finally { f.close(); }
});

test("the workspace opens on the turntable, which fits inside 80x24", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const app = mountWorkspace(setup.renderer, {
    theme: "dark",
    reducedMotion: true,
    api: { async call<T>(method: string, params?: Params) {
      if (method === "player.artwork") return unavailableArtwork(params) as T;
      return (method === "player.status" ? { repeat: "off", shuffle: false } : {}) as T;
    } },
  });
  app.setStatus(trackStatus());
  try {
    await setup.renderOnce(); await setup.renderOnce();
    const deck = setup.renderer.root.findDescendantById("np-turntable")!;
    expect(deck.visible).toBe(true);
    expect(setup.captureCharFrame()).toContain("The Colour of Air");
    for (const node of [deck, setup.renderer.root.findDescendantById("np-turntable-spec")!]) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(80);
      expect(node.y + node.height).toBeLessThanOrEqual(24);
    }
  } finally { app.dispose(); setup.renderer.destroy(); }
});
