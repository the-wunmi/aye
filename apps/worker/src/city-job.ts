/**
 * Building a city, in passes, so people can play within minutes while the rest is made:
 *
 *   1. quick   the city sketched (map, places, travel, starts, interface) with low effort and no
 *              more revising than it takes to have nothing broken; then the homes and the public
 *              place nearest them, each laid out and given a world the same quick way. Then the
 *              world opens, if at least one home and one public place stand.
 *   2. fill    every other place, the same quick way, all at once (a few in parallel); each
 *              appears on the map as it lands.
 *   3. dress   the city's looks, then each place's, through the visual loop (dressing); each
 *              improvement is pinned as a new revision, and rooms in play pick it up live.
 *
 * Furnishing rides along: the city's outfits are chosen with its sketch, each
 * place's library models with its world, and dressing furnishes anything still bare (places
 * built before the library). It only adds looks and set dressing, and never blocks a build: if
 * it fails, the place is drawn from its primitives.
 *
 * Durable like the place job (compile-job.ts): every step is checkpointed, steps return small
 * JSON, and model calls are memoised by recipe, so a crash resumes where it stopped and a
 * retried step replays finished stages with zero calls. Places that already stand are skipped,
 * so rerunning a build fills in only what is missing. A place that can't be built leaves a
 * gap on the map rather than failing the whole city.
 *
 * Publishing the finished city (making it public) is the owner's approval of everything the
 * models wrote for it; until then only its members can enter.
 */
