/**
 * Fetch the asset library: download every source in `library-sources.ts`, pack
 * each model into one self-contained GLB, measure it, and write
 *   - the files under `apps/web/public/library/` (not committed: fetched, like a lockfile's
 *     packages), and
 *   - the catalog `packages/schema/src/library-catalog.ts` (committed), which is what models
 *     choose from and what specs are checked against.
 *
 * Pinned: every file's SHA-256 is in the catalog. A re-fetch that gets different bytes fails that
 * file with an error (pass `--update` to accept new versions deliberately). Downloads are HTTPS
 * only, from the sources' own hosts, and every output path is built from our ids, never from
 * anything a source returns.
 *
 * Usage: node packages/engine/scripts/fetch-library.ts [--update]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LibraryCatalog, LibraryCatalog as LibraryCatalogSchema } from "@aye/schema";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import jpeg from "jpeg-js";
import { MeshoptEncoder } from "meshoptimizer";
import { PNG } from "pngjs";
import * as THREE from "three";
import {
  BUILDINGS,
  THINGS as LOOSE_THINGS,
  OUTFITS,
  REAL_HEIGHT_M,
  SURFACES,
  type ThingSource,
} from "./library-sources.ts";

const THINGS = [...LOOSE_THINGS, ...BUILDINGS];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = join(ROOT, "apps/web/public/library");
const CATALOG = join(ROOT, "packages/schema/src/library-catalog.ts");
const UPDATE = process.argv.includes("--update");
const HOSTS = new Set(["api.polyhaven.com", "dl.polyhaven.org", "drive.usercontent.google.com"]);

/**
 * GitHub-hosted packs are read from shallow, sparse clones (raw file downloads are heavily
 * rate-limited). Cached under .aye/, which is ignored.
 */
const SOURCES_CACHE = join(ROOT, ".aye/library-src");
const QUATERNIUS = {
  url: "https://github.com/trebeljahr/quaternius-showcase.git",
  dir: "quaternius",
  base: "public/glb",
};
const KAYKIT = {
  url: "https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0.git",
  dir: "kaykit-city",
  base: "addons/kaykit_city_builder_bits/Assets/gltf",
};

/** Check out just these folders of a repo (shallow, sparse) and return its directory. */
function sparse(repo: { url: string; dir: string }, folders: string[]): string {
  const dir = join(SOURCES_CACHE, repo.dir);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(SOURCES_CACHE, { recursive: true });
    execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      repo.url,
      dir,
    ]);
  }
  execFileSync("git", ["-C", dir, "sparse-checkout", "set", ...new Set(folders)]);
  return dir;
}
/** Quaternius Ultimate Modular Men, "Adventurer" (CC0): carries the shared animation clips. */
const ANIMATION_FBX =
  "https://drive.usercontent.google.com/download?id=1WrSsAVKqNgUey8LDEOmmn2aFK30xyJHU&export=download&confirm=t";
const ANIMATION_CLIPS = {
  idle: "CharacterArmature|Idle",
  walk: "CharacterArmature|Walk",
  run: "CharacterArmature|Run",
  interact: "CharacterArmature|Interact",
  wave: "CharacterArmature|Wave",
};

const previous: LibraryCatalog | null = (() => {
  if (!existsSync(CATALOG)) return null;
  const m = /export const LIBRARY_CATALOG_JSON = (`[\s\S]*?`);/.exec(readFileSync(CATALOG, "utf8"));
  if (!m?.[1]) return null;
  return LibraryCatalogSchema.parse(JSON.parse(m[1].slice(1, -1)));
})();
const pinned = new Map<string, string>();
for (const a of [
  ...(previous?.things ?? []),
  ...(previous?.outfits ?? []),
  ...(previous?.surfaces ?? []),
]) {
  pinned.set(a.file, a.sha256);
}
if (previous?.animations) pinned.set(previous.animations.file, previous.animations.sha256);

// ── Downloads ─────────────────────────────────────────────────────────────────────────────

