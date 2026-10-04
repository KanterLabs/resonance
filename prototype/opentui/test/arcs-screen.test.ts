import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mountWorkspace } from "../src/workspace/app.js";
import { ArcsController } from "../src/screens/arcs/controller.js";
import { normalizeRecipe, type ArcDraft, type ArcSlot, type Recipe } from "../src/screens/arcs/model.js";
import type { Params } from "../src/workspace/contracts.js";
import type { ParsedStatus } from "../src/status.js";

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const slot = (i: number, extra: Partial<ArcSlot> = {}): ArcSlot => ({ slot: i, uri: `spotify:track:t${i}`, title: `Track ${i}`, artists: [`Artist ${i}`], album: null, duration_ms: 200_000, target: 0.5, energy: 0.1 * i, measure: "measured", tempo: 100 + i, score: 0.7, affinity: 0.8, curve_fit: 0.9, transition: 0.6, penalty: 0, reasons: [`reason ${i}`], pinned: false, seed: i === 0, ...extra });
const draft = (slots: ArcSlot[] = [0, 1, 2, 3].map(i => slot(i)), extra: Partial<ArcDraft> = {}): ArcDraft => ({ recipe: { ...normalizeRecipe(undefined), seeds: ["spotify:track:t0"] }, slots, targets: [], confidence: 0.8, measured: slots.length, estimated: 0, unmeasured: 0, pool_size: 30, duration_ms: slots.length * 200_000, notes: [], playlist_id: null, ...extra });
const status = { mode: { kind: "playing", startedAtMs: 0 }, playable: { uri: "spotify:track:t0", title: "Track 0", artists: ["Artist 0"], album: "", duration: 200_000 }, prototype: { position_ms: 0, volume_percent: 50 } } as unknown as ParsedStatus;

/** The whole workspace with a scripted engine, driven by real key sequences. */
async function workspace(options: { playing?: boolean; size?: { width: number; height: number } } = {}) {
  const setup = await createTestRenderer(options.size ?? { width: 110, height: 34 });
  const calls: { method: string; params: Params }[] = [];
  let current = draft();
  const api = { async call<T>(method: string, params: Params = {}): Promise<T> {
    calls.push({ method, params });
    switch (method) {
      case "builder.state": return { recipe: normalizeRecipe(undefined), draft: null, fingerprinted: 12, current: options.playing === false ? null : { uri: "spotify:track:t0", title: "Track 0", artists: ["Artist 0"] } } as T;
      case "builder.build": {
        const recipe = params.recipe as Recipe;
        current = draft(undefined, { recipe: { ...recipe, seeds: recipe.seeds.length ? recipe.seeds : ["spotify:track:t0"] } });
        return current as T;
      }
      case "builder.reroll": return { slot: params.slot, alternatives: [slot(9, { slot: params.slot as number })] } as T;
      case "builder.choose": current = draft(current.slots.map((s, i) => i === params.slot ? slot(9, { slot: i }) : s)); return current as T;
      case "builder.pin": current = draft(current.slots.map((s, i) => i === params.slot ? { ...s, pinned: !!params.pinned } : s)); return current as T;
      case "builder.ban": current = draft(current.slots.filter((_, i) => i !== params.slot).map((s, i) => ({ ...s, slot: i }))); return current as T;
      case "builder.play": return { queued: 4 - Number(params.slot ?? 0) } as T;
      case "builder.save": return { id: "p1", overwritten: false, tracks: current.slots.length } as T;
      case "search": return { items: [{ id: "s1", kind: "track", title: "Found", subtitle: "Someone", uri: "spotify:track:found" }], offset: 0, limit: 8, total: 1, has_more: false } as T;
      default: return {} as T;
    }
  } };
  const app = mountWorkspace(setup.renderer, { api, theme: "dark", reducedMotion: true });
  if (options.playing !== false) app.setStatus(status);
  setup.mockInput.pressKey("0"); await tick(30);
  const keys = setup.mockInput;
  return {
    app, calls, keys,
    builds: () => calls.filter(call => call.method === "builder.build"),
    last: (method: string) => calls.filter(call => call.method === method).at(-1),
    async frame() { await setup.renderOnce(); return setup.captureCharFrame(); },
    async type(text: string) { await keys.typeText(text); await tick(); },
    cleanup() { app.dispose(); setup.renderer.destroy(); },
  };
}

test("0 opens Arc Studio and builds from the playing song without a keypress", async () => {
  const w = await workspace();
  try {
    expect(w.app.route).toBe("arcs");
    expect((w.builds()[0]?.params.recipe as Recipe).seeds).toEqual(["spotify:track:t0"]);
    const frame = await w.frame();
    expect(frame).toContain("Arc Studio");
    expect(frame).toContain("From   Track 0");
    expect(frame).toContain("Shape  ◀ Rise & Fall ▶");
    expect(frame).toContain("Track 3");
    expect(frame).toContain("↑↓ pick  ⏎ play from here");
    expect(frame).toContain("Built 4 tracks from Track 0");
  } finally { w.cleanup(); }
});

test("with nothing playing the screen says what to do instead of failing", async () => {
  const w = await workspace({ playing: false });
  try {
    expect(w.builds()).toHaveLength(0);
    const frame = await w.frame();
    expect(frame).toContain("play a song, or press / to choose one");
    expect(frame).toContain("Play a song, then press c");
  } finally { w.cleanup(); }
});

test("arrows move through the list and Enter plays from the selected track", async () => {
  const w = await workspace();
  try {
    w.keys.pressArrow("down"); w.keys.pressArrow("down"); await tick();
    expect(await w.frame()).toContain("Why Track 2: reason 2");
    w.keys.pressEnter(); await tick();
    expect(w.last("builder.play")?.params).toEqual({ slot: 2 });
    expect(await w.frame()).toContain("Playing from Track 2");
    await w.type("p");
    expect(w.last("builder.play")?.params).toEqual({});
  } finally { w.cleanup(); }
});

