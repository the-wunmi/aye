/**
 * Keeping a place smooth on whatever is drawing it. Nothing here knows about devices: it watches
 * how long frames really take and gives up looks, one step at a time, until they're quick enough.
 * It never steps up because frames got quick: flickering between looks would be worse than either
 * of them. And if giving something up didn't help, it takes that one step back and stops, because
 * then drawing was never what held it back: a phone saving its battery shows every page at 30
 * frames a second, however little there is to draw.
 */

/** Slower than this, on average, and it's visibly lagging behind a finger (about 40 frames/s). */
const SLOW_FRAME_MS = 25;
/** How many frames to judge by, and how many to let settle after a change. */
const WINDOW_FRAMES = 45;
const SETTLE_FRAMES = 30;
/** A step has to make frames at least this much quicker to be worth taking another. */
const WORTH_IT = 0.9;
/** Longer than this wasn't slow drawing: the tab was hidden or the phone was busy elsewhere. */
const IGNORE_FRAME_MS = 250;

export interface Governor {
  /** The frame took this long. True if the level just changed, either way. */
  frame(ms: number): boolean;
  readonly level: number;
  /** Frames per second lately, for showing. */
  readonly fps: number;
}

export function qualityGovernor(start: number, lowest: number): Governor {
  let level = Math.min(start, lowest);
  let settle = SETTLE_FRAMES;
  let total = 0;
  let count = 0;
  let fps = 0;
  /** How long frames took before the last step down; null if none yet. */
  let before: number | null = null;
  let stopped = false;
  return {
    get level() {
      return level;
    },
    get fps() {
      return fps;
    },
    frame(ms) {
      if (settle > 0) {
        settle--;
        return false;
      }
      if (ms > IGNORE_FRAME_MS) return false;
      total += ms;
      count++;
      if (count < WINDOW_FRAMES) return false;
      const average = total / count;
      fps = Math.round(1000 / average);
      total = 0;
      count = 0;
      if (average <= SLOW_FRAME_MS || level >= lowest || stopped) return false;
      if (before !== null && average > before * WORTH_IT) {
        // That didn't help, so the next wouldn't either. Give back what it cost.
        stopped = true;
        level--;
        settle = SETTLE_FRAMES;
        return true;
      }
      before = average;
      level++;
      settle = SETTLE_FRAMES;
      return true;
    },
  };
}

/** Where to start: a phone or tablet starts without what's costliest and least missed. */
export const startingLevel = () => (globalThis.matchMedia?.("(pointer: coarse)").matches ? 1 : 0);

/** What's drawn at a level. Shadows redrawn only every few frames keep most of their look. */
export interface PlaceLook {
  ambientOcclusion: boolean;
  maxPixelRatio: number;
  shadowEveryFrames: number;
}

export const PLACE_LOOKS: readonly PlaceLook[] = [
  { ambientOcclusion: true, maxPixelRatio: 2, shadowEveryFrames: 1 },
  { ambientOcclusion: false, maxPixelRatio: 2, shadowEveryFrames: 1 },
  { ambientOcclusion: false, maxPixelRatio: 1.5, shadowEveryFrames: 2 },
  { ambientOcclusion: false, maxPixelRatio: 1, shadowEveryFrames: 6 },
];

/** The city map: most of what moves in it is too small to need a sharp shadow every frame. */
export const MAP_LOOKS: readonly { maxPixelRatio: number; shadowEveryFrames: number }[] = [
  { maxPixelRatio: 2, shadowEveryFrames: 1 },
  { maxPixelRatio: 1.5, shadowEveryFrames: 4 },
  { maxPixelRatio: 1.25, shadowEveryFrames: 12 },
  { maxPixelRatio: 1, shadowEveryFrames: 30 },
];

/** A camera that follows a finger closely: three.js's default keeps gliding long after it. */
export const CAMERA_DAMPING = 0.22;
