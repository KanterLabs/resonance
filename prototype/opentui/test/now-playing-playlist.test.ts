import { expect, test } from "bun:test";
import { pickerChoices } from "../src/screens/now-playing/playlist-picker.js";
import { settle, fixtureCtx } from "./helpers/now-playing.js";

const playlistRow = (id: string, title: string, meta: Record<string, unknown> = { owned: true, can_edit: true }) => ({ id, kind: "playlist", title, subtitle: "", uri: `spotify:playlist:${id}`, meta });

test("playlist choices keep editable lists, put the last used first and offer to create a new one", () => {
  const lists = [playlistRow("a", "Road Trip"), playlistRow("b", "Someone else's", { owned: false, can_edit: false }), playlistRow("c", "Late Night Drive")];
  expect(pickerChoices(lists, "").map(choice => choice.id)).toEqual(["a", "c"]);
  expect(pickerChoices(lists, "", "c").map(choice => choice.id)).toEqual(["c", "a"]);
  expect(pickerChoices(lists, "drive late")).toEqual([{ kind: "playlist", id: "c", title: "Late Night Drive" }, { kind: "create", title: "drive late" }]);
  expect(pickerChoices(lists, "road trip")).toEqual([{ kind: "playlist", id: "a", title: "Road Trip" }]);
  expect(pickerChoices(lists, "  Gym ")).toEqual([{ kind: "create", title: "Gym" }]);
});

test("p in Now Playing adds the playing song to a chosen playlist, or to a new one", async () => {
  const lists = [playlistRow("road", "Road Trip"), playlistRow("night", "Late Night Drive"), playlistRow("theirs", "Shared With Me", { owned: false, can_edit: false })];
  const f = await fixtureCtx({ width: 120, height: 34, respond: (method, params) => {
    if (method === "library.list") return { items: lists, offset: 0, limit: 200, total: lists.length, has_more: false };
    if (method === "playlist.action" && params?.action === "create") return { id: "fresh" };
    if (method === "player.status") return { repeat: "off", shuffle: false, saved: false, current: { uri: "spotify:track:demo1" } };
    return { applied: true };
  } });
  f.renderer.keyInput.on("keypress", key => { if (f.screen.handleKey(key)) key.preventDefault(); });
  try {
    await settle(f);
    f.mockInput.pressKey("p"); await settle(f); await settle(f);
    expect(f.screen.editing?.()).toBe(true);
    let frame = f.captureCharFrame();
    expect(frame).toContain("ADD TO PLAYLIST");
    expect(frame).toContain("Late Night Drive");
    expect(frame).not.toContain("Shared With Me");
    f.mockInput.pressArrow("down"); f.mockInput.pressEnter(); await settle(f);
    expect(f.calls.at(-1)).toEqual({ method: "playlist.action", params: { action: "add", id: "night", uri: "spotify:track:demo1" } });
    expect(f.notices.at(-1)).toContain("to Late Night Drive");
    expect(f.screen.editing?.()).toBe(false);

    // The last used list comes first, and adding the same song twice asks first.
    f.mockInput.pressKey("p"); await settle(f); await settle(f);
    frame = f.captureCharFrame();
    expect(frame.indexOf("Late Night Drive")).toBeLessThan(frame.indexOf("Road Trip"));
    const adds = () => f.calls.filter(call => call.method === "playlist.action").length;
    const before = adds();
    f.mockInput.pressEnter(); await settle(f);
    expect(adds()).toBe(before);
    expect(f.captureCharFrame()).toContain("Already added");
    f.screen.handleKey({ name: "escape" }); await settle(f);
    expect(f.screen.editing?.()).toBe(false);

    // Typing a name nothing matches creates that playlist with the song in it.
    f.mockInput.pressKey("p"); await settle(f); await settle(f);
    await f.mockInput.typeText("Gym"); await settle(f);
    expect(f.captureCharFrame()).toContain("New playlist “Gym”");
    f.mockInput.pressEnter(); await settle(f); await settle(f);
    expect(f.calls.filter(call => call.method === "playlist.action").slice(-2).map(call => call.params)).toEqual([{ action: "create", name: "Gym" }, { action: "add", id: "fresh", uri: "spotify:track:demo1" }]);
    expect(f.notices.at(-1)).toContain("to Gym");
  } finally { f.close(); }
});