test("shape, length, mix and remix keys rebuild the arc", async () => {
  const w = await workspace();
  try {
    const start = w.builds().length;
    w.keys.pressArrow("right"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).preset).toBe("steady_focus");
    expect(await w.frame()).toContain("◀ Steady Focus ▶");
    w.keys.pressArrow("left"); w.keys.pressArrow("left"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).preset).toBe("run");
    await w.type("++-"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).length).toEqual({ tracks: 20 });
    await w.type("]]"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).discovery).toBe(50);
    const before = (w.last("builder.build")?.params.recipe as Recipe).rng_seed;
    await w.type("g"); await tick();
    expect((w.last("builder.build")?.params.recipe as Recipe).rng_seed).not.toBe(before);
    expect(w.builds().length).toBeGreaterThan(start + 3);
  } finally { w.cleanup(); }
});

test("e edits the curve modally and digits do not navigate away while editing", async () => {
  const w = await workspace();
  try {
    await w.type("e");
    expect(await w.frame()).toContain("Editing curve");
    w.keys.pressArrow("right"); w.keys.pressArrow("up"); await tick();
    await w.type("3");
    expect(w.app.route).toBe("arcs");
    expect(await w.frame()).toContain("point 2/8 · energy 45%");
    w.keys.pressEnter(); await tick(450);
    const recipe = w.last("builder.build")?.params.recipe as Recipe;
    expect(recipe.curve[1]!.energy).toBeCloseTo(0.45);
    expect(recipe.preset).toBeNull();
    expect(await w.frame()).toContain("◀ Custom ▶");
    expect(await w.frame()).not.toContain("Editing curve");
  } finally { w.cleanup(); }
});

test("swap, keep, remove and save work from the keyboard", async () => {
  const w = await workspace();
  try {
    w.keys.pressArrow("down"); await tick();
    await w.type("r");
    expect(w.last("builder.reroll")?.params).toEqual({ slot: 1 });
    expect(await w.frame()).toContain("Swap: ↑↓ pick a replacement");
    w.keys.pressEnter(); await tick();
    expect(w.last("builder.choose")?.params).toEqual({ slot: 1, uri: "spotify:track:t9" });
    expect(await w.frame()).toContain("Swapped in Track 9");
    await w.type("k");
    expect(w.last("builder.pin")?.params).toEqual({ slot: 1, pinned: true });
    expect(await w.frame()).toContain("◆ Track 9");
    await w.type("x");
    expect(w.last("builder.ban")?.params).toEqual({ slot: 1 });
    await w.type("s");
    expect(await w.frame()).toContain("Save as a private playlist named");
    w.keys.pressEnter(); await tick();
    expect(w.last("builder.save")?.params).toEqual({ name: "Track 0 arc", overwrite: false });
    expect(await w.frame()).toContain("Saved 3 tracks to Track 0 arc");
  } finally { w.cleanup(); }
});

test("/ adds a starting song, Esc cancels a swap, and Esc on the arc returns to Now Playing", async () => {
  const w = await workspace();
  try {
    await w.type("/");
    await w.type("found"); w.keys.pressEnter(); await tick();
    expect(await w.frame()).toContain("+ Found");
    w.keys.pressEnter(); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).seeds).toEqual(["spotify:track:t0", "spotify:track:found"]);
    await w.type("r");
    w.keys.pressKey("ESCAPE"); await tick(60);
    expect(w.app.route).toBe("arcs");
    expect(await w.frame()).toContain("↑↓ pick  ⏎ play from here");
    w.keys.pressBackspace(); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).seeds).toEqual(["spotify:track:t0"]);
    w.keys.pressKey("ESCAPE"); await tick(60);
    expect(w.app.route).toBe("now-playing");
  } finally { w.cleanup(); }
});

test("the studio fits 80x24 with both legend lines visible", async () => {
  const w = await workspace({ size: { width: 80, height: 24 } });
  try {
    const frame = await w.frame();
    expect(frame.split("\n").length).toBeLessThanOrEqual(25);
    expect(frame).toContain("↑↓ pick  ⏎ play here");
    expect(frame).toContain("g remix  / add  c playing");
    expect(frame).toContain("Shape  ◀ Rise & Fall ▶  18 tracks  mix familiar");
    expect(frame).not.toContain("...");
    expect(frame).toContain("Track 0");
    w.app.context.setTheme("light");
    expect(await w.frame()).toContain("Arc Studio");
  } finally { w.cleanup(); }
});

test("controller ignores stale builds and keeps errors visible", async () => {
  let resolveFirst: ((value: unknown) => void) | undefined;
  let call = 0;
  const controller = new ArcsController({ call<T>(method: string) {
    if (method !== "builder.build") return Promise.resolve({} as T);
    call++;
    if (call === 1) return new Promise<T>(resolve => { resolveFirst = resolve as (value: unknown) => void; });
    if (call === 2) return Promise.resolve(draft([slot(0), slot(1)]) as T);
    return Promise.reject(new Error("Not enough cached tracks"));
  } }, () => {}, 5);
  controller.recipe = { ...controller.recipe, seeds: ["spotify:track:t0"] };
  const first = controller.build();
  await controller.build();
  resolveFirst!(draft());
  await first;
  expect(controller.draft?.slots).toHaveLength(2);
  await controller.build();
  expect(controller.error).toBe(true);
  expect(controller.status).toBe("Not enough cached tracks");
  controller.dispose();
});
