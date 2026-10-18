import { expect, test } from "bun:test";
import { InputRenderable, type KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createSearchScreen } from "../src/screens/search/index.js";
import { PageLoader } from "../src/screens/search/model.js";
import type { Page, Params, Row, ScreenContext } from "../src/workspace/contracts.js";

// Failure cases established before implementation:
// - Every key starts a request, or the debounce keeps the first query.
// - Old successes/errors/automatic refreshes paint during the debounce window.
// - Clearing, Escape, or disposal leaves a timer or an in-flight render alive.
// - Enter waits for debounce, submits twice, plays a row, or loses input focus.
// - Saved matches vanish, duplicate catalog rows, lose saved state, or inflate
//   catalog ranges, totals, offsets, and the next-page decision.
// - A refresh changes selected identity when saved/catalog ordering changes.
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const track = (id: string, title = id): Row => ({ id, kind: "track", title, subtitle: "Artist", uri: `spotify:track:${id}` });
const page = (items: Row[], extra: Partial<Page> = {}): Page => ({ items, offset: 0, limit: 10, total: items.length, has_more: false, source: "spotify", ...extra });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(respond: (method: string, params?: Params) => unknown | Promise<unknown>, initial?: string) {
  const setup = await createTestRenderer({ width: 120, height: 26 });
  const calls: Array<{ method: string; params?: Params }> = [];
  const previous = new InputRenderable(setup.renderer, { id: "search-previous-focus", width: 1 });
  setup.renderer.root.add(previous); previous.focus();
  const ctx: ScreenContext = {
    renderer: setup.renderer,
    api: { async call<T>(method: string, params?: Params) { calls.push({ method, params }); return await respond(method, params) as T; } },
    theme: () => "dark", setTheme() {}, reducedMotion: () => true, setReducedMotion() {},
    status: () => null, onStatus: () => () => {}, navigate() {}, notify() {},
  };
  const screen = createSearchScreen(ctx, initial === undefined ? {} : { query: initial });
  setup.renderer.root.add(screen.root);
  const listener = (key: KeyEvent) => { if (screen.handleKey(key)) key.preventDefault(); };
  setup.renderer.keyInput.on("keypress", listener);
  await wait();
  return { ...setup, calls, screen, previous,
    searchCalls: () => calls.filter(call => call.method === "search"),
    cleanup() { setup.renderer.keyInput.off("keypress", listener); screen.dispose(); setup.renderer.destroy(); },
  };
}

test("full search debounces native text changes, keeps input focus and submits Enter immediately once", async () => {
  const f = await fixture(() => page([track("answer", "Answer")], { local_items: [{ ...track("saved", "Saved match"), saved: true }] }));
  try {
    expect(f.screen.editing?.()).toBe(true);
    const input = f.renderer.currentFocusedRenderable;
    await f.mockInput.typeText("ab"); await wait(85);
    await f.mockInput.typeText("c"); await wait(85);
    expect(f.searchCalls()).toHaveLength(0);
    await wait(85);
    expect(f.searchCalls().map(call => call.params?.query)).toEqual(["abc"]);
    expect(f.renderer.currentFocusedRenderable).toBe(input!);
    await f.renderOnce();
    const liveFrame = f.captureCharFrame();
    expect(liveFrame).toContain("Saved match [saved]");
    expect(liveFrame).toContain("Answer");
    expect(liveFrame).toContain("1 saved");
    await Bun.write("/tmp/resonance-search-live-frame.txt", liveFrame);
    await f.mockInput.typeText("d");
    f.mockInput.pressEnter();
    expect(f.screen.editing?.()).toBe(false);
    expect(f.renderer.currentFocusedRenderable).toBe(f.previous);
    expect(f.searchCalls().map(call => call.params?.query)).toEqual(["abc", "abcd"]);
    await wait(180);
    expect(f.searchCalls()).toHaveLength(2);
    expect(f.calls.every(call => call.method === "search")).toBe(true);
    await f.renderOnce();
    expect(f.captureCharFrame()).toContain("Answer");
  } finally { f.cleanup(); }
});

test("a keystroke invalidates an old response immediately before the replacement debounce fires", async () => {
  const old = deferred<Page>();
  const f = await fixture((_method, params) => params?.query === "old" ? old.promise : page([track("fresh", "Fresh result")]), "old");
  try {
    f.mockInput.pressKey("/");
    await f.mockInput.typeText("x");
    old.resolve(page([track("stale", "Stale result")]));
    await wait(); await f.renderOnce();
    expect(f.captureCharFrame()).not.toContain("Stale result");
    expect(f.captureCharFrame()).toContain("Waiting to search");
    expect(f.searchCalls()).toHaveLength(1);
    await wait(180); await f.renderOnce();
    expect(f.searchCalls().at(-1)?.params?.query).toBe("oldx");
    expect(f.captureCharFrame()).toContain("Fresh result");
    expect(f.screen.editing?.()).toBe(true);
  } finally { f.cleanup(); }
});

test("clear cancels pending debounce and ignores stale failures while remaining editable", async () => {
  const old = deferred<Page>();
  const f = await fixture(() => old.promise, "old");
  try {
    f.mockInput.pressKey("/");
    await f.mockInput.typeText("x");
    for (let n = 0; n < 4; n++) f.mockInput.pressBackspace();
    old.reject(new Error("stale failure"));
    await wait(180); await f.renderOnce();
    expect(f.searchCalls()).toHaveLength(1);
    expect(f.captureCharFrame()).not.toContain("stale failure");
    expect(f.captureCharFrame()).not.toContain("Loading");
    expect(f.captureCharFrame()).toContain("Search tracks");
    expect(f.screen.editing?.()).toBe(true);
  } finally { f.cleanup(); }
});

