/**
 * Grid search: A* to a goal set, plus flood fill. Integer costs (cell / diagonal mm),
 * deterministic tie-breaking (lower f, then lower h, then lower cell index), no corner
 * cutting, and scratch buffers reused across queries to keep the GC quiet.
 */
import { Block, cellIndex, edgeClearance, type Mover, moveCheck, type NavGrid } from "./navgrid.ts";

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** Visit each neighbour `b` of `a` that `mover` can step into, with its move cost. */
export function forEachMove(
  grid: NavGrid,
  a: number,
  mover: Mover,
  visit: (b: number, cost: number) => void,
): void {
  const ax = a % grid.width;
  const az = (a - ax) / grid.width;
  for (const [dx, dz] of NEIGHBOURS) {
    const bx = ax + dx;
    const bz = az + dz;
    if (bx < 0 || bz < 0 || bx >= grid.width || bz >= grid.height) continue;
    const b = cellIndex(grid, bx, bz);
    const diagonal = dx !== 0 && dz !== 0;
    if (moveCheck(grid, a, b, diagonal, mover) !== Block.None) continue;
    if (diagonal) {
      // No squeezing between two obstacles that only touch at a corner.
      if (moveCheck(grid, a, cellIndex(grid, ax + dx, az), false, mover) !== Block.None) continue;
      if (moveCheck(grid, a, cellIndex(grid, ax, az + dz), false, mover) !== Block.None) continue;
    }
    visit(b, diagonal ? grid.diagMm : grid.cellMm);
  }
}

/** Min-heap of cell indices keyed by (f, h, index). */
class Heap {
  #items: number[] = [];
  #f: Float64Array;
  #h: Float64Array;

  constructor(f: Float64Array, h: Float64Array) {
    this.#f = f;
    this.#h = h;
  }

  get size(): number {
    return this.#items.length;
  }

  clear(): void {
    this.#items.length = 0;
  }

  #less(a: number, b: number): boolean {
    const fa = this.#f[a] as number;
    const fb = this.#f[b] as number;
    if (fa !== fb) return fa < fb;
    const ha = this.#h[a] as number;
    const hb = this.#h[b] as number;
    if (ha !== hb) return ha < hb;
    return a < b;
  }

  push(i: number): void {
    const items = this.#items;
    items.push(i);
    let k = items.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.#less(items[k] as number, items[p] as number)) break;
      [items[k], items[p]] = [items[p] as number, items[k] as number];
      k = p;
    }
  }

  pop(): number {
    const items = this.#items;
    const top = items[0] as number;
    const last = items.pop() as number;
    if (items.length > 0) {
      items[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < items.length && this.#less(items[l] as number, items[m] as number)) m = l;
        if (r < items.length && this.#less(items[r] as number, items[m] as number)) m = r;
        if (m === k) break;
        [items[k], items[m]] = [items[m] as number, items[k] as number];
        k = m;
      }
    }
    return top;
  }
}

/** Reusable search state for one grid. Not thread-safe; create one per worker. */
export class PathFinder {
  readonly grid: NavGrid;
  readonly #g: Float64Array;
  readonly #f: Float64Array;
  readonly #h: Float64Array;
  readonly #parent: Int32Array;
  readonly #stamp: Uint32Array;
  readonly #closed: Uint32Array;
  readonly #heap: Heap;
  #generation = 0;

  constructor(grid: NavGrid) {
    const n = grid.width * grid.height;
    this.grid = grid;
    this.#g = new Float64Array(n);
    this.#f = new Float64Array(n);
    this.#h = new Float64Array(n);
    this.#parent = new Int32Array(n);
    this.#stamp = new Uint32Array(n);
    this.#closed = new Uint32Array(n);
    this.#heap = new Heap(this.#f, this.#h);
  }

  #octile(a: number, b: number): number {
    const w = this.grid.width;
    const dx = Math.abs((a % w) - (b % w));
    const dz = Math.abs(Math.floor(a / w) - Math.floor(b / w));
    const lo = Math.min(dx, dz);
    return (Math.max(dx, dz) - lo) * this.grid.cellMm + lo * this.grid.diagMm;
  }

  /**
   * Shortest path from `start` to any cell in `goals` (sorted cell list). `aim` steers the
   * heuristic toward the goal set; it is inadmissible for scattered goals, which trades
   * optimality for speed — fine for agents, never used for measurements.
   * Returns cells from start (exclusive) to goal (inclusive), or null if unreachable.
   */
  find(
    start: number,
    goals: ReadonlySet<number>,
    aim: number,
    mover: Mover,
    maxExpanded = 200_000,
  ): number[] | null {
    if (goals.has(start)) return [];
    const gen = ++this.#generation;
    const heap = this.#heap;
    heap.clear();
    this.#stamp[start] = gen;
    this.#g[start] = 0;
    this.#h[start] = this.#octile(start, aim);
    this.#f[start] = this.#h[start] as number;
    this.#parent[start] = -1;
    heap.push(start);
    let expanded = 0;
    while (heap.size > 0 && expanded++ < maxExpanded) {
      const a = heap.pop();
      if (this.#closed[a] === gen) continue;
      this.#closed[a] = gen;
      if (goals.has(a)) return this.#unwind(a);
      const ga = this.#g[a] as number;
      forEachMove(this.grid, a, mover, (b, cost) => {
        if (this.#closed[b] === gen) return;
        const g = ga + cost;
        if (this.#stamp[b] === gen && g >= (this.#g[b] as number)) return;
        this.#stamp[b] = gen;
        this.#g[b] = g;
        this.#h[b] = this.#octile(b, aim);
        this.#f[b] = g + (this.#h[b] as number);
        this.#parent[b] = a;
        heap.push(b);
      });
    }
    return null;
  }

  #unwind(goal: number): number[] {
    const path: number[] = [];
    for (let c = goal; this.#parent[c] !== -1; c = this.#parent[c] as number) path.push(c);
    return path.reverse();
  }
}

/** Every cell `mover` can reach from `starts`. Returns a 0/1 mask. */
export function floodFill(grid: NavGrid, starts: readonly number[], mover: Mover): Uint8Array {
  const seen = new Uint8Array(grid.width * grid.height);
  const queue = new Int32Array(grid.width * grid.height);
  let head = 0;
  let tail = 0;
  for (const s of starts) {
    if (s < 0 || seen[s]) continue;
    seen[s] = 1;
    queue[tail++] = s;
  }
  while (head < tail) {
    const a = queue[head++] as number;
    forEachMove(grid, a, mover, (b) => {
      if (seen[b]) return;
      seen[b] = 1;
      queue[tail++] = b;
    });
  }
  return seen;
}

/**
 * Connected regions for one body: cells it can stand in get a region id, others -1. Moves
 * are symmetric between cells a body fits in, so two cells share an id iff a path exists.
 * Computed once per (grid, mover) and turns "can I ever get there?" into an O(1) lookup.
 */
export function labelRegions(grid: NavGrid, mover: Mover): Int32Array {
  const n = grid.width * grid.height;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || !fits(grid, s, mover)) continue;
    let head = 0;
    let tail = 0;
    label[s] = next;
    queue[tail++] = s;
    while (head < tail) {
      forEachMove(grid, queue[head++] as number, mover, (b) => {
        if (label[b] !== -1) return;
        label[b] = next;
        queue[tail++] = b;
      });
    }
    next++;
  }
  return label;
}

function fits(grid: NavGrid, i: number, mover: Mover): boolean {
  return !((grid.flags[i] as number) & 1) && edgeClearance(grid, i) * 2 >= mover.clearWidthMm;
}
