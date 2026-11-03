/**
 * City life: the people of a whole city going about their day on its roads.
 *
 * The city's model writes who lives where and what their day looks like (`Population`); this
 * plays it. Roads become a graph (split where they cross, joined where they nearly meet).
 * Each agent (one per person, or one standing for several when a city is big) leaves home or
 * wherever they are at their routine's times, give or take a personal habit of minutes, and
 * takes the shortest way by road. Vehicles slow as a road fills: a speed–density model
 * (Greenshields: speed falls linearly from free flow to a crawl as a road approaches its jam
 * density), with how many a road holds from its lanes (its width) and length. People on foot
 * (slow modes) don't congest roads.
 *
 * It is a plausible, generic model of a city the model invented, not a calibrated one of a
 * real city: good for seeing how a place lives, not for decisions about real streets.
 *
 * Deterministic like the place sim: one step is one city minute; all state is
 * integers (metres, minutes, people); randomness comes from one seeded stream; agents and
 * roads are processed in index order; `hash()` covers all mutable state. Same city, same
 * population, same seed ⇒ same hash everywhere, so every player sees the same traffic.
 */
import { Rng } from "./rng.ts";

type Pt = readonly [number, number];

export interface CityLayout {
  districts: readonly { key: string; polygon: readonly Pt[] }[];
  places: readonly { key: string; at: Pt }[];
  roads: readonly { points: readonly Pt[]; widthM: number }[];
  /** The city's ways to get around: its kinds with the mover trait. */
  movers: readonly {
    key: string;
    speedKmh: number;
    /** People one carries, driver included (0: people on foot). */
    holds: number;
    /** The network it runs on. */
    way: "road" | "water" | "rail";
    /** For a line: the mover its riders reach its stops by; null: on foot. */
    reach: string | null;
  }[];
  /**
   * A real road network to play on instead of `roads`: nodes as x, z pairs and
   * links as rows of [a, b, lanes each way, speed km/h, one-way, class, name], with each
   * link's shape points (for its true length).
   */
  network?: {
    nodes: readonly number[];
    links: readonly number[];
    shapeAt: readonly number[];
    shape: readonly number[];
  };
}

/**
 * A planner's what-if: roads closed, or given more or fewer lanes each way, by
 * edge index (for a real city, its network link). Applied when the sim is built, so a
 * scenario and its baseline are two sims of the same city, seed and population.
 */
export interface CityScenario {
  closed?: readonly number[];
  /** [edge, lanes each way], lanes 1..8. */
  lanes?: readonly (readonly [number, number])[];
}

/** What a day (or any stretch) of city life came to: people, not agents. */
export interface CityReport {
  /** Trips finished, and the minutes they took altogether. */
  trips: number;
  tripMinutes: number;
  /** Trips nobody could make: no way there by road. They stayed where they were. */
  unreached: number;
  /** People-minutes spent queued for room on a road or for a road's exit. */
  queuedMinutes: number;
}

/** Integers per link row in a network (see `RoadNetwork` in @aye/schema). */
const LINK_ROW = 7;
/**
 * What an edge is, from its network class (`ROAD_CLASSES` in @aye/schema: roads up to 5,
 * then ferry 6, rail 7, access 8): a road, a ferry route, a railway, or the access between a
 * line's stop and the road.
 */
const Kind = { Road: 0, Ferry: 1, Rail: 2, Access: 3 } as const;
const kindOfClass = (cls: number) =>
  cls === 6 ? Kind.Ferry : cls === 7 ? Kind.Rail : cls === 8 ? Kind.Access : Kind.Road;
/**
 * Who may use which edges: road traffic only roads; boat and train riders their own lines,
 * the access to them, and the roads (reaching a stop, not driving).
 */
const WAY = { road: 0, water: 1, rail: 2 } as const;
const allowed = (way: number, kind: number) =>
  kind === Kind.Road ||
  (way === WAY.water && (kind === Kind.Ferry || kind === Kind.Access)) ||
  (way === WAY.rail && (kind === Kind.Rail || kind === Kind.Access));
/** How fast a line's riders get along the roads to and from its stops, metres a minute. */
/** How fast people get about when the city has nobody on foot to say (metres a minute). */
const FALLBACK_M_PER_MIN = 80;

export interface CityPopulation {
  groups: readonly {
    key: string;
    count: number;
    home: string;
    routine: readonly {
      at: number;
      place: string | null;
      /** Somewhere in a district instead of a place: each agent gets its own spot there. */
      district?: string | undefined;
      mode: string;
    }[];
  }[];
}

/** Representative junctions per district that its trips go to (routing stays on trees). */
const HUBS_PER_DISTRICT = 32;
/** Junctions around a place its visitors arrive at (a market is a neighbourhood, not a node). */
const PLACE_SPREAD = 12;
const PLACE_SPREAD_M = 600;
/**
 * Minutes between re-routings: routes are fastest by the roads as they are now (free-flow
 * time stretched by how full each road is), so later travellers go around jams.
 */
const REROUTE_MIN = 15;

/** Agents simulated at most; bigger populations are represented by fewer, weightier agents. */
export const CITY_MAX_AGENTS = 3_000;
/** How far a habit shifts someone's day, minutes either way. */
const HABIT_MIN = 35;
/** Metres of lane a vehicle takes in a jam, and the people one carries on average. */
const JAM_GAP_M = 8;
const PEOPLE_PER_VEHICLE = 2;
/**
 * How much road density is judged over, at least, metres: an agent stands for several
 * people spread along a road, not stacked on a 20 m stretch between two junctions, so a
 * short link is judged as part of the road it belongs to.
 */
const DENSITY_MIN_M = 200;
/** Vehicles a lane lets out a minute at most (1,800 an hour: a lane's usual capacity). */
const LANE_VEHICLES_PER_MIN = 30;
/** How far along a road a queue at its junction is drawn. */
const QUEUE_DRAWN_M = 150;
/** Minutes someone waits for room on the next road before squeezing on anyway (gridlock). */
const STUCK_MIN = 10;
/** The slowest a jam gets, permille of free flow: a crawl, never a standstill. */
const CRAWL_PERMILLE = 60;

