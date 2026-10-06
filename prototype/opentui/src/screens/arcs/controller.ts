import type { Page, Row, RpcApi } from "../../workspace/contracts.js";
import { DEFAULT_PRESETS, normalizeRecipe, type ArcDraft, type ArcSlot, type ArcState, type Coverage, type Preset, type Recipe, type SeedRow } from "./model.js";

export type ListMode = "draft" | "alternatives" | "search";
const MAX_SEEDS = 5;

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** Owns the arc being edited and every request about it, so the view only draws. */
export class ArcsController {
  recipe: Recipe = normalizeRecipe(undefined);
  presets: Preset[] = DEFAULT_PRESETS;
  draft: ArcDraft | null = null;
  current: SeedRow | null = null;
  fingerprinted = 0;
  mode: ListMode = "draft";
  alternatives: ArcSlot[] = [];
  alternativeSlot = -1;
  results: Row[] = [];
  status = "Loading arcs…";
  error = false;
  busy = false;
  /** Songs measured from previews since the arc was built; a rebuild would use them. */
  newlyMeasured = 0;
  private seedInfo = new Map<string, SeedRow>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private poller: ReturnType<typeof setTimeout> | undefined;
  /** Library songs with a preview when the arc was built, or null before the first poll. */
  private previewedAtBuild: number | null = null;
  private loaded = false;
  /** When the status line last changed, so a selection can take it over afterwards. */
  statusAt = 0;

  constructor(private api: RpcApi, private onChange: () => void, private debounceMs = 400, private pollMs = 10_000) {}

  seeds(): SeedRow[] {
    return this.recipe.seeds.map(uri => this.seedInfo.get(uri) ?? { uri, title: uri.split(":").pop() ?? uri, artists: [] });
  }

  async load(buildNow = false): Promise<void> {
    try {
      const state = await this.api.call<ArcState>("builder.state");
      if (this.disposed) return;
      if (Array.isArray(state?.presets) && state.presets.length) this.presets = state.presets;
      this.recipe = normalizeRecipe(state?.recipe);
      this.current = state?.current ?? null;
      this.fingerprinted = Number(state?.fingerprinted) || 0;
      for (const seed of [...(state?.seeds ?? []), ...(this.current ? [this.current] : [])]) this.seedInfo.set(seed.uri, seed);
      this.draft = state?.draft ?? null;
      this.say(this.draft ? "Arc restored · c rebuilds from the playing song" : "");
      this.loaded = true;
      if (buildNow || (!this.draft && (this.recipe.seeds.length || this.current))) await this.build(buildNow || !this.recipe.seeds.length);
    } catch (reason) { this.fail(reason); }
  }

