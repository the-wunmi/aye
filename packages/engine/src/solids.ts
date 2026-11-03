/**
 * Drawing looks: the primitives models build everything from (the same meshes the pipeline's
 * critic sees), as three.js geometry. Static looks are merged into one vertex-coloured
 * geometry per batch, so a whole city's buildings, or every copy of a tree, is one draw call.
 */
import { type Primitive, primitiveMesh } from "@aye/schema";
import * as THREE from "three/webgpu";

const unit = new Map<string, THREE.BufferGeometry>();

/** The unit geometry of a primitive (shared; never dispose). */
export function primitiveGeometry(p: Primitive, detail = 1): THREE.BufferGeometry {
  const key = `${p}/${detail}`;
  let g = unit.get(key);
  if (!g) {
    const m = primitiveMesh(p, detail);
    g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
    g.setIndex(m.indices);
    g.computeVertexNormals();
    unit.set(key, g);
  }
  return g;
}

export interface PlacedSolid {
  primitive: Primitive;
  position: [number, number, number];
  scale: [number, number, number];
  rotateDeg: [number, number, number];
  colour: string;
  /** Gives off light: drawn unlit. */
  glow?: boolean;
}

const deg = THREE.MathUtils.degToRad;

/** One geometry of many solids, each in its own colour (vertex colours). */
export function mergeSolids(solids: readonly PlacedSolid[], detail = 1): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (const s of solids) {
    const g = primitiveGeometry(s.primitive, detail);
    matrix.compose(
      new THREE.Vector3(...s.position),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(deg(s.rotateDeg[0]), deg(s.rotateDeg[1]), deg(s.rotateDeg[2])),
      ),
      new THREE.Vector3(...s.scale.map((x) => Math.max(1e-4, x))),
    );
    normalMatrix.getNormalMatrix(matrix);
    c.set(s.colour);
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      positions.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      normals.push(v.x, v.y, v.z);
      colours.push(c.r, c.g, c.b);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  out.setIndex(indices);
  return out;
}

/** Solids sized in permille of a box (w, h, d metres), as in every spec's looks. */
export function placeSolids(
  solids: readonly {
    shape: Primitive;
    centre: readonly [number, number, number];
    size: readonly [number, number, number];
    rotateDeg: readonly [number, number, number];
    colour: string;
    glow?: boolean;
  }[],
  w: number,
  h: number,
  d: number,
): PlacedSolid[] {
  return solids.map((s) => ({
    primitive: s.shape,
    position: [(s.centre[0] / 1000) * w, (s.centre[1] / 1000) * h, (s.centre[2] / 1000) * d],
    scale: [(s.size[0] / 1000) * w, (s.size[1] / 1000) * h, (s.size[2] / 1000) * d],
    rotateDeg: [s.rotateDeg[0], s.rotateDeg[1], s.rotateDeg[2]],
    colour: s.colour,
    glow: s.glow === true,
  }));
}

/** Unlit, vertex-coloured: for things that give off light. */
export function glowing(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
}

/** A material that takes its colours from the geometry. */
export function vertexColoured(roughness = 0.8): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness,
    side: THREE.DoubleSide,
  });
}
