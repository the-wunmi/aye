/**
 * A small software renderer for looks, so the harness can show a model what it designed
 * without a browser or a GPU. Draws primitives (the same meshes the game uses) into numbered
 * tiles of a contact sheet: a three-quarter view, flat-shaded with a key light, depth-tested,
 * each item fitted to its tile. Deterministic: the same looks give the same bytes, so critiques
 * of them are memoised like any other stage.
 */
import { type Primitive, primitiveMesh } from "@aye/schema";
import { encodePng, type RgbaImage } from "./png.ts";

/** One primitive placed in an item's space (metres). */
export interface Placed {
  primitive: Primitive;
  position: [number, number, number];
  scale: [number, number, number];
  rotateDeg: [number, number, number];
  colour: string;
  /** Gives off light: drawn unshaded. */
  glow?: boolean;
}

/** Ready-made triangles in a tile's space (metres): 9 numbers per triangle, a colour each. */
export interface Triangles {
  positions: Float32Array;
  colours: string[];
}

export interface Tile {
  shapes: Placed[];
  /** Triangles drawn as they are (library models, whole neighbourhoods). */
  meshes?: Triangles[];
}

/** Default tile edge in pixels. */
const TILE_PX = 256;
const BG: [number, number, number] = [236, 232, 224];
const LIGHT = normalise([-0.45, 0.8, 0.55]);
const YAW = (-35 * Math.PI) / 180;
const PITCH = (28 * Math.PI) / 180;

function normalise(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return [(v[0] ?? 0) / l, (v[1] ?? 0) / l, (v[2] ?? 0) / l];
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [180, 170, 160];
}

/** Rotate by Euler XYZ (three.js order: R = Rx · Ry · Rz). */
function rotate(p: number[], [ax, ay, az]: number[]): [number, number, number] {
  const [rx, ry, rz] = [ax ?? 0, ay ?? 0, az ?? 0].map((d) => (d * Math.PI) / 180) as [
    number,
    number,
    number,
  ];
  let [x, y, z] = p as [number, number, number];
  // z first, then y, then x (applying Rz, Ry, Rx to the point in that order).
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}

/** World → view: turn the item a little and look down at it. */
function view([x = 0, y = 0, z = 0]: readonly number[]): [number, number, number] {
  const cx = x * Math.cos(YAW) + z * Math.sin(YAW);
  const cz = -x * Math.sin(YAW) + z * Math.cos(YAW);
  const vy = y * Math.cos(PITCH) - cz * Math.sin(PITCH);
  const vz = y * Math.sin(PITCH) + cz * Math.cos(PITCH);
  return [cx, vy, vz];
}

interface Tri {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  colour: [number, number, number];
  glow: boolean;
}

/** Primitive shapes as plain triangles, for placing into a bigger picture. */
export function shapeTriangles(shapes: readonly Placed[]): Triangles {
  const tris = triangles({ shapes: [...shapes] });
  const positions = new Float32Array(tris.length * 9);
  const colours: string[] = [];
  tris.forEach((t, i) => {
    positions.set([...t.a, ...t.b, ...t.c], i * 9);
    colours.push(`#${t.colour.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`);
  });
  return { positions, colours };
}

function triangles(tile: Tile): Tri[] {
  const out: Tri[] = [];
  for (const m of tile.meshes ?? []) {
    for (let i = 0; i + 8 < m.positions.length; i += 9) {
      const p = m.positions;
      out.push({
        a: [p[i] as number, p[i + 1] as number, p[i + 2] as number],
        b: [p[i + 3] as number, p[i + 4] as number, p[i + 5] as number],
        c: [p[i + 6] as number, p[i + 7] as number, p[i + 8] as number],
        colour: rgb(m.colours[i / 9] ?? "#bbbbbb"),
        glow: false,
      });
    }
  }
  for (const s of tile.shapes) {
    const mesh = primitiveMesh(s.primitive, 0.5);
    const colour = rgb(s.colour);
    const pts: [number, number, number][] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const local = [
        (mesh.positions[i] ?? 0) * s.scale[0],
        (mesh.positions[i + 1] ?? 0) * s.scale[1],
        (mesh.positions[i + 2] ?? 0) * s.scale[2],
      ];
      const r = rotate(local, s.rotateDeg);
      pts.push([r[0] + s.position[0], r[1] + s.position[1], r[2] + s.position[2]]);
    }
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = pts[mesh.indices[i] as number];
      const b = pts[mesh.indices[i + 1] as number];
      const c = pts[mesh.indices[i + 2] as number];
      if (a && b && c) out.push({ a, b, c, colour, glow: s.glow === true });
    }
  }
  return out;
}

