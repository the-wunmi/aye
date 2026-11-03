/**
 * City life on the map: the city's people going about their day, played by
 * the deterministic city sim on the city's own clock, so every player sees the same streets.
 *
 * The sim runs in a Web Worker (a real city has tens of thousands of agents). It is built
 * once per city (roads or the real network, homes, routes), caught up to the clock from the
 * start of today, then advanced minute by minute; between minutes, positions are
 * interpolated so traffic moves smoothly.
 */
import type { CitySpec, RoadNetwork, WorldSettings } from "@aye/schema";
import { type CityStats, cityLayoutOf } from "@aye/sim";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LifeReply, LifeRequest } from "./cityLife.worker.ts";

export interface LifeFrame {
  xz: Float32Array;
  /** Which of the city's movers each traveller is on (`RESTING`: not out). */
  mover: Uint8Array;
  /** Which way each is heading (x, z; not normalised). */
  dir: Float32Array;
  roads: {
    x: Int32Array;
    z: Int32Array;
    a: Int32Array;
    b: Int32Array;
    loadPermille: Uint16Array;
  };
}

/** Agents for a sketched city, and for a real one (more: it is much bigger). */
const SKETCH_AGENTS = 3_000;
export const REAL_AGENTS = 20_000;

/** City minutes since the world began, with the fraction of the current minute (0..1). */
function cityMinute(
  createdAt: string,
  settings: Pick<WorldSettings, "startMinuteOfDay" | "ticksPerRealSecond">,
  now = Date.now(),
) {
  const minutes =
    settings.startMinuteOfDay +
    ((now - Date.parse(createdAt)) / 1000) * (settings.ticksPerRealSecond / 60);
  return { whole: Math.floor(minutes), fraction: minutes - Math.floor(minutes) };
}

/** A stable seed from the city's identity, so the same city lives the same day everywhere. */
export function seedOf(city: CitySpec): number {
  let h = 0x811c9dc5;
  for (const c of `${city.name}|${city.brief}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return h | 0;
}

export function useCityLife(
  city: CitySpec,
  createdAt: string,
  settings: WorldSettings,
  on: boolean,
  /** A real city plays on its real roads; until they arrive, it waits. */
  network: RoadNetwork | null = null,
) {
  // The city is re-fetched now and then; only a change to what the sim reads rebuilds it.
  const shape = useMemo(
    () =>
      JSON.stringify([
        city.population,
        cityLayoutOf(city, null),
        network ? network.links.length : 0,
      ]),
    [city, network],
  );
  const latest = useRef({ city, createdAt, settings, network });
  latest.current = { city, createdAt, settings, network };
  const [stats, setStats] = useState<CityStats | null>(null);
  const [info, setInfo] = useState({ people: 0, scale: 1 });
  const state = useRef<{
    graph: Extract<LifeReply, { type: "graph" }> | null;
    prev: Float32Array | null;
    next: Float32Array | null;
    mover: Uint8Array;
    dir: Float32Array;
    loads: Uint16Array;
  }>({
    graph: null,
    prev: null,
    next: null,
    mover: new Uint8Array(0),
    dir: new Float32Array(0),
    loads: new Uint16Array(0),
  });
  const lerped = useRef(new Float32Array(0));
  const { startMinuteOfDay, ticksPerRealSecond } = settings;

  useEffect(() => {
    const c = latest.current.city;
    const net = latest.current.network;
    if (!on || !shape || c.population.groups.length === 0 || (c.real && !net)) {
      setStats(null);
      return;
    }
    const worker = new Worker(new URL("./cityLife.worker.ts", import.meta.url), {
      type: "module",
    });
    let busy = true;
    worker.onmessage = (ev: MessageEvent<LifeReply>) => {
      const m = ev.data;
      const s = state.current;
      if (m.type === "graph") {
        s.graph = m;
        setInfo({ people: m.people, scale: m.scale });
        return;
      }
      if (m.type !== "frame") return;
      busy = false;
      s.prev = s.next && s.next.length === m.xz.length ? s.next : m.xz;
      s.next = m.xz;
      s.mover = m.mover;
      s.dir = m.dir;
      s.loads = m.loadPermille;
      setStats(m.stats);
    };
    const { whole } = cityMinute(createdAt, { startMinuteOfDay, ticksPerRealSecond });
    const start: LifeRequest = {
      type: "start",
      layout: cityLayoutOf(c, net),
      population: c.population,
      seed: seedOf(c),
      maxAgents: c.real ? REAL_AGENTS : SKETCH_AGENTS,
      dayStart: whole - (whole % 1440),
      minute: whole,
    };
    worker.postMessage(start);
    let asked = whole;
    const t = setInterval(() => {
      if (busy) return;
      const now = cityMinute(latest.current.createdAt, latest.current.settings).whole;
      if (now <= asked) return;
      asked = now;
      busy = true;
      worker.postMessage({ type: "advance", minute: now } satisfies LifeRequest);
    }, 250);
    return () => {
      clearInterval(t);
      worker.terminate();
      state.current = {
        graph: null,
        prev: null,
        next: null,
        mover: new Uint8Array(0),
        dir: new Float32Array(0),
        loads: new Uint16Array(0),
      };
    };
  }, [shape, createdAt, startMinuteOfDay, ticksPerRealSecond, on]);

  /** The latest frame, interpolated to now, for the renderer. */
  const frame = (): LifeFrame | null => {
    const s = state.current;
    if (!s.graph || !s.prev || !s.next) return null;
    const { fraction } = cityMinute(latest.current.createdAt, latest.current.settings);
    if (lerped.current.length !== s.next.length) lerped.current = new Float32Array(s.next.length);
    const out = lerped.current;
    for (let i = 0; i < out.length; i++) {
      const a = s.prev[i] as number;
      out[i] = a + ((s.next[i] as number) - a) * fraction;
    }
    return {
      xz: out,
      mover: s.mover,
      dir: s.dir,
      roads: { x: s.graph.x, z: s.graph.z, a: s.graph.a, b: s.graph.b, loadPermille: s.loads },
    };
  };

  return { stats, frame, people: info.people, scale: info.scale };
}
