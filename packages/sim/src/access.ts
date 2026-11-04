/**
 * Questions about who can do what in a place, answered by physics rather than opinion. Given a
 * body (how wide, what it can climb, how high it reaches) and optionally some changes to the
 * place (a ramp, a wider door, something moved out of the way), this says what that person can
 * and can't get to and why, and how a whole day goes for them.
 *
 * It knows nothing about wheelchairs or anyone in particular: a body is only numbers, and a
 * model decides which numbers fit the question it was asked. These are the tools it uses, so
 * whatever it tells someone rests on the same rules the game itself runs on.
 *
 * Pure and deterministic, like everything in this package.
 */
import type { PersonDef, Scene, WorldSettings, WorldSpec } from "@aye/schema";
import { buildNavGrid, cellCentre, Flag } from "./navgrid.ts";
import { Sim, TICKS_PER_HOUR } from "./sim.ts";

export interface BodyQuery {
  /** Shoulder to shoulder, or wheel to wheel. */
  widthMm: number;
  /** The highest step they can manage without stairs. */
  stepMm: number;
  stairs: boolean;
  /** Steepest slope they can climb, rise per 1000 run (a 1:12 ramp is 83). */
  slopePermille: number;
  speedMmPerS: number;
  /** The highest they can reach, from the floor. */
  reachUpMm: number;
}

/** A change to try. Things, crossings and openings are by their number in the place. */
export type PlaceChange =
  | { type: "remove_thing"; thing: number }
  /** A ramp over a crossing, at the slope chosen (rise per 1000 run). */
  | { type: "ramp"; crossing: number; slopePermille: number }
  | { type: "widen"; opening: number; widthMm: number };

const CROSSING_CELL_MM = 100;

const clampTo = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(v)));

/**
 * Every place the floor changes on the way through: the crossings the scene marks, then any
 * doorway or gate whose two sides are at different heights with nothing marked there. A rise
 * like that stops wheels just the same, so it has to be something a ramp can be tried on.
 * Numbering is stable: marked crossings keep theirs, and the rest follow in opening order.
 */
export function crossingsOf(scene: Scene): Scene["levelChanges"] {
  const found: Scene["levelChanges"][number][] = [];
  for (const level of scene.levels) {
    const grid = buildNavGrid(scene, level.id, { cellMm: CROSSING_CELL_MM, isSolid: () => false });
    const floor = (i: number) => (grid.floorMm[i] as number) - (grid.lipMm[i] as number);
    scene.openings.forEach((opening, index) => {
      if (opening.levelId !== level.id) return;
      let highX = 0;
      let highZ = 0;
      let lowX = 0;
      let lowZ = 0;
      let pairs = 0;
      let rise = 0;
      for (let i = 0; i < grid.opening.length; i++) {
        if (grid.opening[i] !== index) continue;
        // Across the opening only, in index order, so the same scene gives the same crossing.
        for (const j of [i + 1, i + grid.width]) {
          if (j >= grid.opening.length || (grid.flags[j] as number) & Flag.Blocked) continue;
          if ((grid.flags[i] as number) & Flag.LevelChange) continue;
          if ((grid.flags[j] as number) & Flag.LevelChange) continue;
          const d = floor(i) - floor(j);
          if (d === 0) continue;
          const [ix, iz] = cellCentre(grid, i);
          const [jx, jz] = cellCentre(grid, j);
          highX += d > 0 ? ix : jx;
          highZ += d > 0 ? iz : jz;
          lowX += d > 0 ? jx : ix;
          lowZ += d > 0 ? jz : iz;
          rise = Math.max(rise, Math.abs(d));
          pairs++;
        }
      }
      if (pairs === 0) return;
      found.push({
        id: `lch_${opening.id.slice(opening.id.indexOf("_") + 1)}` as never,
        kind: "step",
        fromLevelId: level.id,
        toLevelId: level.id,
        // From the top, so a ramp tried here runs down into the lower side.
        from: [Math.round(highX / pairs), Math.round(highZ / pairs)],
        to: [Math.round(lowX / pairs), Math.round(lowZ / pairs)],
        widthMm: opening.clearWidthMm,
        riseMm: rise,
        stepCount: 1,
        hasHandrail: false,
      });
    });
  }
  return [...scene.levelChanges, ...found];
}

