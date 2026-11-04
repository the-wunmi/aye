/**
 * A library model's real shape for the harness's pictures: its triangles, fitted
 * into a thing's box exactly as the game fits them (`fitInto` in the engine: turned a
 * quarter when its footprint runs the other way, scaled evenly across the floor, height kept
 * near its own proportions, standing on the floor, centred). Models see what players see,
 * so they can judge what a primitive sketch can't show: which way a bench's backrest faces.
 *
 * Bytes come from the caller (the library lives on disk for the worker); nothing here reads
 * files. Deterministic: the same bytes give the same triangles.
 */
import { type Document, WebIO } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { decodePng, type RgbaImage } from "./png.ts";

/** Triangles in metres, in the model's own frame; colour per triangle as #rrggbb. */
export interface LibraryMesh {
  positions: Float32Array;
  colours: string[];
  min: [number, number, number];
  max: [number, number, number];
}

/** Triangles placed in a thing's frame (metres): x across, y up, z its front. */
export interface FittedMesh {
  positions: Float32Array;
  colours: string[];
}

const hex = (c: readonly number[]) =>
  `#${c
    .slice(0, 3)
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

function mul(m: readonly number[], p: readonly number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0] = p;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/** At most this many triangles per model: plenty for a contact-sheet tile. */
const MAX_TRIANGLES = 20_000;
/** Bigger than any model's picture we'd make or take. */
const MAX_PICTURE_SIDE = 4096;

/**
 * Read a library GLB into triangles. Null if it holds none. `textured` colours each triangle from
 * its material's picture where that's a PNG: what's on a model is all a judge can tell it by, when
 * the model is meant to look like something real.
 */
export async function readLibraryMesh(
  bytes: Uint8Array,
  options: { textured?: boolean; maxTriangles?: number } = {},
): Promise<LibraryMesh | null> {
  const limit = options.maxTriangles ?? MAX_TRIANGLES;
  await MeshoptDecoder.ready;
  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const doc: Document = await io.readBinary(bytes);
  const out: number[] = [];
  const colours: string[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // triangles only
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const colour = hex(prim.getMaterial()?.getBaseColorFactor() ?? [0.75, 0.75, 0.75, 1]);
      const uv = options.textured ? prim.getAttribute("TEXCOORD_0") : null;
      const picture = uv
        ? await pictureOf(prim.getMaterial()?.getBaseColorTexture()?.getImage())
        : null;
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const el: number[] = [];
      const at: number[] = [];
      for (let i = 0; i + 2 < count && colours.length < limit; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = idx ? idx.getScalar(i + k) : i + k;
          pos.getElement(v, el);
          const p = mul(m, el);
          out.push(p[0], p[1], p[2]);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a] as number, p[a] as number);
            max[a] = Math.max(max[a] as number, p[a] as number);
          }
        }
        if (uv && picture) {
          // The middle of the triangle's patch of the picture.
          let u = 0;
          let w = 0;
          for (let k = 0; k < 3; k++) {
            uv.getElement(idx ? idx.getScalar(i + k) : i + k, at);
            u += (at[0] ?? 0) / 3;
            w += (at[1] ?? 0) / 3;
          }
          const px = Math.min(picture.width - 1, Math.max(0, Math.floor(u * picture.width)));
          const py = Math.min(picture.height - 1, Math.max(0, Math.floor(w * picture.height)));
          const o = (py * picture.width + px) * 4;
          colours.push(
            `#${[picture.data[o], picture.data[o + 1], picture.data[o + 2]]
              .map((v) => (v ?? 0).toString(16).padStart(2, "0"))
              .join("")}`,
          );
        } else {
          colours.push(colour);
        }
      }
    }
  }
  if (colours.length === 0) return null;
  return { positions: Float32Array.from(out), colours, min, max };
}

/** A PNG's pixels, or null for anything else: a picture's colours are a nicety. */
async function pictureOf(image: Uint8Array | null | undefined): Promise<RgbaImage | null> {
  if (!image) return null;
  try {
    return await decodePng(image, MAX_PICTURE_SIDE);
  } catch {
    return null;
  }
}

/** Fit a model into a box w × h × d (metres), as the game does. */
export function fitMesh(mesh: LibraryMesh, w: number, h: number, d: number): FittedMesh {
  const sx = mesh.max[0] - mesh.min[0];
  const sy = mesh.max[1] - mesh.min[1];
  const sz = mesh.max[2] - mesh.min[2];
  if (sx <= 0 || sy <= 0 || sz <= 0) return { positions: new Float32Array(0), colours: [] };
  const turn = (w > d * 1.25 && sz > sx * 1.25) || (d > w * 1.25 && sx > sz * 1.25);
  const ax = turn ? sz : sx;
  const az = turn ? sx : sz;
  const floor = Math.min(w / ax, d / az);
  const up = Math.min(Math.max(h / sy, floor * 0.7), floor * 1.4);
  const cx = (mesh.min[0] + mesh.max[0]) / 2;
  const cz = (mesh.min[2] + mesh.max[2]) / 2;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] as number) - cx;
    const y = (mesh.positions[i + 1] as number) - mesh.min[1];
    const z = (mesh.positions[i + 2] as number) - cz;
    // A quarter turn about y (as three.js turns it): (x, z) → (z, −x).
    const [tx, tz] = turn ? [z, -x] : [x, z];
    positions[i] = tx * floor;
    positions[i + 1] = y * up;
    positions[i + 2] = tz * floor;
  }
  return { positions, colours: mesh.colours };
}
