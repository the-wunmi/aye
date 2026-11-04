/**
 * Taking a filmed place away, for good. Whoever filmed it can, and so can whoever owns the city.
 * It leaves the city, and everything made from the video goes with the video: the frames (some
 * of them before faces were blurred), what was found in them, the layout, the pictures and the
 * models. Deleting only the video would leave most of what someone asked to have gone.
 *
 * What's made from a video is found by following the recipes: each stage names what it took in
 * and what it gave out. Anything something else still uses stays. The API has checked who's asking;
 * this checks again, in case that's changed since.
 */
import type { ArtifactStore } from "@aye/artifacts";
import { encodeJson } from "@aye/artifacts";
import {
  type Db,
  listRemovablePlaceKeys,
  systemArtifactStillUsed,
  systemFilmedPlace,
  systemForgetArtifacts,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemLiveArtifacts,
  systemRecipesTaking,
  systemRecordArtifacts,
  systemRemovePlace,
  systemSwapWorldCity,
  systemVideoUsedElsewhere,
} from "@aye/db";
import { readJson } from "@aye/pipeline";
import { type ArtifactHash, CitySpec, SpecKey, WorldId } from "@aye/schema";
import { z } from "zod";

export const RemoveJob = z.strictObject({
  worldId: WorldId,
  place: SpecKey,
  userId: z.string().max(64),
  nonce: z.string().regex(/^[0-9a-z]{6,32}$/),
});
export type RemoveJob = z.infer<typeof RemoveJob>;

export type RemoveResult =
  | { ok: true; worldId: string; place: string }
  | { ok: false; reason: string };

/** How many times to try if the city changes at the same moment. */
const SWAP_TRIES = 6;
/** Far more than one video ever makes. */
const MAX_FOLLOWED = 20_000;
const ARTIFACT_HASH = /^b3:[0-9a-f]{64}$/;

const ref = (hash: string) => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

/** The city without this place, or anything in it that still points there. */
function withoutPlace(city: CitySpec, place: string): CitySpec {
  return CitySpec.parse({
    ...city,
    items: city.items
      .filter((i) => i.key !== place)
      .map((i) =>
        i.traits.mover
          ? {
              ...i,
              traits: {
                ...i.traits,
                mover: {
                  ...i.traits.mover,
                  serves: (i.traits.mover.serves ?? []).filter((s) => s !== place),
                },
              },
            }
          : i,
      ),
    events: city.events.map((e) => ({
      ...e,
      effects: e.effects.filter((f) => f.type !== "closed" || f.place !== place),
    })),
  });
}

/** Every artifact hash mentioned anywhere in a piece of JSON. */
function hashesIn(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (ARTIFACT_HASH.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) hashesIn(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) hashesIn(v, into);
  }
}

/** A video and all that's made from it, by following what each stage took in and gave out. */
async function madeFrom(
  db: Db,
  store: ArtifactStore,
  start: readonly string[],
): Promise<{ hashes: Set<string>; recipes: Set<string> }> {
  const hashes = new Set(start);
  const recipes = new Set<string>();
  const queue = [...start];
  while (queue.length > 0 && hashes.size < MAX_FOLLOWED) {
    const hash = queue.pop() as string;
    for (const r of await systemRecipesTaking(db, hash)) {
      recipes.add(r.recipeHash);
      for (const out of r.outputs) {
        const found = new Set<string>([out]);
        const bytes = await store.get(out as ArtifactHash);
        if (bytes && r.jsonOutputs.includes(out)) {
          try {
            hashesIn(JSON.parse(new TextDecoder().decode(bytes)), found);
          } catch {
            // Not JSON after all: only itself, then.
          }
        }
        for (const h of found) {
          if (!hashes.has(h)) {
            hashes.add(h);
            queue.push(h);
          }
        }
      }
    }
  }
  return { hashes, recipes };
}

export async function runRemoveJob(
  raw: unknown,
  deps: { db: Db; store: ArtifactStore },
): Promise<RemoveResult> {
  const job = RemoveJob.parse(raw);
  const { db, store } = deps;
  const actor = { kind: "user" as const, userId: job.userId as never };
  if (!(await listRemovablePlaceKeys(db, actor, job.worldId)).includes(job.place)) {
    return { ok: false, reason: "That isn't yours to remove." };
  }
  const filmed = await systemFilmedPlace(db, job.worldId, job.place);
  if (!filmed) return { ok: false, reason: "That place has already gone." };

  // Off the map first, so nobody sets out for it while the rest goes.
  let left = false;
  for (let t = 0; t < SWAP_TRIES && !left; t++) {
    const world = await systemGetWorld(db, job.worldId);
    if (!world?.city) return { ok: false, reason: "That city isn't ready." };
    const now = CitySpec.parse(await readJson(store, ref(world.city)));
    if (!now.items.some((i) => i.key === job.place)) {
      left = true;
      break;
    }
    const next = withoutPlace(now, job.place);
    const stored = await store.put(encodeJson(next), "application/json");
    await systemRecordArtifacts(db, [stored]);
    await systemLinkWorldArtifacts(db, job.worldId, [stored.hash]);
    left = await systemSwapWorldCity(db, job.worldId, world.city as ArtifactHash, stored.hash);
  }
  if (!left) return { ok: false, reason: "The city was too busy. Try again." };

  const videos: string[] = [];
  for (const v of filmed.videos) {
    if (!(await systemVideoUsedElsewhere(db, v, filmed.placeId))) videos.push(v);
  }
  const { hashes, recipes } = await madeFrom(db, store, videos);
  for (const h of filmed.revisionArtifacts) hashes.add(h);
  await systemRemovePlace(db, job.worldId, job.place, filmed.placeId);

  // Everything still in use anywhere stays, including what's only named inside something else: two
  // places can share a picture or a layout, and only one of them is going.
  const inUse = new Set<string>();
  for (const live of await systemLiveArtifacts(db)) {
    inUse.add(live);
    const bytes = await store.get(live as ArtifactHash);
    if (!bytes) continue;
    try {
      hashesIn(JSON.parse(new TextDecoder().decode(bytes)), inUse);
    } catch {
      // Not JSON: it's only itself.
    }
  }
  const gone: string[] = [];
  for (const h of hashes) {
    if (!inUse.has(h) && !(await systemArtifactStillUsed(db, h, recipes))) gone.push(h);
  }
  await systemForgetArtifacts(db, gone, recipes);
  for (const h of gone) await store.delete(h as ArtifactHash);
  return { ok: true, worldId: job.worldId, place: job.place };
}
