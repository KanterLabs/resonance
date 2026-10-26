import type { RpcApi } from "../../workspace/contracts.js";

/** How long the engine plays an audition when it does not say. */
const DEFAULT_MS = 20_000;

/** A track being auditioned, and when the engine will end it. */
export interface Audition { uri: string; title: string; until: number }

/** Auditions from Arc Studio, with a once-a-second change so the view can count down. */
export class Auditioner {
  current: Audition | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private api: RpcApi, private onChange: () => void) {}

  /** Start auditioning. Throws when the engine refuses, for example while casting. */
  async start(uri: string, title: string): Promise<void> {
    const result = await this.api.call<{ ends_in_ms?: number }>("builder.audition", { uri });
    if (this.disposed) return;
    this.current = { uri, title, until: Date.now() + (Number(result?.ends_in_ms) || DEFAULT_MS) };
    this.tick();
  }

  /** End the audition and bring back what was playing. Returns whether one was playing. */
  async stop(): Promise<boolean> {
    if (!this.current) return false;
    this.clear();
    this.onChange();
    try { await this.api.call("builder.audition_stop"); } catch { /* The engine ends it on its own soon. */ }
    return true;
  }

  /** Forget the audition without asking the engine, because playback has moved on. */
  clear(): void { this.current = null; clearTimeout(this.timer); }

  dispose(): void {
    if (this.current) void this.api.call("builder.audition_stop").catch(() => {});
    this.disposed = true;
    this.clear();
  }

  private tick(): void {
    clearTimeout(this.timer);
    if (!this.current || this.disposed) return;
    if (Date.now() >= this.current.until) { this.current = null; this.onChange(); return; }
    this.timer = setTimeout(() => { this.onChange(); this.tick(); }, 1000);
  }
}
