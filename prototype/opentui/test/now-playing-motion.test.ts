import { expect, spyOn, test } from "bun:test";
import { trackStatus, coloredArtwork, settle, nativeRgb, fixtureCtx } from "./helpers/now-playing.js";

test("track fades blend covers and album tint while retaining artwork nodes and making no frame RPCs", async () => {
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const first = trackStatus(); first.mode = { kind: "paused", positionMs: 82_000 };
  const second = trackStatus(1); second.mode = { kind: "paused", positionMs: 82_000 };
  const f = await fixtureCtx({ status: first, reducedMotion: false, artwork: params => ({
    ...coloredArtwork(String(params.uri), Number(params.width), Number(params.height)),
    pixels: Array(Number(params.width) * Number(params.height) * 2).fill(params.uri === first.playable!.uri ? "#224488" : "#cc6633"),
  }) });
  const tick = async (milliseconds: number) => { now += milliseconds; await new Promise(resolve => setTimeout(resolve, 90)); await f.renderOnce(); };
  try {
    await settle(f); await tick(1000);
    const art = f.screen.root.findDescendantById("np-art-0")!;
    const cover = f.screen.root.findDescendantById("np-cover-box")!;
    const beforeTint = nativeRgb(f.renderer, cover.x, cover.y, "fg");
    expect(nativeRgb(f.renderer, art.x, art.y, "fg")).toEqual([34, 68, 136]);
    f.update(second); await settle(f);
    await tick(180);
    const blended = nativeRgb(f.renderer, art.x, art.y, "fg");
    expect(blended).not.toEqual([34, 68, 136]);
    expect(blended).not.toEqual([204, 102, 51]);
    expect(f.screen.root.findDescendantById("np-art-0")).toBe(art);
    const title = f.screen.root.findDescendantById("np-title")!;
    expect(nativeRgb(f.renderer, title.x + 5, title.y, "fg")).not.toEqual([25, 38, 58]);
    await tick(1000);
    expect(nativeRgb(f.renderer, art.x, art.y, "fg")).toEqual([204, 102, 51]);
    expect(nativeRgb(f.renderer, cover.x, cover.y, "fg")).not.toEqual(beforeTint);
    expect(nativeRgb(f.renderer, title.x + 5, title.y, "fg")).toEqual([25, 38, 58]);
    const calls = f.calls.length;
    f.update(second); await tick(1000);
    expect(f.calls).toHaveLength(calls);
    expect(f.calls.filter(call => call.method === "player.artwork")).toHaveLength(2);
    expect(nativeRgb(f.renderer, title.x + 5, title.y, "fg")).toEqual([25, 38, 58]);
  } finally { f.close(); clock.mockRestore(); }
});

test("queue advancement and radio additions animate within the fifteen-row body and settle", async () => {
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const before = trackStatus(); before.mode = { kind: "paused", positionMs: 82_000 };
  before.prototype!.radio_active = true;
  before.prototype!.up_next = Array.from({ length: 16 }, (_, index) => ({ ...before.prototype!.up_next[0]!, id: `queued${index}`, uri: `spotify:track:queued${index}`, title: `Queued song ${index}` }));
  const f = await fixtureCtx({ width: 189, status: before, reducedMotion: false });
  const tick = async (milliseconds: number) => { now += milliseconds; await new Promise(resolve => setTimeout(resolve, 90)); await f.renderOnce(); };
  try {
    await settle(f); await tick(1000);
    const advancing = { ...before, playable: before.prototype!.up_next[0]!, prototype: { ...before.prototype!, up_next: before.prototype!.up_next.slice(1) } };
    f.update(advancing); await f.renderOnce();
    const first = f.screen.root.findDescendantById("np-up-next-0")!;
    expect(first.translateY).toBe(1);
    expect(f.screen.root.findDescendantById("np-queue-leaving")!.visible).toBe(true);
    expect(f.captureCharFrame()).toContain("Queued song 0");
    const footer = f.screen.root.findDescendantById("np-queue-foot")!;
    const last = f.screen.root.findDescendantById("np-up-next-14")!;
    expect(last.y + last.height).toBeLessThanOrEqual(footer.y);
    await tick(300); expect(first.translateY).toBe(0);
    expect(f.screen.root.findDescendantById("np-queue-leaving")!.visible).toBe(false);
    const fresh = { ...advancing.prototype.up_next[0]!, id: "brand-new", uri: "spotify:track:brand-new", title: "Fresh radio pick" };
    const refill = { ...advancing, prototype: { ...advancing.prototype, up_next: [...advancing.prototype.up_next.slice(0, 14), fresh] } };
    f.update(refill); await tick(300);
    const number = f.screen.root.findDescendantById("np-queue-number-14")!;
    const highlighted = nativeRgb(f.renderer, number.x, number.y, "bg");
    expect(highlighted).not.toEqual([247, 250, 255]);
    f.update(refill); await tick(600);
    expect(nativeRgb(f.renderer, number.x, number.y, "bg")).toEqual([247, 250, 255]);
    expect(f.captureCharFrame()).toContain("Fresh radio pick");
    expect(f.captureCharFrame()).toContain("15 upcoming");
  } finally { f.close(); clock.mockRestore(); }
});

test("Play, Save, and Radio pulse for keyboard and mouse actions and reduced motion clears feedback", async () => {
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const live = trackStatus(); live.mode = { kind: "paused", positionMs: 82_000 };
  const f = await fixtureCtx({ status: live, reducedMotion: false });
  try {
    await settle(f);
    for (const [name, id] of [["space", "np-play"], ["f", "np-save"], ["R", "np-radio"]]) {
      now += 1000; await new Promise(resolve => setTimeout(resolve, 90)); await f.renderOnce();
      const node = f.screen.root.findDescendantById(id!)!;
      const baseline = nativeRgb(f.renderer, node.x + Math.floor(node.width / 2), node.y, "bg");
      f.screen.handleKey({ name }); await settle(f);
      expect(nativeRgb(f.renderer, node.x + Math.floor(node.width / 2), node.y, "bg")).not.toEqual(baseline);
    }
    now += 1000; await new Promise(resolve => setTimeout(resolve, 90)); await f.renderOnce();
    const save = f.screen.root.findDescendantById("np-save")!;
    await f.mockMouse.click(save.x + 2, save.y); await settle(f);
    expect(nativeRgb(f.renderer, save.x + 5, save.y, "bg")).not.toEqual([247, 250, 255]);
    f.motion(true); await settle(f);
    expect(nativeRgb(f.renderer, save.x + 5, save.y, "bg")).toEqual([247, 250, 255]);
    const callCount = f.calls.length;
    now += 1000; await new Promise(resolve => setTimeout(resolve, 90)); await f.renderOnce();
    expect(f.calls).toHaveLength(callCount);
    expect(nativeRgb(f.renderer, save.x + 5, save.y, "bg")).toEqual([247, 250, 255]);
  } finally { f.close(); clock.mockRestore(); }
});
