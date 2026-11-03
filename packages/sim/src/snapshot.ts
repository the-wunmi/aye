/**
 * A plain snapshot of everything a viewer needs to draw a place and its people at one tick.
 * The realm server streams these to players; the same shape drives the renderer whether the
 * sim runs on a server or anywhere else. Integers only, so it serialises exactly.
 */
import type { Snapshot } from "@aye/schema";
import { MAX_PEOPLE, Mode, NEED_SCALE, POSES, type Sim } from "./sim.ts";

export function snapshot(sim: Sim): Snapshot {
  const positions: number[] = [];
  const poses: number[] = [];
  const doing: string[] = [];
  const using: string[] = [];
  const on: number[] = [];
  for (let i = 0; i < MAX_PEOPLE; i++) {
    if (!sim.present[i]) {
      positions.push(0, 0);
      poses.push(255);
      doing.push("");
      using.push("");
      on.push(0);
      continue;
    }
    const [x, z] = sim.position(i);
    positions.push(x, z);
    const { action, thing } = sim.activity(i);
    const mode = sim.mode[i];
    const acting = mode === Mode.Acting || mode === Mode.Away;
    poses.push(acting && action ? (mode === Mode.Away ? 3 : POSES.indexOf(action.pose)) : 255);
    doing.push(action && mode !== Mode.Idle ? action.label : "");
    const resting = mode === Mode.Acting && (action?.pose === "sit" || action?.pose === "lie");
    using.push(resting && thing ? thing : "");
    on.push(resting && action ? (action.on === undefined ? 2 : action.on ? 1 : 0) : 0);
  }
  return {
    tick: sim.tick,
    clock: sim.clock(),
    positions,
    modes: Array.from(sim.mode),
    poses,
    needs: Array.from(sim.needs, (v) => Math.floor(v / NEED_SCALE)),
    marks: Array.from(sim.marks),
    wallet: Array.from(sim.wallet),
    thingVars: Array.from(sim.thingVars),
    thingAway: Array.from(sim.thingAway, (until) => (until > sim.tick ? 1 : 0)),
    resourcesOn: sim.resourceKeys.map((_, r) => (sim.resourceOn(r) ? 1 : 0)),
    shut: sim.shut,
    doing,
    using,
    on,
  };
}
