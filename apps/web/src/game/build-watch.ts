/**
 * The cities someone is waiting on, kept across reloads and screens so they hear when one's done
 * wherever they are in the game. This browser's own note of what to watch: what's true always
 * comes from the server, and it only tells someone about cities their own list shows them.
 */
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { notifyAway } from "./notify.ts";
import type { WorldSummary } from "./types.ts";

const KEY = "aye:watching-builds";
const CHECK_MS = 20_000;
const MAX_WATCHED = 8;

const watched = (): string[] => {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const keep = (ids: readonly string[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX_WATCHED)));
  } catch {
    // Private mode: they just won't hear, and the list of cities still shows it.
  }
};

export const watchBuild = (id: string) => keep([...watched(), id]);

/** Which of these have finished, either way, and which are still worth watching. */
export function settle(ids: readonly string[], worlds: readonly WorldSummary[]) {
  const byId = new Map(worlds.map((w) => [w.id, w]));
  return {
    done: ids.flatMap((id) => {
      const w = byId.get(id);
      return w && w.status !== "building" ? [w] : [];
    }),
    // A city that's gone from the list was deleted, so there's nothing left to wait for.
    waiting: ids.filter((id) => byId.get(id)?.status === "building"),
  };
}

export const doneLine = (w: Pick<WorldSummary, "name" | "status">) =>
  w.status === "ready" ? `${w.name} is ready to play.` : `${w.name} couldn't be built.`;

/** What's just finished, for the banner. Only looks while there's something being waited on. */
export function useBuildWatch(signedIn: boolean) {
  const [finished, setFinished] = useState<WorldSummary[]>([]);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const check = async () => {
      const ids = watched();
      if (ids.length === 0) return;
      const res = await api<{ worlds: WorldSummary[] }>("/worlds").catch(() => null);
      if (!live || !res) return;
      const { done, waiting } = settle(ids, res.worlds);
      keep(waiting);
      for (const w of done) void notifyAway(`build-${w.id}`, "Ayé", doneLine(w));
      if (done.length > 0) setFinished((now) => [...now, ...done]);
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signedIn]);
  return { finished, dismiss: () => setFinished([]) };
}
