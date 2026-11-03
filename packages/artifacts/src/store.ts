/**
 * Artifact storage ports.
 *
 * Stores are dumb, verified byte buckets keyed by hash. They do no authorisation: knowing a
 * hash must never grant access. Callers (the API) check that the actor may read a record
 * that references the artifact, then hand out a short-lived URL or stream the bytes.
 */
import { ArtifactHash, type ArtifactRef, type StageRecord } from "@aye/schema";
import { hashBytes } from "./hash.ts";

export interface ArtifactStore {
  /** Idempotent: storing the same bytes twice returns the same ref and writes once. */
  put(bytes: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  /** Returns null if absent. Implementations verify bytes against the hash on read. */
  get(hash: ArtifactHash): Promise<Uint8Array | null>;
  has(hash: ArtifactHash): Promise<boolean>;
}

/** Maps recipe hashes to the stage outputs they produced: the memo table for generation. */
export interface RecipeIndex {
  lookup(recipeHash: ArtifactHash): Promise<StageRecord | null>;
  record(entry: StageRecord): Promise<void>;
}

export class IntegrityError extends Error {
  constructor(expected: ArtifactHash, actual: ArtifactHash) {
    super(`artifact integrity check failed: expected ${expected}, got ${actual}`);
    this.name = "IntegrityError";
  }
}

export function verify(hash: ArtifactHash, bytes: Uint8Array): Uint8Array {
  const actual = hashBytes(bytes);
  if (actual !== hash) throw new IntegrityError(hash, actual);
  return bytes;
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly #blobs = new Map<ArtifactHash, Uint8Array>();

  async put(bytes: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const hash = hashBytes(bytes);
    if (!this.#blobs.has(hash)) this.#blobs.set(hash, bytes.slice());
    return { hash, mediaType, bytes: bytes.byteLength };
  }

  async get(hash: ArtifactHash): Promise<Uint8Array | null> {
    const blob = this.#blobs.get(ArtifactHash.parse(hash));
    return blob ? verify(hash, blob.slice()) : null;
  }

  async has(hash: ArtifactHash): Promise<boolean> {
    return this.#blobs.has(ArtifactHash.parse(hash));
  }
}

export class MemoryRecipeIndex implements RecipeIndex {
  readonly #entries = new Map<ArtifactHash, StageRecord>();

  async lookup(recipeHash: ArtifactHash): Promise<StageRecord | null> {
    return this.#entries.get(recipeHash) ?? null;
  }

  async record(entry: StageRecord): Promise<void> {
    this.#entries.set(entry.recipeHash, entry);
  }
}
