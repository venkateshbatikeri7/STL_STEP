/**
 * Shared mesh types and helpers.
 *
 * A mesh is stored as a flat `Float32Array` of XYZ triples. That is the same
 * layout Three.js wants for a `position` attribute, so the preview and the
 * conversion pipeline can share one buffer without copying.
 */

export type Vec3 = [number, number, number];

export type StlFormat = "binary" | "ascii";

export interface BBox {
  min: Vec3;
  max: Vec3;
  /** max - min, per axis. */
  size: Vec3;
}

export interface ParsedMesh {
  format: StlFormat;
  /** 9 floats (3 vertices × xyz) per triangle. */
  positions: Float32Array;
  triangleCount: number;
  bbox: BBox;
  /**
   * Bytes present after the last triangle of a binary STL. Non-zero means the
   * file is inconsistent with its own header, which is worth telling the user
   * about even when the readable part parsed cleanly.
   */
  trailingBytes: number;
}

export function computeBBox(positions: Float32Array): BBox {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  const mb = kb / 1024;
  const text = (mb < 10 ? mb.toFixed(2) : mb.toFixed(1)).replace(/\.0+$/, "");
  return `${text} MB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}