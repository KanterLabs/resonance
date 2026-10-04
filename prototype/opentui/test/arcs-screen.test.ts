import { expect, test } from "bun:test";
import { InputRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createArcsScreen } from "../src/screens/arcs/index.js";
import { ArcsController } from "../src/screens/arcs/controller.js";
import { normalizeRecipe, type ArcDraft, type ArcSlot } from "../src/screens/arcs/model.js";
import type { Params, ScreenContext } from "../src/workspace/contracts.js";
import type { ParsedStatus } from "../src/status.js";

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const slot = (i: number, extra: Partial<ArcSlot> = {}): ArcSlot => ({ slot: i, uri: `spotify:track:t${i}`, title: `Track ${i}`, artists: [`Artist ${i}`], album: null, duration_ms: 200_000, target: 0.5, energy: 0.1 * i, measure: "measured", tempo: 100 + i, score: 0.7, affinity: 0.8, curve_fit: 0.9, transition: 0.6, penalty: 0, reasons: [`reason ${i}`], pinned: false, seed: i === 0, ...extra });
const draft = (count = 4, extra: Partial<ArcDraft> = {}): ArcDraft => ({ recipe: { ...normalizeRecipe(undefined), seeds: ["spotify:track:t0"] }, slots: Array.from({ length: count }, (_, i) => slot(i)), targets: [], confidence: 0.8, measured: count, estimated: 0, unmeasured: 0, pool_size: 30, duration_ms: count * 200_000, notes: [], playlist_id: null, ...extra });
const status = { playable: { uri: "spotify:track:t0", title: "Track 0", artists: ["Artist 0"], album: "", duration: 1 } } as unknown as ParsedStatus;

function input(root: Renderable): InputRenderable | undefined {
  if (root instanceof InputRenderable) return root;
  for (const child of root.getChildren()) { const found = input(child); if (found) return found; }
}

async function fixture(params: Params = {}, size = { width: 100, height: 32 }) {
  const setup = await createTestRenderer(size);
  const calls: { method: string; params: Params }[] = [];
  const api = { async call<T>(method: string, params: Params = {}) {
    calls.push({ method, params });
    switch (method) {
      case "builder.state": return { recipe: normalizeRecipe(undefined), draft: null, fingerprinted: 12, current: { uri: "spotify:track:t0", title: "Track 0", artists: ["Artist 0"] } } as T;
      case "builder.build": return draft() as T;
      case "builder.reroll": return { slot: params.slot, alternatives: [slot(9, { slot: params.slot as number })] } as T;
      case "builder.choose": return draft(4, { slots: [slot(0), slot(9, { slot: 1 }), slot(2), slot(3)] }) as T;
      case "builder.pin": return draft(4, { slots: [slot(0), slot(1, { pinned: true, reasons: ["pinned", "reason 1"] }), slot(2), slot(3)] }) as T;
      case "builder.ban": return draft(3) as T;
      case "builder.play": return { queued: 4 } as T;
      case "builder.save": return { id: "p1", overwritten: false, tracks: 4 } as T;
      case "search": return { items: [{ id: "s1", kind: "track", title: "Found", subtitle: "Someone", uri: "spotify:track:found" }], offset: 0, limit: 8, total: 1, has_more: false } as T;
      default: return {} as T;
    }
  } };
  const context: ScreenContext = { renderer: setup.renderer, api, theme: () => "dark", setTheme() {}, reducedMotion: () => true, setReducedMotion() {}, status: () => status, onStatus: () => () => {}, navigate() {}, notify() {} };
  const screen = createArcsScreen(context, params);
  setup.renderer.root.add(screen.root);
  await tick();
  return { setup, screen, calls, async frame() { await setup.renderOnce(); return setup.captureCharFrame(); }, submit(value: string) { input(screen.root)!.emit("enter", value); }, cleanup() { screen.dispose(); setup.renderer.destroy(); } };
}

test("building draws the curve, the landed energies and explained rows", async () => {
  const f = await fixture();
  try {
    expect(await f.frame()).toContain("Track 0 (playing now)");
    f.screen.handleKey({ name: "return" }); await tick();
    expect(f.calls.find(call => call.method === "builder.build")).toBeDefined();
    const frame = await f.frame();
    expect(frame).toContain("Energy");
    expect(frame).toContain("Landed");
    expect(frame).toContain("Track 3");
    expect(frame).toContain("reason 2");
    expect(frame).toContain("4 tracks · 13m · confidence 80%");
  } finally { f.cleanup(); }
});

test("the arc command builds from the playing song straight away", async () => {
  const f = await fixture({ fromCurrent: true });
  try {
    await tick();
    const build = f.calls.find(call => call.method === "builder.build");
    expect((build?.params.recipe as { seeds: string[] }).seeds).toEqual(["spotify:track:t0"]);
  } finally { f.cleanup(); }
});

