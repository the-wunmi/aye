/**
 * City life in a Web Worker: the city sim runs here, off the main thread,
 * so a real city's tens of thousands of agents never stall drawing or input. The page asks
 * for a minute; this runs to it and sends back where everyone is and how full each road is.
 * Only our own page talks to it; it holds no secrets and makes no requests.
 *
 * It also compares a planner's scenario with the city as it is: two whole days
 * from midnight, same city, people and seed, one with the scenario's roads.
 */
import {
  type CityLayout,
  type CityPopulation,
  type CityReport,
  type CityScenario,
  CitySim,
} from "@aye/sim";

export type LifeRequest =
  | {
      type: "start";
      layout: CityLayout;
      population: CityPopulation;
      seed: number;
      maxAgents: number;
      /** Start of the city's day (midnight), then run to `minute`. */
      dayStart: number;
      minute: number;
    }
  | { type: "advance"; minute: number }
  | {
      type: "compare";
      layout: CityLayout;
      population: CityPopulation;
      seed: number;
      maxAgents: number;
      scenario: CityScenario;
    };

/** The hours a comparison judges roads over (the day, not the empty night). */
const DAY_FROM = 6 * 60;
const DAY_TO = 21 * 60;

export interface Compared {
  type: "compared";
  base: CityReport;
  plan: CityReport;
  /** Per edge: how much fuller it is with the scenario, permille of what it holds, by day. */
  changePermille: Int16Array;
  x: Int32Array;
  z: Int32Array;
  a: Int32Array;
  b: Int32Array;
}

export type LifeReply =
  | {
      type: "graph";
      x: Int32Array;
      z: Int32Array;
      a: Int32Array;
      b: Int32Array;
      agents: number;
      people: number;
      scale: number;
    }
  | {
      type: "frame";
      minute: number;
      xz: Float32Array;
      mover: Uint8Array;
      dir: Float32Array;
      loadPermille: Uint16Array;
      stats: ReturnType<CitySim["stats"]>;
    }
  | { type: "progress"; done: number }
  | Compared;

let sim: CitySim | null = null;

function frame(s: CitySim): LifeReply {
  const xz = new Float32Array(s.agents * 2);
  const mover = new Uint8Array(s.agents);
  const dir = new Float32Array(s.agents * 2);
  s.positions(xz, mover, dir);
  const loadPermille = new Uint16Array(s.edgeA.length);
  for (let e = 0; e < loadPermille.length; e++) {
    loadPermille[e] = Math.min(
      65_535,
      Math.floor(((s.load[e] as number) * 1000) / Math.max(1, s.edgeCap[e] as number)),
    );
  }
  return { type: "frame", minute: s.minute, xz, mover, dir, loadPermille, stats: s.stats() };
}

const post = (m: LifeReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(
    m,
    transfer,
  );

/** A whole day, and how full each road was through the day hours, summed. */
function wholeDay(sim: CitySim, onHour: (h: number) => void): Float64Array {
  const fullness = new Float64Array(sim.edgeA.length);
  while (sim.minute < 1440) {
    sim.step();
    if (sim.minute >= DAY_FROM && sim.minute < DAY_TO) {
      for (let e = 0; e < fullness.length; e++) {
        fullness[e] =
          (fullness[e] as number) + (sim.load[e] as number) / Math.max(1, sim.edgeCap[e] as number);
      }
    }
    if (sim.minute % 60 === 0) onHour(sim.minute / 60);
  }
  return fullness;
}

function compare(m: Extract<LifeRequest, { type: "compare" }>): void {
  const base = new CitySim(m.layout, m.population, m.seed, { maxAgents: m.maxAgents });
  const before = wholeDay(base, (h) => post({ type: "progress", done: h / 48 }));
  const plan = new CitySim(m.layout, m.population, m.seed, {
    maxAgents: m.maxAgents,
    scenario: m.scenario,
  });
  const after = wholeDay(plan, (h) => post({ type: "progress", done: 0.5 + h / 48 }));
  const changePermille = new Int16Array(before.length);
  for (let e = 0; e < before.length; e++) {
    const d = (((after[e] as number) - (before[e] as number)) * 1000) / (DAY_TO - DAY_FROM);
    changePermille[e] = Math.max(-32_000, Math.min(32_000, Math.round(d)));
  }
  const out: Compared = {
    type: "compared",
    base: base.report(),
    plan: plan.report(),
    changePermille,
    x: base.nodeX.slice(),
    z: base.nodeZ.slice(),
    a: base.edgeA.slice(),
    b: base.edgeB.slice(),
  };
  post(out, [out.changePermille.buffer]);
}

self.onmessage = (ev: MessageEvent<LifeRequest>) => {
  const m = ev.data;
  if (m.type === "compare") {
    compare(m);
    return;
  }
  if (m.type === "start") {
    sim = new CitySim(m.layout, m.population, m.seed, { maxAgents: m.maxAgents });
    sim.minute = m.dayStart;
    post({
      type: "graph",
      x: sim.nodeX.slice(),
      z: sim.nodeZ.slice(),
      a: sim.edgeA.slice(),
      b: sim.edgeB.slice(),
      agents: sim.agents,
      people: sim.population,
      scale: sim.scale,
    });
    sim.runTo(m.minute);
  } else if (sim) {
    sim.runTo(m.minute);
  }
  if (!sim) return;
  const f = frame(sim);
  if (f.type === "frame") {
    post(f, [f.xz.buffer, f.mover.buffer, f.dir.buffer, f.loadPermille.buffer]);
  }
};