/** `positions()`: someone not out (not drawn). */
export const RESTING = 255;

/** What an agent is doing. */
const State = { Resting: 0, Travelling: 1 } as const;

export interface CityStats {
  /** People (not agents) out on a trip right now, and of them on the roads in vehicles. */
  travelling: number;
  onRoads: number;
  /** Average speed of road traffic as a share of free flow, permille (1000 = no delay). */
  flowPermille: number;
  /** The fullest road segment, as people on it over what it holds in a jam, permille. */
  worstPermille: number;
  /** Which edge that is (its network link, for a real city), or -1 if the roads are empty. */
  worstEdge: number;
}

export class CitySim {
  /** City minutes since the simulation's start (day 0, 00:00). */
  minute = 0;
  readonly scale: number;
  readonly agents: number;
  readonly population: number;

  // ── Road graph ─────────────────────────────────────────────────────────────────────────
  readonly nodeX: Int32Array;
  readonly nodeZ: Int32Array;
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  readonly edgeLen: Int32Array;
  readonly edgeCap: Int32Array;
  /** Free-flow speed on each edge, metres a minute (0: no limit but the traveller's own). */
  readonly edgeFree: Int32Array;
  /** 1 where an edge only runs a → b. */
  readonly edgeOneway: Uint8Array;
  /** People an edge lets out a minute at most (its lanes' flow capacity). */
  readonly edgeFlow: Int32Array;
  /** 1 where a scenario closed an edge: nobody routes over it. */
  readonly edgeClosed: Uint8Array;
  /** What each edge is (`Kind`). */
  readonly edgeKind: Uint8Array;
  /** 1 for junctions on a road: where people live, go and set off from. */
  readonly #roadNode: Uint8Array;
  /** The network each agent's current trip travels on (`WAY`). */
  readonly #way: Uint8Array;
  readonly #modeWay: Map<string, number>;
  readonly #modeIndex: Map<string, number>;
  /** How fast each network's riders get to its stops along the roads (metres a minute). */
  readonly #accessPace: Int32Array;
  /** Which mover each agent's current trip is by (index into the layout's movers). */
  readonly #mover: Uint8Array;
  /** What has happened so far (see `CityReport`). */
  #trips = 0;
  #tripMinutes = 0;
  #unreached = 0;
  #queuedMinutes = 0;
  /** The minute each agent's current trip began. */
  readonly #tripStart: Int32Array;
  /** People let out of each edge this minute (reset every minute). */
  readonly #exited: Int32Array;
  /** Minutes each agent has waited at the end of a road for room on the next. */
  readonly #waited: Uint16Array;
  /** Edges you can leave each node by, and arrive at it by (CSR), index-ordered. */
  readonly #outStart: Int32Array;
  readonly #out: Int32Array;
  readonly #inStart: Int32Array;
  readonly #in: Int32Array;
  /** Shortest-path trees out of and into each place's node, built when first needed. */
  readonly #treesOut = new Map<number, Int32Array>();
  readonly #treesIn = new Map<number, Int32Array>();
  readonly #placeNodes: Set<number>;

  // ── Agents (struct of arrays) ──────────────────────────────────────────────────────────
  readonly #group: Uint16Array;
  readonly #homeNode: Int32Array;
  readonly #habit: Int16Array;
  readonly #nextStop: Int16Array;
  readonly #state: Uint8Array;
  readonly #at: Int32Array;
  readonly #target: Int32Array;
  readonly #speed: Int32Array;
  readonly #foot: Uint8Array;
  /**
   * How much road each agent's trip takes, in car-sized people (PEOPLE_PER_VEHICLE a car):
   * its people over its vehicle's occupancy. A busload takes a bus's room, not 14 cars'.
   */
  readonly #weight: Int32Array;
  /** Current route: its edges live in #routes from #routeAt, #routeLeft edges to go. */
  readonly #routeAt: Int32Array;
  readonly #routeLeft: Int32Array;
  /** Metres along the current edge, and which way it's walked (1: a→b, 0: b→a). */
  readonly #along: Int32Array;
  readonly #forward: Uint8Array;
  readonly #edge: Int32Array;
  /** Travellers (people) on each edge in vehicles. */
  readonly load: Int32Array;

  readonly #groups: CityPopulation["groups"];
  /** Per agent and stop: the junction a district stop goes to, or -1. */
  readonly #stopNode: Int32Array;
  readonly #stops: number;
  readonly #placeNode: Map<string, number>;
  readonly #modeSpeed: Map<string, number>;
  readonly #modeCarries: Map<string, number>;
  readonly #routes: number[] = [];
  readonly #routeCache = new Map<number, { at: number; n: number }>();

