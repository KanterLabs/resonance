import { expect, test } from "bun:test";
import type { Recipe } from "../src/screens/arcs/model.js";
import { tick, workspace } from "./helpers/arcs.js";

const uris = (w: Awaited<ReturnType<typeof workspace>>) => w.draft().slots.map(slot => slot.uri);

test("z undoes a removal exactly and Z redoes it", async () => {
  const w = await workspace();
  try {
    w.keys.pressArrow("down"); await tick();
    await w.type("x");
    expect(uris(w)).not.toContain("spotify:track:t1");
    expect(await w.frame()).toContain("Removed Track 1; it won't come back in this arc · z undo");
    await w.type("z");
    expect(w.last("builder.restore")?.params.uris).toEqual(["spotify:track:t0", "spotify:track:t1", "spotify:track:t2", "spotify:track:t3"]);
    expect(uris(w)).toContain("spotify:track:t1");
    expect(await w.frame()).toContain("Undid: remove Track 1 · Z redo");
    w.keys.pressKey("Z", { shift: true }); await tick();
    expect(uris(w)).not.toContain("spotify:track:t1");
    expect(await w.frame()).toContain("Redid: remove Track 1");
    await w.type("z"); await w.type("z");
    expect(await w.frame()).toContain("Nothing to undo");
  } finally { w.cleanup(); }
});

test("a burst of shape edits is a single undo step", async () => {
  const w = await workspace();
  try {
    await w.type("+++"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).length).toEqual({ tracks: 24 });
    await w.type("z");
    expect((w.last("builder.restore")?.params.recipe as Recipe).length).toEqual({ tracks: 18 });
    expect(await w.frame()).toContain("Undid: length change");
  } finally { w.cleanup(); }
});

test("removing a starting song says so, and undo brings it back", async () => {
  const w = await workspace();
  try {
    await w.type("x");
    expect(await w.frame()).toContain("Removed Track 0 and dropped it as a starting song · now building from the playing song · z undo");
    await w.type("z");
    expect((w.last("builder.restore")?.params.recipe as Recipe).seeds).toEqual(["spotify:track:t0"]);
  } finally { w.cleanup(); }
});

test("Shift+arrows and < > move a track and the selection follows it", async () => {
  const w = await workspace();
  try {
    w.keys.pressArrow("down"); await tick();
    w.keys.pressArrow("down", { shift: true }); await tick();
    expect(w.last("builder.move")?.params).toEqual({ from: 1, to: 2 });
    expect(uris(w)[2]).toBe("spotify:track:t1");
    let frame = await w.frame();
    expect(frame).toContain("Moved Track 1 to 3 and kept it there");
    expect(frame).toContain("› 03 ◆ Track 1");
    await w.type("<");
    expect(w.last("builder.move")?.params).toEqual({ from: 2, to: 1 });
    frame = await w.frame();
    expect(frame).toContain("› 02 ◆ Track 1");
    // The top track cannot move further up.
    w.keys.pressKey("HOME"); await tick();
    const moves = w.calls.filter(call => call.method === "builder.move").length;
    await w.type("<");
    expect(w.calls.filter(call => call.method === "builder.move")).toHaveLength(moves);
  } finally { w.cleanup(); }
});

test("an action pressed while building runs on the same track afterwards", async () => {
  const w = await workspace({ buildDelay: 60 });
  try {
    await tick(80);
    w.keys.pressArrow("down"); w.keys.pressArrow("down"); await tick();
    await w.type("+");
    await w.type("k");
    expect(await w.frame()).toContain("working… then keep Track 2");
    await tick(120);
    expect(w.last("builder.pin")?.params).toEqual({ slot: 2, pinned: true });
    expect(await w.frame()).toContain("Keeping Track 2 in place");
  } finally { w.cleanup(); }
});

test("f lists starting songs, and x removes the selected one rather than the last", async () => {
  const w = await workspace();
  try {
    await w.type("/"); await w.type("found"); w.keys.pressEnter(); await tick();
    w.keys.pressEnter(); await tick(450);
    expect(await w.frame()).toContain("From   Track 0 · Found");
    await w.type("f");
    let frame = await w.frame();
    expect(frame).toContain("Arc Studio / starting songs");
    expect(frame).toContain("✦ Track 0");
    expect(frame).toContain("✦ Found");
    await w.type("x");
    expect(await w.frame()).toContain("Dropped Track 0 from the starting songs");
    await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).seeds).toEqual(["spotify:track:found"]);
    w.keys.pressKey("ESCAPE"); await tick(60);
    frame = await w.frame();
    expect(w.app.route).toBe("arcs");
    expect(frame).not.toContain("Arc Studio / starting songs");
    expect(frame).toContain("Back to the arc");
  } finally { w.cleanup(); }
});

