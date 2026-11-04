/**
 * One turn of a world's director: if it's time (every few city hours), within its budget, and
 * nothing else is rewriting the city, read how the city is doing, let the director decide
 * what happens next, and swap the new city in (only if it's still the one read). The world's
 * players pick it up on their next fetch; the realm reads it again before each trip.
 *
 * Trusted job: it acts only on worlds the scheduler hands it, through `system*` functions.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import { encodeJson } from "@aye/artifacts";
import {
  type Db,
  type DirectorState,
  systemActivePlayers,
  systemAddThread,
  systemExpireThreads,
  systemGetDirector,
  systemGetPinnedPlace,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemPlayersByPlace,
  systemRecordArtifacts,
  systemSaveDirector,
  systemSwapWorldCity,
} from "@aye/db";
import {
  type ActivePlayer,
  type Director,
  directCity,
  type PlaceCatalog,
  readJson,
} from "@aye/pipeline";
import {
  type ArtifactHash,
  type ArtifactRef,
  CitySpec,
  cityMinuteNow,
  ownersOnly,
  placesOf,
  RoadNetwork,
  WorldId,
  type WorldSettings,
  WorldSpec,
} from "@aye/schema";
import { CitySim, cityLayoutOf } from "@aye/sim";
import { z } from "zod";

export const DirectorJob = z.strictObject({
  worldId: WorldId,
  /**
   * A player with nothing on (just joined, or just finished): give them something now, without
   * waiting for the next turn (only threads, only for them).
   */
  welcome: z.string().max(64).optional(),
});
export type DirectorJob = z.infer<typeof DirectorJob>;

export interface DirectorConfig {
  /** City minutes between turns. */
  everyMin: number;
  /** Model calls a world's director may make a day (UTC); null: no limit. */
  callsPerDay: number | null;
}

export interface DirectorJobDeps {
  db: Db;
  store: ArtifactStore;
  index: RecipeIndex;
  director: Director;
  config: DirectorConfig;
  now: () => number;
  /** Whether a city build or finishing pass is still running for the world (it'd race). */
  building(worldId: string): Promise<boolean>;
  signal?: AbortSignal;
}

/** Agents the director's reading of city life plays (enough to see the roads, quickly). */
const READING_AGENTS = 3_000;

const ref = (hash: string): ArtifactRef => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

/** How the city's life is going right now, played from midnight on the same sim as the map. */
async function lifeNow(city: CitySpec, minute: number, store: ArtifactStore, seed: number) {
  if (city.population.groups.length === 0) return null;
  const network = city.real
    ? RoadNetwork.parse(await readJson(store, ref(city.real.network)))
    : null;
  const sim = new CitySim(cityLayoutOf(city, network), city.population, seed, {
    maxAgents: READING_AGENTS,
  });
  sim.runTo(minute % 1440);
  const s = sim.stats();
  const busiest =
    network && s.worstEdge >= 0
      ? (network.names[network.links[s.worstEdge * 7 + 6] ?? -1] ?? "an unnamed road")
      : "";
  return {
    out: s.travelling,
    onRoads: s.onRoads,
    trafficPercent: Math.round(s.flowPermille / 10),
    busiest,
  };
}

/** Players who've played in the last two real days count as around. */
const ACTIVE_MS = 2 * 24 * 3600 * 1000;
/** Someone has played within this long, or a turn isn't worth taking. */
const AROUND_MS = 3600 * 1000;

/** Whether a thing's starting value meets a condition. */
function startsMeeting(value: number, op: "eq" | "ne" | "gte" | "lte", than: number): boolean {
  if (op === "eq") return value === than;
  if (op === "ne") return value !== than;
  return op === "gte" ? value >= than : value <= than;
}

/** What each built place offers (its actions, on which kind) and who its people are. */
async function catalogOf(
  deps: DirectorJobDeps,
  worldId: string,
  city: CitySpec,
): Promise<Map<string, PlaceCatalog>> {
  const out = new Map<string, PlaceCatalog>();
  for (const p of placesOf(city).filter((x) => !x.private)) {
    const pinned = await systemGetPinnedPlace(deps.db, worldId, p.key);
    if (!pinned?.spec) continue;
    const spec = WorldSpec.safeParse(await readJson(deps.store, ref(pinned.spec)));
    if (!spec.success) continue;
    out.set(p.key, {
      // Named with the thing they're done on, so two "Sit" actions read apart.
      actions: spec.data.kinds.flatMap((k) =>
        k.actions.map((a) => ({
          kind: k.key,
          action: a.key,
          label: `${a.label} (${k.label})`,
          cost: a.cost,
          income: a.income,
          durationMin: a.durationMin,
          // Ready if any one of these things can do it from how it starts.
          // Work someone has to earn their way to isn't work to send a newcomer to.
          ready:
            !ownersOnly(spec.data, k.key, a) &&
            !(a.asks ?? []).some((x) => x.op === "gte" && x.value > 0) &&
            spec.data.things
              .filter((t) => t.kind === k.key)
              .some((t) =>
                a.requires.every(
                  (c) =>
                    !("var" in c) ||
                    startsMeeting(
                      t.state.find((s) => s.var === c.var)?.value ??
                        k.vars.find((v) => v.key === c.var)?.initial ??
                        0,
                      c.op,
                      c.value,
                    ),
                ),
              ),
        })),
      ),
      people: spec.data.people.map((x) => ({ key: x.key, name: x.name })),
    });
  }
  return out;
}

