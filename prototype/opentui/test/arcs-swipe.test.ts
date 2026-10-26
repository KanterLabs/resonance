import { expect, test } from "bun:test";
import { tick, workspace } from "./helpers/arcs.js";

test("w hears the arc one track at a time: → keeps, ← skips and refills the spot", async () => {
  const w = await workspace({ size: { width: 120, height: 40 } });
  try {
    await w.type("w");
    // The starting song is already picked, so the first track heard is the next one.
    expect(w.last("builder.audition")?.params).toEqual({ uri: "spotify:track:t1" });
    let frame = await w.frame();
    expect(frame).toContain("Arc Studio / one at a time · 1 of 4 picked");
    expect(frame).toContain("Track 2 of 4: Track 1 — Artist 1 · → keep  ← skip");
    expect(frame).toContain("Track 1   ← skip · keep →");
    // Tracks not yet heard stay hidden: the playlist grows as you pick.
    expect(frame).not.toContain("Track 3");

    w.keys.pressArrow("right"); await tick();
    expect(w.last("builder.pin")?.params).toEqual({ slot: 1, pinned: true });
    expect(w.last("builder.audition")?.params).toEqual({ uri: "spotify:track:t2" });
    frame = await w.frame();
    expect(frame).toContain("2 of 4 picked");
    expect(frame).toContain("◆ Track 1");

    w.keys.pressArrow("left"); await tick();
    expect(w.last("builder.ban")?.params).toEqual({ slot: 2 });
    expect(w.last("builder.audition")?.params).toEqual({ uri: "spotify:track:t4" });
    frame = await w.frame();
    expect(frame).toContain("Track 3 of 4: Track 4");
    expect(frame).not.toContain("Track 2 ");

    // Undo brings the skipped track back to be heard again.
    await w.type("z"); await tick();
    expect(w.last("builder.audition")?.params).toEqual({ uri: "spotify:track:t2" });
  } finally { w.cleanup(); }
});

test("picking every track stops the audition, and Esc returns to the arc", async () => {
  const w = await workspace({ size: { width: 120, height: 40 } });
  try {
    await w.type("w");
    for (let i = 0; i < 3; i++) { w.keys.pressArrow("right"); await tick(); }
    expect(w.last("builder.audition_stop")).toBeDefined();
    let frame = await w.frame();
    expect(frame).toContain("4 of 4 picked");
    expect(frame).toContain("All 4 tracks picked · s save · p play the arc");
    // Saving still works from here.
    await w.type("s");
    expect(await w.frame()).toContain("Save as a private playlist named");
    w.keys.pressKey("ESCAPE"); await tick(60);
    w.keys.pressKey("ESCAPE"); await tick(60);
    frame = await w.frame();
    expect(w.app.route).toBe("arcs");
    expect(frame).not.toContain("one at a time ·");
    expect(frame).toContain("Track 3");
  } finally { w.cleanup(); }
});

test("other studio keys do nothing while picking one at a time", async () => {
  const w = await workspace();
  try {
    await w.type("w");
    const builds = w.builds().length;
    await w.type("g+");
    w.keys.pressKey("ESCAPE"); await tick(450);
    expect(w.builds()).toHaveLength(builds);
    expect(w.last("builder.audition_stop")).toBeDefined();
  } finally { w.cleanup(); }
});

test("w without an arc says to build one first", async () => {
  const w = await workspace({ playing: false });
  try {
    await w.type("w");
    expect(await w.frame()).toContain("Build an arc first");
  } finally { w.cleanup(); }
});
