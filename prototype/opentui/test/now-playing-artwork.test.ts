import { expect, test } from "bun:test";
import { artworkLines, type Artwork } from "../src/screens/now-playing/index.js";
import { testPng } from "./helpers/png.js";
import type { ImageRenderable } from "@opentui/core";
import { deferred, trackStatus, coloredArtwork, settle, nativeRgb, fixtureCtx } from "./helpers/now-playing.js";

test("native covers retain full image detail, repaint themes locally, and preserve metadata", async () => {
  const f = await fixtureCtx({ nativeArtwork: true, artwork: params => ({
    ...coloredArtwork(String(params.uri), Number(params.width), Number(params.height)),
    image: { mime: "image/png", width: 64, height: 64, data: testPng(64, 64) },
  }) });
  try {
    await settle(f);
    const node = f.screen.root.findDescendantById("np-cover-image") as ImageRenderable;
    expect(node.visible).toBe(true);
    expect(node.effectiveProtocol).toBe("kitty");
    expect(node.image?.width).toBe(64);
    expect(node.image?.height).toBe(64);
    expect(f.calls.filter(call => call.method === "player.artwork")[0]?.params?.format).toBe("png");
    expect(f.screen.root.findDescendantById("np-art-0")?.visible).toBe(false);
    const before = node.image!.raw().data.slice();
    const requests = f.calls.filter(call => call.method === "player.artwork").length;
    f.screen.setTheme("dark"); await settle(f);
    expect(node.image!.raw().data).not.toEqual(before);
    expect(f.calls.filter(call => call.method === "player.artwork")).toHaveLength(requests);
    expect(f.captureCharFrame()).toContain("Now Playing".toUpperCase());
  } finally { f.close(); }
});

test("native covers stay centered inside the cover box after Kitty and Sixel geometry resizes", async () => {
  for (const nativeArtwork of [true, "sixel"] as const) {
    const f = await fixtureCtx({ width: 96, height: 34, nativeArtwork, artwork: params => ({
      ...coloredArtwork(String(params.uri), Number(params.width), Number(params.height)),
      image: { mime: "image/png", width: 64, height: 64, data: testPng(64, 64) },
    }) });
    let resolution = { width: 960, height: 707 };
    Object.defineProperty(f.renderer, "resolution", { configurable: true, get: () => resolution });
    try {
      for (const size of [[96, 34], [80, 24], [120, 40]] as const) {
        resolution = { width: size[0] * 10, height: size[1] * 20.8 };
        f.resize(size[0], size[1]);
        await settle(f);
        const node = f.screen.root.findDescendantById("np-cover-image") as ImageRenderable;
        const box = f.screen.root.findDescendantById("np-cover-box")!;
        expect(node.visible).toBe(true);
        expect(node.x).toBeGreaterThanOrEqual(box.x);
        expect(node.y).toBeGreaterThanOrEqual(box.y);
        expect(node.x + node.width).toBeLessThanOrEqual(box.x + box.width);
        expect(node.y + node.height).toBeLessThanOrEqual(box.y + box.height);
        expect(node.image?.width).toBeGreaterThanOrEqual(64);
        expect(node.image?.height).toBeGreaterThanOrEqual(64);
        expect(node.image?.height).toBeGreaterThan(node.image?.width ?? 0);
        const fitted = node.getFittedSize(node.width, node.height);
        const contentWidth = fitted.width * resolution.width / size[0] * 64 / (node.image?.width ?? 64);
        const contentHeight = fitted.height * resolution.height / size[1] * 64 / (node.image?.height ?? 64);
        expect(Math.abs(Math.round(contentWidth) - Math.round(contentHeight))).toBeLessThanOrEqual(1);
      }
    } finally { f.close(); }
  }
});

test("Kitty pixel geometry arriving late refits the cached cover without a backend request", async () => {
  const paused = trackStatus(); paused.mode = { kind: "paused", positionMs: 82_000 };
  const f = await fixtureCtx({ nativeArtwork: true, status: paused, reducedMotion: true, artwork: params => ({
    ...coloredArtwork(String(params.uri), Number(params.width), Number(params.height)),
    image: { mime: "image/png", width: 64, height: 64, data: testPng(64, 64) },
  }) });
  try {
    await settle(f);
    const node = f.screen.root.findDescendantById("np-cover-image") as ImageRenderable;
    expect(node.image?.height).toBe(64);
    const requests = f.calls.filter(call => call.method === "player.artwork").length;
    Object.defineProperty(f.renderer, "resolution", { get: () => ({ width: 960, height: 782 }) });
    f.renderer.emit("frame"); await settle(f);
    expect(node.image?.width).toBe(64);
    expect(node.image?.height).toBe(74);
    expect(f.calls.filter(call => call.method === "player.artwork")).toHaveLength(requests);
  } finally { f.close(); }
});

