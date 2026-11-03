/**
 * Can people actually get around this place? An ordinary body is walked through it from where
 * people arrive, with the real navigation, and anything it can't get to is reported: a room with
 * no way in, or a thing with no floor beside it. It says what's wrong, never how to fix it; that
 * is the model's to decide, knowing what the place really is (a door, some stairs, moving the
 * sofa). It knows nothing about what any of it is, only where it is and how big.
 *
 * This is about the building: walls, openings, floors, steps. Before a place has a world nobody
 * has said which things are solid, and guessing from size calls a string of crisp packets a
 * wall, so things don't count here. What things block is judged later, by playing the world,
 * where the model has said what's solid.
 */
import type { Scene } from "@aye/schema";
import { buildNavGrid, cellCentre, type Mover, pointInPolygon } from "./navgrid.ts";
import { labelRegions } from "./path.ts";
import { entryCells, objectUseCells } from "./reach.ts";

export const ORDINARY_BODY: Mover = {
  clearWidthMm: 450,
  maxStepRiseMm: 200,
  maxSlopePermille: 150,
  canUseStairs: true,
};
const CELL_MM = 100;
const REACH_MM = 700;
/** A space is cut off if less than this share of its open floor can be walked to. */
const REACHED_SHARE = 0.8;

export interface CutOff {
  /** Spaces nobody can walk to, by id. */
  spaces: string[];
  /** Things nobody can get beside, by id. */
  things: string[];
}

export function cutOff(
  scene: Scene,
  isSolid: (object: Scene["objects"][number]) => boolean = () => false,
): CutOff {
  const level = scene.levels[0];
  if (!level) return { spaces: [], things: [] };
  const grid = buildNavGrid(scene, level.id, {
    cellMm: CELL_MM,
    isSolid,
  });
  const regions = labelRegions(grid, ORDINARY_BODY);
  const size = new Map<number, number>();
  for (const r of regions) if (r >= 0) size.set(r, (size.get(r) ?? 0) + 1);
  // The ground people arrive on: of all the ways in, the one opening onto the most.
  let main = -1;
  let best = -1;
  const biggest = (r: number) => {
    const s = size.get(r) ?? 0;
    if (r >= 0 && s > best) {
      best = s;
      main = r;
    }
  };
  for (const c of entryCells(scene, grid)) biggest(regions[c] as number);
  if (main < 0) for (const r of size.keys()) biggest(r);

  const spaces = scene.spaces.flatMap((space) => {
    let open = 0;
    let reached = 0;
    for (let c = 0; c < regions.length; c++) {
      const r = regions[c] as number;
      if (r < 0) continue;
      const [x, z] = cellCentre(grid, c);
      if (!pointInPolygon(x, z, space.polygon)) continue;
      open++;
      if (r === main) reached++;
    }
    return reached < open * REACHED_SHARE || open === 0 ? [space.id as string] : [];
  });
  const things = scene.objects.flatMap((o) => {
    if (o.levelId !== level.id) return [];
    return objectUseCells(grid, o, REACH_MM).some((c) => regions[c] === main)
      ? []
      : [o.id as string];
  });
  return { spaces, things };
}
