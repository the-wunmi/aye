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

/** At most this many triangles per model: plenty for a 256 px tile. */
const MAX_TRIANGLES = 20_000;

/** Read a library GLB into triangles. Null if it holds none. */
export async function readLibraryMesh(bytes: Uint8Array): Promise<LibraryMesh | null> {
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
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const el: number[] = [];
      for (let i = 0; i + 2 < count && colours.length < MAX_TRIANGLES; i += 3) {
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
        colours.push(colour);
      }
    }
  }
  if (colours.length === 0) return null;
  return { positions: Float32Array.from(out), colours, min, max };
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