/** A need's name in the city's words (keys as read from characters). */
const needLabel = (city: CitySpec, key: string) =>
  city.needs.find((n) => n.key === key)?.label ?? key;

/** The players who've been around lately: where they are, their money and needs. */
async function activeOf(
  deps: DirectorJobDeps,
  worldId: string,
  city: CitySpec,
): Promise<ActivePlayer[]> {
  const rows = await systemActivePlayers(deps.db, worldId, new Date(deps.now() - ACTIVE_MS));
  return rows.map((r) => ({
    userId: r.userId,
    name: r.character.person.name,
    place: r.character.place,
    money: r.character.person.money,
    needs: r.character.person.needs.map((n) => ({ label: n.need, level: Math.round(n.start) })),
    owes: r.character.billed.owes,
    threads: r.open.filter((t) => !t.aim).map((t) => t.title),
    aim: r.open.find((t) => t.aim)?.title ?? "",
    marks: (r.character.person.marks ?? []).flatMap((m) => {
      const label = city.marks.find((x) => x.key === m.mark)?.label;
      return label && m.value > 0 ? [{ label, value: m.value }] : [];
    }),
    recent: r.recent.flatMap((t) =>
      t.steps.flatMap((s) =>
        s.check === "do" ? [{ place: s.place, kind: s.kind, action: s.action }] : [],
      ),
    ),
  }));
}

export async function runDirectorTurn(
  job: DirectorJob,
  deps: DirectorJobDeps,
): Promise<{ status: "acted" | "skipped"; reason: string }> {
  const skip = (reason: string) => ({ status: "skipped" as const, reason });
  const world = await systemGetWorld(deps.db, job.worldId);
  if (world?.status !== "ready" || !world.city) return skip("not ready");
  // While the city is still being built or finished, its spec may change under us: only
  // threads (which are the players', not the city's) are given then.
  const onlyThreads = Boolean(job.welcome) || (await deps.building(job.worldId));

  const settings = world.settings as WorldSettings;
  const minute = cityMinuteNow(world.createdAt.toISOString(), settings, deps.now());
  // What ran out of time is missed, so nobody is left carrying a thread they can't finish.
  await systemExpireThreads(deps.db, job.worldId, minute);
  const state: DirectorState = await systemGetDirector(deps.db, job.worldId);
  if (!job.welcome && state.lastMinute >= 0 && minute - state.lastMinute < deps.config.everyMin) {
    return skip("not time yet");
  }
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  const calls = state.day === today ? state.calls : 0;
  if (deps.config.callsPerDay !== null && calls >= deps.config.callsPerDay) {
    return skip("out of budget today");
  }

  const prev = world.city;
  const parsed = CitySpec.safeParse(await readJson(deps.store, ref(prev)));
  // A city from an older format can't be directed (it can't be played either).
  if (!parsed.success) return skip("city can't be read");
  const city = parsed.data;
  const active = (await activeOf(deps, job.worldId, city)).filter(
    (a) => !job.welcome || (a.userId === job.welcome && a.threads.length === 0),
  );
  if (job.welcome && active.length === 0) return skip("nobody to welcome");
  // Every turn is a paid call, and a city nobody has been in lately has nobody to direct it for.
  const around = await systemActivePlayers(deps.db, job.worldId, new Date(deps.now() - AROUND_MS));
  if (around.length === 0) return skip("nobody around");
  const turn = await directCity(
    {
      city,
      minute,
      players: await systemPlayersByPlace(deps.db, job.worldId),
      catalog: await catalogOf(deps, job.worldId, city),
      active: active.map((a) => ({
        ...a,
        needs: a.needs.map((n) => ({ ...n, label: needLabel(city, n.label) })),
      })),
      life: await lifeNow(city, minute, deps.store, settings.seed),
      memory: state.memory,
    },
    {
      director: deps.director,
      store: deps.store,
      index: deps.index,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );
  // Threads go to players whatever happened to the city: they're theirs, not the city's.
  for (const t of turn.threads) {
    await systemAddThread(deps.db, job.worldId, t.userId, t.thread);
  }
  if (onlyThreads) {
    await systemSaveDirector(deps.db, job.worldId, {
      memory: turn.memory || state.memory,
      lastMinute: state.lastMinute,
      day: today,
      calls: calls + turn.calls,
    });
    return { status: "acted", reason: `threads only (${turn.threads.length})` };
  }
  const next = CitySpec.parse(turn.city);
  const nextRef = await deps.store.put(encodeJson(next), "application/json");
  await systemRecordArtifacts(deps.db, [nextRef]);
  await systemLinkWorldArtifacts(deps.db, job.worldId, [nextRef.hash]);
  const swapped = await systemSwapWorldCity(
    deps.db,
    job.worldId,
    prev as ArtifactHash,
    nextRef.hash,
  );
  // A turn that lost the race isn't a turn: it looks again soon, and keeps its old notes.
  await systemSaveDirector(deps.db, job.worldId, {
    memory: swapped ? turn.memory : state.memory,
    lastMinute: swapped ? minute : state.lastMinute,
    day: today,
    calls: calls + turn.calls,
  });
  return swapped
    ? { status: "acted", reason: turn.issues.slice(0, 3).join(" ") }
    : skip("the city changed while it thought; it'll look again next turn");
}
