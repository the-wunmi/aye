/**
 * Where someone can stand, for a device to walk its own character before the server answers. The
 * same grid and walls the sim walks on, so the two rarely disagree, and if they do the server's
 * answer wins. Nothing here decides anything: it only keeps a drawing out of the walls.
 */
import type { Scene, WorldSpec } from "@aye/schema";
import { buildNavGrid, cellAt, Flag } from "./navgrid.ts";
import { solidity } from "./sim.ts";

/** How far from their middle a person takes up floor. */
const BODY_RADIUS_MM = 200;

export function footingCheck(
  scene: Scene,
  spec: WorldSpec,
  cellMm: number,
): (xMm: number, zMm: number) => boolean {
  const level = scene.levels[0];
  if (!level) return () => true;
  const grid = buildNavGrid(scene, level.id, { cellMm, isSolid: solidity(spec) });
  const clear = (x: number, z: number) => {
    const cell = cellAt(grid, x, z);
    return cell >= 0 && ((grid.flags[cell] as number) & Flag.Blocked) === 0;
  };
  return (x, z) =>
    clear(x, z) &&
    clear(x + BODY_RADIUS_MM, z) &&
    clear(x - BODY_RADIUS_MM, z) &&
    clear(x, z + BODY_RADIUS_MM) &&
    clear(x, z - BODY_RADIUS_MM);
}
