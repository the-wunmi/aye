/**
 * Moving your own character the moment you ask. The server still decides where they really are;
 * waiting for it before showing anything is what makes steering feel like wading. So your own
 * device walks them straight away, stopping at what it can see is in the way, and eases back to
 * the server's answer whenever the two disagree. Only ever a drawing: it never tells the server
 * anything but where you'd like to go.
 */

/** Further than this from the server's answer, and it's the server's answer that's drawn. */
const TOO_FAR_MM = 3_000;
/** How quickly a position comes back to the server's, per second. */
const SETTLE_PER_S = 7;
/** Closer than this, it's the same place. */
const SAME_MM = 25;

export type Footing = (xMm: number, zMm: number) => boolean;

/** One frame's walk: straight on, or along whatever's in the way, or nowhere. */
export function stepTowards(
  x: number,
  z: number,
  dx: number,
  dz: number,
  distanceMm: number,
  fits: Footing,
): [number, number] {
  const nx = x + dx * distanceMm;
  const nz = z + dz * distanceMm;
  if (fits(nx, nz)) return [nx, nz];
  if (dx !== 0 && fits(nx, z)) return [nx, z];
  if (dz !== 0 && fits(x, nz)) return [x, nz];
  return [x, z];
}

/** Where to aim a walk request: as far ahead as there's floor, so a wall isn't asked for. */
export function aimAhead(
  x: number,
  z: number,
  dx: number,
  dz: number,
  aheadMm: number,
  fits: Footing,
): [number, number] {
  for (let d = aheadMm; d > 100; d -= 200) {
    const ax = x + dx * d;
    const az = z + dz * d;
    if (fits(ax, az)) return [ax, az];
  }
  return [x, z];
}

export interface Predicted {
  x: number;
  z: number;
}

/**
 * One frame of your own character: walking if there's a direction, settling on the server's answer
 * if not. Null when they've arrived, and only the server's answer needs drawing.
 */
export function predict(
  was: Predicted | null,
  server: Predicted,
  steer: { dx: number; dz: number; speedMmPerS: number } | null,
  dtSeconds: number,
  fits: Footing,
): Predicted | null {
  const at = was ?? server;
  const off = Math.hypot(at.x - server.x, at.z - server.z);
  const settle = (keep: Predicted): Predicted => {
    const k = 1 - Math.exp(-dtSeconds * SETTLE_PER_S);
    return { x: keep.x + (server.x - keep.x) * k, z: keep.z + (server.z - keep.z) * k };
  };
  if (!steer) {
    if (!was || off < SAME_MM) return null;
    return settle(at);
  }
  if (off > TOO_FAR_MM) return { ...server };
  const [x, z] = stepTowards(at.x, at.z, steer.dx, steer.dz, steer.speedMmPerS * dtSeconds, fits);
  return { x, z };
}