/** Lambert shading of a triangle, facing whichever way sees the camera. */
function shade(t: Tri): [number, number, number] {
  if (t.glow) return t.colour;
  const [u0, u1, u2] = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
  const [v0, v1, v2] = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
  let n = normalise([u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0]);
  // Toward the camera (view direction is +z after `view`, camera looks from +z).
  const vn = view(n);
  if (vn[2] < 0) n = [-n[0], -n[1], -n[2]];
  const lit = 0.5 + 0.5 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  return [t.colour[0] * lit, t.colour[1] * lit, t.colour[2] * lit];
}

/** 3×5 digits, for tile numbers. */
const DIGITS = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001010010010",
  "111101111101111",
  "111101111001111",
];

function number(img: RgbaImage, x0: number, y0: number, n: number): void {
  const text = String(n);
  const px = 4;
  const w = text.length * 4 * px + px;
  for (let y = y0; y < y0 + 7 * px; y++) {
    for (let x = x0; x < x0 + w; x++) put(img, x, y, [30, 30, 30]);
  }
  [...text].forEach((ch, k) => {
    const glyph = DIGITS[Number(ch)] ?? "";
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (glyph[r * 3 + c] !== "1") continue;
        for (let dy = 0; dy < px; dy++) {
          for (let dx = 0; dx < px; dx++) {
            put(img, x0 + px + (k * 4 + c) * px + dx, y0 + px + r * px + dy, [255, 255, 255]);
          }
        }
      }
    }
  });
}

function put(img: RgbaImage, x: number, y: number, c: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = 255;
}

function drawTile(
  img: RgbaImage,
  depth: Float32Array,
  tx: number,
  ty: number,
  tile: Tile,
  TILE: number,
): void {
  const tris = triangles(tile).map((t) => ({ t, a: view(t.a), b: view(t.b), c: view(t.c) }));
  if (tris.length === 0) return;
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const { a, b, c } of tris) {
    for (const p of [a, b, c]) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const margin = 18;
  const scale = (TILE - margin * 2) / Math.max(maxX - minX, maxY - minY, 1e-6);
  const ox = tx + TILE / 2 - ((minX + maxX) / 2) * scale;
  const oy = ty + TILE / 2 + ((minY + maxY) / 2) * scale;
  const sx = (p: readonly number[]) => ox + (p[0] ?? 0) * scale;
  const sy = (p: readonly number[]) => oy - (p[1] ?? 0) * scale;
  for (const { t, a, b, c } of tris) {
    const colour = shade(t);
    const [ax, ay, bx, by, cx, cy] = [sx(a), sy(a), sx(b), sy(b), sx(c), sy(c)];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(tx, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(tx + TILE - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(ty, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(ty + TILE - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const i = y * img.width + x;
        if (z <= (depth[i] as number)) continue;
        depth[i] = z;
        put(img, x, y, colour);
      }
    }
  }
}

/** A contact sheet: tiles in a grid, numbered from 0 in reading order. PNG bytes. */
export async function contactSheet(
  tiles: readonly Tile[],
  columns = 4,
  TILE = TILE_PX,
): Promise<Uint8Array> {
  const cols = Math.max(1, Math.min(columns, tiles.length));
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  const img: RgbaImage = {
    width: cols * TILE,
    height: rows * TILE,
    data: new Uint8Array(cols * TILE * rows * TILE * 4),
  };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const edge = x % TILE === 0 || y % TILE === 0;
      put(img, x, y, edge ? [205, 200, 190] : BG);
    }
  }
  const depth = new Float32Array(img.width * img.height).fill(-Infinity);
  tiles.forEach((tile, i) => {
    const tx = (i % cols) * TILE;
    const ty = Math.floor(i / cols) * TILE;
    drawTile(img, depth, tx, ty, tile, TILE);
    number(img, tx + 6, ty + 6, i);
  });
  return encodePng(img);
}
