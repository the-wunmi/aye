/**
 * Someone in a place answers a player: the realm hands over what was said (or that they
 * walked in), who's there and the last few lines; this reads the place's people and what they
 * remember, lets the conversation stage decide who (if anyone) answers and what they say,
 * keeps the speaker's updated memory, and returns the reply for the realm to post.
 *
 * With nobody there, the place itself tells them what they can do when they ask: a real place
 * someone filmed has nobody in it unless they said so, and it shouldn't just go quiet on them.
 *
 * Trusted job: the realm queues it for a player it has already checked is in that place.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type Db,
  systemGetPinnedPlace,
  systemGetWorld,
  systemPersonMemories,
  systemRememberPerson,
} from "@aye/db";
import { type Conversationalist, converse, type Reply, readJson } from "@aye/pipeline";
import { type ArtifactHash, CitySpec, placesOf, SpecKey, WorldId, WorldSpec } from "@aye/schema";
import { z } from "zod";

export const ConverseJob = z.strictObject({
  worldId: WorldId,
  placeKey: SpecKey,
  /** Which copy of the place (a private home's owner), or "": memories never cross copies. */
  instance: z.string().max(64),
  playerName: z.string().max(80),
  /** What they said; "" when they just walked in. */
  said: z.string().max(300),
  arrived: z.boolean(),
  /** The place's people who are here (not players, not held), by key. */
  present: z.array(SpecKey).max(16),
  /** How close the player is to each of the people here, by person key. */
  closeness: z.record(SpecKey, z.int().min(0).max(1_000)).optional(),
  recent: z.array(z.strictObject({ from: z.string().max(80), text: z.string().max(300) })).max(8),
});
export type ConverseJob = z.infer<typeof ConverseJob>;

export interface ConverseJobDeps {
  db: Db;
  store: ArtifactStore;
  index: RecipeIndex;
  voice: Conversationalist;
  signal?: AbortSignal;
}

const ref = (hash: string) => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

/** Who "speaks" when a place has nobody in it: the place, never a person. */
const THE_PLACE = "the_place";

export async function runConverseJob(
  job: ConverseJob,
  deps: ConverseJobDeps,
): Promise<Reply | null> {
  // Nobody here and nothing said: walking into an empty place gets no greeting.
  if (job.present.length === 0 && job.arrived) return null;
  const world = await systemGetWorld(deps.db, job.worldId);
  if (!world?.city) return null;
  const city = CitySpec.safeParse(await readJson(deps.store, ref(world.city)));
  const pinned = await systemGetPinnedPlace(deps.db, job.worldId, job.placeKey);
  if (!city.success || !pinned?.spec) return null;
  const spec = WorldSpec.safeParse(await readJson(deps.store, ref(pinned.spec)));
  if (!spec.success) return null;
  const place = placesOf(city.data).find((p) => p.key === job.placeKey);
  // What can really be done here: the kinds of thing present, and what each offers.
  const present = new Set(spec.data.things.map((t) => t.kind));
  const money = (v: number) => `${(v / 100).toFixed(2)} ${city.data.currency}`;
  const offers = spec.data.kinds
    .filter((k) => present.has(k.key))
    .flatMap((k) =>
      k.actions.map((a) => ({
        kind: k.key,
        action: a.key,
        label: a.label,
        thing: k.label,
        cost: a.cost,
        income: a.income,
      })),
    )
    .slice(0, 40);
  const here = new Set(job.present);
  const people = spec.data.people.filter((p) => here.has(p.key));
  const empty = people.length === 0;
  if (empty && job.arrived) return null;
  const placeName = place?.name ?? spec.data.name;
  // A private place is one copy per player: what's said in yours is remembered in yours.
  const memoryKey = job.instance ? `${job.placeKey}#${job.instance}` : job.placeKey;
  const memories = await systemPersonMemories(deps.db, job.worldId, memoryKey);
  const { reply } = await converse(
    {
      city: `${city.data.name}: ${city.data.tagline}`,
      place: { name: place?.name ?? spec.data.name, about: place?.blurb ?? spec.data.summary },
      people: empty
        ? [{ name: placeName, about: "The place itself. Nobody's here.", remembers: "" }]
        : people.map((p) => ({
            name: p.name,
            about: p.about,
            remembers: memories.get(p.key) ?? "",
            closeness: job.closeness?.[p.key] ?? 0,
          })),
      ...(empty ? { empty: true } : {}),
      player: { name: job.playerName, said: job.said, arrived: job.arrived },
      recent: job.recent,
      offers: offers.map((o) => ({
        label: o.label,
        thing: o.thing,
        costs: o.cost > 0 ? money(o.cost) : "",
        pays: o.income > 0 ? money(o.income) : "",
      })),
    },
    empty
      ? [{ key: THE_PLACE, name: placeName }]
      : people.map((p) => ({ key: p.key, name: p.name })),
    {
      voice: deps.voice,
      store: deps.store,
      index: deps.index,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    offers.map((o) => ({ kind: o.kind, action: o.action, label: o.label })),
  );
  if (reply?.remember && !empty) {
    await systemRememberPerson(deps.db, job.worldId, memoryKey, reply.person, reply.remember);
  }
  return reply;
}
