// Build-time switches of the art (art/artStyle.ts) and the art lab (artlab/), on top of src/net/env.d.ts.
interface ImportMetaEnv {
  /** one art style for every category, or the art lab's copied picks line (art/artStyle.ts parseStylePicks) */
  readonly VITE_ART_STYLE?: string;
  /** one motion preset for every category, or "category: preset" pairs (art/artStyle.ts parseMotionPicks) */
  readonly VITE_ART_MOTION?: string;
  /** "1" builds the art lab into the page (shown at #artlab); vite.config.ts turns it into __ART_LAB__ */
  readonly VITE_ART_LAB?: string;
}

/** True only in an art lab build (VITE_ART_LAB=1, vite.config.ts define); false code is dropped from the build. */
declare const __ART_LAB__: boolean;
