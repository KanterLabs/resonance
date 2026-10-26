import type { Page, Row, RpcApi } from "../../workspace/contracts.js";
import { Auditioner, type Audition } from "./audition.js";
import { ArcHistory, type Snapshot } from "./history.js";
import { DEFAULT_PRESETS, normalizeRecipe, type ArcDraft, type ArcSlot, type ArcState, type Preset, type Recipe, type SavedArcRow, type SeedRow } from "./model.js";
import { PreviewWatch } from "./previews.js";

export type ListMode = "draft" | "alternatives" | "search" | "seeds";
export type SaveState = "none" | "saved" | "unsaved";
const MAX_SEEDS = 5;

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const signature = (draft: ArcDraft | null) => draft?.slots.map(slot => slot.uri).join("|") ?? "";

/** An action on one track (or the whole arc, with no URI) waiting for a build to finish. */
interface Pending { label: string; uri: string | null; title: string; run: (slot: number) => Promise<void> }

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
  /** The slot the view should select after the last change, if it moved a track. */
  focusSlot: number | null = null;
  /** The name of the playlist this arc was saved to, when known. */
  savedName: string | null = null;
  /** Keep one undo step open across edits, while a curve is being shaped. */
  holdBurst = false;
  private pending: Pending | null = null;
  private history = new ArcHistory();
  private burst = false;
  private savedSignature: string | null = null;
  private saved: SavedArcRow[] = [];
  private searchFrom: ListMode = "draft";
  private seedInfo = new Map<string, SeedRow>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private auditioner: Auditioner;
  private previews: PreviewWatch;
  private loaded = false;
  /** When the status line last changed, so a selection can take it over afterwards. */
  statusAt = 0;

  constructor(private api: RpcApi, private onChange: () => void, private debounceMs = 400, pollMs = 10_000) {
    this.auditioner = new Auditioner(api, () => this.changed());
    this.previews = new PreviewWatch(api, () => this.changed(), pollMs);
  }

  /** Songs measured from previews since the arc was built; a rebuild would use them. */
  get newlyMeasured(): number { return this.previews.newlyMeasured; }
  get audition(): Audition | null { return this.auditioner.current; }

  seeds(): SeedRow[] {
    return this.recipe.seeds.map(uri => this.seedInfo.get(uri) ?? { uri, title: uri.split(":").pop() ?? uri, artists: [] });
  }

  /** What is waiting for the current build, in words, or null. */
  get pendingLabel(): string | null { return this.pending?.label ?? null; }
  get canUndo(): boolean { return this.history.canUndo; }
  get canRedo(): boolean { return this.history.canRedo; }

  /** Whether the arc matches the playlist it was saved to. */
  saveState(): SaveState {
    if (!this.draft?.playlist_id) return "none";
    return signature(this.draft) === this.savedSignature ? "saved" : "unsaved";
  }

  async load(buildNow = false): Promise<void> {
    try {
      const state = await this.api.call<ArcState>("builder.state");
      if (this.disposed) return;
      if (Array.isArray(state?.presets) && state.presets.length) this.presets = state.presets;
      this.recipe = normalizeRecipe(state?.recipe);
      this.current = state?.current ?? null;
      this.fingerprinted = Number(state?.fingerprinted) || 0;
      this.saved = Array.isArray(state?.saved) ? state.saved : [];
      for (const seed of [...(state?.seeds ?? []), ...(this.current ? [this.current] : [])]) this.seedInfo.set(seed.uri, seed);
      this.draft = state?.draft ?? null;
      if (this.draft?.playlist_id) this.markSaved(this.saved.find(saved => saved.playlist_id === this.draft?.playlist_id)?.name ?? null);
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
    this.timer = undefined;
    if (!this.holdBurst) this.burst = false;
    if (this.disposed) return;
    const request = ++this.generation;
    if (!fromCurrent && !this.recipe.seeds.length && !this.current) { this.say("Play a song or press / to choose a starting song", true); this.flushPending(); return; }
    const recipe: Recipe = { ...this.recipe, seeds: fromCurrent && this.current ? [this.current.uri] : this.recipe.seeds };
    if (fromCurrent) { recipe.pins = []; recipe.bans = []; }
    this.busy = true; this.say("Building arc…");
    try {
      const draft = await this.api.call<ArcDraft>("builder.build", { recipe });
      if (this.disposed || request !== this.generation) return;
      this.accept(draft);
      // Rebuilding after a starting song changes keeps the list of them open.
      if (this.mode !== "seeds") this.mode = "draft";
      const generation = this.generation;
      this.previews.watch(() => !this.disposed && generation === this.generation);
      const seeds = this.seeds();
      this.say(`Built ${draft.slots.length} tracks from ${seeds[0]?.title ?? "your seeds"}${seeds.length > 1 ? ` and ${seeds.length - 1} more` : ""}`);
    } catch (reason) { if (request === this.generation) this.fail(reason); }
    finally { if (request === this.generation) { this.busy = false; this.changed(); this.flushPending(); } }
  }

  async reroll(slot: number): Promise<void> {
    await this.onTrack(slot, title => `swap ${title}`, async (index, title) => {
      await this.request(async () => {
        const result = await this.api.call<{ alternatives: ArcSlot[] }>("builder.reroll", { slot: index });
        this.alternatives = result.alternatives ?? [];
        this.alternativeSlot = index;
        this.mode = "alternatives";
        if (!this.alternatives.length) { this.mode = "draft"; this.say("Nothing else fits that spot yet; play more music to widen the pool"); return; }
        this.say(`Pick a replacement for ${title}`);
      });
    });
  }

  /** Put an alternative in the slot being swapped. The engine keeps it there. */
  async choose(uri: string): Promise<void> {
    const slot = this.alternativeSlot;
    this.record(`swap in ${this.alternatives.find(option => option.uri === uri)?.title ?? "a track"}`);
    await this.request(async () => {
      this.accept(await this.api.call<ArcDraft>("builder.choose", { slot, uri }));
      this.mode = "draft";
      this.focusSlot = slot;
      this.say(`Swapped in ${this.draft?.slots[slot]?.title ?? "a new track"} and kept it there · k lets it move`);
    });
  }

  async pin(slot: number): Promise<void> {
    await this.onTrack(slot, title => `keep ${title}`, async (index, title) => {
      const pinned = !this.draft?.slots[index]?.pinned;
      this.record(pinned ? `keep ${title}` : `let ${title} move`);
      await this.request(async () => {
        this.accept(await this.api.call<ArcDraft>("builder.pin", { slot: index, pinned }));
        this.say(pinned ? `Keeping ${title} in place` : `${title} can move again`);
      });
    });
  }

  async ban(slot: number): Promise<void> {
    await this.onTrack(slot, title => `remove ${title}`, async (index, title) => {
      const uri = this.draft?.slots[index]?.uri ?? "";
      const wasSeed = this.recipe.seeds.includes(uri);
      this.record(`remove ${title}`);
      await this.request(async () => {
        this.accept(await this.api.call<ArcDraft>("builder.ban", { slot: index }));
        if (wasSeed && !this.recipe.seeds.includes(uri)) {
          const fallback = this.recipe.seeds.length ? "" : this.current ? " · now building from the playing song" : "";
          this.say(`Removed ${title} and dropped it as a starting song${fallback} · z undo`);
        } else this.say(`Removed ${title}; it won't come back in this arc · z undo`);
      });
    });
  }

  /** Move a track up or down by `delta` and keep it where it lands. */
  async move(slot: number, delta: number): Promise<void> {
    await this.onTrack(slot, title => `move ${title}`, async (index, title) => {
      const count = this.draft?.slots.length ?? 0;
      const to = Math.max(0, Math.min(count - 1, index + delta));
      if (to === index) return;
      this.record(`move ${title}`);
      await this.request(async () => {
        this.accept(await this.api.call<ArcDraft>("builder.move", { from: index, to }));
        this.focusSlot = to;
        this.say(`Moved ${title} to ${to + 1} and kept it there`);
      });
    });
  }

  /** Play the arc from `slot`, or the whole arc with null. */
  async play(slot: number | null = null): Promise<void> {
    const label = slot === null ? "play the arc" : `play from ${this.draft?.slots[slot]?.title ?? "here"}`;
    await this.act(label, slot === null ? null : this.draft?.slots[slot]?.uri ?? null, async index => {
      this.auditioner.clear();
      await this.request(async () => {
        const start = Math.max(0, index);
        const result = await this.api.call<{ queued: number }>("builder.play", start ? { slot: start } : {});
        const title = this.draft?.slots[start]?.title;
        this.say(start && title ? `Playing from ${title} · ${result.queued} tracks` : `Playing the arc · ${result.queued} tracks`);
      });
    });
  }

  /** Same shape and seeds, different picks. Kept tracks stay. */
  remix(): void {
    this.record("remix");
    this.recipe = { ...this.recipe, rng_seed: Math.floor(Math.random() * 1_000_000_000) + 1 };
    void this.build();
  }

  /** Start over from the playing song, dropping kept and removed tracks. */
  async useCurrent(): Promise<void> {
    if (!this.current) { this.say("Nothing is playing; press / to choose a starting song", true); return; }
    this.record("start over");
    this.seedInfo.set(this.current.uri, this.current);
    this.recipe = { ...this.recipe, seeds: [this.current.uri], pins: [], bans: [] };
    await this.build();
  }

  /** Save the arc: update the playlist it created, or with `asNew` always create another. */
  async save(name: string, asNew = false): Promise<void> {
    await this.act(asNew ? "save as new" : "save", null, async () => {
      const overwrite = !asNew && !!this.draft?.playlist_id;
      await this.request(async () => {
        const result = await this.api.call<{ id: string; overwritten: boolean; tracks: number }>("builder.save", { name, overwrite });
        if (this.draft) this.draft = { ...this.draft, playlist_id: result.id };
        this.markSaved(name);
        this.say(result.overwritten ? `Updated playlist ${name}` : `Saved ${result.tracks} tracks to ${name}`);
      });
    });
  }

  async undo(): Promise<void> { await this.act("undo", null, () => this.step("undo")); }
  async redo(): Promise<void> { await this.act("redo", null, () => this.step("redo")); }

  async search(query: string): Promise<void> {
    const from = this.mode;
    await this.request(async () => {
      const page = await this.api.call<Page>("search", { query, kind: "tracks", limit: 8 });
      this.results = (page.items ?? []).filter(row => row.uri);
      this.searchFrom = from === "seeds" ? "seeds" : "draft";
      this.mode = "search";
      this.say(this.results.length ? "Enter adds a seed · Esc returns to the arc" : `No tracks found for ${query}`);
    });
  }

  addSeed(seed: SeedRow): boolean {
    if (this.recipe.seeds.includes(seed.uri)) { this.say(`${seed.title} is already a seed`); return false; }
    if (this.recipe.seeds.length >= MAX_SEEDS) { this.say(`An arc takes at most ${MAX_SEEDS} seeds`, true); return false; }
    this.record(`add ${seed.title}`);
    this.seedInfo.set(seed.uri, seed);
    this.recipe = { ...this.recipe, seeds: [...this.recipe.seeds, seed.uri] };
    this.mode = this.mode === "search" ? this.searchFrom : this.mode;
    this.say(`Added ${seed.title} as a starting song`);
    this.scheduleBuild();
    return true;
  }

  addCurrentSeed(): boolean {
    if (!this.current) { this.say("Nothing is playing to add as a seed", true); return false; }
    return this.addSeed(this.current);
  }

  /** Drop the last starting song. */
  removeSeed(): void {
    const removed = this.recipe.seeds.at(-1);
    if (!removed) { this.say("No seeds to remove"); return; }
    this.removeSeedAt(removed);
  }

  removeSeedAt(uri: string): void {
    if (!this.recipe.seeds.includes(uri)) return;
    const title = this.seedInfo.get(uri)?.title ?? uri;
    this.record(`drop ${title}`);
    this.recipe = { ...this.recipe, seeds: this.recipe.seeds.filter(seed => seed !== uri) };
    this.say(`Dropped ${title} from the starting songs`);
    if (this.recipe.seeds.length || this.current) this.scheduleBuild();
  }

  /** List the starting songs, to remove or add some. */
  showSeeds(): void { this.mode = "seeds"; this.say(this.recipe.seeds.length ? "" : "No starting songs yet; / adds one"); }

  /** Update the recipe locally and rebuild once edits settle. A burst of edits is one undo step. */
  edit(change: Partial<Recipe>, label = "change"): void {
    if (!this.burst) { this.record(label); this.burst = true; }
    this.recipe = { ...this.recipe, ...change };
    this.changed();
    if (this.recipe.seeds.length || this.current) this.scheduleBuild();
  }

  /** Close the undo step held open while shaping a curve. */
  endBurst(): void { this.holdBurst = false; if (!this.timer) this.burst = false; }

  back(): boolean {
    if (this.mode === "draft") return false;
    this.mode = this.mode === "search" ? this.searchFrom : "draft";
    this.searchFrom = "draft";
    this.say(this.draft ? (this.mode === "seeds" ? "" : "Back to the arc") : "");
    return true;
  }

  /** Audition a track for a short while, or stop when it is the one already playing. */
  async listen(uri: string, title: string): Promise<void> {
    if (this.audition?.uri === uri) { await this.stopListening(); return; }
    try { await this.auditioner.start(uri, title); this.say(`Auditioning ${title}`); } catch (reason) { this.fail(reason); }
  }

  /** End an audition and bring back what was playing. Returns whether one was playing. */
  stopListening(): Promise<boolean> { return this.auditioner.stop(); }

  dispose(): void {
    this.auditioner.dispose(); this.previews.dispose();
    this.disposed = true; this.generation++; this.pending = null;
    clearTimeout(this.timer);
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
    finally { this.busy = false; this.changed(); this.flushPending(); }
  }

  /** Run an action on the track in `slot`, or once the current build is done if one is running. */
  private async onTrack(slot: number, label: (title: string) => string, run: (slot: number, title: string) => Promise<void>): Promise<void> {
    const track = this.draft?.slots[slot];
    if (!track) return;
    await this.act(label(track.title), track.uri, index => run(index, this.draft?.slots[index]?.title ?? track.title), track.title);
  }

  /**
   * Run `run` now, or remember it until the build in progress finishes. A waiting action
   * names its track by URI, because the build may move it; the latest action wins.
   */
  private async act(label: string, uri: string | null, run: (slot: number) => Promise<void>, title = ""): Promise<void> {
    if (this.disposed) return;
    const action: Pending = { label, uri, title, run };
    if (this.busy || this.timer) {
      this.pending = action;
      if (this.timer && !this.busy) void this.build();
      else this.changed();
      return;
    }
    await this.perform(action);
  }

  private async perform(action: Pending): Promise<void> {
    const slot = action.uri === null ? -1 : this.draft?.slots.findIndex(slot => slot.uri === action.uri) ?? -1;
    if (action.uri !== null && slot < 0) { this.say(`${action.title || "That track"} is no longer in the arc`); return; }
    await action.run(slot);
  }

  private flushPending(): void {
    const action = this.pending;
    if (!action || this.busy || this.timer || this.disposed) return;
    this.pending = null;
    void this.perform(action);
  }

  private uris(): string[] { return this.draft?.slots.map(slot => slot.uri) ?? []; }

  /** Remember the arc as it is, before a change labelled `label`. */
  private record(label: string): void {
    if (!this.draft?.slots.length) return;
    this.history.record({ label, recipe: structuredClone(this.recipe), uris: this.uris() });
  }

  private async step(direction: "undo" | "redo"): Promise<void> {
    const current = { recipe: structuredClone(this.recipe), uris: this.uris() };
    const step: Snapshot | undefined = direction === "undo" ? this.history.undo(current) : this.history.redo(current);
    if (!step) { this.say(direction === "undo" ? "Nothing to undo" : "Nothing to redo"); return; }
    this.generation++;
    this.recipe = structuredClone(step.recipe);
    await this.request(async () => {
      try {
        this.accept(await this.api.call<ArcDraft>("builder.restore", { recipe: step.recipe, uris: step.uris }));
      } catch (reason) {
        this.history.revert(direction, step);
        this.recipe = current.recipe;
        throw reason;
      }
      this.mode = "draft";
      this.say(direction === "undo" ? `Undid: ${step.label}${this.history.canRedo ? " · Z redo" : ""}` : `Redid: ${step.label}`);
    });
  }

  private markSaved(name: string | null): void {
    this.savedSignature = signature(this.draft);
    this.savedName = name;
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
