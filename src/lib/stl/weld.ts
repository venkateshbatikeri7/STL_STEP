/**
 * Vertex merging.
 *
 * An STL stores three independent vertices per triangle, so a cube arrives as
 * 36 vertices instead of 8. Before we can build a BRep we need to know which
 * of those vertices are really the same point in space — otherwise no two
 * faces share an edge and sewing has nothing to stitch together.
 *
 * We bucket points into a uniform grid whose cell size equals the tolerance and
 * probe the 27 neighbouring cells. That is near O(n) and, unlike naive rounding
 * to a grid, it still merges two points that sit either side of a cell
 * boundary.
 */

export interface WeldResult {
  /** 3 indices per triangle into `positions`. */
  indices: Uint32Array;
  /** Deduplicated positions, 3 floats per unique vertex. */
  positions: Float32Array;
  uniqueVertexCount: number;
  /**
   * Triangles that collapsed once vertices were merged (two or three corners
   * landed on the same point). They enclose no area and cannot become a face.
   */
  degenerateCount: number;
}

export interface WeldOptions {
  tolerance: number;
  /** Called with (sourceVertex, totalSourceVertices) while scanning. */
  onProgress?: (done: number, total: number) => void;
  /** Roughly how many source vertices to process between progress calls. */
  progressEvery?: number;
}

/** cx -> cy -> cz -> list of unique vertex indices. */
type Grid = Map<number, Map<number, Map<number, number[]>>>;

export function weld(
  positions: Float32Array,
  options: WeldOptions,
): WeldResult {
  const tolerance = Math.max(options.tolerance, 0);
  // The grid needs a non-zero cell size even when the caller asks for exact
  // matching; the distance test still uses the real tolerance.
  const cellSize = Math.max(tolerance, 1e-12);
  const toleranceSquared = tolerance * tolerance;

  const triangleCount = Math.floor(positions.length / 9);
  const indices = new Uint32Array(triangleCount * 3);

  const grid: Grid = new Map();

  let uniqueX = new Float64Array(Math.max(1024, triangleCount));
  let uniqueY = new Float64Array(uniqueX.length);
  let uniqueZ = new Float64Array(uniqueX.length);
  let uniqueCount = 0;

  const findOrInsert = (x: number, y: number, z: number): number => {
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);

    // Look in this cell first: the overwhelmingly common case is a hit, and
    // skipping the 26 neighbours saves most of the work.
    let byY = grid.get(cx);
    let byZ = byY?.get(cy);
    let bucket = byZ?.get(cz);

    if (bucket !== undefined) {
      for (let k = 0; k < bucket.length; k++) {
        const candidate = bucket[k]!;
        const dx = uniqueX[candidate]! - x;
        const dy = uniqueY[candidate]! - y;
        const dz = uniqueZ[candidate]! - z;
        if (dx * dx + dy * dy + dz * dz <= toleranceSquared) return candidate;
      }
    }

    // Otherwise sweep the 26 neighbouring cells. Two points further apart than
    // one cell cannot be within tolerance, so this is exhaustive.
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0) continue;
      const nearY = grid.get(cx + ox);
      if (nearY === undefined) continue;
      for (let oy = -1; oy <= 1; oy++) {
        const nearZ = nearY.get(cy + oy);
        if (nearZ === undefined) continue;
        for (let oz = -1; oz <= 1; oz++) {
          const near = nearZ.get(cz + oz);
          if (near === undefined) continue;
          for (let k = 0; k < near.length; k++) {
            const candidate = near[k]!;
            const dx = uniqueX[candidate]! - x;
            const dy = uniqueY[candidate]! - y;
            const dz = uniqueZ[candidate]! - z;
            if (dx * dx + dy * dy + dz * dz <= toleranceSquared) return candidate;
          }
        }
      }
    }

    const index = uniqueCount++;
    if (index === uniqueX.length) {
      const grownX = new Float64Array(uniqueX.length * 2);
      grownX.set(uniqueX);
      uniqueX = grownX;
      const grownY = new Float64Array(uniqueY.length * 2);
      grownY.set(uniqueY);
      uniqueY = grownY;
      const grownZ = new Float64Array(uniqueZ.length * 2);
      grownZ.set(uniqueZ);
      uniqueZ = grownZ;
    }
    uniqueX[index] = x;
    uniqueY[index] = y;
    uniqueZ[index] = z;

    if (byY === undefined) {
      byY = new Map();
      grid.set(cx, byY);
    }
    if (byZ === undefined) {
      byZ = new Map();
      byY.set(cy, byZ);
    }
    if (bucket === undefined) {
      bucket = [index];
      byZ.set(cz, bucket);
    } else {
      bucket.push(index);
    }
    return index;
  };

  const { onProgress } = options;
  const requested = options.progressEvery ?? 50_000;
  // The loop advances by 9 floats (one triangle), so round the interval to a
  // multiple of 9 to keep the modulo check cheap and the callbacks even.
  const progressEvery = Math.max(9, requested - (requested % 9));
  const total = positions.length;

  let degenerateCount = 0;

  // One iteration per triangle: three vertices, stride 9.
  for (let i = 0; i + 8 < total; i += 9) {
    const a = findOrInsert(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    const b = findOrInsert(positions[i + 3]!, positions[i + 4]!, positions[i + 5]!);
    const c = findOrInsert(positions[i + 6]!, positions[i + 7]!, positions[i + 8]!);

    const slot = (i / 9) * 3;
    indices[slot] = a;
    indices[slot + 1] = b;
    indices[slot + 2] = c;

    if (a === b || b === c || a === c) degenerateCount++;

    if (onProgress !== undefined && i % progressEvery === 0) {
      onProgress(i, total);
    }
  }

  onProgress?.(total, total);

  const uniquePositions = new Float32Array(uniqueCount * 3);
  for (let i = 0; i < uniqueCount; i++) {
    uniquePositions[i * 3] = uniqueX[i]!;
    uniquePositions[i * 3 + 1] = uniqueY[i]!;
    uniquePositions[i * 3 + 2] = uniqueZ[i]!;
  }

  return {
    indices,
    positions: uniquePositions,
    uniqueVertexCount: uniqueCount,
    degenerateCount,
  };
}