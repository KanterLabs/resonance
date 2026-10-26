import type { Row } from "../../workspace/contracts.js";
import type { ArcsController } from "./controller.js";
import { slotRow, type ArcSlot } from "./model.js";

/** Keys that still reach the studio while picking one at a time: looking around, saving, playing. */
export const SWIPE_PASSTHROUGH = new Set(["up", "down", "pageup", "pagedown", "home", "end", "i", "s", "p"]);

/**
 * Build an arc one song at a time: hear the next track, then keep it (→) or skip it (←).
 * Keeping pins the track where it is; skipping removes it, and the arc refills that spot.
 */
export class Swiper {
  active = false;

  constructor(private arcs: ArcsController) {}

  /** The track under review: the first one that is neither kept nor a starting song. */
  get candidate(): ArcSlot | undefined {
    return this.arcs.draft?.slots.find(slot => !slot.pinned && !slot.seed);
  }

  /** Returns false when there is no arc to pick from yet. */
  start(): boolean {
    if (!this.arcs.draft?.slots.length) return false;
    this.active = true;
    void this.hear();
    return true;
  }

  async stop(): Promise<void> {
    this.active = false;
    await this.arcs.stopListening();
  }

  async keep(): Promise<void> {
    const slot = this.candidate;
    if (!slot || this.arcs.busy) return;
    await this.arcs.pin(slot.slot);
    await this.hear();
  }

  async skip(): Promise<void> {
    const slot = this.candidate;
    if (!slot || this.arcs.busy) return;
    await this.arcs.ban(slot.slot);
    await this.hear();
  }

  /** Play the track under review unless it already is, and stop once every track is picked. */
  async hear(): Promise<void> {
    if (!this.active) return;
    const slot = this.candidate;
    if (!slot) { await this.arcs.stopListening(); return; }
    if (this.arcs.audition?.uri !== slot.uri) await this.arcs.listen(slot.uri, slot.title);
  }

  /** Handle a key while active. Returns false for keys left to the studio. */
  key(name: string, sequence: string): boolean {
    if (sequence === "Z") { void this.arcs.redo().then(() => this.hear()); return true; }
    switch (name) {
      case "right": case "l": case "k": case "return": case "enter": void this.keep(); return true;
      case "left": case "h": case "x": void this.skip(); return true;
      case "a": { const slot = this.candidate; if (slot) void this.arcs.listen(slot.uri, slot.title); return true; }
      case "z": void this.arcs.undo().then(() => this.hear()); return true;
      case "escape": case "w": void this.stop(); return true;
      default: return !SWIPE_PASSTHROUGH.has(name) && sequence !== "S";
    }
  }

  /** The playlist so far: what has been picked, then the track being heard. */
  rows(): Row[] {
    const slots = this.arcs.draft?.slots ?? [];
    const at = this.candidate?.slot ?? slots.length - 1;
    return slots.slice(0, at + 1).map(slot => {
      const row = slotRow(slot);
      return slot.slot === at && this.candidate ? { ...row, title: `${row.title}   ← skip · keep →` } : row;
    });
  }

  heading(): string {
    const slots = this.arcs.draft?.slots ?? [];
    const picked = slots.filter(slot => slot.pinned || slot.seed).length;
    return `Arc Studio / one at a time · ${picked} of ${slots.length} picked`;
  }

  message(): string {
    const slots = this.arcs.draft?.slots ?? [];
    const slot = this.candidate;
    if (!slot) return `All ${slots.length} tracks picked · s save · p play the arc · Esc back to the arc`;
    return `Track ${slot.slot + 1} of ${slots.length}: ${slot.title} — ${slot.artists.join(", ")} · → keep  ← skip`;
  }
}
