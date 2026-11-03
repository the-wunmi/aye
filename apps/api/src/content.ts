/**
 * Loading what worlds are made of (city specs, scenes, world specs) from the artifact store,
 * validated, with a small bounded cache. Content is immutable and addressed by hash, so a
 * cached parse is always right. Callers must already have authorised the read (they got the
 * hash from an actor-scoped repository); this module never decides who may see what.
 */
import type { ArtifactStore } from "@aye/artifacts";
import { type ArtifactHash, CitySpec, Scene, WorldSpec } from "@aye/schema";
import type { z } from "zod";

const MAX_ENTRIES = 256;

/**
 * Stored content that no longer fits today's shapes (a city from an older format): not a
 * server fault, and nothing a client can fix. Answered as gone.
 */
export class OutdatedContent extends Error {
  constructor() {
    super("content is in an older format");
  }
}

export interface Content {
  city(hash: ArtifactHash): Promise<CitySpec>;
  scene(hash: ArtifactHash): Promise<Scene>;
  spec(hash: ArtifactHash): Promise<WorldSpec>;
}

export function contentLoader(store: ArtifactStore): Content {
  const cache = new Map<string, Promise<unknown>>();
  const load = <S extends z.ZodType>(schema: S, hash: ArtifactHash): Promise<z.output<S>> => {
    const key = `${hash}`;
    const hit = cache.get(key);
    if (hit) {
      // Refresh recency.
      cache.delete(key);
      cache.set(key, hit);
      return hit as Promise<z.output<S>>;
    }
    const loading = (async () => {
      const bytes = await store.get(hash);
      if (!bytes) throw new Error("content missing");
      const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!parsed.success) throw new OutdatedContent();
      return parsed.data;
    })();
    loading.catch(() => cache.delete(key));
    cache.set(key, loading);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return loading;
  };
  return {
    city: (hash) => load(CitySpec, hash),
    scene: (hash) => load(Scene, hash),
    spec: (hash) => load(WorldSpec, hash),
  };
}
