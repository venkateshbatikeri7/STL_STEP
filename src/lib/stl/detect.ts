import type { StlFormat } from "../mesh";
import { TRIANGLE_HARD_LIMIT } from "../limits";
import { StlParseError } from "./errors";

/** Bytes before the triangle count in a binary STL. */
export const BINARY_HEADER_BYTES = 80;
/** Bytes per triangle in a binary STL: 3 normal floats + 9 vertex floats + u16 attribute. */
export const BINARY_TRIANGLE_BYTES = 50;
/** 80-byte header + u32 triangle count. */
export const BINARY_PREAMBLE_BYTES = BINARY_HEADER_BYTES + 4;

export interface DetectionResult {
  format: StlFormat;
  /** Only meaningful for binary input. */
  triangleCount: number;
}

type BinaryFit = "exact" | "trailing" | "truncated" | "none";

function binaryFit(byteLength: number, count: number): BinaryFit {
  if (count === 0) return "none";
  const expected = BINARY_PREAMBLE_BYTES + count * BINARY_TRIANGLE_BYTES;
  if (expected === byteLength) return "exact";
  if (expected < byteLength) return "trailing";
  return "truncated";
}

/** Cheap ASCII check: does the file start with the word "solid"? */
function startsWithSolid(view: DataView, byteLength: number): boolean {
  // Some Windows exporters prefix ASCII STLs with a UTF-8 BOM. The decoder
  // strips it before parsing, so detection has to skip it too or the file
  // looks like binary noise.
  let offset = 0;
  if (
    byteLength >= 3 &&
    view.getUint8(0) === 0xef &&
    view.getUint8(1) === 0xbb &&
    view.getUint8(2) === 0xbf
  ) {
    offset = 3;
  }

  const probe = Math.min(byteLength - offset, 64);
  let ascii = "";
  for (let i = 0; i < probe; i++) ascii += String.fromCharCode(view.getUint8(offset + i));
  return ascii.trimStart().toLowerCase().startsWith("solid");
}

/**
 * Decide whether a buffer is a binary or ASCII STL.
 *
 * The classic trap is that plenty of exporters write the ASCII word `solid`
 * into the 80-byte header of a *binary* file. So we never trust the first
 * bytes on their own: a binary file is only accepted when its declared
 * triangle count lines up exactly with the file length, which is a far
 * stronger signal than a leading `solid`.
 */
export function detectFormat(buffer: ArrayBuffer): DetectionResult {
  const byteLength = buffer.byteLength;

  if (byteLength === 0) {
    throw new StlParseError(
      "empty-file",
      "The file is 0 bytes long.",
    );
  }
  if (byteLength < 15) {
    throw new StlParseError(
      "too-small",
      `The file is only ${byteLength} bytes long.`,
      `A binary STL needs at least ${BINARY_PREAMBLE_BYTES} bytes; an ASCII STL needs a "solid … endsolid" block.`,
    );
  }

  const view = new DataView(buffer);

  let count = 0;
  let fit: BinaryFit = "none";
  if (byteLength >= BINARY_PREAMBLE_BYTES) {
    count = view.getUint32(BINARY_HEADER_BYTES, true);
    fit = binaryFit(byteLength, count);
  }

  // 1. Length-consistent binary wins over everything else, including a
  //    leading "solid" in the header. Only now is the declared count
  //    trustworthy, so this is also the first point at which an over-limit
  //    count is really an over-limit STL rather than a corrupt header.
  if (fit === "exact" || fit === "trailing") {
    if (count > TRIANGLE_HARD_LIMIT) {
      throw new StlParseError(
        "too-many-triangles",
        `The binary header declares ${count.toLocaleString("en-US")} triangles, ` +
          `which is over this converter's limit of ` +
          `${TRIANGLE_HARD_LIMIT.toLocaleString("en-US")}.`,
      );
    }
    return {
      format: "binary",
      triangleCount: count,
    };
  }

  // 2. The ASCII keyword.
  if (startsWithSolid(view, byteLength)) {
    return {
      format: "ascii",
      triangleCount: -1,
    };
  }

  // 3. A binary file that lost its tail.
  if (fit === "truncated") {
    const expected = BINARY_PREAMBLE_BYTES + count * BINARY_TRIANGLE_BYTES;
    if (count <= TRIANGLE_HARD_LIMIT) {
      throw new StlParseError(
        "truncated",
        `The header declares ${count.toLocaleString("en-US")} triangles, ` +
          `which needs ${expected.toLocaleString("en-US")} bytes, but the file is only ` +
          `${byteLength.toLocaleString("en-US")} bytes.`,
        `Missing ${(expected - byteLength).toLocaleString("en-US")} bytes ` +
          `(~${Math.ceil((expected - byteLength) / BINARY_TRIANGLE_BYTES)} triangles).`,
      );
    }
  }

  throw new StlParseError(
    "not-an-stl",
    `No STL signature found in the first bytes of the ${byteLength.toLocaleString("en-US")}-byte file.`,
  );
}