async function get(url: string): Promise<Uint8Array> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) throw new Error(`refusing ${u.host}`);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(u, { headers: { "user-agent": "aye-library-fetch" } });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (attempt >= 3) throw new Error(`${res.status} for ${u.pathname}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}
const getJson = async (url: string) => JSON.parse(new TextDecoder().decode(await get(url)));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Write a library file, refusing bytes that differ from the pinned ones. */
function save(file: string, bytes: Uint8Array): string {
  const hash = sha256(bytes);
  const pin = pinned.get(file);
  if (pin && pin !== hash && !UPDATE) {
    throw new Error(`${file} changed upstream (pass --update to accept it)`);
  }
  const path = join(OUT, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return hash;
}

// ── Shrinking for phones ──────────────────────────────────────────────────────────────────

/** Largest texture edge shipped, in pixels: plenty at game distance, a quarter of 1k's pixels. */
const MAX_TEXTURE_PX = 512;

/** Decode a PNG or JPEG to RGBA, or null if it's neither. */
function decodeImage(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  if (mime === "image/jpeg") {
    const img = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 512,
    });
    return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  }
  return null;
}

/** Box-filter an RGBA image down so its longest edge is at most `max`. */
function shrinkImage(img: { width: number; height: number; data: Uint8Array }, max: number) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * img.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * img.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / width));
      const sum = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (img.data[i + c] as number);
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = Math.round((sum[c] as number) / n);
    }
  }
  return { width, height, data };
}

/**
 * A GLB made small enough for a phone on a mobile network: textures at most
 * MAX_TEXTURE_PX (JPEG unless they need their alpha), geometry meshopt-compressed (the game
 * decodes it with three's bundled decoder). Deterministic, so pins stay meaningful.
 */
async function shrinkGlb(bytes: Uint8Array): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const doc = await io.readBinary(bytes);
  for (const tex of doc.getRoot().listTextures()) {
    const image = tex.getImage();
    const img = image ? decodeImage(image, tex.getMimeType()) : null;
    if (!image || !img) continue;
    const small = shrinkImage(img, MAX_TEXTURE_PX);
    let opaque = true;
    for (let i = 3; i < small.data.length && opaque; i += 4) opaque = small.data[i] === 255;
    const out = opaque
      ? new Uint8Array(jpeg.encode({ ...small, data: Buffer.from(small.data) }, 82).data)
      : new Uint8Array(
          PNG.sync.write(
            Object.assign(new PNG({ width: small.width, height: small.height }), {
              data: Buffer.from(small.data),
            }),
          ),
        );
    if (out.byteLength >= image.byteLength && small === img) continue;
    tex.setImage(out).setMimeType(opaque ? "image/jpeg" : "image/png");
  }
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  return io.writeBinary(doc);
}

// ── glTF packing and measuring ────────────────────────────────────────────────────────────

type Gltf = {
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  textures?: { source?: number; sampler?: number }[];
  materials?: Record<string, unknown>[];
  accessors?: { min?: number[]; max?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number> }[] }[];
  nodes?: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  scenes?: { nodes: number[] }[];
  scene?: number;
  [key: string]: unknown;
};

const align4 = (n: number) => (n + 3) & ~3;

/**
 * Pack a .gltf with external files into one GLB. Texture slots not in `keep` are dropped
 * (smaller downloads: colour and roughness carry the look at game distance).
 */
async function packGltf(
  gltf: Gltf,
  fetchUri: (uri: string) => Promise<Uint8Array>,
  keep = new Set(["baseColorTexture", "metallicRoughnessTexture"]),
): Promise<Uint8Array> {
  // Drop texture slots we don't ship, and images no remaining texture uses.
  const usedTextures = new Set<number>();
  for (const m of gltf.materials ?? []) {
    for (const slot of ["normalTexture", "occlusionTexture", "emissiveTexture"]) {
      if (!keep.has(slot)) delete m[slot];
    }
    const pbr = (m["pbrMetallicRoughness"] ?? {}) as Record<string, { index: number }>;
    for (const slot of ["baseColorTexture", "metallicRoughnessTexture"]) {
      if (!keep.has(slot)) delete pbr[slot];
      else if (pbr[slot]) usedTextures.add(pbr[slot].index);
    }
    for (const slot of ["normalTexture", "occlusionTexture", "emissiveTexture"]) {
      const t = m[slot] as { index: number } | undefined;
      if (t) usedTextures.add(t.index);
    }
    delete m["extensions"];
  }
  const usedImages = new Set(
    [...usedTextures].map((t) => gltf.textures?.[t]?.source).filter((s) => s !== undefined),
  );

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const views: NonNullable<Gltf["bufferViews"]> = [];
  const push = (bytes: Uint8Array) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength };
    chunks.push(bytes);
    const padded = align4(bytes.byteLength);
    if (padded > bytes.byteLength) chunks.push(new Uint8Array(padded - bytes.byteLength));
    offset += padded;
    return view;
  };
  // Existing buffers become one, keeping their views' offsets.
  const bufferBase: number[] = [];
  for (const b of gltf.buffers ?? []) {
    if (!b.uri) throw new Error("embedded buffers are not expected here");
    const bytes = await fetchUri(b.uri);
    bufferBase.push(offset);
    push(bytes);
  }
  for (const v of gltf.bufferViews ?? []) {
    views.push({ ...v, buffer: 0, byteOffset: (v.byteOffset ?? 0) + (bufferBase[v.buffer] ?? 0) });
  }
  const images: NonNullable<Gltf["images"]> = [];
  for (const [i, img] of (gltf.images ?? []).entries()) {
    if (!usedImages.has(i) || !img.uri) {
      images.push({ bufferView: views.length, mimeType: "image/png" });
      views.push(push(TRANSPARENT_PIXEL));
      continue;
    }
    const bytes = await fetchUri(img.uri);
    const mimeType = img.uri.endsWith(".png") ? "image/png" : "image/jpeg";
    images.push({ bufferView: views.length, mimeType });
    views.push(push(bytes));
  }
  const json: Gltf = { ...gltf, buffers: [{ byteLength: offset }], bufferViews: views, images };
  if (images.length === 0) delete json.images;
  return glb(json, concat(chunks, offset));
}

/** A 1×1 transparent PNG for image slots we don't ship (keeps indices valid). */
const TRANSPARENT_PIXEL = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function glb(json: Gltf, bin: Uint8Array): Uint8Array {
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(align4(text.byteLength)).fill(0x20);
  padded.set(text);
  text = padded;
  const binLength = align4(bin.byteLength);
  const total = 12 + 8 + text.byteLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, text.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  const binAt = 20 + text.byteLength;
  view.setUint32(binAt, binLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  out.set(bin, binAt + 8);
  return out;
}

function readGlbJson(bytes: Uint8Array): Gltf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

/** The model's bounding box (metres), from accessor bounds and node transforms; no decoding. */
function measure(gltf: Gltf): THREE.Box3 {
  const box = new THREE.Box3();
  const local = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  const visit = (index: number, parent: THREE.Matrix4) => {
    const node = gltf.nodes?.[index];
    if (!node) return;
    if (node.matrix) local.fromArray(node.matrix);
    else
      local.compose(
        new THREE.Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
        new THREE.Quaternion(
          ...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number]),
        ),
        new THREE.Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
      );
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) {
      for (const p of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        const acc = gltf.accessors?.[p.attributes["POSITION"] ?? -1];
        if (!acc?.min || !acc.max) continue;
        for (let c = 0; c < 8; c++) {
          corner
            .set(
              c & 1 ? (acc.max[0] as number) : (acc.min[0] as number),
              c & 2 ? (acc.max[1] as number) : (acc.min[1] as number),
              c & 4 ? (acc.max[2] as number) : (acc.min[2] as number),
            )
            .applyMatrix4(world);
          box.expandByPoint(corner);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const n of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) visit(n, new THREE.Matrix4());
  return box;
}

const sizeMm = (box: THREE.Box3): [number, number, number] => {
  const s = box.getSize(new THREE.Vector3());
  return [s.x, s.y, s.z].map((v) => Math.max(1, Math.round(v * 1000))) as [number, number, number];
};

/** Scale a measured size so its height is the entry's real height, when one is given. */
function realSize(id: string, size: [number, number, number]): [number, number, number] {
  const real = REAL_HEIGHT_M[id];
  if (!real) return size;
  const k = (real * 1000) / size[1];
  return size.map((v) => Math.max(1, Math.round(v * k))) as [number, number, number];
}

// ── Sources ───────────────────────────────────────────────────────────────────────────────

async function thing(
  src: ThingSource,
): Promise<{ bytes: Uint8Array; source: string; author: string; style: "photoreal" | "lowpoly" }> {
  if (src.from === "polyhaven") {
    const files = await getJson(`https://api.polyhaven.com/files/${src.ph}`);
    const entry = files.gltf?.["1k"]?.gltf;
    if (!entry?.url) throw new Error(`no 1k glTF for ${src.ph}`);
    const include = (entry.include ?? {}) as Record<string, { url?: string; md5?: string }>;
    const gltf = (await getJson(entry.url)) as Gltf;
    // Every file the glTF names is listed, with its real URL and checksum, in `include`.
    const bytes = await packGltf(gltf, async (uri) => {
      const file = include[decodeURIComponent(uri)];
      if (!file?.url) throw new Error(`${src.ph}: ${uri} is not listed`);
      const data = await get(file.url);
      if (file.md5 && createHash("md5").update(data).digest("hex") !== file.md5) {
        throw new Error(`${src.ph}: ${uri} failed its checksum`);
      }
      return data;
    });
    return {
      bytes,
      source: `https://polyhaven.com/a/${src.ph}`,
      author: "Poly Haven",
      style: "photoreal",
    };
  }
  if (src.from === "kaykit") {
    const folder = join(kaykitDir, KAYKIT.base);
    const gltf = JSON.parse(readFileSync(join(folder, `${src.name}.gltf`), "utf8")) as Gltf;
    const bytes = await packGltf(gltf, async (uri) => readLocal(folder, uri));
    return {
      bytes,
      source: "https://kaylousberg.itch.io/city-builder-bits",
      author: "Kay Lousberg",
      style: "lowpoly",
    };
  }
  const bytes = readLocal(join(quaterniusDir, QUATERNIUS.base), `${src.path}.glb`);
  return { bytes, source: "https://quaternius.com", author: "Quaternius", style: "lowpoly" };
}

