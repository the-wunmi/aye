/**
 * A real city's road network and land cover: each fetched once from its artifact
 * (readable because the world links it), validated at this boundary like anything that comes
 * over the wire, and kept while the city stays the same. Null for a sketched city, or until
 * it arrives; a map without them still shows its places.
 */
import { type CitySpec, LandCover, landIssues, networkIssues, RoadNetwork } from "@aye/schema";
import { useEffect, useState } from "react";
import type { z } from "zod";

function useArtifact<T>(
  hash: string | null,
  schema: z.ZodType<T>,
  issues: (value: T) => string[],
): T | null {
  const [got, setGot] = useState<{ hash: string; value: T } | null>(null);
  useEffect(() => {
    if (!hash) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/artifacts/${encodeURIComponent(hash)}`, {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const parsed = schema.safeParse(await res.json());
        if (!parsed.success || issues(parsed.data).length > 0) return;
        if (live) setGot({ hash, value: parsed.data });
      } catch {
        // Nothing to draw: the city still shows, with its places.
      }
    })();
    return () => {
      live = false;
    };
  }, [hash, schema, issues]);
  return hash && got?.hash === hash ? got.value : null;
}

export function useNetwork(city: CitySpec): RoadNetwork | null {
  return useArtifact(city.real?.network ?? null, RoadNetwork, networkIssues);
}

export function useLand(city: CitySpec): LandCover | null {
  return useArtifact(city.real?.land ?? null, LandCover, landIssues);
}
