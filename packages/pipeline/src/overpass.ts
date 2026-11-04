/**
 * OpenStreetMap's Overpass API as a map source. Server-side only: it reaches the
 * internet. Public instances are often at capacity, so each is tried in turn; answers are
 * size-capped and must look like Overpass JSON before anything reads them (the grounding
 * stage then validates them fully). Being polite is part of the deal: each query (roads, lines,
 * land) is asked once for a city and memoised forever after, with a user agent that says who
 * we are.
 */
import type { MapSource } from "./ground.ts";

const HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const ROUNDS = 4;
const BACKOFF_MS = 20_000;

export function overpassSource(opts: { userAgent?: string } = {}): MapSource {
  return {
    // What the data is: OSM as of the fetch, for every query, though the version names only
    // roads. Each fetch is memoised by its query.
    ref: { provider: "openstreetmap", model: "overpass", version: "main-roads-1" },
    async fetch(query, signal) {
      const failures: string[] = [];
      // Busy servers come and go: a few rounds over all of them, waiting longer each time.
      for (let round = 0; round < ROUNDS; round++) {
        if (round > 0) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS * round));
        }
        for (const host of HOSTS) {
          signal.throwIfAborted();
          try {
            const res = await fetch(host, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": opts.userAgent ?? "aye/0.1 (city life simulation)",
              },
              body: new URLSearchParams({ data: query }).toString(),
              signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
            });
            if (!res.ok) {
              failures.push(`${new URL(host).host} ${res.status}`);
              continue;
            }
            const length = Number(res.headers.get("content-length") ?? 0);
            if (length > MAX_BYTES) throw new Error("map data too large");
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.byteLength > MAX_BYTES) throw new Error("map data too large");
            // Busy servers answer 200 with an error page; only JSON with elements will do.
            const head = new TextDecoder().decode(bytes.subarray(0, 200));
            if (!head.trimStart().startsWith("{") || !head.includes('"version"')) {
              failures.push(`${new URL(host).host} not json`);
              continue;
            }
            return bytes;
          } catch (err) {
            if (signal.aborted) throw err;
            failures.push(`${new URL(host).host} ${(err as Error).name}`);
          }
        }
      }
      throw new Error(`map data unavailable (${failures.slice(-HOSTS.length).join(", ")})`);
    },
  };
}