  /** Rebuild shortly after the last edit, so dragging a curve point does not flood the engine. */
  scheduleBuild(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.build(); }, this.debounceMs);
  }

  async build(fromCurrent = false): Promise<void> {
    clearTimeout(this.timer);
    if (this.disposed) return;
    const request = ++this.generation;
    if (!fromCurrent && !this.recipe.seeds.length && !this.current) { this.say("Play a song or press / to choose a starting song", true); return; }
    const recipe: Recipe = { ...this.recipe, seeds: fromCurrent && this.current ? [this.current.uri] : this.recipe.seeds };
    if (fromCurrent) { recipe.pins = []; recipe.bans = []; }
    this.busy = true; this.say("Building arc…");
    try {
      const draft = await this.api.call<ArcDraft>("builder.build", { recipe });
      if (this.disposed || request !== this.generation) return;
      this.accept(draft);
      this.mode = "draft";
      this.watchPreviews();
      const seeds = this.seeds();
      this.say(`Built ${draft.slots.length} tracks from ${seeds[0]?.title ?? "your seeds"}${seeds.length > 1 ? ` and ${seeds.length - 1} more` : ""}`);
    } catch (reason) { if (request === this.generation) this.fail(reason); }
    finally { if (request === this.generation) { this.busy = false; this.changed(); } }
  }

  async reroll(slot: number): Promise<void> {
    await this.request(async () => {
      const result = await this.api.call<{ alternatives: ArcSlot[] }>("builder.reroll", { slot });
      this.alternatives = result.alternatives ?? [];
      this.alternativeSlot = slot;
      this.mode = "alternatives";
      if (!this.alternatives.length) { this.mode = "draft"; this.say("Nothing else fits that spot yet; play more music to widen the pool"); return; }
      this.say(`Pick a replacement for ${this.draft?.slots[slot]?.title ?? `track ${slot + 1}`}`);
    });
  }

  async choose(uri: string): Promise<void> {
    const slot = this.alternativeSlot;
    await this.request(async () => {
      this.accept(await this.api.call<ArcDraft>("builder.choose", { slot, uri }));
      this.mode = "draft";
      this.say(`Swapped in ${this.draft?.slots[slot]?.title ?? "a new track"}`);
    });
  }

  async pin(slot: number): Promise<void> {
    const pinned = !this.draft?.slots[slot]?.pinned;
    await this.request(async () => {
      this.accept(await this.api.call<ArcDraft>("builder.pin", { slot, pinned }));
      this.say(pinned ? `Keeping ${this.draft?.slots[slot]?.title ?? "it"} in place` : `${this.draft?.slots[slot]?.title ?? "Track"} can move again`);
    });
  }

  async ban(slot: number): Promise<void> {
    const title = this.draft?.slots[slot]?.title ?? "track";
    await this.request(async () => {
      this.accept(await this.api.call<ArcDraft>("builder.ban", { slot }));
      this.say(`Removed ${title}; it won't come back in this arc`);
    });
  }

  async play(slot = 0): Promise<void> {
    await this.request(async () => {
      const result = await this.api.call<{ queued: number }>("builder.play", slot ? { slot } : {});
      const title = this.draft?.slots[slot]?.title;
      this.say(slot && title ? `Playing from ${title} · ${result.queued} tracks` : `Playing the arc · ${result.queued} tracks`);
    });
  }

  /** Same shape and seeds, different picks. Kept tracks stay. */
  remix(): void {
    this.recipe = { ...this.recipe, rng_seed: Math.floor(Math.random() * 1_000_000_000) + 1 };
    void this.build();
  }

  /** Start over from the playing song, dropping kept and removed tracks. */
  async useCurrent(): Promise<void> {
    if (!this.current) { this.say("Nothing is playing; press / to choose a starting song", true); return; }
    this.seedInfo.set(this.current.uri, this.current);
    this.recipe = { ...this.recipe, seeds: [this.current.uri], pins: [], bans: [] };
    await this.build();
  }

  async save(name: string): Promise<void> {
    const overwrite = !!this.draft?.playlist_id;
    await this.request(async () => {
      const result = await this.api.call<{ id: string; overwritten: boolean; tracks: number }>("builder.save", { name, overwrite });
      if (this.draft) this.draft = { ...this.draft, playlist_id: result.id };
      this.say(result.overwritten ? `Updated playlist ${name}` : `Saved ${result.tracks} tracks to ${name}`);
    });
  }

  async search(query: string): Promise<void> {
    await this.request(async () => {
      const page = await this.api.call<Page>("search", { query, kind: "tracks", limit: 8 });
      this.results = (page.items ?? []).filter(row => row.uri);
      this.mode = "search";
      this.say(this.results.length ? "Enter adds a seed · Esc returns to the arc" : `No tracks found for ${query}`);
    });
  }

  addSeed(seed: SeedRow): boolean {
    if (this.recipe.seeds.includes(seed.uri)) { this.say(`${seed.title} is already a seed`); return false; }
    if (this.recipe.seeds.length >= MAX_SEEDS) { this.say(`An arc takes at most ${MAX_SEEDS} seeds`, true); return false; }
    this.seedInfo.set(seed.uri, seed);
    this.recipe = { ...this.recipe, seeds: [...this.recipe.seeds, seed.uri] };
    this.mode = "draft";
    this.say(`Added ${seed.title} as a starting song`);
    this.scheduleBuild();
    return true;
  }

  addCurrentSeed(): boolean {
    if (!this.current) { this.say("Nothing is playing to add as a seed", true); return false; }
    return this.addSeed(this.current);
  }

  removeSeed(): void {
    const removed = this.recipe.seeds.at(-1);
    if (!removed) { this.say("No seeds to remove"); return; }
    this.recipe = { ...this.recipe, seeds: this.recipe.seeds.slice(0, -1) };
    this.say(`Dropped ${this.seedInfo.get(removed)?.title ?? removed} from the starting songs`);
    if (this.recipe.seeds.length) this.scheduleBuild();
  }

  /** Update the recipe locally and rebuild once edits settle. */
  edit(change: Partial<Recipe>): void {
    this.recipe = { ...this.recipe, ...change };
    this.changed();
    if (this.recipe.seeds.length || this.current) this.scheduleBuild();
  }

  back(): boolean {
    if (this.mode === "draft") return false;
    this.mode = "draft";
    this.say(this.draft ? "Back to the arc" : "");
    return true;
  }

  dispose(): void { this.disposed = true; this.generation++; clearTimeout(this.timer); clearTimeout(this.poller); }

  /**
   * While songs are being measured from previews in the background, check now and then how
   * many more the library has, so the view can offer a rebuild instead of rebuilding under
   * the listener.
   */
  private watchPreviews(): void {
    clearTimeout(this.poller);
    this.newlyMeasured = 0;
    this.previewedAtBuild = null;
    const generation = this.generation;
    const poll = async () => {
      if (this.disposed || generation !== this.generation) return;
      let coverage: Coverage;
      try { coverage = await this.api.call<Coverage>("builder.coverage"); } catch { return; }
      if (this.disposed || generation !== this.generation || !coverage?.preview_lookup) return;
      const previewed = Number(coverage.catalog_previewed) || 0;
      if (this.previewedAtBuild === null) this.previewedAtBuild = previewed;
      const more = Math.max(0, previewed - this.previewedAtBuild);
      if (more !== this.newlyMeasured) { this.newlyMeasured = more; this.changed(); }
      if ((Number(coverage.preview_pending) || 0) > 0) this.poller = setTimeout(() => { void poll(); }, this.pollMs);
    };
    void poll();
  }

  private accept(draft: ArcDraft): void {
    this.draft = draft;
    if (draft.recipe) {
      const local = this.recipe;
      this.recipe = { ...normalizeRecipe(draft.recipe), curve: local.curve, preset: local.preset ?? null };
    }
    if (this.current && this.recipe.seeds.includes(this.current.uri)) this.seedInfo.set(this.current.uri, this.current);
  }

  private async request(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.changed();
    try { await work(); } catch (reason) { this.fail(reason); }
    finally { this.busy = false; this.changed(); }
  }

  /** Follow the playing song; the first one seen builds an arc if there is none yet. */
  setCurrent(seed: SeedRow | null): void {
    const first = !this.current && seed;
    this.current = seed;
    if (first && this.loaded && !this.draft && !this.busy && !this.recipe.seeds.length) void this.build(true);
  }

  private say(text: string, error = false): void { this.status = text; this.error = error; this.statusAt = Date.now(); this.changed(); }
  private fail(reason: unknown): void { this.say(message(reason), true); }
  private changed(): void { if (!this.disposed) this.onChange(); }
}