test("Escape cancels pending search and in-flight completion without a stuck loading message", async () => {
  const pending = deferred<Page>();
  const f = await fixture(() => pending.promise);
  try {
    await f.mockInput.typeText("pending");
    f.mockInput.pressEscape();
    await wait(180);
    expect(f.searchCalls()).toHaveLength(0);
    expect(f.screen.editing?.()).toBe(false);
    expect(f.renderer.currentFocusedRenderable).toBe(f.previous);
    f.mockInput.pressKey("/");
    await f.mockInput.typeText("x"); await wait(180);
    expect(f.searchCalls()).toHaveLength(1);
    f.mockInput.pressEscape();
    await wait(40);
    expect(f.screen.editing?.()).toBe(false);
    pending.resolve(page([track("late", "Late result")]));
    await wait(); await f.renderOnce();
    expect(f.captureCharFrame()).not.toContain("Late result");
    expect(f.captureCharFrame()).not.toContain("Loading");
    expect(f.captureCharFrame()).toContain("Search canceled");
  } finally { f.cleanup(); }
});

test("disposing full search cancels its timer and prevents delayed results or reopening", async () => {
  const f = await fixture(() => page([track("unexpected")]));
  try {
    await f.mockInput.typeText("pending");
    f.screen.dispose();
    await wait(180);
    expect(f.searchCalls()).toHaveLength(0);
    expect(f.screen.root.isDestroyed).toBe(true);
  } finally { f.cleanup(); }
  const pending = deferred<Page>();
  const g = await fixture(() => pending.promise, "pending");
  try {
    g.screen.dispose(); pending.resolve(page([track("late")])); await wait();
    expect(g.screen.root.isDestroyed).toBe(true);
  } finally { g.cleanup(); }
});

test("loader merges saved matches first without changing catalog metadata, rows or pagination", async () => {
  const local = { ...track("local", "Saved only"), saved: true };
  const duplicate = { ...track("duplicate", "Saved duplicate"), saved: true };
  const catalog = [track("duplicate", "Catalog duplicate"), track("remote", "Catalog only")];
  const raw = page(catalog, { local_items: [local, duplicate], total: 25, has_more: true });
  const shown: Array<{ page: Page; rows: Row[] }> = []; const messages: string[] = [];
  const loader = new PageLoader({ async call<T>(_method: string, params?: Params) {
    return (params?.offset ? page([track("next")], { offset: 10, total: 25, has_more: true }) : raw) as T;
  } }, (p, rows) => shown.push({ page: p, rows }), message => messages.push(message));
  await loader.load("search", { query: "test", offset: 0, limit: 10 });
  expect(shown.at(-1)?.rows.map(item => item.id)).toEqual(["local", "duplicate", "remote"]);
  expect(shown.at(-1)?.rows[1]?.saved).toBe(true);
  expect(shown.at(-1)?.page).toBe(raw);
  expect(raw.items).toEqual(catalog);
  expect(raw.total).toBe(25);
  expect(messages.at(-1)).toContain("2 saved");
  expect(messages.at(-1)).toContain("1–2 of 25");
  await loader.load("search", { query: "test", offset: 10, limit: 10 });
  expect(shown.at(-1)?.rows.map(item => item.id)).toEqual(["next"]);
  expect(messages.at(-1)).toContain("11–11 of 25");
  loader.dispose();
});

test("loader deduplicates missing URIs by kind and id, reports saved-only results accurately", async () => {
  const saved = { ...track("one"), uri: undefined, saved: true };
  const raw = page([{ ...saved, saved: undefined }, { ...saved, kind: "album" }], { local_items: [saved], total: 2 });
  let rows: Row[] = []; const messages: string[] = [];
  const loader = new PageLoader({ async call<T>() { return raw as T; } }, (_p, next) => { rows = next; }, value => messages.push(value));
  await loader.load("search", {});
  expect(rows.map(item => item.kind)).toEqual(["track", "album"]);
  raw.items = []; raw.total = 0;
  await loader.load("search", { refresh: true });
  expect(rows).toHaveLength(1);
  expect(messages.at(-1)).toContain("1 saved");
  expect(messages.at(-1)).toContain("0–0 of 0");
  expect(messages.at(-1)).not.toContain("No results");
  loader.dispose();
});

test("saved matches survive automatic refresh and full search pages by catalog offsets", async () => {
  const remote = deferred<Page>();
  const f = await fixture((_method, params) => {
    if (params?.refresh) return remote.promise;
    if (params?.offset) return page([track("next", "Next catalog page")], { offset: 10, total: 21, has_more: true });
    return page([track("catalog", "Catalog result")], { local_items: [{ ...track("saved", "Saved result"), saved: true }], total: 21, has_more: true, refresh_available: true });
  }, "query");
  try {
    await f.renderOnce();
    expect(f.captureCharFrame()).toContain("Saved result");
    expect(f.captureCharFrame()).toContain("saved");
    f.mockInput.pressArrow("down");
    remote.resolve(page([track("saved", "Saved catalog copy"), track("catalog", "Catalog result")], { local_items: [{ ...track("saved", "Saved result"), saved: true }], total: 21, has_more: true }));
    await wait();
    f.mockInput.pressEnter(); await wait();
    expect(f.calls.at(-1)).toEqual({ method: "player.action", params: { action: "play", uri: "spotify:track:catalog" } });
    f.mockInput.pressKey("]"); await wait(); await f.renderOnce();
    expect(f.searchCalls().at(-1)?.params?.offset).toBe(10);
    expect(f.captureCharFrame()).toContain("Next catalog page");
    expect(f.captureCharFrame()).not.toContain("Saved result");
  } finally { f.cleanup(); }
});
