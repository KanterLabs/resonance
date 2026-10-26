import { createTestRenderer } from "@opentui/core/testing";
import { mountWorkspace } from "../../src/workspace/app.js";
import { normalizeRecipe, type ArcDraft, type ArcSlot, type Recipe } from "../../src/screens/arcs/model.js";
import type { Params } from "../../src/workspace/contracts.js";
import type { ParsedStatus } from "../../src/status.js";

export const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
export const slot = (i: number, extra: Partial<ArcSlot> = {}): ArcSlot => ({ slot: i, uri: `spotify:track:t${i}`, title: `Track ${i}`, artists: [`Artist ${i}`], album: null, duration_ms: 200_000, target: 0.5, energy: 0.1 * i, measure: "measured", tempo: 100 + i, score: 0.7, affinity: 0.8, curve_fit: 0.9, transition: 0.6, penalty: 0, reasons: [`reason ${i}`], pinned: false, seed: i === 0, ...extra });
export const draft = (slots: ArcSlot[] = [0, 1, 2, 3].map(i => slot(i)), extra: Partial<ArcDraft> = {}): ArcDraft => ({ recipe: { ...normalizeRecipe(undefined), seeds: ["spotify:track:t0"] }, slots, targets: [], confidence: 0.8, measured: slots.length, estimated: 0, unmeasured: 0, pool_size: 30, duration_ms: slots.length * 200_000, notes: [], playlist_id: null, ...extra });
export const status = { mode: { kind: "playing", startedAtMs: 0 }, playable: { uri: "spotify:track:t0", title: "Track 0", artists: ["Artist 0"], album: "", duration: 200_000 }, prototype: { position_ms: 0, volume_percent: 50 } } as unknown as ParsedStatus;

export interface WorkspaceOptions {
  playing?: boolean;
  size?: { width: number; height: number };
  /** How long `builder.build` takes, to act while an arc is building. */
  buildDelay?: number;
}

/** The whole workspace with a scripted engine, driven by real key sequences. */
export async function workspace(options: WorkspaceOptions = {}) {
  const setup = await createTestRenderer(options.size ?? { width: 110, height: 34 });
  const calls: { method: string; params: Params }[] = [];
  let current = draft();
  const known = new Map<string, ArcSlot>(Array.from({ length: 10 }, (_, i) => [slot(i).uri, slot(i)]));
  /** The next draft from these slots, numbered in order, keeping the recipe and playlist. */
  const next = (slots: ArcSlot[], recipe: Recipe = current.recipe) => {
    current = draft(slots.map((s, i) => ({ ...s, slot: i })), { recipe, playlist_id: current.playlist_id });
    return current;
  };
  const api = { async call<T>(method: string, params: Params = {}): Promise<T> {
    calls.push({ method, params });
    switch (method) {
      case "builder.state": return { recipe: normalizeRecipe(undefined), draft: null, fingerprinted: 12, current: options.playing === false ? null : { uri: "spotify:track:t0", title: "Track 0", artists: ["Artist 0"] } } as T;
      case "builder.build": {
        if (options.buildDelay) await tick(options.buildDelay);
        const recipe = params.recipe as Recipe;
        return next([0, 1, 2, 3].map(i => slot(i)), { ...recipe, seeds: recipe.seeds.length ? recipe.seeds : ["spotify:track:t0"] }) as T;
      }
      case "builder.restore": return next((params.uris as string[]).map(uri => known.get(uri)!).filter(Boolean), params.recipe as Recipe) as T;
      case "builder.reroll": return { slot: params.slot, alternatives: [slot(9, { slot: params.slot as number })] } as T;
      case "builder.choose": return next(current.slots.map((s, i) => i === params.slot ? slot(9, { pinned: true }) : s)) as T;
      case "builder.pin": return next(current.slots.map((s, i) => i === params.slot ? { ...s, pinned: !!params.pinned } : s)) as T;
      case "builder.ban": {
        const banned = current.slots[params.slot as number]!;
        return next(current.slots.filter((_, i) => i !== params.slot), { ...current.recipe, seeds: current.recipe.seeds.filter(seed => seed !== banned.uri) }) as T;
      }
      case "builder.move": {
        const slots = [...current.slots];
        const [moved] = slots.splice(params.from as number, 1);
        slots.splice(params.to as number, 0, { ...moved!, pinned: true });
        return next(slots) as T;
      }
      case "builder.play": return { queued: 4 - Number(params.slot ?? 0) } as T;
      case "builder.save": current = { ...current, playlist_id: params.overwrite ? current.playlist_id : `p${calls.filter(call => call.method === "builder.save").length}` }; return { id: current.playlist_id, overwritten: !!params.overwrite, tracks: current.slots.length } as T;
      case "builder.audition": return { uri: params.uri, ends_in_ms: 20_000 } as T;
      case "builder.audition_stop": return { stopped: true } as T;
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
    draft: () => current,
    builds: () => calls.filter(call => call.method === "builder.build"),
    last: (method: string) => calls.filter(call => call.method === method).at(-1),
    async frame() { await setup.renderOnce(); return setup.captureCharFrame(); },
    async type(text: string) { await keys.typeText(text); await tick(); },
    cleanup() { app.dispose(); setup.renderer.destroy(); },
  };
}
