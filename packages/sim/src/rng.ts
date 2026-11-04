/**
 * Seeded PRNG (SFC32, seeded via SplitMix32). Pure 32-bit integer arithmetic, so every
 * runtime produces the same sequence. The only source of randomness the simulation may use.
 */

function splitmix32(state: number): [next: number, out: number] {
  const next = (state + 0x9e3779b9) | 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return [next, (z ^ (z >>> 16)) >>> 0];
}

export type RngState = readonly [number, number, number, number];

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  private constructor([a, b, c, d]: RngState) {
    this.#a = a;
    this.#b = b;
    this.#c = c;
    this.#d = d;
  }

  /**
   * Independent streams from one seed, e.g. one per subsystem, so adding draws in one place never
   * shifts another.
   */
  static seeded(seed: number, stream = 0): Rng {
    let s = (seed ^ Math.imul(stream + 1, 0x632be5ab)) | 0;
    const words: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [next, out] = splitmix32(s);
      s = next;
      words.push(out);
    }
    const rng = new Rng(words as unknown as RngState);
    for (let i = 0; i < 12; i++) rng.nextU32();
    return rng;
  }

  static restore(state: RngState): Rng {
    return new Rng(state);
  }

  state(): RngState {
    return [this.#a, this.#b, this.#c, this.#d];
  }

  nextU32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** Integer in [0, n). n must be ≤ 2^21 so the product stays exact in a double. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 2 ** 21)
      throw new RangeError(`Rng.int: bad bound ${n}`);
    return Math.floor((this.nextU32() * n) / 2 ** 32);
  }

  /** Integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chancePermille(p: number): boolean {
    return this.int(1000) < p;
  }
}
