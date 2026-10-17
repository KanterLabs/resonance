import { expect, test } from "bun:test";
import { DemoApi } from "../src/workspace/demo.js";
import { RpcError } from "../src/workspace/client.js";
import type { Page, Row } from "../src/workspace/contracts.js";

test("demo relative playback controls clamp bounds and previous restarts after three seconds", async () => {
  const demo = new DemoApi();
  const action = (action: string, value?: number) => demo.call("player.action", { action, ...(value === undefined ? {} : { value }) });
  await action("volume_relative", 5); expect(demo.status.prototype!.volume_percent).toBe(73);
  await action("volume_relative", 100); expect(demo.status.prototype!.volume_percent).toBe(100);
  await action("volume_relative", -200); expect(demo.status.prototype!.volume_percent).toBe(0);
  await action("play_pause"); await action("seek", 3_001);
  const first = demo.status.playable!.uri;
  await action("previous_or_restart");
  expect(demo.status.playable!.uri).toBe(first);
  expect(demo.status.mode).toEqual({ kind: "paused", positionMs: 0 });
  await action("seek_relative", -10_000); expect(demo.status.prototype!.position_ms).toBe(0);
  await action("seek_relative", 1_000_000); expect(demo.status.mode).toEqual({ kind: "paused", positionMs: demo.status.playable!.duration });
  await action("seek", 3_000); await action("previous_or_restart");
  expect(demo.status.playable!.uri).not.toBe(first);
  await expect(action("seek_relative", NaN)).rejects.toBeInstanceOf(RpcError);
  await expect(action("volume_relative", Infinity)).rejects.toBeInstanceOf(RpcError);
});

test("demo undo restores only the latest manual skip with position and paused state", async () => {
  const demo = new DemoApi();
  const action = (action: string, value?: number) => demo.call("player.action", { action, ...(value === undefined ? {} : { value }) });
  await expect(action("undo_skip")).rejects.toBeInstanceOf(RpcError);
  await action("seek", 12_345); await action("play_pause");
  const first = demo.status.playable!.uri;
  await action("next"); await action("undo_skip");
  expect(demo.status.playable!.uri).toBe(first);
  expect(demo.status.mode).toEqual({ kind: "paused", positionMs: 12_345 });
  expect(demo.status.prototype!.position_ms).toBe(12_345);
  await expect(action("undo_skip")).rejects.toBeInstanceOf(RpcError);
  await action("next"); await action("seek", 7_000);
  const second = demo.status.playable!.uri;
  await action("next"); await action("undo_skip");
  expect(demo.status.playable!.uri).toBe(second);
  expect(demo.status.prototype!.position_ms).toBe(7_000);
  await action("next"); await demo.call("queue.action", { action: "append", uri: first });
  await expect(action("undo_skip")).rejects.toBeInstanceOf(RpcError);
  await action("next"); await action("previous");
  await expect(action("undo_skip")).rejects.toBeInstanceOf(RpcError);
  const natural = new DemoApi();
  await natural.call("player.action", { action: "seek", value: natural.status.playable!.duration });
  natural.tick();
  await expect(natural.call("player.action", { action: "undo_skip" })).rejects.toBeInstanceOf(RpcError);
});

test("offline fixtures cover browsing, searching and playback without shared state", async () => {
  let broadcasts = 0;
  const demo = new DemoApi(() => broadcasts++);
  for (const kind of ["tracks", "albums", "artists", "playlists", "shows", "browse"]) {
    const page = await demo.call<Page>("library.list", { kind });
    expect(page.source).toBe("offline preview");
    expect(page.total).toBeGreaterThan(0);
    expect((await demo.call<Page>("library.detail", { kind, id: page.items[0]!.id })).items.length).toBeGreaterThan(0);
  }
  expect((await demo.call<Page>("search", { query: "Soft" })).items[0]!.title).toBe("Soft Geometry");
  expect((await demo.call<Page>("library.list", { kind: "tracks", filter: "", sort: "added" })).total).toBe(4);
  expect(await demo.call("player.status")).toMatchObject({ current: { uri: "spotify:track:demo-1" }, repeat: "off", shuffle: false, saved: true });
  const before = demo.status.prototype!.position_ms;
  demo.tick(); expect(demo.status.prototype!.position_ms).toBe(before + 1_000);
  await demo.call("player.action", { action: "play_pause" });
  demo.tick(); expect(demo.status.prototype!.position_ms).toBe(before + 1_000);
  await demo.call("player.action", { action: "volume", value: 25 });
  expect(demo.status.prototype!.volume_percent).toBe(25);
  await demo.call("player.action", { action: "play", uri: "spotify:episode:demo-1" });
  expect(demo.status.playable?.type).toBe("Episode");
  expect(broadcasts).toBeGreaterThan(3);
  expect(new DemoApi().status.prototype!.volume_percent).toBe(68);
});

test("queue duplicate identities and stale revision checks protect mutations", async () => {
  const demo = new DemoApi();
  const first = await demo.call<Page>("queue.list");
  await demo.call("queue.action", { action: "append", uri: "spotify:track:demo-1" });
  await demo.call("queue.action", { action: "append", uri: "spotify:track:demo-1" });
  const page = await demo.call<Page>("queue.list");
  expect(new Set(page.items.map(row => row.id)).size).toBe(page.total);
  expect(page.items.filter(row => row.uri === "spotify:track:demo-1")).toHaveLength(3);
  await expect(demo.call("queue.action", { action: "remove", entry_id: first.items[0]!.id, revision: first.revision })).rejects.toMatchObject({ code: "stale_revision" });
  const remove = page.items.at(-1)!;
  await demo.call("queue.action", { action: "remove", entry_id: remove.id, revision: page.revision });
  const updated = await demo.call<Page>("queue.list");
  expect(updated.items.some(row => row.id === remove.id)).toBe(false);
  await demo.call("queue.action", { action: "move", entry_id: updated.items.at(-1)!.id, revision: updated.revision, to: 0 });
  const moved = await demo.call<Page>("queue.list");
  expect(moved.items[0]!.id).toBe(updated.items.at(-1)!.id);
  await demo.call("queue.action", { action: "clear", revision: moved.revision });
  expect((await demo.call<Page>("queue.list")).total).toBe(0);
  expect(demo.status.mode.kind).toBe("stopped");
});

