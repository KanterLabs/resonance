import type { Recipe } from "./model.js";

/** An arc as it stood before a change: its recipe and its tracks in order. */
export interface Snapshot { label: string; recipe: Recipe; uris: string[] }

const LIMIT = 50;

/**
 * Undo and redo for an arc. `past` holds the state before each change with that change's
 * label; undoing swaps the current state into `future` under the same label.
 */
export class ArcHistory {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];

  /** Remember the state before a change. Any new change ends the redo trail. */
  record(snapshot: Snapshot): void {
    this.past.push(snapshot);
    if (this.past.length > LIMIT) this.past.shift();
    this.future = [];
  }

  /** The state to go back to, given the current one; undefined when there is nothing to undo. */
  undo(current: Omit<Snapshot, "label">): Snapshot | undefined {
    const previous = this.past.pop();
    if (previous) this.future.push({ ...current, label: previous.label });
    return previous;
  }

  redo(current: Omit<Snapshot, "label">): Snapshot | undefined {
    const next = this.future.pop();
    if (next) this.past.push({ ...current, label: next.label });
    return next;
  }

  /** Undo an `undo` or `redo` whose restore failed, putting `step` back where it came from. */
  revert(direction: "undo" | "redo", step: Snapshot): void {
    const [from, to] = direction === "undo" ? [this.future, this.past] : [this.past, this.future];
    from.pop();
    to.push(step);
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
}
