/**
 * Someone asking to change their own home: the model proposes, code checks, and the result is
 * stored and offered at a price. Nothing changes until they buy it, which the realm does, from
 * this result and their wallet: the client never names a hash or a price.
 *
 * The request is the player's words: data for the model. The API has already checked this is
 * their own home, and rate-limited them.
 */
import { type ArtifactStore, encodeJson } from "@aye/artifacts";
import {
  type Db,
  PgRecipeIndex,
  systemGetCharacter,
  systemGetPinnedPlace,
  systemGetWorld,
  systemRecordArtifacts,
} from "@aye/db";
import { makeYours, type PlaceChanger, readJson } from "@aye/pipeline";
import {
  type ArtifactHash,
  LIBRARY_CATALOG,
  type LibraryCatalog,
  Scene,
  SpecKey,
  WorldSpec,
} from "@aye/schema";
import { moveThings } from "@aye/sim";
import { z } from "zod";
import { Moves } from "./move-job.ts";

export const HomeJob = z.strictObject({
  worldId: z.string().max(64),
  userId: z.string().max(64),
  place: SpecKey,
  /** What they said they want, for the model to propose; or, moving things by hand: */
  request: z.string().min(2).max(300).optional(),
  moves: Moves.optional(),
  nonce: z.string().min(6).max(32),
});
export type HomeJob = z.infer<typeof HomeJob>;

export type HomeResult =
  | {
      ok: true;
      say: string;
      place: string;
      price: number;
      added: string[];
      moved: string[];
      removed: string[];
      /** What it would become, and what it's a change from: read only by the server. */
      scene: string;
      spec: string;
      base: string;
    }
  | { ok: false; reason: string };

const ref = (hash: string) => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

export async function runHomeJob(
  raw: unknown,
  deps: {
    db: Db;
    store: ArtifactStore;
    changer: PlaceChanger;
    catalog?: LibraryCatalog;
    signal: AbortSignal;
  },
): Promise<HomeResult> {
  const job = HomeJob.parse(raw);
  const [world, character, pinned] = await Promise.all([
    systemGetWorld(deps.db, job.worldId),
    systemGetCharacter(deps.db, job.worldId, job.userId),
    systemGetPinnedPlace(deps.db, job.worldId, job.place),
  ]);
  if (!world?.city || !character || !pinned?.spec) {
    return { ok: false, reason: "that place isn't ready" };
  }
  const own = character.home?.place === job.place ? character.home : null;
  const sceneHash = own?.scene ?? pinned.scene;
  const specHash = own?.spec ?? pinned.spec;
  const [scene, spec] = await Promise.all([
    readJson(deps.store, ref(sceneHash)).then((j) => Scene.parse(j)),
    readJson(deps.store, ref(specHash)).then((j) => WorldSpec.parse(j)),
  ]);
  if (job.moves) {
    // By hand: nothing to design and nothing to pay. It's their own furniture.
    const moved = moveThings(scene, spec, job.moves);
    if (!moved.ok) return moved;
    const sceneRef = await deps.store.put(encodeJson(moved.scene), "application/json");
    await systemRecordArtifacts(deps.db, [sceneRef]);
    return {
      ok: true,
      say: "",
      place: job.place,
      price: 0,
      added: [],
      moved: moved.moved.map((o) => o.label),
      removed: [],
      scene: sceneRef.hash,
      spec: specHash,
      base: sceneHash,
    };
  }
  if (!job.request) return { ok: false, reason: "that isn't something that can be done here" };
  const made = await makeYours(scene, spec, job.request, {
    changer: deps.changer,
    store: deps.store,
    index: new PgRecipeIndex(deps.db),
    catalog: deps.catalog ?? LIBRARY_CATALOG,
    signal: deps.signal,
  });
  if (!made.scene || !made.spec) {
    return { ok: false, reason: made.say || "that isn't something that can be done here" };
  }
  const [sceneRef, specRef] = await Promise.all([
    deps.store.put(encodeJson(made.scene), "application/json"),
    deps.store.put(encodeJson(made.spec), "application/json"),
  ]);
  await systemRecordArtifacts(deps.db, [sceneRef, specRef]);
  return {
    ok: true,
    say: made.say,
    place: job.place,
    price: made.price,
    added: made.added,
    moved: made.moved,
    removed: made.removed,
    scene: sceneRef.hash,
    spec: specRef.hash,
    base: sceneHash,
  };
}
