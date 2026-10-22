import { describe, expect, it } from "vitest";

import { weld } from "./weld";

/** Lay out `points` (9 floats per triangle) for the welder. */
const tris = (...points: number[][]): Float32Array => {
  const flat: number[] = [];
  for (const triangle of points) flat.push(...triangle);
  return new Float32Array(flat);
};

/** A unit square as two triangles: 6 corners, but only 4 distinct points. */
const SQUARE = tris(
  [0, 0, 0, 1, 0, 0, 1, 1, 0],
  [0, 0, 0, 1, 1, 0, 0, 1, 0],
);

describe("weld", () => {
  it("merges duplicated corners", () => {
    const result = weld(SQUARE, { tolerance: 1e-6 });
    expect(result.uniqueVertexCount).toBe(4);
    expect(result.degenerateCount).toBe(0);
    expect(result.indices.length).toBe(6);
  });

  it("shares vertices between triangles that share a corner", () => {
    const result = weld(SQUARE, { tolerance: 1e-9 });
    // Still 4: the square's corners really are duplicated in the source.
    expect(result.uniqueVertexCount).toBe(4);
    // Triangle 0 = (0,0,0) (1,0,0) (1,1,0); triangle 1 = (0,0,0) (1,1,0) (0,1,0).
    // Both name the origin, and both name the far end of the shared diagonal.
    expect(result.indices[0]).toBe(result.indices[3]);
    expect(result.indices[2]).toBe(result.indices[4]);
    expect(result.indices[3]).not.toBe(result.indices[4]);
  });

  it("merges points that fall either side of a grid cell boundary", () => {
    // 0.1 is exactly on the cell edge for a 0.1 grid; the naive
    // "round to the nearest cell" approach would keep these two apart.
    const points = tris([0.1, 0, 0, 0.1 + 1e-7, 0, 0, 0.1, 1, 0]);
    const result = weld(points, { tolerance: 1e-5 });
    expect(result.uniqueVertexCount).toBe(2);
  });

  it("respects the tolerance", () => {
    const points = tris([0, 0, 0, 0.001, 0, 0, 0, 1, 0]);

    expect(weld(points, { tolerance: 1e-6 }).uniqueVertexCount).toBe(3);
    expect(weld(points, { tolerance: 0.01 }).uniqueVertexCount).toBe(2);
  });

  it("is idempotent: welding welded data changes nothing", () => {
    const once = weld(SQUARE, { tolerance: 1e-4 });

    // Rebuild triangles from the welded unique positions.
    const rebuilt = new Float32Array(once.indices.length * 3);
    once.indices.forEach((vertexIndex, slot) => {
      rebuilt[slot * 3] = once.positions[vertexIndex * 3]!;
      rebuilt[slot * 3 + 1] = once.positions[vertexIndex * 3 + 1]!;
      rebuilt[slot * 3 + 2] = once.positions[vertexIndex * 3 + 2]!;
    });

    const again = weld(rebuilt, { tolerance: 1e-4 });
    expect(again.uniqueVertexCount).toBe(4);
    expect(again.degenerateCount).toBe(0);
    expect(Array.from(again.indices)).toEqual(Array.from(once.indices));
  });

  it("counts triangles that collapse to zero area", () => {
    // Two of the three corners sit on the same point.
    const points = tris(
      [0, 0, 0, 0, 0, 0, 1, 1, 0],
      [0, 0, 0, 1, 0, 0, 1, 1, 0],
    );
    const result = weld(points, { tolerance: 1e-6 });
    expect(result.degenerateCount).toBe(1);
    expect(result.uniqueVertexCount).toBe(3);
  });

  it("handles an empty mesh", () => {
    const result = weld(new Float32Array(0), { tolerance: 1e-4 });
    expect(result.uniqueVertexCount).toBe(0);
    expect(result.positions.length).toBe(0);
    expect(result.indices.length).toBe(0);
  });

  it("grows past its initial capacity", () => {
    const many = new Float32Array(5000 * 9);
    for (let i = 0; i < 5000; i++) {
      many[i * 9] = i; // every vertex unique
    }
    const result = weld(many, { tolerance: 1e-6 });
    expect(result.uniqueVertexCount).toBe(5000);
  });

  it("keeps the first-seen coordinate of a merged group", () => {
    const points = tris([1, 2, 3, 1 + 1e-7, 2, 3, 1, 2, 4]);
    const result = weld(points, { tolerance: 1e-5 });
    expect(result.uniqueVertexCount).toBe(2);
    expect(Array.from(result.positions.slice(0, 3))).toEqual([1, 2, 3]);
  });

  it("reports progress and finishes at 100%", () => {
    const seen: Array<[number, number]> = [];
    weld(SQUARE, {
      tolerance: 1e-6,
      progressEvery: 3,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual([SQUARE.length, SQUARE.length]);
    expect(seen.every(([done]) => done % 3 === 0)).toBe(true);
  });
});