test("Sixel geometry arriving while paused switches from cells to native artwork", async () => {
  const paused = trackStatus(); paused.mode = { kind: "paused", positionMs: 82_000 };
  const f = await fixtureCtx({ nativeArtwork: "sixel", status: paused, reducedMotion: true, artwork: params => ({
    ...coloredArtwork(String(params.uri), Number(params.width), Number(params.height)),
    ...(params.format === "png" ? { image: { mime: "image/png" as const, width: 64, height: 64, data: testPng(64, 64) } } : {}),
  }) });
  try {
    await settle(f);
    const node = f.screen.root.findDescendantById("np-cover-image") as ImageRenderable;
    expect(node.visible).toBe(false);
    Object.defineProperty(f.renderer, "resolution", { get: () => ({ width: 960, height: 680 }) });
    f.renderer.emit("frame"); await settle(f);
    expect(node.visible).toBe(true);
    expect(node.effectiveProtocol).toBe("sixel");
    expect(f.calls.filter(call => call.method === "player.artwork").at(-1)?.params?.format).toBe("png");
  } finally { f.close(); }
});

test("late native covers cannot replace a newer track and bad high-resolution data falls back to pixels", async () => {
  const first = deferred<Artwork>();
  const f = await fixtureCtx({ nativeArtwork: true, artwork: params => params.uri === "spotify:track:demo1" ? first.promise : ({
    ...coloredArtwork(String(params.uri), Number(params.width), Number(params.height)),
    image: { mime: "image/png", width: 64, height: 64, data: "broken" },
  }) });
  try {
    f.update(trackStatus(1)); await settle(f);
    first.resolve({ ...coloredArtwork("spotify:track:demo1", 20, 10), image: { mime: "image/png", width: 64, height: 64, data: testPng(64, 64) } });
    await settle(f);
    const node = f.screen.root.findDescendantById("np-cover-image") as ImageRenderable;
    expect(node.visible).toBe(false);
    expect(node.image).toBeNull();
    expect(f.screen.root.findDescendantById("np-art-0")?.visible).toBe(true);
  } finally { f.close(); }
});

test("Now Playing renders live metadata, artwork fallback, and truthful ambient label", async () => {
  const f = await fixtureCtx();
  try {
    await f.renderOnce();
    let frame = f.captureCharFrame();
    expect(frame).toContain("The Colour of Air");
    expect(frame).toContain("TC");
    expect(frame).toContain("1:22");
    expect(frame).toContain("Reduced motion");
    expect(frame).not.toContain("Cover initials");

    f.update(trackStatus(1, 14_000));
    await f.renderOnce();
    frame = f.captureCharFrame();
    expect(frame).toContain("Soft Geometry");
    expect(frame).toContain("0:14");
    f.screen.setTheme("dark");
    await f.renderOnce();
    expect(f.captureCharFrame()).toContain("Soft Geometry");
  } finally { f.close(); }
  expect(f.unsubscribed()).toBe(true);
});

test("artworkLines validates the RGB contract and pairs two pixels per terminal cell", () => {
  const value = coloredArtwork("spotify:track:demo1", 2, 1);
  const lines = artworkLines(value);
  expect(lines).toHaveLength(1);
  expect(lines?.[0]?.chunks).toHaveLength(2);
  expect(lines?.[0]?.chunks.map(chunk => chunk.text)).toEqual(["▀", "▀"]);
  expect(lines?.[0]?.chunks[0]?.fg?.toInts()).toEqual([17, 34, 51, 255]);
  expect(lines?.[0]?.chunks[0]?.bg?.toInts()).toEqual([68, 85, 102, 255]);
  expect(artworkLines({ ...value, available: false })).toBeNull();
  expect(artworkLines({ ...value, pixels: ["#112233"] })).toBeNull();
  expect(artworkLines({ ...value, pixels: ["#112233", "not-a-pixel", "#445566", "#778899"] })).toBeNull();
});