  constructor(
    layout: CityLayout,
    population: CityPopulation,
    seed: number,
    opts: { maxAgents?: number; scenario?: CityScenario } = {},
  ) {
    const graph = layout.network ? networkGraph(layout.network) : buildRoadGraph(layout.roads);
    // A scenario: lanes change what a road holds and lets out; closed roads aren't joined up.
    this.edgeKind = graph.kind;
    this.edgeClosed = new Uint8Array(graph.a.length);
    for (const e of opts.scenario?.closed ?? []) {
      if (Number.isInteger(e) && e >= 0 && e < graph.a.length) this.edgeClosed[e] = 1;
    }
    for (const [e, lanes] of opts.scenario?.lanes ?? []) {
      if (!Number.isInteger(e) || e < 0 || e >= graph.a.length) continue;
      const was = graph.lanes[e] as number;
      const now = Math.max(1, Math.min(8, Math.floor(lanes)));
      graph.cap[e] = Math.max(1, Math.floor(((graph.cap[e] as number) * now) / was));
      graph.flow[e] = Math.max(1, Math.floor(((graph.flow[e] as number) * now) / was));
      graph.lanes[e] = now;
    }
    this.nodeX = graph.x;
    this.nodeZ = graph.z;
    this.edgeA = graph.a;
    this.edgeB = graph.b;
    this.edgeLen = graph.len;
    this.edgeCap = graph.cap;
    this.edgeFree = graph.free;
    this.edgeOneway = graph.oneway;
    this.edgeFlow = graph.flow;
    this.#exited = new Int32Array(this.edgeA.length);
    const n = this.nodeX.length;
    // Adjacency in CSR form, edges in index order: deterministic routing. A one-way edge
    // leaves only from a and arrives only at b.
    const csr = (ends: (e: number) => number[]) => {
      const start = new Int32Array(n + 1);
      for (let e = 0; e < this.edgeA.length; e++) {
        if (this.edgeClosed[e]) continue;
        for (const v of ends(e)) start[v + 1] = (start[v + 1] as number) + 1;
      }
      for (let v = 0; v < n; v++) start[v + 1] = (start[v + 1] as number) + (start[v] as number);
      const list = new Int32Array(start[n] as number);
      const fill = start.slice(0, n);
      for (let e = 0; e < this.edgeA.length; e++) {
        if (this.edgeClosed[e]) continue;
        for (const v of ends(e)) {
          list[fill[v] as number] = e;
          fill[v] = (fill[v] as number) + 1;
        }
      }
      return { start, list };
    };
    const a = (e: number) => this.edgeA[e] as number;
    const b = (e: number) => this.edgeB[e] as number;
    const out = csr((e) => (this.edgeOneway[e] ? [a(e)] : [a(e), b(e)]));
    const into = csr((e) => (this.edgeOneway[e] ? [b(e)] : [a(e), b(e)]));
    this.#outStart = out.start;
    this.#out = out.list;
    this.#inStart = into.start;
    this.#in = into.list;

    this.#modeCarries = new Map(layout.movers.map((m) => [m.key, m.holds]));
    this.#modeWay = new Map(layout.movers.map((m) => [m.key, WAY[m.way]]));
    this.#modeIndex = new Map(layout.movers.map((m, k) => [m.key, k]));
    const perMin = (kmh: number) => Math.max(1, Math.floor((kmh * 1000) / 60));
    // How each line's riders get to its stops along the roads: the mover the city names, or
    // on foot (its slowest mover that carries nobody).
    const foot = layout.movers
      .filter((m) => m.holds === 0)
      .sort((a, b) => a.speedKmh - b.speedKmh)[0];
    const footPace = foot ? perMin(foot.speedKmh) : FALLBACK_M_PER_MIN;
    this.#accessPace = new Int32Array(3).fill(footPace);
    for (const m of layout.movers) {
      if (m.way === "road") continue;
      const by = m.reach ? layout.movers.find((x) => x.key === m.reach) : undefined;
      this.#accessPace[WAY[m.way]] = by ? perMin(by.speedKmh) : footPace;
    }
    this.#roadNode = new Uint8Array(n);
    for (let e = 0; e < this.edgeA.length; e++) {
      if (this.edgeKind[e] !== Kind.Road) continue;
      this.#roadNode[this.edgeA[e] as number] = 1;
      this.#roadNode[this.edgeB[e] as number] = 1;
    }
    if (!this.#roadNode.includes(1)) this.#roadNode.fill(1);
    this.#modeSpeed = new Map(layout.movers.map((m) => [m.key, perMin(m.speedKmh)]));
    this.#placeNode = new Map(layout.places.map((p) => [p.key, this.nearestNode(p.at)]));
    this.#placeNodes = new Set(this.#placeNode.values());
    // Each place's arrival area: the junctions nearest it, nearest first (ties by index).
    const areas = new Map<string, number[]>();
    for (const [key, node] of this.#placeNode) {
      const x0 = this.nodeX[node] as number;
      const z0 = this.nodeZ[node] as number;
      const nearest = Array.from({ length: this.nodeX.length }, (_, v) => v)
        .filter((v) => this.#roadNode[v] === 1)
        .map((v) => ({
          v,
          d: ((this.nodeX[v] as number) - x0) ** 2 + ((this.nodeZ[v] as number) - z0) ** 2,
        }))
        .sort((a, b) => a.d - b.d || a.v - b.v)
        .filter((n, k) => k === 0 || n.d <= PLACE_SPREAD_M * PLACE_SPREAD_M)
        .slice(0, PLACE_SPREAD)
        .map((n) => n.v);
      areas.set(key, nearest);
      for (const v of nearest) this.#placeNodes.add(v);
    }
    // Each district's hubs: junctions spread through it, in index order (deterministic).
    const hubs = new Map<string, number[]>();
    for (const d of layout.districts) {
      const inside = this.#nodesIn(d.polygon);
      const step = Math.max(1, Math.floor(inside.length / HUBS_PER_DISTRICT));
      const picked = inside.filter((_, k) => k % step === 0).slice(0, HUBS_PER_DISTRICT);
      const list = picked.length > 0 ? picked : [this.nearestNode(centroid(d.polygon))];
      hubs.set(d.key, list);
      for (const h of list) this.#placeNodes.add(h);
    }
    this.#groups = population.groups;
    this.population = population.groups.reduce((s, g) => s + g.count, 0);
    this.scale = Math.max(1, Math.ceil(this.population / (opts.maxAgents ?? CITY_MAX_AGENTS)));

    const rng = Rng.seeded(seed, 7);
    const counts = population.groups.map((g) => Math.max(1, Math.round(g.count / this.scale)));
    const total = counts.reduce((s, c) => s + c, 0);
    this.agents = total;
    this.#group = new Uint16Array(total);
    this.#homeNode = new Int32Array(total);
    this.#habit = new Int16Array(total);
    this.#nextStop = new Int16Array(total);
    this.#state = new Uint8Array(total);
    this.#at = new Int32Array(total);
    this.#target = new Int32Array(total);
    this.#speed = new Int32Array(total);
    this.#foot = new Uint8Array(total);
    this.#weight = new Int32Array(total);
    this.#routeAt = new Int32Array(total);
    this.#routeLeft = new Int32Array(total);
    this.#along = new Int32Array(total);
    this.#forward = new Uint8Array(total);
    this.#edge = new Int32Array(total).fill(-1);
    this.load = new Int32Array(this.edgeA.length);
    this.#stops = Math.max(1, ...population.groups.map((g) => g.routine.length));
    this.#stopNode = new Int32Array(total * this.#stops).fill(-1);
    this.#waited = new Uint16Array(total);
    this.#tripStart = new Int32Array(total);
    this.#way = new Uint8Array(total);
    this.#mover = new Uint8Array(total);

    let i = 0;
    population.groups.forEach((g, gi) => {
      const district = layout.districts.find((d) => d.key === g.home);
      const homes = district ? this.#nodesIn(district.polygon) : [];
      for (let k = 0; k < (counts[gi] as number); k++, i++) {
        this.#group[i] = gi;
        const home =
          homes.length > 0
            ? (homes[rng.int(homes.length)] as number)
            : this.nearestNode(centroid(district?.polygon ?? [[2000, 2000]]));
        this.#homeNode[i] = home;
        this.#at[i] = home;
        this.#habit[i] = rng.range(-HABIT_MIN, HABIT_MIN);
        g.routine.forEach((stop, k) => {
          const list =
            stop.place !== null
              ? areas.get(stop.place)
              : stop.district
                ? hubs.get(stop.district)
                : undefined;
          if (list) this.#stopNode[i * this.#stops + k] = list[rng.int(list.length)] as number;
        });
      }
    });
  }

  /** Advance one city minute. */
  step(): void {
    const minuteOfDay = this.minute % 1440;
    if (minuteOfDay === 0) this.#nextStop.fill(0);
    this.#exited.fill(0);
    for (let i = 0; i < this.agents; i++) {
      if (this.#state[i] === State.Resting) this.#maybeLeave(i, minuteOfDay);
      else this.#move(i);
    }
    this.minute++;
    if (this.minute % REROUTE_MIN === 0) this.#reroute();
  }

  /** Run to a given minute (e.g. the city clock), from wherever it is. */
  runTo(minute: number): void {
    while (this.minute < minute) this.step();
  }

  #maybeLeave(i: number, minuteOfDay: number): void {
    const g = this.#groups[this.#group[i] as number];
    const s = this.#nextStop[i] as number;
    const stop = g?.routine[s];
    if (!g || !stop) return;
    const when = (((stop.at + (this.#habit[i] as number)) % 1440) + 1440) % 1440;
    if (minuteOfDay !== when) return;
    this.#nextStop[i] = s + 1;
    const zone = this.#stopNode[i * this.#stops + s] as number;
    const target =
      zone >= 0
        ? zone
        : stop.place !== null
          ? (this.#placeNode.get(stop.place) ?? (this.#homeNode[i] as number))
          : (this.#homeNode[i] as number);
    if (target === this.#at[i]) return;
    const way = this.#modeWay.get(stop.mode) ?? WAY.road;
    const route = this.#route(this.#at[i] as number, target, way);
    if (!route) {
      // No road between them (a closed bridge, say): the trip isn't made, and they stay.
      this.#unreached += this.scale;
      return;
    }
    this.#tripStart[i] = this.minute;
    const speed = this.#modeSpeed.get(stop.mode) ?? 80;
    this.#speed[i] = speed;
    const carries = this.#modeCarries.get(stop.mode) ?? PEOPLE_PER_VEHICLE;
    this.#way[i] = way;
    // Riders of a line take no road room: they reach its stops on foot or by motorbike.
    this.#mover[i] = this.#modeIndex.get(stop.mode) ?? 0;
    // On foot, or riding a line: no road room taken (they reach its stops on the roads).
    this.#foot[i] = carries === 0 || way !== WAY.road ? 1 : 0;
    this.#weight[i] = Math.max(
      1,
      Math.round((this.scale * PEOPLE_PER_VEHICLE) / Math.max(1, carries)),
    );
    this.#target[i] = target;
    this.#routeAt[i] = route.at;
    this.#routeLeft[i] = route.n;
    this.#state[i] = State.Travelling;
    this.#enterEdge(i, this.#at[i] as number);
  }

  /**
   * Step onto the next edge of the route, leaving from node `from`, if it has room: a full
   * road takes no more vehicles, so they queue at the junction (edge -1) and try again.
   */
  #enterEdge(i: number, from: number, checked = false): boolean {
    const e = this.#routes[this.#routeAt[i] as number] as number;
    if (
      !checked &&
      !this.#foot[i] &&
      (this.load[e] as number) + (this.#weight[i] as number) > (this.edgeCap[e] as number)
    ) {
      // Waiting where they are; someone on an empty road always gets on (no deadlock).
      if ((this.load[e] as number) > 0) {
        this.#edge[i] = -1;
        return false;
      }
    }
    this.#routeAt[i] = (this.#routeAt[i] as number) + 1;
    this.#routeLeft[i] = (this.#routeLeft[i] as number) - 1;
    this.#edge[i] = e;
    this.#forward[i] = this.edgeA[e] === from ? 1 : 0;
    this.#along[i] = 0;
    if (!this.#foot[i]) this.load[e] = (this.load[e] as number) + (this.#weight[i] as number);
    return true;
  }

  #leaveEdge(i: number): void {
    const e = this.#edge[i] as number;
    if (e >= 0 && !this.#foot[i])
      this.load[e] = (this.load[e] as number) - (this.#weight[i] as number);
    this.#edge[i] = -1;
  }

  /**
   * A queue model (as in MATSim's): people cross a road at its free speed (or their own, if
   * slower), then leave its far end at most at the road's flow capacity a minute, and only
   * if the next road has room; otherwise they wait there, and the road fills behind them.
   * Someone stuck STUCK_MIN minutes squeezes on anyway, so a ring of full roads can't lock
   * forever. People on foot use neither capacity nor room.
   */
  #move(i: number): void {
    // Queued at a junction: try to get onto the road again.
    if ((this.#edge[i] as number) < 0) {
      const stuck = (this.#waited[i] as number) >= STUCK_MIN;
      if (!this.#enterEdge(i, this.#at[i] as number, stuck)) {
        this.#waited[i] = (this.#waited[i] as number) + 1;
        this.#queuedMinutes += this.scale;
        return;
      }
      this.#waited[i] = 0;
    }
    let budget = this.#speed[i] as number;
    while (budget > 0) {
      const e = this.#edge[i] as number;
      const len = this.edgeLen[e] as number;
      const free =
        this.#way[i] !== WAY.road && this.edgeKind[e] === Kind.Road
          ? this.#access(e, this.#way[i] as number)
          : (this.edgeFree[e] as number);
      const pace =
        free > 0
          ? Math.max(1, Math.min(1000, Math.floor((free * 1000) / (this.#speed[i] as number))))
          : 1000;
      const step = Math.floor((budget * pace) / 1000);
      const left = len - (this.#along[i] as number);
      if (step < left) {
        this.#along[i] = (this.#along[i] as number) + Math.max(1, step);
        return;
      }
      // At the far end: out only if the road lets more out this minute and there is room
      // on the next one.
      this.#along[i] = len;
      if (!this.#foot[i]) {
        const weight = this.#weight[i] as number;
        const out = (this.#exited[e] as number) + weight > (this.edgeFlow[e] as number);
        const next =
          (this.#routeLeft[i] as number) > 0
            ? (this.#routes[this.#routeAt[i] as number] as number)
            : -1;
        const full =
          next >= 0 &&
          (this.load[next] as number) > 0 &&
          (this.load[next] as number) + weight > (this.edgeCap[next] as number);
        // Stuck long enough, they squeeze on: slow traffic, but a ring of full roads never locks.
        const stuck = (this.#waited[i] as number) >= STUCK_MIN;
        if (((out && (this.#exited[e] as number) > 0) || full) && !stuck) {
          this.#waited[i] = (this.#waited[i] as number) + 1;
          this.#queuedMinutes += this.scale;
          return;
        }
        this.#exited[e] = (this.#exited[e] as number) + weight;
      }
      this.#waited[i] = 0;
      budget -= Math.max(1, Math.ceil((left * 1000) / pace));
      const end = this.#forward[i] ? (this.edgeB[e] as number) : (this.edgeA[e] as number);
      this.#leaveEdge(i);
      this.#at[i] = end;
      if ((this.#routeLeft[i] as number) <= 0) {
        this.#state[i] = State.Resting;
        this.#trips += this.scale;
        this.#tripMinutes += (this.minute + 1 - (this.#tripStart[i] as number)) * this.scale;
        return;
      }
      if (!this.#enterEdge(i, end, true)) return;
    }
  }

  /** Speed on an edge as a share of free flow, permille (Greenshields, integer). */
  speedPermille(e: number): number {
    const full = Math.floor(
      ((this.load[e] as number) * 1000) / Math.max(1, this.edgeCap[e] as number),
    );
    return Math.max(CRAWL_PERMILLE, 1000 - full);
  }

  /** How fast a line's riders cross a road on the way to its stops (metres a minute). */
  #access(e: number, way: number): number {
    const pace = this.#accessPace[way] as number;
    const free = this.edgeFree[e] as number;
    return free > 0 ? Math.min(pace, free) : pace;
  }

  /** Time to cross an edge at free flow (an integer cost for routing). */
  #cost(e: number, way: number): number {
    if (way !== WAY.road) {
      // A line's riders: their lines at line speed, roads at access pace, no congestion.
      const pace =
        this.edgeKind[e] === Kind.Road
          ? this.#access(e, way)
          : Math.max(1, this.edgeFree[e] as number);
      return Math.max(1, Math.floor(((this.edgeLen[e] as number) * 1000) / pace));
    }
    const free = this.edgeFree[e] as number;
    const base = Math.floor(((this.edgeLen[e] as number) * 1000) / (free > 0 ? free : 1000));
    // A full road takes longer: (1 + 3·(load/capacity)²), in integers.
    const full = Math.min(
      4000,
      Math.floor(((this.load[e] as number) * 1000) / (this.edgeCap[e] as number)),
    );
    return Math.max(1, Math.floor((base * (1_000_000 + 3 * full * full)) / 1_000_000));
  }

  /**
   * Forget routes for the roads as they were: trees and cached routes go, and the routes
   * still being travelled are packed into a fresh list (so it never grows without end).
   */
  #reroute(): void {
    this.#treesIn.clear();
    this.#treesOut.clear();
    this.#routeCache.clear();
    const packed: number[] = [];
    for (let i = 0; i < this.agents; i++) {
      if (this.#state[i] !== State.Travelling) continue;
      const at = this.#routeAt[i] as number;
      const left = this.#routeLeft[i] as number;
      this.#routeAt[i] = packed.length;
      for (let k = 0; k < left; k++) packed.push(this.#routes[at + k] as number);
    }
    this.#routes.length = 0;
    for (const e of packed) this.#routes.push(e);
  }

  /**
   * A shortest-path tree by free-flow time (Dijkstra with a binary heap; ties by node index,
   * so it is deterministic): from `root` along `out` edges, or into it along `in` edges.
   * `via[v]` is the edge that leads from v toward the root (into) or into v from it (out).
   */
  #tree(root: number, into: boolean, way: number, stopAt = -1): Int32Array {
    const n = this.nodeX.length;
    const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
    const via = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    dist[root] = 0;
    heap.push(0, root);
    const start = into ? this.#inStart : this.#outStart;
    const list = into ? this.#in : this.#out;
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (d > (dist[u] as number)) continue;
      if (u === stopAt) break;
      for (let k = start[u] as number; k < (start[u + 1] as number); k++) {
        const e = list[k] as number;
        if (!allowed(way, this.edgeKind[e] as number)) continue;
        const v = this.edgeA[e] === u ? (this.edgeB[e] as number) : (this.edgeA[e] as number);
        const nd = d + this.#cost(e, way);
        if (nd < (dist[v] as number)) {
          dist[v] = nd;
          via[v] = e;
          heap.push(nd, v);
        }
      }
    }
    return via;
  }

  /**
   * Shortest route between two nodes. Nearly every trip starts or ends at a place, so each
   * place keeps a tree out of it and one into it; other trips get a search of their own.
   */
  #route(from: number, to: number, way: number): { at: number; n: number } | null {
    // Up to 2²⁰ nodes each way, three networks: exact in a double.
    const key = (way * 1_048_576 + from) * 1_048_576 + to;
    const treeKey = (v: number) => way * 1_048_576 + v;
    const hit = this.#routeCache.get(key);
    if (hit) return hit.n > 0 ? hit : null;
    const other = (e: number, v: number) =>
      this.edgeA[e] === v ? (this.edgeB[e] as number) : (this.edgeA[e] as number);
    const edges: number[] = [];
    if (this.#placeNodes.has(to) && !this.#placeNodes.has(from)) {
      let tree = this.#treesIn.get(treeKey(to));
      if (!tree) {
        tree = this.#tree(to, true, way);
        this.#treesIn.set(treeKey(to), tree);
      }
      for (let v = from; v !== to; ) {
        const e = tree[v] as number;
        if (e < 0 || edges.length > this.edgeA.length) break;
        edges.push(e);
        v = other(e, v);
      }
    } else {
      let tree: Int32Array | undefined;
      if (this.#placeNodes.has(from)) {
        tree = this.#treesOut.get(treeKey(from));
        if (!tree) {
          tree = this.#tree(from, false, way);
          this.#treesOut.set(treeKey(from), tree);
        }
      } else {
        tree = this.#tree(from, false, way, to);
      }
      for (let v = to; v !== from; ) {
        const e = tree[v] as number;
        if (e < 0 || edges.length > this.edgeA.length) break;
        edges.push(e);
        v = other(e, v);
      }
      edges.reverse();
    }
    // A route that didn't reach (no way there by road) is none at all.
    let v = from;
    for (const e of edges) v = other(e, v);
    if (edges.length === 0 || v !== to) {
      this.#routeCache.set(key, { at: 0, n: 0 });
      return null;
    }
    const route = { at: this.#routes.length, n: edges.length };
    this.#routes.push(...edges);
    this.#routeCache.set(key, route);
    return route;
  }

  nearestNode([x, z]: Pt): number {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let v = 0; v < this.nodeX.length; v++) {
      if (this.#roadNode[v] !== 1) continue;
      const d = ((this.nodeX[v] as number) - x) ** 2 + ((this.nodeZ[v] as number) - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  #nodesIn(polygon: readonly Pt[]): number[] {
    const out: number[] = [];
    for (let v = 0; v < this.nodeX.length; v++) {
      if (this.#roadNode[v] !== 1) continue;
      if (inside(this.nodeX[v] as number, this.nodeZ[v] as number, polygon)) out.push(v);
    }
    return out;
  }

  /**
   * Where each agent is now (metres), which mover they travel by (an index into the layout's
   * movers; `RESTING` when they're not out), and which way they're heading (a direction,
   * not normalised; 0, 0 when waiting), for drawing. Fills the given arrays (length
   * agents·2, agents, agents·2).
   */
  positions(xz: Float32Array, mover: Uint8Array, dir: Float32Array): void {
    for (let i = 0; i < this.agents; i++) {
      const e = this.#edge[i] as number;
      if (this.#state[i] !== State.Travelling || e < 0) {
        const v = this.#at[i] as number;
        const queued = this.#state[i] === State.Travelling;
        // A queue lines up along the road it's waiting for, not in a block round the junction.
        const next = queued ? (this.#routes[this.#routeAt[i] as number] ?? -1) : -1;
        const far = next < 0 ? v : this.edgeA[next] === v ? this.edgeB[next] : this.edgeA[next];
        const dx = (this.nodeX[far as number] as number) - (this.nodeX[v] as number);
        const dz = (this.nodeZ[far as number] as number) - (this.nodeZ[v] as number);
        const metres = Math.max(1, dist(dx, dz));
        const back = (((i * 37) % 100) / 100) * Math.min(QUEUE_DRAWN_M, metres);
        xz[i * 2] = (this.nodeX[v] as number) + (dx * back) / metres;
        xz[i * 2 + 1] = (this.nodeZ[v] as number) + (dz * back) / metres;
        mover[i] = queued ? (this.#mover[i] as number) : RESTING;
        dir[i * 2] = 0;
        dir[i * 2 + 1] = 0;
        continue;
      }
      const a = this.#forward[i] ? (this.edgeA[e] as number) : (this.edgeB[e] as number);
      const b = this.#forward[i] ? (this.edgeB[e] as number) : (this.edgeA[e] as number);
      const t = (this.#along[i] as number) / Math.max(1, this.edgeLen[e] as number);
      const dx = (this.nodeX[b] as number) - (this.nodeX[a] as number);
      const dz = (this.nodeZ[b] as number) - (this.nodeZ[a] as number);
      xz[i * 2] = (this.nodeX[a] as number) + dx * t;
      xz[i * 2 + 1] = (this.nodeZ[a] as number) + dz * t;
      mover[i] = this.#mover[i] as number;
      dir[i * 2] = dx;
      dir[i * 2 + 1] = dz;
    }
  }

  stats(): CityStats {
    let travelling = 0;
    let onRoads = 0;
    let pace = 0;
    for (let i = 0; i < this.agents; i++) {
      if (this.#state[i] !== State.Travelling) continue;
      travelling += this.scale;
      if (!this.#foot[i]) {
        onRoads += this.scale;
        const e = this.#edge[i] as number;
        // Queued at a junction, or waiting at a road's end: going nowhere this minute.
        const waiting = e < 0 || (this.#waited[i] as number) > 0;
        pace += waiting ? 0 : 1000;
      }
    }
    let worst = 0;
    let worstEdge = -1;
    for (let e = 0; e < this.load.length; e++) {
      const full = Math.floor(((this.load[e] as number) * 1000) / (this.edgeCap[e] as number));
      if (full > worst) {
        worst = full;
        worstEdge = e;
      }
    }
    const vehicles = onRoads / this.scale;
    return {
      travelling,
      onRoads,
      flowPermille: vehicles > 0 ? Math.floor(pace / vehicles) : 1000,
      worstPermille: worst,
      worstEdge,
    };
  }

  /** What city life has come to since the sim began. */
  report(): CityReport {
    return {
      trips: this.#trips,
      tripMinutes: this.#tripMinutes,
      unreached: this.#unreached,
      queuedMinutes: this.#queuedMinutes,
    };
  }

  /** FNV-1a over all mutable state. */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v | 0), 0x01000193);
    };
    mix(this.minute);
    // Counters can pass 2³²: both halves.
    for (const v of [this.#trips, this.#tripMinutes, this.#unreached, this.#queuedMinutes]) {
      mix(v % 4_294_967_296);
      mix(Math.floor(v / 4_294_967_296));
    }
    for (const arr of [
      this.#nextStop,
      this.#state,
      this.#at,
      this.#target,
      this.#speed,
      this.#routeAt,
      this.#routeLeft,
      this.#along,
      this.#forward,
      this.#edge,
      this.load,
      this.#exited,
      this.#waited,
      this.#weight,
      this.#tripStart,
      this.#way,
      this.#mover,
    ]) {
      for (let k = 0; k < arr.length; k++) mix(arr[k] as number);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
}

// ── Routing heap ─────────────────────────────────────────────────────────────────────────

/** A binary min-heap of (cost, node), ties by node index: a total order. */
class MinHeap {
  #cost: number[] = [];
  #node: number[] = [];
  get size(): number {
    return this.#node.length;
  }
  #less(i: number, j: number): boolean {
    const ci = this.#cost[i] as number;
    const cj = this.#cost[j] as number;
    return ci < cj || (ci === cj && (this.#node[i] as number) < (this.#node[j] as number));
  }
  #swap(i: number, j: number): void {
    [this.#cost[i], this.#cost[j]] = [this.#cost[j] as number, this.#cost[i] as number];
    [this.#node[i], this.#node[j]] = [this.#node[j] as number, this.#node[i] as number];
  }
  push(cost: number, node: number): void {
    this.#cost.push(cost);
    this.#node.push(node);
    let i = this.#node.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.#cost[0] as number, this.#node[0] as number];
    const last = this.#node.length - 1;
    this.#swap(0, last);
    this.#cost.pop();
    this.#node.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.#node.length && this.#less(l, m)) m = l;
      if (r < this.#node.length && this.#less(r, m)) m = r;
      if (m === i) break;
      this.#swap(i, m);
      i = m;
    }
    return top;
  }
}

// ── A real network into a graph ──────────────────────────────────────────────────────────

/** A network's links as edges: true lengths (through their shape), capacity from lanes. */
export function networkGraph(net: NonNullable<CityLayout["network"]>) {
  const nodes = net.nodes.length / 2;
  const count = Math.floor(net.links.length / LINK_ROW);
  const x = new Int32Array(nodes);
  const z = new Int32Array(nodes);
  for (let v = 0; v < nodes; v++) {
    x[v] = net.nodes[v * 2] as number;
    z[v] = net.nodes[v * 2 + 1] as number;
  }
  const a = new Int32Array(count);
  const b = new Int32Array(count);
  const len = new Int32Array(count);
  const cap = new Int32Array(count);
  const free = new Int32Array(count);
  const oneway = new Uint8Array(count);
  const flow = new Int32Array(count);
  const lanesOf = new Int32Array(count);
  const kind = new Uint8Array(count);
  for (let l = 0; l < count; l++) {
    const r = l * LINK_ROW;
    const ia = net.links[r] as number;
    const ib = net.links[r + 1] as number;
    a[l] = ia;
    b[l] = ib;
    // The way it really runs: a, its shape points, b.
    let px = x[ia] as number;
    let pz = z[ia] as number;
    let metres = 0;
    const from = net.shapeAt[l] ?? 0;
    const to = net.shapeAt[l + 1] ?? from;
    for (let k = from; k <= to; k++) {
      const qx = k < to ? (net.shape[k * 2] as number) : (x[ib] as number);
      const qz = k < to ? (net.shape[k * 2 + 1] as number) : (z[ib] as number);
      metres += dist(qx - px, qz - pz);
      px = qx;
      pz = qz;
    }
    len[l] = Math.max(1, Math.round(metres));
    const lanes = Math.max(1, net.links[r + 2] as number);
    lanesOf[l] = lanes;
    kind[l] = kindOfClass(net.links[r + 5] as number);
    const directions = net.links[r + 4] ? 1 : 2;
    // People a road holds in a jam: a vehicle every JAM_GAP_M of lane, PEOPLE_PER_VEHICLE each,
    // judged over at least DENSITY_MIN_M of it.
    const over = Math.max(len[l] as number, DENSITY_MIN_M);
    cap[l] = Math.max(
      PEOPLE_PER_VEHICLE,
      Math.floor((lanes * directions * over * PEOPLE_PER_VEHICLE) / JAM_GAP_M),
    );
    free[l] = Math.max(1, Math.floor(((net.links[r + 3] as number) * 1000) / 60));
    oneway[l] = net.links[r + 4] ? 1 : 0;
    flow[l] = lanes * LANE_VEHICLES_PER_MIN * PEOPLE_PER_VEHICLE;
  }
  return { x, z, a, b, len, cap, free, oneway, flow, lanes: lanesOf, kind };
}

// ── Roads into a graph ───────────────────────────────────────────────────────────────────

/** Roads that end this close to another road join it (models rarely draw exact junctions). */
const JOIN_M = 40;

export function buildRoadGraph(roads: CityLayout["roads"]) {
  type Seg = { ax: number; az: number; bx: number; bz: number; w: number; cuts: number[] };
  const segs: Seg[] = [];
  for (const r of roads) {
    for (let k = 1; k < r.points.length; k++) {
      const [ax, az] = r.points[k - 1] as Pt;
      const [bx, bz] = r.points[k] as Pt;
      if (ax === bx && az === bz) continue;
      segs.push({ ax, az, bx, bz, w: r.widthM, cuts: [0, 1] });
    }
  }
  // Cut where segments cross, and where an end comes near another segment (a T-junction).
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as Seg;
    for (let j = i + 1; j < segs.length; j++) {
      const o = segs[j] as Seg;
      const hit = crossing(s, o);
      if (hit) {
        s.cuts.push(hit[0]);
        o.cuts.push(hit[1]);
      }
    }
  }
  for (const s of segs) {
    for (const [px, pz] of [
      [s.ax, s.az],
      [s.bx, s.bz],
    ] as const) {
      for (const o of segs) {
        if (o === s) continue;
        const t = project(px, pz, o);
        const qx = o.ax + (o.bx - o.ax) * t;
        const qz = o.az + (o.bz - o.az) * t;
        if (dist(qx - px, qz - pz) <= JOIN_M) o.cuts.push(t);
      }
    }
  }
  // Nodes: every cut point, merged when within a few metres.
  const x: number[] = [];
  const z: number[] = [];
  const nodeOf = (px: number, pz: number): number => {
    const rx = Math.round(px);
    const rz = Math.round(pz);
    for (let v = 0; v < x.length; v++) {
      if (Math.abs((x[v] as number) - rx) <= JOIN_M && Math.abs((z[v] as number) - rz) <= JOIN_M) {
        return v;
      }
    }
    x.push(rx);
    z.push(rz);
    return x.length - 1;
  };
  const a: number[] = [];
  const b: number[] = [];
  const len: number[] = [];
  const cap: number[] = [];
  const flow: number[] = [];
  const lanesOf: number[] = [];
  const seen = new Set<number>();
  for (const s of segs) {
    const cuts = [...new Set(s.cuts.map((t) => Math.round(t * 10_000)))].sort((p, q) => p - q);
    let prev = -1;
    for (const c of cuts) {
      const t = c / 10_000;
      const v = nodeOf(s.ax + (s.bx - s.ax) * t, s.az + (s.bz - s.az) * t);
      if (prev >= 0 && prev !== v) {
        const key = Math.min(prev, v) * 1_048_576 + Math.max(prev, v);
        if (!seen.has(key)) {
          seen.add(key);
          a.push(prev);
          b.push(v);
          len.push(
            Math.max(
              1,
              Math.round(
                dist(
                  (x[v] as number) - (x[prev] as number),
                  (z[v] as number) - (z[prev] as number),
                ),
              ),
            ),
          );
          // What it holds in a jam: lanes (one per 3 m of width) × vehicles per lane × people.
          const lanes = Math.max(1, Math.floor(s.w / 3));
          const metres = Math.max(
            1,
            Math.round(
              dist((x[v] as number) - (x[prev] as number), (z[v] as number) - (z[prev] as number)),
            ),
          );
          cap.push(Math.max(1, Math.floor((lanes * metres) / JAM_GAP_M) * PEOPLE_PER_VEHICLE));
          flow.push(lanes * LANE_VEHICLES_PER_MIN * PEOPLE_PER_VEHICLE);
          lanesOf.push(lanes);
        }
      }
      prev = v;
    }
  }
  return {
    x: Int32Array.from(x),
    z: Int32Array.from(z),
    a: Int32Array.from(a),
    b: Int32Array.from(b),
    len: Int32Array.from(len),
    cap: Int32Array.from(cap),
    // Sketched roads have no speed limits and run both ways.
    free: new Int32Array(len.length),
    oneway: new Uint8Array(len.length),
    flow: Int32Array.from(flow),
    lanes: Int32Array.from(lanesOf),
    kind: new Uint8Array(len.length),
  };
}

function crossing(
  s: { ax: number; az: number; bx: number; bz: number },
  o: { ax: number; az: number; bx: number; bz: number },
): [number, number] | null {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const ex = o.bx - o.ax;
  const ez = o.bz - o.az;
  const den = dx * ez - dz * ex;
  if (den === 0) return null;
  const t = ((o.ax - s.ax) * ez - (o.az - s.az) * ex) / den;
  const u = ((o.ax - s.ax) * dz - (o.az - s.az) * dx) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [t, u] : null;
}

function project(px: number, pz: number, o: { ax: number; az: number; bx: number; bz: number }) {
  const dx = o.bx - o.ax;
  const dz = o.bz - o.az;
  const l2 = dx * dx + dz * dz || 1;
  return Math.max(0, Math.min(1, ((px - o.ax) * dx + (pz - o.az) * dz) / l2));
}

function centroid(poly: readonly Pt[]): Pt {
  const x = poly.reduce((s, p) => s + p[0], 0) / Math.max(1, poly.length);
  const z = poly.reduce((s, p) => s + p[1], 0) / Math.max(1, poly.length);
  return [Math.round(x), Math.round(z)];
}

function inside(x: number, z: number, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as Pt;
    const [xj, zj] = poly[j] as Pt;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Euclidean length with only correctly rounded operations (no Math.hypot). */
function dist(dx: number, dz: number): number {
  return Math.sqrt(dx * dx + dz * dz);
}
