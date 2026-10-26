import { expect, test } from "bun:test";
import { ArcsController } from "../src/screens/arcs/controller.js";
import type { Recipe } from "../src/screens/arcs/model.js";
import { draft, slot, tick, workspace } from "./helpers/arcs.js";

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
    expect(await w.frame()).toContain("point 2/8 · energy 45%");
    await w.type("3");
    expect(w.app.route).toBe("arcs");
    expect(await w.frame()).toContain("point 2/8 · energy 30%");
    w.keys.pressEnter(); await tick(450);
    const recipe = w.last("builder.build")?.params.recipe as Recipe;
    expect(recipe.curve[1]!.energy).toBeCloseTo(0.3);
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
    expect(await w.frame()).toContain("Swapped in Track 9 and kept it there");
    expect(await w.frame()).toContain("◆ Track 9");
    await w.type("k");
    expect(w.last("builder.pin")?.params).toEqual({ slot: 1, pinned: false });
    expect(await w.frame()).toContain("Track 9 can move again");
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

test("the studio fits 80x24 with its legend visible", async () => {
  const w = await workspace({ size: { width: 80, height: 24 } });
  try {
    const frame = await w.frame();
    expect(frame.split("\n").length).toBeLessThanOrEqual(25);
    expect(frame).toContain("↑↓ ⏎ play  r swap  k keep  x remove  z undo  s save  ? keys");
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

test("songs measured from previews after a build are offered as a refresh, not rebuilt in", async () => {
  const replies = [
    { preview_lookup: true, catalog_previewed: 10, preview_pending: 40 },
    { preview_lookup: true, catalog_previewed: 13, preview_pending: 37 },
    { preview_lookup: true, catalog_previewed: 15, preview_pending: 0 },
    { preview_lookup: true, catalog_previewed: 99, preview_pending: 0 },
  ];
  let polls = 0;
  let builds = 0;
  const controller = new ArcsController({ call<T>(method: string) {
    if (method === "builder.coverage") return Promise.resolve(replies[Math.min(polls++, replies.length - 1)] as T);
    if (method === "builder.build") { builds++; return Promise.resolve(draft() as T); }
    return Promise.resolve({} as T);
  } }, () => {}, 5, 5);
  controller.recipe = { ...controller.recipe, seeds: ["spotify:track:t0"] };
  await controller.build();
  await tick(60);
  expect(controller.newlyMeasured).toBe(5);
  // Nothing is pending any more, so polling stopped and the arc was left alone.
  expect(polls).toBe(3);
  expect(builds).toBe(1);
  controller.dispose();
});

test("arcs never poll for previews when lookups are off", async () => {
  let polls = 0;
  const controller = new ArcsController({ call<T>(method: string) {
    if (method === "builder.coverage") { polls++; return Promise.resolve({ preview_lookup: false, preview_pending: 5 } as T); }
    return Promise.resolve((method === "builder.build" ? draft() : {}) as T);
  } }, () => {}, 5, 5);
  controller.recipe = { ...controller.recipe, seeds: ["spotify:track:t0"] };
  await controller.build();
  await tick(40);
  expect(polls).toBe(1);
  expect(controller.newlyMeasured).toBe(0);
  controller.dispose();
});

test("u rebuilds the arc with what has been measured since", async () => {
  const w = await workspace();
  try {
    const before = w.builds().length;
    w.keys.pressKey("u"); await tick(30);
    expect(w.builds().length).toBe(before + 1);
  } finally { w.cleanup(); }
});
