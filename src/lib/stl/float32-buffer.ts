/**
 * A tiny growable Float32Array.
 *
 * The ASCII parser does not know the triangle count up front, and pushing into
 * a plain `number[]` costs far more memory once you are past a few hundred
 * thousand triangles.
 */
export class Float32Buffer {
  #data: Float32Array;
  #length = 0;

  constructor(initialCapacity = 4096) {
    this.#data = new Float32Array(initialCapacity);
  }

  get length(): number {
    return this.#length;
  }

  /** Push 9 values (one triangle) at once. */
  push9(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
  ): void {
    this.#ensure(this.#length + 9);
    const target = this.#data;
    let p = this.#length;
    target[p++] = a;
    target[p++] = b;
    target[p++] = c;
    target[p++] = d;
    target[p++] = e;
    target[p++] = f;
    target[p++] = g;
    target[p++] = h;
    target[p++] = i;
    this.#length = p;
  }

  /** Returns an exactly-sized copy. */
  toFloat32Array(): Float32Array {
    return this.#data.slice(0, this.#length);
  }

  #ensure(required: number): void {
    const capacity = this.#data.length;
    if (required <= capacity) return;
    let next = capacity * 2;
    while (next < required) next *= 2;
    const grown = new Float32Array(next);
    grown.set(this.#data.subarray(0, this.#length));
    this.#data = grown;
  }
}