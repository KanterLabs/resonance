import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mountWorkspace } from "../src/workspace/app.js";
import { DemoApi } from "../src/workspace/demo.js";
import { ROUTES, type Page } from "../src/workspace/contracts.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test("global playback shortcuts dispatch exact actions from list screens and preserve local arrows", async () => {
  // Kitty carries Shift on Ctrl+letters; classic terminal control bytes cannot.
  const native = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const demo = new DemoApi();
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const app = mountWorkspace(native.renderer, { api: { async call<T>(method: string, params?: Record<string, unknown>) {
    calls.push({ method, params });
    return method === "player.action" ? {} as T : demo.call<T>(method, params);
  } }, theme: "light", reducedMotion: true, route: "queue" });
  try {
    app.setStatus(demo.status); await settle();
    native.mockInput.pressArrow("left", { ctrl: true });
    native.mockInput.pressArrow("right", { ctrl: true });
    native.mockInput.pressArrow("up", { ctrl: true });
    native.mockInput.pressArrow("down", { ctrl: true });
    native.mockInput.pressArrow("left", { meta: true });
    native.mockInput.pressArrow("right", { meta: true });
    native.mockInput.pressKey("z", { ctrl: true });
    await settle();
    expect(calls.filter(call => call.method === "player.action").map(call => call.params)).toEqual([
      { action: "previous_or_restart" }, { action: "next" },
      { action: "volume_relative", value: 5 }, { action: "volume_relative", value: -5 },
      { action: "seek_relative", value: -10_000 }, { action: "seek_relative", value: 10_000 }, { action: "undo_skip" },
    ]);
    calls.length = 0;
    native.mockInput.pressArrow("down");
    for (const direction of ["left", "right", "up", "down"] as const) {
      native.mockInput.pressArrow(direction, { ctrl: true, shift: true });
      native.mockInput.pressArrow(direction, { ctrl: true, meta: true });
      native.mockInput.pressArrow(direction, { meta: true, shift: true });
      native.mockInput.pressArrow(direction, { ctrl: true, super: true });
      native.mockInput.pressArrow(direction, { meta: true, hyper: true });
    }
    native.mockInput.pressKey("z", { ctrl: true, shift: true });
    await settle();
    expect(calls.filter(call => call.method === "player.action")).toEqual([]);
    app.setBindings({ "Ctrl+Right": "focus library", "Alt+Left": "focus browse", "Ctrl+z": "focus queue" });
    native.mockInput.pressArrow("right", { ctrl: true }); expect(app.route).toBe("library");
    native.mockInput.pressArrow("left", { meta: true }); expect(app.route).toBe("browse");
    native.mockInput.pressKey("z", { ctrl: true }); expect(app.route).toBe("queue");
    expect(calls.filter(call => call.method === "player.action")).toEqual([]);
    await native.renderOnce();
    expect(native.captureCharFrame()).toContain("Ctrl+Z undo");
    native.resize(60, 24); await native.renderOnce();
    expect(native.captureCharFrame()).toContain("^Z undo");
    app.setConnection(false, "Engine disconnected"); await native.renderOnce();
    expect(native.captureCharFrame()).toContain("Engine disconnected");
    app.setConnection(true, "Connected"); await native.renderOnce();
    expect(native.captureCharFrame()).toContain("^Z undo");
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("playback shortcuts and their custom bindings stay inside focused text editors", async () => {
  const native = await createTestRenderer({ width: 80, height: 24 });
  const demo = new DemoApi();
  const calls: string[] = [];
  const app = mountWorkspace(native.renderer, { api: { async call<T>(method: string, params?: Record<string, unknown>) {
    calls.push(method); return demo.call<T>(method, params);
  } }, theme: "light", reducedMotion: true });
  try {
    app.setStatus(demo.status);
    app.setBindings({ "Ctrl+Right": "focus queue", "Ctrl+z": "focus library" });
    for (const editor of ["popup", "search", "command"] as const) {
      app.navigate(editor === "search" ? "search" : "now-playing");
      if (editor !== "search") await native.mockInput.typeText(editor === "popup" ? "/" : ":");
      await settle();
      const route = app.route;
      calls.length = 0;
      for (const direction of ["left", "right", "up", "down"] as const) native.mockInput.pressArrow(direction, { ctrl: true });
      for (const direction of ["left", "right"] as const) native.mockInput.pressArrow(direction, { meta: true });
      native.mockInput.pressKey("z", { ctrl: true });
      await settle();
      expect(app.route).toBe(route);
      expect(calls).not.toContain("player.action");
      expect(calls).not.toContain("settings.action");
    }
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("Now Playing popup captures route, theme, configured binding and quit letters until Escape", async () => {
  const native = await createTestRenderer({ width: 80, height: 24 });
  const api = new DemoApi();
  let quit = 0;
  const app = mountWorkspace(native.renderer, { api, theme: "light", reducedMotion: true, onQuit: () => quit++ });
  try {
    app.setStatus(api.status);
    app.setBindings({ z: "focus queue" });
    await native.mockInput.typeText("/");
    await native.mockInput.typeText("1lqrz");
    native.mockInput.pressKey("r", { shift: true });
    await native.renderOnce();
    expect(app.route).toBe("now-playing");
    expect(app.context.theme()).toBe("light");
    expect(quit).toBe(0);
    expect(native.captureCharFrame()).toContain("1lqrzR");
    for (const [width, height] of [[189, 34], [80, 24]]) {
      native.resize(width!, height!); await native.renderOnce(); await native.renderOnce();
      const popup = native.renderer.root.findDescendantById("np-quick-search")!;
      const parent = native.renderer.root.findDescendantById("np-root")!;
      expect(popup.x).toBeGreaterThanOrEqual(parent.x);
      expect(popup.y).toBeGreaterThanOrEqual(parent.y);
      expect(popup.x + popup.width).toBeLessThanOrEqual(parent.x + parent.width);
      expect(popup.y + popup.height).toBeLessThanOrEqual(parent.y + parent.height);
      expect(Math.abs(popup.x + popup.width / 2 - parent.x - parent.width / 2)).toBeLessThanOrEqual(1);
    }
    native.mockInput.pressKey("ESCAPE");
    await new Promise(resolve => setTimeout(resolve, 60));
    await native.mockInput.typeText("2");
    expect(app.route).toBe("queue");
  } finally { app.dispose(); native.renderer.destroy(); }
});

test("Now Playing native popup keys act on the selected cached track after refresh failure", async () => {
  for (const action of ["play", "play_next", "append"] as const) {
    const native = await createTestRenderer({ width: 80, height: 24 });
    const api = new DemoApi();
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const page: Page = { items: [
      { id: "alpha", kind: "track", title: "Quick Alpha", subtitle: "First artist", uri: "spotify:track:alpha" },
      { id: "beta", kind: "track", title: "Quick Beta", subtitle: "Second artist", uri: "spotify:track:beta" },
    ], offset: 0, limit: 20, total: 2, has_more: false, source: "search_cache", refresh_available: true };
    const app = mountWorkspace(native.renderer, {
      theme: "light", reducedMotion: true,
      api: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ method, params });
        if (method === "search") {
          if (params?.refresh) throw new Error("refresh unavailable");
          return page as T;
        }
        if (method === "player.action" || method === "queue.action") return {} as T;
        return api.call<T>(method, params);
      } },
    });
    try {
      app.setStatus(api.status);
      await native.mockInput.typeText("/");
      await native.mockInput.typeText("Quick");
      await new Promise(resolve => setTimeout(resolve, 220));
      await native.renderOnce();
      expect(native.captureCharFrame()).toContain("Quick Beta");
      expect(calls.some(call => call.method === "search" && call.params?.refresh === true)).toBe(true);
      native.mockInput.pressArrow("down");
      if (action === "play") native.mockInput.pressEnter();
      else native.mockInput.pressKey(action === "play_next" ? "n" : "e", { ctrl: true });
      await settle();
      const mutations = calls.filter(call => call.method === "player.action" || call.method === "queue.action");
      expect(mutations).toEqual([{ method: action === "play" ? "player.action" : "queue.action", params: { action, uri: "spotify:track:beta" } }]);
      expect(app.route).toBe("now-playing");
      await native.mockInput.typeText("2");
      expect(app.route).toBe("queue");
    } finally { app.dispose(); native.renderer.destroy(); }
  }
});
test("Browse opens the selected category with native Enter and returns with Backspace", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 });
  const api = new DemoApi();
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const app = mountWorkspace(renderer, { api: { async call<T>(method: string, params?: Record<string, unknown>) { calls.push({ method, params }); return api.call<T>(method, params); } }, theme: "light", reducedMotion: true });
  try {
    app.navigate("browse"); await settle();
    mockInput.pressArrow("down"); mockInput.pressEnter(); await settle();
    expect(calls.some(call => call.method === "library.detail" && call.params?.id === "category-2")).toBe(true);
    const before = calls.filter(call => call.method === "library.list" && call.params?.kind === "browse").length;
    mockInput.pressBackspace(); await settle();
    expect(calls.filter(call => call.method === "library.list" && call.params?.kind === "browse")).toHaveLength(before + 1);
  } finally { app.dispose(); renderer.destroy(); }
});