test("playlist, saved items, radio, cast and settings actions mutate only demo fixtures", async () => {
  const demo = new DemoApi();
  const playlist = await demo.call<Row>("playlist.action", { action: "create", name: "Test playlist" });
  await demo.call("playlist.action", { action: "rename", id: playlist.id, name: "Renamed" });
  await demo.call("playlist.action", { action: "add", id: playlist.id, uri: "spotify:track:demo-2" });
  expect((await demo.call<Page>("library.detail", { kind: "playlist", id: playlist.id })).items[0]!.title).toBe("Soft Geometry");
  await demo.call("playlist.action", { action: "remove", id: playlist.id, position: 0 });
  expect((await demo.call<Page>("library.detail", { kind: "playlist", id: playlist.id })).total).toBe(0);
  await demo.call("playlist.action", { action: "delete", id: playlist.id });
  expect((await demo.call<Page>("library.list", { kind: "playlists" })).items.some(row => row.id === playlist.id)).toBe(false);
  await demo.call("library.action", { action: "unsave", kind: "track", id: "demo-1" });
  expect((await demo.call<Page>("library.list", { kind: "tracks" })).items[0]!.saved).toBe(false);
  await demo.call("radio.action", { action: "start" });
  await demo.call("radio.action", { action: "discovery", value: 80 });
  expect(await demo.call("radio.status")).toMatchObject({ active: true, discovery: 80, source: "offline preview" });
  expect(await demo.call("radio.debug")).toMatchObject({ demo: true });
  await demo.call("cast.action", { action: "connect", id: "cast-1" });
  expect((await demo.call<Page>("cast.list")).items[0]!.meta!.active).toBe(true);
  await demo.call("cast.action", { action: "disconnect" });
  expect((await demo.call<Page>("cast.list")).items[0]!.meta!.active).toBe(false);
  await demo.call("settings.action", { action: "command", command: "volume 42" });
  expect((await demo.call<{ values: Record<string, unknown> }>("settings.get")).values.volume).toBe(42);
  await demo.call("settings.action", { action: "logout" });
  expect((await demo.call<{ values: Record<string, unknown> }>("settings.get")).values.logged_in).toBe(false);
});

test("unsupported and malformed requests reject RpcError and results are detached", async () => {
  const demo = new DemoApi();
  for (const [method, params] of [["unknown", {}], ["player.action", { action: "destroy" }], ["player.action", { action: "volume", value: -1 }], ["library.list", { kind: "bad" }], ["library.list", { kind: "tracks", offset: -1 }], ["playlist.action", { action: "add", id: "missing", uri: "bad" }], ["settings.action", { action: "command", command: "arbitrary-command" }]] as const) {
    await expect(demo.call(method, params)).rejects.toBeInstanceOf(RpcError);
  }
  const page = await demo.call<Page>("library.list", { kind: "tracks" });
  page.items[0]!.title = "Tampered";
  expect((await demo.call<Page>("library.list", { kind: "tracks" })).items[0]!.title).toBe("The Colour of Air");
});

test("demo radio retains its seed as playback advances and rejects podcast seeds", async () => {
  const demo = new DemoApi();
  const seed = structuredClone(demo.status.playable);
  await demo.call("radio.action", { action: "start" });
  await demo.call("queue.action", { action: "append", uri: "spotify:track:demo-2" });
  await demo.call("player.action", { action: "next" });
  expect(demo.status.playable?.uri).not.toBe(seed?.uri);
  expect(await demo.call("radio.status")).toMatchObject({ active: true, seed: seed?.uri, seed_track: seed });
  await demo.call("radio.action", { action: "stop" });
  expect(await demo.call("radio.status")).toMatchObject({ active: false, seed: null, seed_track: null });
  await expect(demo.call("radio.action", { action: "start", uri: "spotify:episode:demo-1" })).rejects.toMatchObject({ code: "invalid_params" });
  expect(await demo.call("radio.status")).toMatchObject({ active: false, seed_track: null });
});


test("offline radio parks context and attributes manual repeats without pretending to rank", async () => {
  const demo = new DemoApi();
  const count = (await demo.call<Page>("queue.list")).total;
  await demo.call("radio.action", { action: "start" });
  expect(demo.status.prototype!.up_next).toEqual([]);
  expect(await demo.call("radio.status")).toMatchObject({ queue_mode: "station", parked_count: count - 1, radio_pending_count: 0, waiting: true });
  await demo.call("queue.action", { action: "append", uri: "spotify:track:demo-1" });
  expect(demo.status.prototype!.up_next.map(track => track.uri)).toEqual(["spotify:track:demo-1"]);
  expect(demo.status.prototype!.up_next_origins).toEqual(["explicit"]);
  expect(await demo.call("radio.status")).toMatchObject({ explicit_pending_count: 1, waiting: false });
  await demo.call("radio.action", { action: "stop" });
  expect(await demo.call("radio.status")).toMatchObject({ queue_mode: "context", parked_count: 0 });
  expect((await demo.call<Page>("queue.list")).total).toBe(count + 1);
  expect(demo.status.prototype!.up_next.length).toBe(count);
});