/** Read a file inside a checked-out folder; refuses anything that would leave it. */
function readLocal(folder: string, relative: string): Uint8Array {
  if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split("/").includes("..")) {
    throw new Error(`refusing path ${relative}`);
  }
  return new Uint8Array(readFileSync(join(folder, relative)));
}

const quaterniusDir = sparse(QUATERNIUS, [
  ...THINGS.filter((t) => t.from === "quaternius").map(
    (t) => `${QUATERNIUS.base}/${dirname(t.path)}`,
  ),
  ...OUTFITS.map((o) => `${QUATERNIUS.base}/${dirname(o.path)}`),
]);
const kaykitDir = sparse(KAYKIT, [KAYKIT.base]);

async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

/** Convert the animated FBX's clips to a GLB holding just the skeleton and joint rotations. */
async function animations(): Promise<Uint8Array> {
  // GLTFExporter reads blobs with FileReader, which Node lacks.
  (globalThis as Record<string, unknown>)["self"] ??= globalThis;
  (globalThis as Record<string, unknown>)["FileReader"] ??= class {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((b) => {
        this.result = b;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((b) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString("base64")}`;
        this.onloadend?.();
      });
    }
  };
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const fbx = await get(ANIMATION_FBX);
  const pin = "b3a28d7a6578e2039908b11d1516c98130f7b4f1a5553141be51349c8fc63bf3";
  if (sha256(fbx) !== pin) {
    const html = new TextDecoder().decode(fbx.subarray(0, 64)).includes("<!DOCTYPE html");
    throw new Error(
      html ? "the source sent a web page, not the file" : "the animation source changed upstream",
    );
  }
  const warn = console.warn;
  console.warn = () => undefined;
  const group = new FBXLoader().parse(fbx.slice().buffer, "");
  console.warn = warn;
  const wanted = new Set(Object.values(ANIMATION_CLIPS));
  const clips = group.animations
    .filter((c) => wanted.has(c.name))
    .map((c) => {
      // Joint rotations only: they retarget onto any outfit on the same skeleton.
      c.tracks = c.tracks.filter((t) => t.name.endsWith(".quaternion"));
      return c;
    });
  const meshes: THREE.Object3D[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o);
  });
  for (const m of meshes) m.parent?.remove(m);
  const out = await new GLTFExporter().parseAsync(group, { binary: true, animations: clips });
  return new Uint8Array(out as ArrayBuffer);
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

const catalog: LibraryCatalog = {
  format: "aye.library",
  version: 1,
  things: [],
  outfits: [],
  surfaces: [],
  animations: null,
};
const failed: string[] = [];

await pool(THINGS, 6, async (src) => {
  try {
    const { bytes, source, author, style } = await thing(src);
    const file = `things/${src.id}.glb`;
    const small = await shrinkGlb(bytes);
    const sha = save(file, small);
    catalog.things.push({
      id: src.id,
      category: "thing",
      label: src.label,
      tags: src.tags,
      file,
      sha256: sha,
      sizeMm: realSize(src.id, sizeMm(measure(readGlbJson(bytes)))),
      style,
      source,
      author,
      licence: "CC0-1.0",
    });
    console.log(
      `thing   ${src.id} ${(bytes.byteLength / 1024).toFixed(0)}k → ${(small.byteLength / 1024).toFixed(0)}k`,
    );
  } catch (err) {
    failed.push(`${src.id}: ${(err as Error).message}`);
  }
});

await pool(OUTFITS, 4, async (src) => {
  try {
    const bytes = readLocal(join(quaterniusDir, QUATERNIUS.base), `${src.path}.glb`);
    const file = `outfits/${src.id}.glb`;
    const sha = save(file, await shrinkGlb(bytes));
    catalog.outfits.push({
      id: src.id,
      category: "outfit",
      label: src.label,
      tags: src.tags,
      file,
      sha256: sha,
      heightMm: sizeMm(measure(readGlbJson(bytes)))[1],
      slots: src.slots,
      source: "https://quaternius.com",
      author: "Quaternius",
      licence: "CC0-1.0",
    });
    console.log(`outfit  ${src.id}`);
  } catch (err) {
    failed.push(`${src.id}: ${(err as Error).message}`);
  }
});

await pool(SURFACES, 6, async (src) => {
  try {
    const [files, info] = await Promise.all([
      getJson(`https://api.polyhaven.com/files/${src.ph}`),
      getJson(`https://api.polyhaven.com/info/${src.ph}`),
    ]);
    const url = files.Diffuse?.["1k"]?.jpg?.url;
    if (!url) throw new Error(`no 1k colour map for ${src.ph}`);
    const raw = await get(url);
    // Seen up close (floors, walls): kept at 1k, re-encoded a little lighter.
    const decoded = decodeImage(raw, "image/jpeg");
    if (!decoded) throw new Error(`${src.ph}: not a JPEG`);
    const small = shrinkImage(decoded, 1024);
    const bytes = new Uint8Array(jpeg.encode({ ...small, data: Buffer.from(small.data) }, 80).data);
    const file = `surfaces/${src.id}.jpg`;
    const sha = save(file, bytes);
    const tile = Math.round(Number(info.dimensions?.[0] ?? 2000));
    catalog.surfaces.push({
      id: src.id,
      category: "surface",
      label: src.label,
      tags: src.tags,
      file,
      sha256: sha,
      tileMm: Math.max(100, Math.min(30_000, tile)),
      tintable: src.tintable,
      use: src.use,
      source: `https://polyhaven.com/a/${src.ph}`,
      author: "Poly Haven",
      licence: "CC0-1.0",
    });
    console.log(`surface ${src.id}`);
  } catch (err) {
    failed.push(`${src.id}: ${(err as Error).message}`);
  }
});