/** The place with these changes made; anything that doesn't apply is ignored and reported. */
export function withChanges(
  scene: Scene,
  changes: readonly PlaceChange[],
): { scene: Scene; ignored: number } {
  const removed = new Set<number>();
  const objects = scene.objects;
  let openings = scene.openings;
  let levelChanges = crossingsOf(scene);
  let ignored = 0;
  for (const c of changes) {
    if (c.type === "remove_thing") {
      if (objects[c.thing]) removed.add(c.thing);
      else ignored++;
    } else if (c.type === "ramp") {
      const at = levelChanges[c.crossing];
      if (!at) {
        ignored++;
        continue;
      }
      // As long as that slope takes, along the way the crossing already runs.
      const dx = at.to[0] - at.from[0];
      const dz = at.to[1] - at.from[1];
      const run = Math.max(1, Math.hypot(dx, dz));
      const need = Math.max(
        run,
        Math.ceil((at.riseMm * 1_000) / clampTo(c.slopePermille, 20, 500)),
      );
      const to: [number, number] = [
        Math.round(at.from[0] + (dx / run) * need),
        Math.round(at.from[1] + (dz / run) * need),
      ];
      levelChanges = levelChanges.map((l, i) =>
        i === c.crossing ? { ...l, kind: "ramp" as const, stepCount: 0, to } : l,
      );
    } else {
      if (!openings[c.opening]) {
        ignored++;
        continue;
      }
      const clearWidthMm = clampTo(c.widthMm, 300, 6_000);
      // Made to measure, so no lip left to get over either.
      openings = openings.map((o, i) =>
        i === c.opening ? { ...o, clearWidthMm, thresholdMm: 0 } : o,
      );
    }
  }
  return {
    scene: {
      ...scene,
      openings,
      levelChanges,
      objects: objects.filter((_, i) => !removed.has(i)),
    },
    ignored,
  };
}

function personOf(spec: WorldSpec, body: BodyQuery): PersonDef {
  return {
    key: "asked_about",
    name: "Asked about",
    about: "",
    colours: { skin: "#8d5a3b", top: "#808080", bottom: "#404040" },
    body: {
      widthMm: clampTo(body.widthMm, 300, 1_200),
      stepMm: clampTo(body.stepMm, 0, 400),
      stairs: body.stairs,
      slopePermille: clampTo(body.slopePermille, 20, 1_000),
      speedMmPerS: clampTo(body.speedMmPerS, 200, 3_000),
      seated: false,
    },
    money: Math.max(1_000_000, spec.hourPay * 40),
    needs: spec.needs.map((n) => ({ need: n.key, start: 700 })),
  };
}

/** Things this body can get to, by object id. */
function reachableIds(
  scene: Scene,
  spec: WorldSpec,
  settings: WorldSettings,
  person: PersonDef,
): Set<string> {
  const sim = new Sim({ scene, spec, settings, people: [person] });
  sim.step([]);
  const slot = sim.slotOf(person.key);
  const ids = new Set<string>();
  sim.things.forEach((t, i) => {
    if (sim.canReach(slot, i)) ids.add(t.id);
  });
  return ids;
}

export interface BodyReport {
  /** Everything that has something to do, and whether this body gets to it. */
  things: {
    thing: number;
    label: string;
    reaches: boolean;
    /**
     * Why not: "width" (a gap's too narrow), "level" (a step, stairs or slope), "both" (only the
     * two together), "cut_off" (neither would help), "height" (out of reach above them).
     */
    blockedBy: "width" | "level" | "height" | "both" | "cut_off" | null;
    /** Its bottom above the floor. */
    aboveFloorMm: number;
  }[];
  crossings: {
    crossing: number;
    kind: string;
    riseMm: number;
    steps: number;
    widthMm: number;
    /** How far it runs along the floor: a ramp's real length. */
    runMm: number;
    fits: boolean;
    climbs: boolean;
  }[];
  openings: { opening: number; kind: string; widthMm: number; lipMm: number; fits: boolean }[];
  /** How many of the changes asked for couldn't be made. */
  ignoredChanges: number;
}

