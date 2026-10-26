import type { RpcApi } from "../../workspace/contracts.js";
import type { Coverage } from "./model.js";

/**
 * While songs are being measured from previews in the background, check now and then how
 * many more the library has, so the view can offer a rebuild instead of rebuilding under
 * the listener.
 */
export class PreviewWatch {
  /** Songs measured from previews since the arc was built; a rebuild would use them. */
  newlyMeasured = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Library songs with a preview when the arc was built, or null before the first poll. */
  private atBuild: number | null = null;

  constructor(private api: RpcApi, private onChange: () => void, private pollMs: number) {}

  /** Start counting from now. `current` says whether this build is still the one shown. */
  watch(current: () => boolean): void {
    clearTimeout(this.timer);
    this.newlyMeasured = 0;
    this.atBuild = null;
    const poll = async () => {
      if (!current()) return;
      let coverage: Coverage;
      try { coverage = await this.api.call<Coverage>("builder.coverage"); } catch { return; }
      if (!current() || !coverage?.preview_lookup) return;
      const previewed = Number(coverage.catalog_previewed) || 0;
      if (this.atBuild === null) this.atBuild = previewed;
      const more = Math.max(0, previewed - this.atBuild);
      if (more !== this.newlyMeasured) { this.newlyMeasured = more; this.onChange(); }
      if ((Number(coverage.preview_pending) || 0) > 0) this.timer = setTimeout(() => { void poll(); }, this.pollMs);
    };
    void poll();
  }

  dispose(): void { clearTimeout(this.timer); }
}