try {
  const bytes = await animations();
  const file = "outfits/animations.glb";
  catalog.animations = {
    file,
    sha256: save(file, bytes),
    clips: ANIMATION_CLIPS,
    source: "https://quaternius.com/packs/ultimatemodularcharacters.html",
    author: "Quaternius",
    licence: "CC0-1.0",
  };
  console.log(`animations ${(bytes.byteLength / 1024).toFixed(0)}k`);
} catch (err) {
  // The source (a shared drive) is sometimes unreachable; the file we already have is kept
  // as long as it is exactly the one pinned.
  const kept = previous?.animations;
  const path = kept ? join(OUT, kept.file) : null;
  if (kept && path && existsSync(path) && sha256(readFileSync(path)) === kept.sha256) {
    catalog.animations = kept;
    console.log(`animations kept (${(err as Error).message})`);
  } else {
    failed.push(`animations: ${(err as Error).message}`);
  }
}

// Stable order, so the committed catalog only changes when the library does.
catalog.things.sort((a, b) => a.id.localeCompare(b.id));
catalog.outfits.sort((a, b) => a.id.localeCompare(b.id));
catalog.surfaces.sort((a, b) => a.id.localeCompare(b.id));
const checked = LibraryCatalogSchema.parse(catalog);
const json = JSON.stringify(checked);
if (json.includes("`") || json.includes("${"))
  throw new Error("catalog text would break the module");
writeFileSync(
  CATALOG,
  `/**
 * The asset library's catalog. Generated by packages/engine/scripts/fetch-library.ts:
 * do not edit by hand. Files live under apps/web/public/library/ (fetched, not committed).
 */
import { LibraryCatalog } from "./library.ts";

export const LIBRARY_CATALOG_JSON = \`${json}\`;

export const LIBRARY_CATALOG: LibraryCatalog = LibraryCatalog.parse(JSON.parse(LIBRARY_CATALOG_JSON));
`,
);
// Formatted like the rest of the repo, so a fetch never fails `pnpm verify`.
execFileSync("pnpm", ["exec", "biome", "format", "--write", CATALOG], {
  cwd: ROOT,
  stdio: "ignore",
});
console.log(
  `\n${checked.things.length} things, ${checked.outfits.length} outfits, ${checked.surfaces.length} surfaces${checked.animations ? ", animations" : ""}`,
);
if (failed.length > 0) {
  console.error(`\nFailed:\n  ${failed.join("\n  ")}`);
  process.exitCode = 1;
}
