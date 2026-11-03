/**
 * The primitives looks are built from, as triangle meshes in plain numbers: shared by the
 * browser renderer and the pipeline's rasteriser, so what a model is shown when its looks are
 * critiqued is exactly what players see.
 *
 * Each primitive fills a unit box (x, y, z in -0.5..0.5) before scaling. Faces that meet at a
 * hard edge (box sides, cylinder caps) have their own vertices, so smooth normals computed
 * from the indexed mesh still shade them flat.
 */
import type { Primitive } from "./world-spec.ts";

export interface Mesh {
  positions: number[];
  indices: number[];
}

function quad(m: Mesh, a: number[], b: number[], c: number[], d: number[]): void {
  const base = m.positions.length / 3;
  m.positions.push(...a, ...b, ...c, ...d);
  m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function tri(m: Mesh, a: number[], b: number[], c: number[]): void {
  const base = m.positions.length / 3;
  m.positions.push(...a, ...b, ...c);
  m.indices.push(base, base + 1, base + 2);
}

/** A latitude/longitude grid through `point(u, v)`, u around, v from top (0) to bottom (1). */
function grid(
  m: Mesh,
  cols: number,
  rows: number,
  point: (u: number, v: number) => number[],
): void {
  const base = m.positions.length / 3;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) m.positions.push(...point(c / cols, r / rows));
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = base + r * (cols + 1) + c;
      const b = a + cols + 1;
      m.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** A flat disc at height y, facing up (or down). */
function disc(m: Mesh, y: number, radius: number, segments: number, up: boolean): void {
  const centre = m.positions.length / 3;
  m.positions.push(0, y, 0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    m.positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
  }
  for (let i = 0; i < segments; i++) {
    const a = centre + 1 + i;
    if (up) m.indices.push(centre, a + 1, a);
    else m.indices.push(centre, a, a + 1);
  }
}

const TAU = Math.PI * 2;
const ring = (u: number, r: number, y: number) => [Math.cos(u * TAU) * r, y, Math.sin(u * TAU) * r];

const cache = new Map<string, Mesh>();

/** The unit mesh of a primitive. `detail` scales the segment counts (1 = normal). */
export function primitiveMesh(primitive: Primitive, detail = 1): Mesh {
  const key = `${primitive}/${detail}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const n = Math.max(6, Math.round(24 * detail));
  const m: Mesh = { positions: [], indices: [] };
  const h = 0.5;
  switch (primitive) {
    case "box":
      quad(m, [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]);
      quad(m, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]);
      quad(m, [h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]);
      quad(m, [-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]);
      quad(m, [-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]);
      quad(m, [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]);
      break;
    case "rounded_box": {
      // A superellipsoid: square-ish with softly rounded edges and corners.
      const e = 0.22;
      const sp = (x: number) => Math.sign(x) * Math.abs(x) ** e;
      grid(m, n, Math.round(n * 0.75), (u, v) => {
        const theta = v * Math.PI;
        const phi = u * TAU;
        return [
          h * sp(Math.sin(theta)) * sp(Math.cos(phi)),
          h * sp(Math.cos(theta)),
          h * sp(Math.sin(theta)) * sp(Math.sin(phi)),
        ];
      });
      break;
    }
    case "sphere":
      grid(m, n, Math.round(n * 0.66), (u, v) => {
        const theta = v * Math.PI;
        return ring(u, Math.sin(theta) * h, Math.cos(theta) * h);
      });
      break;
    case "hemisphere":
      grid(m, n, Math.round(n * 0.33), (u, v) => {
        const theta = v * (Math.PI / 2);
        return ring(u, Math.sin(theta) * h, Math.cos(theta) - h);
      });
      disc(m, -h, h, n, false);
      break;
    case "cylinder":
      grid(m, n, 1, (u, v) => ring(u, h, h - v));
      disc(m, h, h, n, true);
      disc(m, -h, h, n, false);
      break;
    case "cone":
      grid(m, n, 1, (u, v) => ring(u, v * h, h - v));
      disc(m, -h, h, n, false);
      break;
    case "capsule":
      grid(m, n, Math.round(n * 0.66), (u, v) => {
        const theta = v * Math.PI;
        const c = Math.cos(theta);
        return ring(u, Math.sin(theta) * h, c * 0.25 + Math.sign(c) * 0.25);
      });
      break;
    case "torus":
      grid(m, n, Math.round(n / 2), (u, v) => {
        const a = v * TAU;
        const r = 0.35 + Math.cos(a) * 0.15;
        return ring(u, r, Math.sin(a) * 0.15);
      });
      break;
    case "wedge":
      // A gable: flat base, two slopes meeting in a ridge along x at the top.
      quad(m, [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]);
      quad(m, [-h, -h, h], [h, -h, h], [h, h, 0], [-h, h, 0]);
      quad(m, [h, -h, -h], [-h, -h, -h], [-h, h, 0], [h, h, 0]);
      tri(m, [h, -h, h], [h, -h, -h], [h, h, 0]);
      tri(m, [-h, -h, -h], [-h, -h, h], [-h, h, 0]);
      break;
  }
  cache.set(key, m);
  return m;
}