test("m switches the length to minutes and back", async () => {
  const w = await workspace();
  try {
    await w.type("m"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).length).toEqual({ minutes: 20 });
    expect(await w.frame()).toContain("20 min (4 tracks)");
    await w.type("m"); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).length).toEqual({ tracks: 5 });
  } finally { w.cleanup(); }
});

test("S saves a new playlist and the heading tracks unsaved changes", async () => {
  const w = await workspace();
  try {
    await w.type("s"); w.keys.pressEnter(); await tick();
    expect(await w.frame()).toContain("Arc Studio · saved to Track 0 arc");
    await w.type("x");
    expect(await w.frame()).toContain("Arc Studio · unsaved changes");
    await w.type("z");
    expect(await w.frame()).toContain("Arc Studio · saved to Track 0 arc");
    await w.type("s");
    expect(await w.frame()).toContain('Update "Track 0 arc" (rename here)');
    w.keys.pressKey("ESCAPE"); await tick(60);
    w.keys.pressKey("S", { shift: true }); await tick();
    expect(await w.frame()).toContain("Save as a new private playlist named");
    w.keys.pressEnter(); await tick();
    expect(w.last("builder.save")?.params).toEqual({ name: "Track 0 arc", overwrite: false });
  } finally { w.cleanup(); }
});

test("a auditions the selected track until a or Esc stops it", async () => {
  const w = await workspace({ size: { width: 110, height: 40 } });
  try {
    w.keys.pressArrow("down"); await tick();
    await w.type("a");
    expect(w.last("builder.audition")?.params).toEqual({ uri: "spotify:track:t1" });
    expect(await w.frame()).toContain("♪ auditioning Track 1 · 20s · a or Esc to stop");
    // Looking around keeps it playing; Esc stops it without leaving the studio.
    w.keys.pressArrow("down"); await tick();
    expect(w.last("builder.audition_stop")).toBeUndefined();
    w.keys.pressKey("ESCAPE"); await tick(60);
    expect(w.app.route).toBe("arcs");
    expect(w.last("builder.audition_stop")).toBeDefined();
    expect(await w.frame()).not.toContain("♪ auditioning");
    // In a swap, alternatives can be auditioned too.
    await w.type("r");
    await w.type("a");
    expect(w.last("builder.audition")?.params).toEqual({ uri: "spotify:track:t9" });
  } finally { w.cleanup(); }
});

test("a tall studio keeps action results apart from the why line", async () => {
  const w = await workspace({ size: { width: 120, height: 40 } });
  try {
    w.keys.pressArrow("down"); await tick();
    await w.type("k");
    const frame = await w.frame();
    expect(frame).toContain("Keeping Track 1 in place");
    expect(frame).toContain("Why Track 1: kept in place");
  } finally { w.cleanup(); }
});

test("the chart draws the tracks and points at the selected one", async () => {
  const w = await workspace({ size: { width: 120, height: 40 } });
  try {
    w.keys.pressArrow("down"); await tick();
    const frame = await w.frame();
    expect(frame).toContain("●");
    expect(frame).toContain("▲");
    expect(frame).toContain("track 2 · target 50% · energy 10%");
    expect(frame).toContain("fit 90%");
  } finally { w.cleanup(); }
});

test("curve editing adds, slides and deletes points", async () => {
  const w = await workspace();
  try {
    await w.type("e");
    await w.type("n");
    expect(await w.frame()).toContain("point 2/9");
    w.keys.pressArrow("right", { shift: true }); await tick();
    await w.type("d");
    expect(await w.frame()).toContain("point 2/8");
    w.keys.pressEnter(); await tick(450);
    expect((w.last("builder.build")?.params.recipe as Recipe).curve).toHaveLength(8);
    // The whole edit is one undo step.
    await w.type("z");
    expect(await w.frame()).toContain("Undid: curve edit");
  } finally { w.cleanup(); }
});