import { type ArtifactStore, deriveId, encodeJson } from "@aye/artifacts";
import {
  type Db,
  PgRecipeIndex,
  systemEnsurePlace,
  systemFailIfBuilding,
  systemGetPinnedPlace,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemPinnedKeys,
  systemRecordArtifacts,
  systemSetBuildNote,
  systemSetWorld,
} from "@aye/db";
import {
  type Arranger,
  arrangePlace,
  authorCity,
  authorWorld,
  briefFor,
  bringWithinReach,
  type CityAuthor,
  compilePlace,
  type Describer,
  decoratePlace,
  dressCity,
  dressWorld,
  type Furnisher,
  furnishCity,
  furnishWorld,
  groundCity,
  type Locator,
  type LookCritic,
  type LookDesigner,
  type MapSource,
  makeWayThrough,
  populateCity,
  readJson,
  unplayable,
  type WorldAuthor,
} from "@aye/pipeline";
import {
  type ArtifactHash,
  type ArtifactRef,
  type CityPlace,
  CitySpec,
  distanceM,
  LIBRARY_CATALOG,
  type LibraryCatalog,
  type PanelDef,
  type PlaceId,
  type PlaceRevision,
  placesOf,
  Scene,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { evaluateWorld, solidity } from "@aye/sim";
import { z } from "zod";
import { directStep, EVAL_SETTINGS, type StepRunner } from "./compile-job.ts";
import { commitAndPin } from "./pin.ts";

export const CityJob = z.strictObject({
  worldId: WorldId,
  /** quick: sketch the city and open it; finish: build the rest and dress everything. */
  phase: z.enum(["quick", "finish"]).default("quick"),
});
export type CityJob = z.infer<typeof CityJob>;

export interface CityProviders {
  city: CityAuthor;
  /** Looks at every look the models design, and redesigns the weak ones (vision models). */
  critic: LookCritic;
  designer: LookDesigner;
  describer: Describer;
  author: WorldAuthor;
  /** The same models thinking less, for the first pass that gets people playing. */
  quick: { city: CityAuthor; describer: Describer; author: WorldAuthor };
  /** Chooses library models, outfits and surfaces; absent: everything stays primitives. */
  furnisher?: Furnisher;
  /** Looks at seats in place and turns the ones facing the wrong way (vision). */
  arranger?: Arranger;
  /** Lays real cities on their real roads: where things are, and the map data. */
  locator?: Locator;
  maps?: MapSource;
}

export interface CityJobDeps {
  db: Db;
  store: ArtifactStore;
  providers: CityProviders;
  signal: AbortSignal;
  step?: StepRunner;
  /** The asset library to furnish from (default: the committed catalog). */
  catalog?: LibraryCatalog;
  /** A library file's bytes, so arranging can picture models as players see them. */
  readAsset?: (file: string) => Promise<Uint8Array | null>;
  /** Places built at once. Model calls are the bottleneck and cost money. */
  parallel?: number;
  /**
   * Hand the slow passes (the rest of the places, dressing) to another job, so a new city's
   * quick pass never waits behind another city's polish. Without it, one job does both.
   */
  finishLater?: (job: CityJob, opts: { playable: boolean }) => Promise<void>;
}

/** With backoff from 5 s doubling, about five minutes before a first room gives up. */
const FIRST_PLACE_ATTEMPTS = 7;

export type CityJobResult =
  | { status: "ready"; built: string[]; missing: string[] }
  | { status: "failed"; reason: string };

export async function runCityJob(raw: unknown, deps: CityJobDeps): Promise<CityJobResult> {
  const job = CityJob.parse(raw);
  try {
    return await buildCityJob(job, deps);
  } catch (err) {
    // Shutting down isn't failing: the job picks up where it was on the next start. Anything else
    // ends here, and a city nobody can enter must say so, not build forever. One already open
    // stays open with the places it has.
    if (!deps.signal.aborted) {
      await systemFailIfBuilding(deps.db, job.worldId).catch(() => undefined);
    }
    throw err;
  }
}

async function buildCityJob(job: CityJob, deps: CityJobDeps): Promise<CityJobResult> {
  const step = deps.step ?? directStep;
  const index = new PgRecipeIndex(deps.db);
  /** What the model wrote for someone to read while this builds. Code only says how far along. */
  let lines: readonly string[] = [];
  const tell = async (progress: number) => {
    const line = lines[Math.min(progress, lines.length - 1)];
    if (line) await systemSetBuildNote(deps.db, job.worldId, line);
  };
  const looks = () => ({
    critic: deps.providers.critic,
    designer: deps.providers.designer,
    store: deps.store,
    index,
  });
  const furnisher = deps.providers.furnisher;
  /** The city's panels, once its spec is known (things in places may open one). */
  let cityPanels: PanelDef[] = [];
  const furnishing = () =>
    furnisher
      ? {
          furnisher,
          store: deps.store,
          index,
          catalog: deps.catalog ?? LIBRARY_CATALOG,
          panels: cityPanels,
          signal: deps.signal,
        }
      : null;
  /**
   * The last word on getting around: what's solid is only known once the world is written and
   * the place furnished, so that's when a bed across the only way through gets moved.
   */
  const walkable = (set: { scene: Scene; spec: WorldSpec }) => {
    const clear = makeWayThrough(set.scene, solidity(set.spec)).scene;
    return { ...set, scene: bringWithinReach(clear, set.spec, EVAL_SETTINGS).scene };
  };
  /** Set dressing from the library; on any failure, the place as it was. */
  const decorated = async (
    scene: Scene,
    spec: WorldSpec,
  ): Promise<{ scene: Scene; spec: WorldSpec }> => {
    const f = furnishing();
    if (!f) return { scene, spec };
    try {
      const critique = (s: Scene, w: WorldSpec) => evaluateWorld(s, w, EVAL_SETTINGS).findings;
      const d = await decoratePlace(scene, spec, { ...f, critique, settings: EVAL_SETTINGS });
      const arranger = deps.providers.arranger;
      if (!arranger) return { scene: d.scene, spec: d.spec };
      // Seats are looked at in place; any turn physics refuses is simply not taken.
      const a = await arrangePlace(d.scene, d.spec, {
        arranger,
        store: deps.store,
        index,
        catalog: f.catalog,
        readAsset: deps.readAsset ?? (async () => null),
        critique,
        settings: EVAL_SETTINGS,
        signal: deps.signal,
      }).catch(() => null);
      return { scene: a?.scene ?? d.scene, spec: d.spec };
    } catch {
      return { scene, spec };
    }
  };
  /**
   * A real city on its real roads, its network stored and readable by its
   * players; on any failure (or a made-up city), the city as it was.
   */
  const grounded = async (spec: CitySpec): Promise<CitySpec> => {
    const { locator, maps } = deps.providers;
    if (!locator || !maps || spec.real) return spec;
    await tell(1);
    try {
      const g = await groundCity(spec, {
        locator,
        maps,
        store: deps.store,
        index,
        signal: deps.signal,
      });
      if (!g.networkRef) return spec;
      const refs = [g.networkRef, ...(g.landRef ? [g.landRef] : [])];
      await systemRecordArtifacts(deps.db, refs);
      await systemLinkWorldArtifacts(
        deps.db,
        job.worldId,
        refs.map((r) => r.hash),
      );
      return g.spec;
    } catch {
      return spec;
    }
  };
  /** Library looks for a place's world; on any failure, the world as it was. */
  const furnished = async (spec: WorldSpec, scene: Scene): Promise<WorldSpec> => {
    const f = furnishing();
    if (!f) return spec;
    try {
      return (await furnishWorld(spec, scene, f)).spec;
    } catch {
      return spec;
    }
  };

  const world = await step("load", async () => {
    const row = await systemGetWorld(deps.db, job.worldId);
    return (
      row && {
        ownerId: row.ownerId as UserId,
        description: row.description,
        city: (row.city as ArtifactHash | null) ?? null,
      }
    );
  });
  if (!world) return { status: "failed", reason: "no such world" };

  // ── Pass 1: a quick sketch of the city, then its homes and nearest public place ──────
  const city = await step(
    "city",
    async () => {
      // A city that already exists is never redesigned: its places, homes and characters
      // depend on it. Only a new world (or one whose first sketch failed) is written here.
      if (world.city) {
        return {
          ref: { hash: world.city, mediaType: "application/json", bytes: 0 } as ArtifactRef,
          reason: "",
        };
      }
      const result = await authorCity(
        { description: world.description },
        {
          author: deps.providers.quick.city,
          store: deps.store,
          index,
          signal: deps.signal,
          maxRounds: 2,
          untilNoErrors: true,
        },
      );
      if (!result.spec || !result.specRef) return { ref: null, reason: "no city was written" };
      // After its rounds of revising, what's left is polish unless nobody could live here.
      const stops = unplayable(result.spec);
      if (stops.length > 0) return { ref: null, reason: stops[0] as string };
      // From here the person waiting can see what it's called, and read what it wrote for them.
      lines = result.spec.buildingLines;
      await tell(0);
      await systemSetWorld(deps.db, job.worldId, { name: result.spec.name });
      // The outfits new arrivals choose from, then a real city onto its real roads, then who
      // lives there: a real city's people are written at its real size, knowing its districts
      // as they really are. Each step is optional: the sketch stands without it.
      const f = furnishing();
      const dressed = f
        ? ((await furnishCity(result.spec, f).catch(() => null))?.spec ?? result.spec)
        : result.spec;
      const real = await grounded(dressed);
      await tell(2);
      const peopled = f ? ((await populateCity(real, f).catch(() => null))?.spec ?? real) : real;
      const specRef =
        peopled === result.spec
          ? result.specRef
          : await deps.store.put(encodeJson(peopled), "application/json");
      await systemRecordArtifacts(deps.db, [specRef]);
      await systemLinkWorldArtifacts(deps.db, job.worldId, [specRef.hash]);
      await systemSetWorld(deps.db, job.worldId, {
        city: specRef.hash,
        name: result.spec.name,
        currency: result.spec.currency,
      });
      return { ref: specRef, reason: "" };
    },
    { retries: 3 },
  );
  if (!city.ref) {
    await step("fail", () => systemSetWorld(deps.db, job.worldId, { status: "failed" }));
    return { status: "failed", reason: city.reason };
  }
  const spec = CitySpec.parse(await readJson(deps.store, city.ref));
  cityPanels = spec.ui.panels;

  const pin = async (
    place: CityPlace,
    sceneRef: ArtifactRef,
    scene: Scene,
    specRef: ArtifactRef,
    parent: ArtifactHash | null,
    message: string,
  ) => {
    const placeId = deriveId("place", [job.worldId, place.key]) as PlaceId;
    await systemEnsurePlace(deps.db, { id: placeId, ownerId: world.ownerId, name: place.name });
    await systemRecordArtifacts(deps.db, [sceneRef, specRef]);
    const rev: PlaceRevision = {
      placeId,
      parent,
      base: sceneRef,
      edits: [],
      scene: sceneRef,
      world: { spec: specRef, approved: false },
      authorId: world.ownerId,
      message,
      createdAt: new Date().toISOString(),
    };
    // Whatever the place already has (an earlier build, a rebuild's predecessor), this goes
    // on top of it: a rerun replays from the recipe cache, so at worst it adds an identical
    // revision; a rebuild must never be swapped for the version it replaces.
    await commitAndPin(
      deps.db,
      { worldId: job.worldId, key: place.key, ownerId: world.ownerId },
      rev,
      scene,
    );
  };

  /**
   * Lay a place out and give it a world, quickly; pin it so people can go in. The first places
   * anyone enters (homes and the nearest public place) are dressed now too, so nobody's first
   * minutes are in a bare room; the rest are dressed in the finishing pass.
   */
  const buildPlace = (place: CityPlace, dress = false, again = false) =>
    step(
      `${again ? "place-again" : "place"}:${place.key}`,
      async (): Promise<{ key: string; built: boolean }> => {
        const pinned = await systemPinnedKeys(deps.db, job.worldId, [place.key]);
        if (pinned.length > 0) return { key: place.key, built: true };
        const text = `${place.name}, ${spec.name}. ${place.description}`;
        const layout = await compilePlace(
          { kind: "description", text },
          {
            store: deps.store,
            index,
            describer: deps.providers.quick.describer,
            signal: deps.signal,
          },
        );
        const base = Scene.parse(await readJson(deps.store, layout.sceneRef));
        const written = await authorWorld(
          {
            scene: base,
            sceneHash: layout.sceneRef.hash,
            brief: briefFor({
              scene: base,
              name: place.name,
              summary: place.blurb,
              description: text,
              currency: spec.currency,
              city: {
                line: `${spec.name}: ${spec.tagline}`,
                needs: spec.needs,
                marks: spec.marks,
                hourPay: spec.economy.hourPay,
              },
            }),
          },
          {
            author: deps.providers.quick.author,
            store: deps.store,
            index,
            signal: deps.signal,
            maxRounds: again ? MORE_ROUNDS : 2,
            untilNoErrors: true,
            critique: (s) =>
              evaluateWorld(base, s, EVAL_SETTINGS, { home: place.private }).findings,
          },
        );
        if (
          !written.spec ||
          !written.specRef ||
          written.findings.some((f) => f.severity === "error")
        ) {
          // Only what code found, for whoever reads the logs: a place going missing is a mystery.
          const why = written.findings.filter((f) => f.severity === "error").map((f) => f.message);
          console.warn(`place ${place.key} not built:`, why.join(" | ").slice(0, 600));
          return { key: place.key, built: false };
        }
        const withLooks = await furnished(written.spec, base);
        const set = walkable(
          dress ? await decorated(base, withLooks) : { scene: base, spec: withLooks },
        );
        const specRef =
          set.spec === written.spec
            ? written.specRef
            : await deps.store.put(encodeJson(set.spec), "application/json");
        const sceneRef =
          set.scene === base
            ? layout.sceneRef
            : await deps.store.put(encodeJson(set.scene), "application/json");
        await pin(place, sceneRef, set.scene, specRef, null, `Built for ${spec.name}`);
        return { key: place.key, built: true };
      },
      // A new city's first rooms ride out a network blip of a few minutes; the rest can wait.
      { retries: dress ? FIRST_PLACE_ATTEMPTS : 2 },
    ).catch(() => ({ key: place.key, built: false }));

  const homes = new Set(spec.starts.map((s) => s.home));
  const firstHome = placesOf(spec).find((p) => homes.has(p.key));
  const nearest = placesOf(spec)
    .filter((p) => !p.private)
    .sort((a, b) => (firstHome ? distanceM(firstHome, a) - distanceM(firstHome, b) : 0))[0];
  const starters = placesOf(spec).filter((p) => homes.has(p.key) || p.key === nearest?.key);
  lines = spec.buildingLines;
  await tell(3);
  const results = await Promise.all(starters.map((p) => buildPlace(p, true)));
  const playable = (built: readonly string[]) =>
    [...homes].some((h) => built.includes(h)) &&
    placesOf(spec).some((p) => !p.private && built.includes(p.key));
  let open = playable(results.filter((r) => r.built).map((r) => r.key));
  if (open) await step("open", () => systemSetWorld(deps.db, job.worldId, { status: "ready" }));
  if (job.phase === "quick" && deps.finishLater) {
    const later = deps.finishLater;
    // Not a step: starting a workflow is itself checkpointed (and idempotent by its id).
    await later({ worldId: job.worldId, phase: "finish" }, { playable: open });
    return open
      ? { status: "ready", built: results.filter((r) => r.built).map((r) => r.key), missing: [] }
      : { status: "failed", reason: "still building" };
  }

  // ── Pass 2: every other place, a few at a time, each appearing as it lands ────────────
  const rest = placesOf(spec).filter((p) => !starters.includes(p));
  const width = Math.max(1, Math.min(8, deps.parallel ?? 6));
  for (let i = 0; i < rest.length; i += width) {
    results.push(...(await Promise.all(rest.slice(i, i + width).map((p) => buildPlace(p)))));
  }
  // A place that wouldn't come right gets longer at it, not the same two rounds replayed from
  // the cache: a city shouldn't open with a way to start life that has nowhere to wake up.
  const failed = results.filter((r) => !r.built);
  const retried = await Promise.all(
    failed.flatMap((r) => {
      const place = placesOf(spec).find((p) => p.key === r.key);
      return place ? [buildPlace(place, homes.has(place.key), true)] : [];
    }),
  );
  const finished = [...results.filter((r) => r.built), ...retried];
  const built = finished.filter((r) => r.built).map((r) => r.key);
  const missing = finished.filter((r) => !r.built).map((r) => r.key);
  if (!open) {
    open = playable(built);
    await step("finish", () =>
      systemSetWorld(deps.db, job.worldId, { status: open ? "ready" : "failed" }),
    );
    if (!open)
      return { status: "failed", reason: `too few places could be built (${built.length})` };
  }

  // ── Pass 3: make everything look like what it is, live ────────────────────────────────
  await step(
    "dress-city",
    async () => {
      const dressed = await dressCity(spec, { ...looks(), signal: deps.signal });
      const f = furnishing();
      const outfitted = f ? await furnishCity(dressed.spec, f).catch(() => null) : null;
      const peopled = f
        ? await populateCity(outfitted?.spec ?? dressed.spec, f).catch(() => null)
        : null;
      const ref = await deps.store.put(
        encodeJson(peopled?.spec ?? outfitted?.spec ?? dressed.spec),
        "application/json",
      );
      await systemRecordArtifacts(deps.db, [ref]);
      await systemLinkWorldArtifacts(deps.db, job.worldId, [ref.hash]);
      await systemSetWorld(deps.db, job.worldId, { city: ref.hash });
    },
    { retries: 2 },
  ).catch(() => undefined);

  const dressPlace = (place: CityPlace) =>
    step(
      `dress:${place.key}`,
      async () => {
        const pinned = await systemGetPinnedPlace(deps.db, job.worldId, place.key);
        if (!pinned?.spec) return;
        const scene = Scene.parse(
          await readJson(deps.store, {
            hash: pinned.scene,
            mediaType: "application/json",
            bytes: 0,
          }),
        );
        const current = WorldSpec.parse(
          await readJson(deps.store, {
            hash: pinned.spec,
            mediaType: "application/json",
            bytes: 0,
          }),
        );
        const dressed = await dressWorld(current, scene, { ...looks(), signal: deps.signal });
        const ready = await furnished(dressed.spec, scene);
        const set = walkable(await decorated(scene, ready));
        const specRef = await deps.store.put(encodeJson(set.spec), "application/json");
        const sceneRef = await deps.store.put(encodeJson(set.scene), "application/json");
        if (specRef.hash === pinned.spec && sceneRef.hash === pinned.scene) return;
        await pin(
          place,
          sceneRef,
          set.scene,
          specRef,
          pinned.revision,
          "Dressed: everything looks like what it is",
        );
      },
      { retries: 2 },
    ).catch(() => undefined);
  const builtPlaces = placesOf(spec).filter((p) => built.includes(p.key));
  for (let i = 0; i < builtPlaces.length; i += 3) {
    await Promise.all(builtPlaces.slice(i, i + 3).map(dressPlace));
  }
  return { status: "ready", built, missing };
}

/** Rounds a place that failed gets on its second try. */
const MORE_ROUNDS = 5;

/** Encoded JSON size of a city spec, for logs. */
export const citySize = (spec: CitySpec) => encodeJson(spec).byteLength;
