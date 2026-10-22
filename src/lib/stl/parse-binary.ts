import { computeBBox, type ParsedMesh } from "../mesh";
import { BINARY_HEADER_BYTES, BINARY_PREAMBLE_BYTES, BINARY_TRIANGLE_BYTES } from "./detect";
import { StlParseError } from "./errors";

/**
 * Read a binary STL.
 *
 * Layout: 80-byte header, uint32 triangle count, then 50 bytes per triangle
 * (12 bytes normal, 36 bytes vertices, 2 bytes attribute byte count).
 *
 * Vertex normals are ignored: the STEP output is built from positions only, and
 * the preview recomputes what it needs.
 */
export function parseBinaryStl(
  buffer: ArrayBuffer,
  trailingBytes = 0,
): ParsedMesh {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(BINARY_HEADER_BYTES, true);

  const positions = new Float32Array(triangleCount * 9);

  for (let t = 0; t < triangleCount; t++) {
    const base = BINARY_PREAMBLE_BYTES + t * BINARY_TRIANGLE_BYTES;
    const out = t * 9;

    // +0 .. +11 is the stored facet normal, which we skip.
    positions[out + 0] = view.getFloat32(base + 12, true);
    positions[out + 1] = view.getFloat32(base + 16, true);
    positions[out + 2] = view.getFloat32(base + 20, true);
    positions[out + 3] = view.getFloat32(base + 24, true);
    positions[out + 4] = view.getFloat32(base + 28, true);
    positions[out + 5] = view.getFloat32(base + 32, true);
    positions[out + 6] = view.getFloat32(base + 36, true);
    positions[out + 7] = view.getFloat32(base + 40, true);
    positions[out + 8] = view.getFloat32(base + 44, true);
  }

  assertAllFinite(positions, "binary STL");
  if (triangleCount === 0) {
    throw new StlParseError(
      "no-facets",
      "The binary header declares 0 triangles.",
    );
  }

  return {
    format: "binary",
    positions,
    triangleCount,
    bbox: computeBBox(positions),
    trailingBytes,
  };
}

function assertAllFinite(positions: Float32Array, what: string): void {
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i]!;
    if (Number.isFinite(v)) continue;
    const triangle = Math.floor(i / 9) + 1;
    throw new StlParseError(
      "bad-number",
      `Triangle ${triangle} contains a coordinate that is not a finite number (${v}).`,
      `The ${what} is corrupted or was written by a broken exporter.`,
    );
  }
}