test("valid artwork renders colored half-block cells and removes the literal cover fallback", async () => {
  const f = await fixtureCtx({ artwork: params => coloredArtwork(String(params.uri), Number(params.width), Number(params.height)) });
  try {
    await f.renderOnce();
    await settle(f);
    const frame = f.captureCharFrame();
    const cover = f.screen.root.findDescendantById("np-cover");
    const art = f.screen.root.findDescendantById("np-art-0");
    expect(cover?.visible).toBe(false);
    expect(art).toBeDefined();
    expect(frame).toContain("▀");
    expect(frame).not.toContain("TC");
    expect(nativeRgb(f.renderer, art!.x, art!.y, "fg")).toEqual([17, 34, 51]);
    expect(nativeRgb(f.renderer, art!.x, art!.y, "bg")).toEqual([68, 85, 102]);
  } finally { f.close(); }
});

test("malformed artwork pixels keep the initials fallback without throwing", async () => {
  const f = await fixtureCtx({ artwork: params => ({
    available: true,
    uri: String(params.uri),
    width: Number(params.width),
    height: Number(params.height),
    pixels: ["#bad"],
  }) });
  try {
    await f.renderOnce();
    await settle(f);
    expect(f.screen.root.findDescendantById("np-cover")?.visible).toBe(true);
    expect(f.screen.root.findDescendantById("np-art-0")).toBeUndefined();
    expect(f.captureCharFrame()).toContain("TC");
  } finally { f.close(); }
});

test("artwork requests use true and compact dimensions", async () => {
  const normal = await fixtureCtx({ width: 96, height: 34, artwork: params => coloredArtwork(String(params.uri), Number(params.width), Number(params.height)) });
  try {
    await normal.renderOnce();
    await settle(normal);
    expect(normal.calls.find(call => call.method === "player.artwork")?.params).toEqual({ uri: "spotify:track:demo1", width: 20, height: 10 });
  } finally { normal.close(); }

  const compact = await fixtureCtx({ width: 80, height: 24, artwork: params => coloredArtwork(String(params.uri), Number(params.width), Number(params.height)) });
  try {
    await compact.renderOnce();
    await settle(compact);
    expect(compact.calls.find(call => call.method === "player.artwork")?.params).toEqual({ uri: "spotify:track:demo1", width: 12, height: 6 });
  } finally { compact.close(); }
});

test("stale artwork responses are ignored after a track change", async () => {
  const oldArtwork = deferred<Artwork>();
  const newArtwork = deferred<Artwork>();
  let artworkCalls = 0;
  const f = await fixtureCtx({ artwork: () => {
    artworkCalls++;
    return artworkCalls === 1 ? oldArtwork.promise : newArtwork.promise;
  } });
  try {
    await f.renderOnce();
    expect(artworkCalls).toBe(1);
    f.update(trackStatus(1));
    expect(artworkCalls).toBe(2);

    oldArtwork.resolve(coloredArtwork("spotify:track:demo1", 20, 10));
    await settle(f);
    expect(f.screen.root.findDescendantById("np-cover")?.visible).toBe(true);
    expect(f.screen.root.findDescendantById("np-art-0")).toBeUndefined();

    newArtwork.resolve(coloredArtwork("spotify:track:demo2", 20, 10));
    await settle(f);
    expect(f.screen.root.findDescendantById("np-cover")?.visible).toBe(false);
    expect(f.screen.root.findDescendantById("np-art-0")).toBeDefined();
  } finally { f.close(); }
});

test("stale artwork responses are ignored after disposal", async () => {
  const pendingArtwork = deferred<Artwork>();
  const f = await fixtureCtx({ artwork: () => pendingArtwork.promise });
  const cover = f.screen.root.findDescendantById("np-cover")!;
  try {
    await f.renderOnce();
    f.screen.dispose();
    pendingArtwork.resolve(coloredArtwork("spotify:track:demo1", 20, 10));
    await Promise.resolve();
    await Promise.resolve();
    expect(cover.visible).toBe(true);
    expect(f.notices).toEqual([]);
  } finally { f.renderer.destroy(); }
});

test("status updates for the same identity do not issue another artwork RPC", async () => {
  const f = await fixtureCtx();
  try {
    await f.renderOnce();
    const artworkCalls = () => f.calls.filter(call => call.method === "player.artwork");
    expect(artworkCalls()).toHaveLength(1);
    f.update(trackStatus(0, 83_000));
    await f.renderOnce();
    expect(artworkCalls()).toHaveLength(1);
    f.update(trackStatus(1, 12_000));
    await f.renderOnce();
    expect(artworkCalls()).toHaveLength(2);
  } finally { f.close(); }
});