test("complete workspace navigates every real screen in both themes at 80x24", async () => {
  const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ width: 80, height: 24 });
  const api = new DemoApi();
  const app = mountWorkspace(renderer, { api, theme: "light", reducedMotion: true });
  try {
    app.setStatus(api.status);
    for (const theme of ["light", "dark"] as const) {
      app.context.setTheme(theme);
      for (const route of ROUTES) {
        app.navigate(route); await settle(); await renderOnce();
        const frame = captureCharFrame();
        expect(frame).toContain("RESONANCE");
        expect(frame).toContain("The Colour of Air");
        expect(frame.split("\n").length).toBeLessThanOrEqual(25);
        expect(app.route).toBe(route);
      }
    }
    // Prompts capture route digits, appearance letters and quit without navigating.
    app.navigate("search"); await settle(); await mockInput.typeText("1lq"); await renderOnce();
    expect(app.route).toBe("search");
    expect(captureCharFrame()).toContain("1lq");
    mockInput.pressKey("ESCAPE"); await new Promise(resolve => setTimeout(resolve, 60));
    await mockInput.typeText("2"); await settle();
    expect(app.route).toBe("queue");
  } finally { app.dispose(); renderer.destroy(); }
});

test("workspace global transport, notification dedup, motion restart and disposal", async () => {
  const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ width: 120, height: 35 });
  const api = new DemoApi();
  const calls: string[] = [];
  let quit = 0;
  const app = mountWorkspace(renderer, { api: { async call(method, params) { calls.push(method); return api.call(method, params) as any; } }, theme: "light", onQuit: () => quit++ });
  try {
    app.setStatus({ ...api.status, notifications: [{ id: 1, message: "Radio refilled", created_at_ms: 1 }] });
    await renderOnce(); expect(captureCharFrame()).toContain("Radio refilled");
    app.notify("New notice"); app.setStatus({ ...api.status, notifications: [{ id: 1, message: "Radio refilled", created_at_ms: 1 }] });
    await renderOnce(); expect(captureCharFrame()).toContain("New notice");
    app.navigate("queue"); await settle(); await mockInput.typeText(" "); await settle();
    expect(calls).toContain("player.action");
    app.context.setReducedMotion(true); await settle(); expect(app.context.reducedMotion()).toBe(true);
    await mockInput.typeText("q"); expect(quit).toBe(1);
    app.setStatus(api.status); app.dispose();
    expect(() => app.setConnection(false, "Late socket close")).not.toThrow();
    expect(() => app.context.setReducedMotion(false)).not.toThrow();
  } finally { app.dispose(); renderer.destroy(); }
});

