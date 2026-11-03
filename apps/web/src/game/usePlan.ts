/**
 * A planner's what-if on a real city's roads: close roads, change their lanes,
 * then compare a whole day of city life with and without the change.
 *
 * Everything here is the player's own: the scenario lives in this browser (kept per city in
 * local storage, bounded, validated when read back) and runs in a Web Worker on the same
 * deterministic city sim everyone plays, so a comparison is the same on every machine. It
 * changes nothing anyone else sees.
 */
import type { CitySpec, RoadNetwork } from "@aye/schema";
import { NETWORK_BOUNDS } from "@aye/schema";
import { cityLayoutOf } from "@aye/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { Compared, LifeReply, LifeRequest } from "./cityLife.worker.ts";
import { REAL_AGENTS, seedOf } from "./useCityLife.ts";

/** Roads one scenario may change: plenty for a plan, small enough to keep and send. */
const MAX_EDITS = 200;

const Saved = z.strictObject({
  closed: z.array(z.int().min(0).max(NETWORK_BOUNDS.links)).max(MAX_EDITS),
  lanes: z
    .array(z.tuple([z.int().min(0).max(NETWORK_BOUNDS.links), z.int().min(1).max(8)]))
    .max(MAX_EDITS),
});
type Saved = z.infer<typeof Saved>;

const EMPTY: Saved = { closed: [], lanes: [] };
const keyOf = (worldId: string) => `aye.plan.${worldId}`;

function load(worldId: string, links: number): Saved {
  try {
    const parsed = Saved.safeParse(JSON.parse(localStorage.getItem(keyOf(worldId)) ?? "null"));
    if (!parsed.success) return EMPTY;
    // A network that changed since: edits to links it no longer has go.
    return {
      closed: parsed.data.closed.filter((l) => l < links),
      lanes: parsed.data.lanes.filter(([l]) => l < links),
    };
  } catch {
    return EMPTY;
  }
}

export type PlanResult = Compared & { edits: string };

export function usePlan(worldId: string, city: CitySpec, network: RoadNetwork | null) {
  const links = network ? network.links.length / 7 : 0;
  const [edits, setEdits] = useState<Saved>(EMPTY);
  useEffect(() => {
    if (links > 0) setEdits(load(worldId, links));
  }, [worldId, links]);
  const save = useCallback(
    (next: Saved) => {
      setEdits(next);
      try {
        localStorage.setItem(keyOf(worldId), JSON.stringify(next));
      } catch {
        // Storage full or off: the plan still works for this visit.
      }
    },
    [worldId],
  );

  const lanesOf = useCallback(
    (link: number): number => {
      const edited = edits.lanes.find(([l]) => l === link);
      return edited ? edited[1] : ((network?.links[link * 7 + 2] as number | undefined) ?? 1);
    },
    [edits, network],
  );
  const count = edits.closed.length + edits.lanes.length;

  const toggleClosed = (link: number) => {
    const closed = edits.closed.includes(link)
      ? edits.closed.filter((l) => l !== link)
      : [...edits.closed, link];
    if (closed.length + edits.lanes.length > MAX_EDITS) return;
    save({ ...edits, closed });
  };
  const setLanes = (link: number, lanes: number) => {
    const original = (network?.links[link * 7 + 2] as number | undefined) ?? 1;
    const n = Math.max(1, Math.min(NETWORK_BOUNDS.lanes, lanes));
    const rest = edits.lanes.filter(([l]) => l !== link);
    const next: Saved["lanes"] = n === original ? rest : [...rest, [link, n]];
    if (edits.closed.length + next.length > MAX_EDITS) return;
    save({ ...edits, lanes: next });
  };
  const clear = () => save(EMPTY);

  const editsKey = useMemo(() => JSON.stringify(edits), [edits]);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<PlanResult | null>(null);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);

  const compare = () => {
    if (!network || count === 0 || progress !== null) return;
    worker.current?.terminate();
    const w = new Worker(new URL("./cityLife.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    const asked = editsKey;
    setProgress(0);
    w.onmessage = (ev: MessageEvent<LifeReply>) => {
      const m = ev.data;
      if (m.type === "progress") setProgress(m.done);
      if (m.type === "compared") {
        setResult({ ...m, edits: asked });
        setProgress(null);
        w.terminate();
        worker.current = null;
      }
    };
    w.onerror = () => {
      setProgress(null);
      w.terminate();
      worker.current = null;
    };
    w.postMessage({
      type: "compare",
      layout: cityLayoutOf(city, network),
      population: city.population,
      seed: seedOf(city),
      maxAgents: REAL_AGENTS,
      scenario: { closed: edits.closed, lanes: edits.lanes },
    } satisfies LifeRequest);
  };

  return {
    edits,
    count,
    lanesOf,
    toggleClosed,
    setLanes,
    clear,
    compare,
    progress,
    result,
    /** The result is for the edits as they are now (not an older plan). */
    current: result !== null && result.edits === editsKey,
  };
}
