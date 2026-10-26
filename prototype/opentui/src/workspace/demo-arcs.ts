import { RpcError } from "./client.js";
import type { Params, Row } from "./contracts.js";
import { DEFAULT_PRESETS, normalizeRecipe, sampleCurve, type ArcDraft, type ArcSlot, type Recipe } from "../screens/arcs/model.js";

function fail(code: string, message: string): never { throw new RpcError(code, message); }

/** Illustrative arcs over the demo fixtures. Energies are invented, never measured. */
export class DemoArcs {
  private recipe: Recipe | null = null;
  private draft: ArcDraft | null = null;
  constructor(private tracks: () => Row[], private currentUri: () => string | undefined, private playUri: (uri: string) => void) {}

  dispatch(method: string, p: Params): unknown {
    switch (method) {
      case "builder.state": return { presets: DEFAULT_PRESETS, recipe: this.recipe ?? normalizeRecipe(undefined), draft: this.draft, fingerprinted: 0, current: this.seed(this.currentUri()), seeds: (this.recipe?.seeds ?? []).map(uri => this.seed(uri)).filter(Boolean), saved: [], demo: true };
      case "builder.coverage": return { fingerprinted: 0, previewed: 0, catalog_measured: 0, catalog_previewed: 0, catalog_tracks: this.tracks().length, preview_lookup: false, preview_pending: 0, demo: true };
      case "builder.build": {
        const recipe = normalizeRecipe(p.recipe);
        if (!recipe.seeds.length) { const current = this.currentUri(); if (current) recipe.seeds = [current]; }
        if (!recipe.seeds.length) fail("not_ready", "Play a song or add a seed to build an arc");
        this.recipe = recipe;
        return this.build();
      }
      case "builder.reroll": return { slot: this.slot(p), alternatives: [] };
      case "builder.choose": fail("arc_error", "The offline demo has no other tracks to choose");
      // eslint-disable-next-line no-fallthrough
      case "builder.pin": {
        const slot = this.slot(p); const draft = this.require();
        draft.slots[slot]!.pinned = p.pinned !== false;
        return draft;
      }
      case "builder.ban": {
        const slot = this.slot(p); const draft = this.require();
        this.recipe!.bans.push(draft.slots[slot]!.uri);
        return this.build();
      }
      case "builder.move": {
        const draft = this.require();
        const from = this.slot(p), to = this.slot({ slot: p.to });
        const slots = [...draft.slots];
        const [moved] = slots.splice(from, 1);
        slots.splice(to, 0, { ...moved!, pinned: true });
        draft.slots = slots.map((slot, i) => ({ ...slot, slot: i, target: draft.targets[i] ?? slot.target }));
        return draft;
      }
      case "builder.restore": {
        this.recipe = normalizeRecipe(p.recipe);
        const draft = this.build();
        const order = Array.isArray(p.uris) ? p.uris.filter((uri): uri is string => typeof uri === "string") : [];
        const byUri = new Map(draft.slots.map(slot => [slot.uri, slot]));
        const kept = order.map(uri => byUri.get(uri)).filter((slot): slot is ArcSlot => !!slot);
        if (kept.length) draft.slots = kept.map((slot, i) => ({ ...slot, slot: i, target: draft.targets[i] ?? slot.target }));
        return draft;
      }
      case "builder.audition": fail("unavailable", "The offline demo cannot audition tracks");
      // eslint-disable-next-line no-fallthrough
      case "builder.audition_stop": return { stopped: false };
      case "builder.play": { const draft = this.require(); if (draft.slots[0]) this.playUri(draft.slots[0].uri); return { queued: draft.slots.length }; }
      case "builder.save": fail("unavailable", "Saving needs a Spotify account; the offline demo cannot create playlists");
      // eslint-disable-next-line no-fallthrough
      default: return fail("unknown_method", `Unknown method ${method}`);
    }
  }

  private seed(uri: string | undefined) {
    const row = this.tracks().find(track => track.uri === uri);
    return row ? { uri: row.uri!, title: row.title, artists: row.subtitle.split(" · ") } : null;
  }
  private slot(p: Params): number {
    const slot = p.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= (this.draft?.slots.length ?? 0)) fail("invalid_params", "slot is outside this arc");
    return slot;
  }
  private require(): ArcDraft { return this.draft ?? fail("not_ready", "Build an arc first"); }

  private build(): ArcDraft {
    const recipe = this.recipe!;
    const pool = this.tracks().filter(row => row.uri && !recipe.bans.includes(row.uri));
    const count = pool.length;
    const energy = (i: number) => ((i * 37) % 10) / 10 + 0.05;
    const targets = Array.from({ length: count }, (_, i) => sampleCurve(recipe.curve, count > 1 ? i / (count - 1) : 0.5));
    const remaining = pool.map((row, i) => ({ row, energy: energy(i) }));
    const slots: ArcSlot[] = targets.map((target, slot) => {
      remaining.sort((a, b) => Math.abs(a.energy - target) - Math.abs(b.energy - target));
      const { row, energy: e } = remaining.shift()!;
      return { slot, uri: row.uri!, title: row.title, artists: row.subtitle.split(" · "), album: row.detail ?? null, duration_ms: row.duration_ms ?? 0, target, energy: e, measure: "estimated", tempo: null, score: 0.5, affinity: 0.5, curve_fit: 1 - Math.abs(e - target), transition: 0.5, penalty: 0, reasons: [recipe.seeds.includes(row.uri!) ? "seed" : "demo fixture", `energy ~${e.toFixed(2)}, illustrative only`], pinned: false, seed: recipe.seeds.includes(row.uri!) };
    });
    this.draft = { recipe, slots, targets, confidence: 0.3, measured: 0, estimated: slots.length, unmeasured: 0, pool_size: count, duration_ms: slots.reduce((sum, slot) => sum + slot.duration_ms, 0), notes: ["offline demo: energies are illustrative"], playlist_id: null };
    return this.draft;
  }
}
