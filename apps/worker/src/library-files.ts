/**
 * Reading the asset library's files on the worker, so the harness can picture
 * library models as players see them. Only catalog-shaped paths inside the library folder
 * are read; anything else is refused. A missing file is null (the harness falls back to
 * primitives), never an error.
 */
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the web app serves the library from, unless LIBRARY_DIR says otherwise. */
const DEFAULT_DIR = fileURLToPath(new URL("../../web/public/library/", import.meta.url));

export function libraryFiles(dir = process.env["LIBRARY_DIR"] ?? DEFAULT_DIR) {
  const root = resolve(dir);
  return async (file: string): Promise<Uint8Array | null> => {
    if (!/^[a-z0-9_]+\/[a-z0-9_]+\.(glb|jpg)$/.test(file)) return null;
    const path = resolve(join(root, file));
    if (!path.startsWith(root + sep)) return null;
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  };
}