test("configured workspace bindings navigate and move locally while prompts retain normal text", async () => {
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24 });
  const api = new DemoApi();
  const app = mountWorkspace(renderer, { api, theme: "light", reducedMotion: true });
  try {
    app.setBindings({ z: "focus queue", j: "move down", "Ctrl+p": "focus playlists" });
    await mockInput.typeText("z"); await settle(); expect(app.route).toBe("queue");
    await mockInput.typeText("j"); await settle(); await renderOnce();
    expect(captureCharFrame()).toContain("The Colour of Air");
    expect(app.bindings().z).toBe("focus queue");
    mockInput.pressKey("p", { ctrl: true }); await settle(); expect(app.route).toBe("playlists");
    app.navigate("search"); await settle(); await mockInput.typeText("zj"); await renderOnce();
    expect(app.route).toBe("search"); expect(captureCharFrame()).toContain("zj");
    await app.command("focus library"); expect(app.route).toBe("library");
  } finally { app.dispose(); renderer.destroy(); }
});

test("Shift+R in Now Playing uses the player action once with its current seed", async () => {
  const { renderer, mockInput, renderOnce } = await createTestRenderer({ width: 120, height: 35 });
  const api = new DemoApi();
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const app = mountWorkspace(renderer, { api: { async call<T>(method: string, params?: Record<string, unknown>) { calls.push({ method, params }); return api.call<T>(method, params); } }, theme: "light", reducedMotion: true });
  try {
    app.setStatus(api.status); await settle(); await renderOnce();
    mockInput.pressKey("r", { shift: true }); await settle();
    const radio = calls.filter(call => call.method === "radio.action");
    expect(radio).toHaveLength(1);
    expect(radio[0]?.params).toEqual({ action: "start", uri: api.status.playable!.uri });
  } finally { app.dispose(); renderer.destroy(); }
});
