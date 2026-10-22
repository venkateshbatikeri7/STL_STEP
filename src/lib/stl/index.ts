import type { ParsedMesh } from "../mesh";
import { BINARY_PREAMBLE_BYTES, BINARY_TRIANGLE_BYTES, detectFormat } from "./detect";
import { parseBinaryStl } from "./parse-binary";
import { decodeAscii, parseAsciiStl } from "./parse-ascii";

export { weld } from "./weld";
export type { WeldOptions, WeldResult } from "./weld";
export { StlParseError, describeStlError } from "./errors";
export type { StlErrorCode } from "./errors";
export { detectFormat } from "./detect";

/**
 * Parse an STL of either flavour.
 *
 * Format detection is length-based rather than keyword-based, because a large
 * share of binary STLs in the wild start with the ASCII word `solid` in their
 * 80-byte header.
 */
export function parseStl(buffer: ArrayBuffer): ParsedMesh {
  const detection = detectFormat(buffer);

  if (detection.format === "ascii") {
    return parseAsciiStl(decodeAscii(buffer));
  }

  const expected =
    BINARY_PREAMBLE_BYTES + detection.triangleCount * BINARY_TRIANGLE_BYTES;
  return parseBinaryStl(buffer, Math.max(buffer.byteLength - expected, 0));
}