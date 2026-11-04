/**
 * Who rebuilds things in 3D, chosen by configuration and nothing else. `fal` is SAM 3D Objects as
 * a hosted API, paid per call. `modal` is any GPU endpoint of our own that keeps the small
 * contract below, so moving between them is one setting and no code. Each names its model in its
 * ref, so a different host makes new artifacts instead of being mistaken for the old one.
 *
 * Keys stay on the server. Errors carry a status and a kind, never a provider's text. Addresses a
 * provider hands back are only followed on its own hosts, so an answer can't point us anywhere.
 */
import { z } from "zod";
import { toBase64 } from "./muse.ts";
import { patientFetch } from "./patient-fetch.ts";
import type { ObjectReconstructor, ReconstructRequest } from "./reconstruct.ts";
import { MAX_MESH_BYTES } from "./reconstruct.ts";

type Fetch = typeof fetch;

const dataUrl = (r: ReconstructRequest) =>
  `data:${r.image.mediaType};base64,${toBase64(r.image.bytes)}`;

/** The whole body, unless it's more than a model could reasonably be. */
async function readBounded(res: Response): Promise<Uint8Array> {
  if (!res.body) throw new Error("reconstruct: empty response");
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of res.body) {
    total += part.byteLength;
    if (total > MAX_MESH_BYTES) throw new Error("reconstruct: response too large");
    parts.push(part);
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

const FAL_MODEL = "fal-ai/sam-3/3d-objects";
const FAL_QUEUE_HOST = "queue.fal.run";
const FAL_DETECTION = 0.3;
const FAL_POLL_MS = 2_000;
const FAL_TIMEOUT_MS = 6 * 60_000;

/** An address from fal's answer, if it's somewhere of fal's over https. */
function falAddress(value: string, hosts: (host: string) => boolean): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !hosts(url.hostname)) {
    throw new Error("reconstruct: unexpected address");
  }
  return url.toString();
}
const isQueue = (host: string) => host === FAL_QUEUE_HOST;
const isFalFile = (host: string) =>
  host === "fal.media" ||
  host.endsWith(".fal.media") ||
  host === "fal.run" ||
  host.endsWith(".fal.run") ||
  host.endsWith(".fal.ai");

const FalQueued = z.object({
  status_url: z.string().max(2048),
  response_url: z.string().max(2048),
});
const FalStatus = z.object({ status: z.string().max(64) });
const FalResult = z.object({ model_glb: z.object({ url: z.string().max(2048) }) });

export function falReconstructor(cfg: {
  apiKey: string;
  fetch?: Fetch;
  pollMs?: number;
  timeoutMs?: number;
}): ObjectReconstructor {
  const doFetch = cfg.fetch ?? patientFetch;
  const headers = { authorization: `Key ${cfg.apiKey}`, "content-type": "application/json" };
  return {
    model: {
      provider: "fal",
      model: FAL_MODEL,
      version: `${FAL_MODEL}@textured-glb-${FAL_DETECTION}`,
    },
    async reconstruct(request, ctx) {
      const signal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(cfg.timeoutMs ?? FAL_TIMEOUT_MS),
      ]);
      const queued = await doFetch(`https://${FAL_QUEUE_HOST}/${FAL_MODEL}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          image_url: dataUrl(request),
          prompt: request.concept,
          export_textured_glb: true,
          // Fal's own advice when a word finds nothing. A thing found by mistake gets caught after.
          detection_threshold: FAL_DETECTION,
          seed: ctx.seed,
        }),
        signal,
      });
      if (!queued.ok) throw new Error(`reconstruct: HTTP ${queued.status}`);
      const job = FalQueued.parse(await queued.json());
      const statusUrl = falAddress(job.status_url, isQueue);
      for (;;) {
        const res = await doFetch(statusUrl, { headers, signal });
        if (!res.ok) throw new Error(`reconstruct: status HTTP ${res.status}`);
        const { status } = FalStatus.parse(await res.json());
        if (status === "COMPLETED") break;
        if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
          throw new Error("reconstruct: job failed");
        }
        await new Promise((done) => setTimeout(done, cfg.pollMs ?? FAL_POLL_MS));
        signal.throwIfAborted();
      }
      const done = await doFetch(falAddress(job.response_url, isQueue), { headers, signal });
      if (!done.ok) throw new Error(`reconstruct: result HTTP ${done.status}`);
      const result = FalResult.parse(await done.json());
      // The file's address is public and needs no key, so the key doesn't go with it.
      const file = await doFetch(falAddress(result.model_glb.url, isFalFile), { signal });
      if (!file.ok) throw new Error(`reconstruct: file HTTP ${file.status}`);
      return readBounded(file);
    },
  };
}

/**
 * Our own GPU endpoint. The contract: POST JSON `{ image, concept, seed }`, where `image` is a
 * data URL and `concept` a few words saying what to find in it, with `authorization: Bearer
 * <token>`; answer 200 with the GLB as the body. `version` names what it runs (model and weights),
 * for the recipes.
 */
export function modalReconstructor(cfg: {
  url: string;
  token: string;
  version: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): ObjectReconstructor {
  const doFetch = cfg.fetch ?? patientFetch;
  return {
    model: { provider: "modal", model: "object-reconstruction", version: cfg.version },
    async reconstruct(request, ctx) {
      const res = await doFetch(cfg.url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl(request), concept: request.concept, seed: ctx.seed }),
        // A GPU that's asleep has to wake and load the model first.
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(cfg.timeoutMs ?? 10 * 60_000)]),
      });
      if (!res.ok) throw new Error(`reconstruct: HTTP ${res.status}`);
      return readBounded(res);
    },
  };
}

const ReconstructEnv = z
  .object({
    RECONSTRUCT_PROVIDER: z.enum(["", "fal", "modal"]).default(""),
    FAL_KEY: z.string().default(""),
    MODAL_RECONSTRUCT_URL: z.string().default(""),
    MODAL_RECONSTRUCT_TOKEN: z.string().default(""),
    MODAL_RECONSTRUCT_VERSION: z.string().max(120).default(""),
  })
  .transform((e, ctx) => {
    const missing = (key: string) => {
      ctx.addIssue({ code: "custom", message: `${key} is required`, path: [key] });
      return z.NEVER;
    };
    if (e.RECONSTRUCT_PROVIDER === "fal" && !e.FAL_KEY) return missing("FAL_KEY");
    if (e.RECONSTRUCT_PROVIDER === "modal") {
      if (!e.MODAL_RECONSTRUCT_URL.startsWith("https://")) return missing("MODAL_RECONSTRUCT_URL");
      if (!e.MODAL_RECONSTRUCT_TOKEN) return missing("MODAL_RECONSTRUCT_TOKEN");
      if (!e.MODAL_RECONSTRUCT_VERSION) return missing("MODAL_RECONSTRUCT_VERSION");
    }
    return e;
  });

/** The configured reconstructor, or null if none is: filmed things then keep the looks they had. */
export function reconstructorFrom(
  env: Record<string, string | undefined>,
): ObjectReconstructor | null {
  const e = ReconstructEnv.parse(env);
  if (e.RECONSTRUCT_PROVIDER === "fal") return falReconstructor({ apiKey: e.FAL_KEY });
  if (e.RECONSTRUCT_PROVIDER === "modal") {
    return modalReconstructor({
      url: e.MODAL_RECONSTRUCT_URL,
      token: e.MODAL_RECONSTRUCT_TOKEN,
      version: e.MODAL_RECONSTRUCT_VERSION,
    });
  }
  return null;
}