test("curve edits and presets rebuild after the edits settle", async () => {
  const f = await fixture();
  try {
    f.screen.handleKey({ name: "up" }); f.screen.handleKey({ name: "up" }); f.screen.handleKey({ name: "right" });
    expect(f.calls.filter(call => call.method === "builder.build")).toHaveLength(0);
    await tick(450);
    const builds = f.calls.filter(call => call.method === "builder.build");
    expect(builds).toHaveLength(1);
    const recipe = builds[0]!.params.recipe as { curve: { energy: number }[]; preset: string | null };
    expect(recipe.curve[0]!.energy).toBeCloseTo(0.4);
    expect(recipe.preset).toBeNull();
    f.screen.handleKey({ name: "p" }); await tick(450);
    expect((f.calls.filter(call => call.method === "builder.build").at(-1)!.params.recipe as { preset: string }).preset).toBe("steady_focus");
  } finally { f.cleanup(); }
});

test("draft focus rerolls, chooses, pins, bans, plays and saves", async () => {
  const f = await fixture();
  try {
    f.screen.handleKey({ name: "return" }); await tick();
    f.screen.handleKey({ name: "tab" }); f.screen.handleKey({ name: "tab" });
    f.screen.handleKey({ name: "down" });
    f.screen.handleKey({ name: "r" }); await tick();
    expect(f.calls.at(-1)).toEqual({ method: "builder.reroll", params: { slot: 1 } });
    expect(await f.frame()).toContain("replace slot 2");
    f.screen.handleKey({ name: "return" }); await tick();
    expect(f.calls.at(-1)).toEqual({ method: "builder.choose", params: { slot: 1, uri: "spotify:track:t9" } });
    f.screen.handleKey({ name: "k" }); await tick();
    expect(f.calls.at(-1)?.method).toBe("builder.pin");
    expect(await f.frame()).toContain("◆ Track 1");
    f.screen.handleKey({ name: "x" }); await tick();
    expect(f.calls.at(-1)?.method).toBe("builder.ban");
    f.screen.handleKey({ name: "p", shift: true }); await tick();
    expect(f.calls.at(-1)?.method).toBe("builder.play");
    f.screen.handleKey({ name: "s" }); expect(f.screen.editing?.()).toBe(true);
    f.submit("Evening arc"); await tick();
    expect(f.calls.at(-1)).toEqual({ method: "builder.save", params: { name: "Evening arc", overwrite: false } });
    expect(await f.frame()).toContain("Saved 4 tracks to Evening arc");
  } finally { f.cleanup(); }
});

test("seeds are found by search and escape returns to the arc", async () => {
  const f = await fixture();
  try {
    f.screen.handleKey({ name: "/" }); f.submit("found"); await tick();
    expect(await f.frame()).toContain("+ Found");
    f.screen.handleKey({ name: "return" }); await tick(450);
    const build = f.calls.filter(call => call.method === "builder.build").at(-1);
    expect((build?.params.recipe as { seeds: string[] }).seeds).toEqual(["spotify:track:found"]);
    f.screen.handleKey({ name: "/" }); f.submit("found"); await tick();
    expect(f.screen.handleKey({ name: "escape" })).toBe(true);
    expect(f.screen.handleKey({ name: "escape" })).toBe(false);
  } finally { f.cleanup(); }
});

test("the screen fits 80x24 in both themes", async () => {
  const f = await fixture({}, { width: 80, height: 24 });
  try {
    f.screen.handleKey({ name: "return" }); await tick();
    const frame = await f.frame();
    expect(frame.split("\n").length).toBeLessThanOrEqual(25);
    expect(frame).toContain("Energy");
    f.screen.setTheme("light");
    expect(await f.frame()).toContain("Landed");
  } finally { f.cleanup(); }
});

test("controller errors stay visible and stale builds are ignored", async () => {
  let resolveFirst: ((value: unknown) => void) | undefined;
  let call = 0;
  const changes: string[] = [];
  const controller = new ArcsController({ call<T>(method: string) {
    if (method !== "builder.build") return Promise.resolve({} as T);
    call++;
    if (call === 1) return new Promise<T>(resolve => { resolveFirst = resolve as (value: unknown) => void; });
    if (call === 2) return Promise.resolve(draft(2) as T);
    return Promise.reject(new Error("Not enough cached tracks"));
  } }, () => changes.push(controller.status), 5);
  controller.recipe = { ...controller.recipe, seeds: ["spotify:track:t0"] };
  const first = controller.build();
  await controller.build();
  resolveFirst!(draft(7));
  await first;
  expect(controller.draft?.slots).toHaveLength(2);
  await controller.build();
  expect(controller.error).toBe(true);
  expect(controller.status).toBe("Not enough cached tracks");
  controller.dispose();
});
