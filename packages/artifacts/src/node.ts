/**
 * Filesystem-backed stores for local development and tests. Production uses S3-compatible
 * object storage behind the same ArtifactStore interface.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtifactHash,
  ArtifactHash as ArtifactHashSchema,
  type ArtifactRef,
  StageRecord,
} from "@aye/schema";
import { hashBytes } from "./hash.ts";
import { type ArtifactStore, type RecipeIndex, verify } from "./store.ts";

export class FsArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** Re-validate the hash before touching the filesystem: it is the only path component. */
  #path(hash: ArtifactHash): string {
    const hex = ArtifactHashSchema.parse(hash).slice(3);
    return join(this.#root, hex.slice(0, 2), hex.slice(2));
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const hash = hashBytes(bytes);
    const path = this.#path(hash);
    if (!(await this.has(hash))) {
      await mkdir(join(path, ".."), { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes, { flag: "wx" });
      await rename(tmp, path);
    }
    return { hash, mediaType, bytes: bytes.byteLength };
  }

  async get(hash: ArtifactHash): Promise<Uint8Array | null> {
    try {
      return verify(hash, new Uint8Array(await readFile(this.#path(hash))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(hash: ArtifactHash): Promise<boolean> {
    try {
      await stat(this.#path(hash));
      return true;
    } catch {
      return false;
    }
  }
}

export class FsRecipeIndex implements RecipeIndex {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #path(recipeHash: ArtifactHash): string {
    return join(this.#root, "recipes", `${ArtifactHashSchema.parse(recipeHash).slice(3)}.json`);
  }

  async lookup(recipeHash: ArtifactHash) {
    try {
      return StageRecord.parse(JSON.parse(await readFile(this.#path(recipeHash), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async record(entry: StageRecord): Promise<void> {
    const path = this.#path(entry.recipeHash);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(StageRecord.parse(entry)));
  }
}
