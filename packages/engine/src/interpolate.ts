/**
 * Smooth motion between simulation snapshots. Snapshots arrive a few times a second; the
 * renderer draws at the display's rate and places people between the last two.
 */

/**
 * Linear interpolation of x, z positions between two snapshots. `alpha` is clamped to [0, 1];
 * mismatched lengths fall back to `next`.
 */
export function interpolatePositions(
  prev: Float32Array,
  next: Float32Array,
  alpha: number,
  out: Float32Array,
): Float32Array {
  const a = Math.min(1, Math.max(0, alpha));
  if (prev.length !== next.length) {
    out.set(next.subarray(0, out.length));
    return out;
  }
  for (let i = 0; i < next.length && i < out.length; i++) {
    const p = prev[i] as number;
    out[i] = p + ((next[i] as number) - p) * a;
  }
  return out;
}