/** What this body can and can't get to in this place (with these changes), and why. */
export function tryBody(
  base: Scene,
  spec: WorldSpec,
  settings: WorldSettings,
  body: BodyQuery,
  changes: readonly PlaceChange[] = [],
): BodyReport {
  const { scene, ignored } = withChanges(base, changes);
  const person = personOf(spec, body);
  const reached = reachableIds(scene, spec, settings, person);
  // What would change if the body were narrower, or could climb anything: that's the reason.
  const narrow = reachableIds(scene, spec, settings, {
    ...person,
    body: { ...person.body, widthMm: 300 },
  });
  const climbing = reachableIds(scene, spec, settings, {
    ...person,
    body: { ...person.body, stepMm: 400, stairs: true, slopePermille: 1_000 },
  });
  const both = reachableIds(scene, spec, settings, {
    ...person,
    body: { ...person.body, widthMm: 300, stepMm: 400, stairs: true, slopePermille: 1_000 },
  });
  const used = new Map(spec.things.map((t) => [t.object as string, t.kind]));
  const actionable = new Set(spec.kinds.filter((k) => k.actions.length > 0).map((k) => k.key));
  const things: BodyReport["things"] = [];
  scene.objects.forEach((o) => {
    const kind = used.get(o.id);
    if (!kind || !actionable.has(kind)) return;
    const number = base.objects.findIndex((x) => x.id === o.id);
    const aboveFloorMm = o.transform.position[1];
    const tooHigh = aboveFloorMm > body.reachUpMm;
    const gets = reached.has(o.id);
    const reaches = gets && !tooHigh;
    let blockedBy: BodyReport["things"][number]["blockedBy"] = null;
    if (!gets) {
      if (narrow.has(o.id)) blockedBy = "width";
      else if (climbing.has(o.id)) blockedBy = "level";
      else if (both.has(o.id)) blockedBy = "both";
      else blockedBy = "cut_off";
    } else if (tooHigh) {
      blockedBy = "height";
    }
    things.push({ thing: number, label: o.label, reaches, blockedBy, aboveFloorMm });
  });
  const climbsRise = (rise: number, steps: number, runMm: number, kind: string) => {
    if (rise === 0) return true;
    if (kind === "ramp") return (rise * 1000) / Math.max(1, runMm) <= person.body.slopePermille;
    if (kind === "lift") return true;
    if (steps > 1 || kind === "stairs") return person.body.stairs;
    return rise <= person.body.stepMm;
  };
  return {
    things,
    crossings: scene.levelChanges.map((l, crossing) => ({
      crossing,
      kind: l.kind,
      riseMm: l.riseMm,
      steps: l.stepCount,
      widthMm: l.widthMm,
      runMm: Math.round(Math.hypot(l.to[0] - l.from[0], l.to[1] - l.from[1])),
      fits: l.widthMm >= person.body.widthMm,
      climbs: climbsRise(
        l.riseMm,
        l.stepCount,
        Math.hypot(l.to[0] - l.from[0], l.to[1] - l.from[1]),
        l.kind,
      ),
    })),
    openings: scene.openings.map((o, opening) => ({
      opening,
      kind: o.kind,
      widthMm: o.clearWidthMm,
      lipMm: o.thresholdMm,
      fits: o.clearWidthMm >= person.body.widthMm && o.thresholdMm <= person.body.stepMm,
    })),
    ignoredChanges: ignored,
  };
}

export interface DayReport {
  hours: number;
  /** What they ended up doing, most often first. */
  did: { label: string; times: number }[];
  /** Hours each need sat at nothing: what this place can't do for them. */
  neglected: { need: string; hoursAtZero: number }[];
}

/** Have this body live a whole day here (it chooses for itself), and report how it went. */
export function tryDay(
  base: Scene,
  spec: WorldSpec,
  settings: WorldSettings,
  body: BodyQuery,
  changes: readonly PlaceChange[] = [],
  hours = 24,
): DayReport {
  const { scene } = withChanges(base, changes);
  const person = personOf(spec, body);
  const sim = new Sim({ scene, spec, settings, people: [person] });
  const slot = sim.slotOf(person.key);
  const N = sim.needKeys.length;
  const zero = new Array<number>(N).fill(0);
  const times = new Map<string, number>();
  const labelOf = new Map(spec.kinds.flatMap((k) => k.actions.map((a) => [a.key, a.label])));
  const total = Math.min(72, Math.max(1, Math.floor(hours))) * TICKS_PER_HOUR;
  for (let t = 0; t < total; t++) {
    for (const e of sim.step([])) {
      if (e.type === "action_started" && e.agent === person.key) {
        const label = labelOf.get(e.action) ?? e.action;
        times.set(label, (times.get(label) ?? 0) + 1);
      }
    }
    if (t % TICKS_PER_HOUR === 0) {
      for (let k = 0; k < N; k++) {
        if ((sim.needs[slot * N + k] as number) === 0) zero[k] = (zero[k] as number) + 1;
      }
    }
  }
  return {
    hours: total / TICKS_PER_HOUR,
    did: [...times.entries()]
      .map(([label, n]) => ({ label, times: n }))
      .sort((a, b) => b.times - a.times || a.label.localeCompare(b.label)),
    neglected: sim.needKeys
      .map((need, k) => ({ need, hoursAtZero: zero[k] as number }))
      .filter((n) => n.hoursAtZero > 0),
  };
}
