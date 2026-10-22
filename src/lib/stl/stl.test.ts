import { describe, expect, it } from "vitest";

import { detectFormat } from "./detect";
import { parseStl } from "./index";
import { parseBinaryStl } from "./parse-binary";
import { decodeAscii, parseAsciiStl } from "./parse-ascii";
import { StlParseError } from "./errors";

/* ------------------------------------------------------------------ helpers */

function binaryStl(triangles: number[][], headerText = "test"): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + 50 * triangles.length);
  const view = new DataView(buffer);
  for (let i = 0; i < Math.min(headerText.length, 79); i++) {
    view.setUint8(i, headerText.charCodeAt(i));
  }
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    const base = 84 + index * 50;
    for (let corner = 0; corner < 3; corner++) {
      view.setFloat32(base + 12 + corner * 12 + 0, triangle[corner * 3 + 0]!, true);
      view.setFloat32(base + 12 + corner * 12 + 4, triangle[corner * 3 + 1]!, true);
      view.setFloat32(base + 12 + corner * 12 + 8, triangle[corner * 3 + 2]!, true);
    }
  });
  return buffer;
}

const UNIT_SQUARE = [
  [0, 0, 0, 1, 0, 0, 0, 1, 0],
  [1, 0, 0, 1, 1, 0, 0, 1, 0],
];

function asciiStl(body: string, name = "shape"): ArrayBuffer {
  const text = `solid ${name}\n${body}\nendsolid ${name}\n`;
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/* -------------------------------------------------------------- detection */

describe("detectFormat", () => {
  it("rejects an empty file", () => {
    expect(() => detectFormat(new ArrayBuffer(0))).toThrowError(
      expect.objectContaining({ code: "empty-file" }),
    );
  });

  it("rejects a file that is too small to be anything", () => {
    expect(() => detectFormat(new ArrayBuffer(6))).toThrowError(
      expect.objectContaining({ code: "too-small" }),
    );
  });

  it("detects a well-formed binary STL", () => {
    const result = detectFormat(binaryStl(UNIT_SQUARE));
    expect(result.format).toBe("binary");
    expect(result.triangleCount).toBe(2);
  });

  it("prefers binary when the header starts with 'solid' but the length matches", () => {
    // This is the trap: many exporters put the ASCII word `solid` in the
    // 80-byte header of a binary file.
    const buffer = binaryStl(UNIT_SQUARE, "solid exported by some tool");
    expect(detectFormat(buffer).format).toBe("binary");
  });

  it("detects ASCII STL", () => {
    const buffer = asciiStl(
      "  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet",
    );
    expect(detectFormat(buffer).format).toBe("ascii");
  });

  it("detects ASCII STL with a UTF-8 BOM", () => {
    // Windows exporters emit these; TextDecoder strips the BOM before parsing,
    // so detection must skip it too.
    const text =
      "solid s\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid s\n";
    const body = new TextEncoder().encode(text);
    const withBom = new Uint8Array(body.length + 3);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(body, 3);

    const buffer = withBom.buffer.slice(0, withBom.byteLength);
    expect(detectFormat(buffer).format).toBe("ascii");
    expect(parseStl(buffer).triangleCount).toBe(1);
  });

  it("accepts a binary STL with trailing bytes and reports how many", () => {
    const original = binaryStl(UNIT_SQUARE);
    const padded = new Uint8Array(original.byteLength + 10);
    padded.set(new Uint8Array(original));

    const detection = detectFormat(padded.buffer);
    expect(detection.format).toBe("binary");

    const mesh = parseStl(padded.buffer);
    expect(mesh.triangleCount).toBe(2);
    expect(mesh.trailingBytes).toBe(10);
  });

  it("reports a truncated binary STL", () => {
    const buffer = binaryStl(UNIT_SQUARE);
    const truncated = buffer.slice(0, buffer.byteLength - 20);
    expect(() => detectFormat(truncated)).toThrowError(
      expect.objectContaining({ code: "truncated" }),
    );
  });

  it("rejects random bytes", () => {
    const noise = new Uint8Array(200).map((_, i) => (i * 37) % 251);
    expect(() => detectFormat(noise.buffer)).toThrowError(
      expect.objectContaining({ code: "not-an-stl" }),
    );
  });

  it("refuses a length-consistent header over the triangle limit", () => {
    // A real 600k-triangle binary file: the length matches, so the count is
    // trustworthy and this is a genuine "too big" rather than a corrupt file.
    const buffer = new ArrayBuffer(84 + 50 * 600_000);
    new DataView(buffer).setUint32(80, 600_000, true);
    expect(() => detectFormat(buffer)).toThrowError(
      expect.objectContaining({ code: "too-many-triangles" }),
    );
  });

  it("rejects a header claiming an absurd triangle count as corrupt", () => {
    // 84 bytes cannot hold 4 billion triangles, so the header is nonsense.
    const buffer = new ArrayBuffer(84);
    new DataView(buffer).setUint32(80, 0xfffffff0, true);
    expect(() => detectFormat(buffer)).toThrowError(
      expect.objectContaining({ code: "not-an-stl" }),
    );
  });
});

/* ---------------------------------------------------------- binary parsing */

describe("parseBinaryStl", () => {
  it("reads the vertex positions and skips the stored normals", () => {
    const mesh = parseBinaryStl(binaryStl(UNIT_SQUARE));
    expect(mesh.format).toBe("binary");
    expect(mesh.triangleCount).toBe(2);
    expect(Array.from(mesh.positions.slice(0, 9))).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
  });

  it("computes a bounding box", () => {
    const mesh = parseBinaryStl(
      binaryStl([
        [-5, -2, 0, 5, -2, 0, 0, 7, 3],
        [0, 0, 0, 1, 1, 1, 2, 2, 2],
      ]),
    );
    expect(mesh.bbox.min).toEqual([-5, -2, 0]);
    expect(mesh.bbox.max).toEqual([5, 7, 3]);
    expect(mesh.bbox.size).toEqual([10, 9, 3]);
  });

  it("rejects a zero-triangle file", () => {
    expect(() => parseBinaryStl(binaryStl([]))).toThrowError(
      expect.objectContaining({ code: "no-facets" }),
    );
  });

  it("rejects non-finite coordinates and names the triangle", () => {
    const buffer = binaryStl([[0, 0, 0, Number.NaN, 0, 0, 0, 1, 0]]);
    expect(() => parseBinaryStl(buffer)).toThrowError(/Triangle 1/);
  });
});

/* ---------------------------------------------------------- ASCII parsing */

describe("parseAsciiStl", () => {
  const facet = (points: number[][]) =>
    [
      "  facet normal 0 0 1",
      "    outer loop",
      ...points.flatMap((p) => `      vertex ${p[0]} ${p[1]} ${p[2]}`),
      "    endloop",
      "  endfacet",
    ].join("\n");

  it("parses a minimal facet", () => {
    const mesh = parseAsciiStl(
      decodeAscii(asciiStl(facet([[0, 0, 0], [1, 0, 0], [0, 1, 0]]))),
    );
    expect(mesh.format).toBe("ascii");
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("parses several facets", () => {
    const mesh = parseAsciiStl(
      decodeAscii(
        asciiStl(
          [
            facet([[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
            facet([[1, 0, 0], [1, 1, 0], [0, 1, 0]]),
          ].join("\n"),
        ),
      ),
    );
    expect(mesh.triangleCount).toBe(2);
  });

  it("accepts scientific notation and negative exponents", () => {
    const mesh = parseAsciiStl(
      decodeAscii(
        asciiStl(
          [
            "  facet normal 0 0 1",
            "    outer loop",
            "      vertex -1.5e2 3E-1 .5",
            "      vertex 1 0 0",
            "      vertex 0 1 0",
            "    endloop",
            "  endfacet",
          ].join("\n"),
        ),
      ),
    );
    // STL stores coordinates as float32, so compare with a tolerance.
    const xyz = Array.from(mesh.positions.slice(0, 3));
    expect(xyz[0]).toBe(-150);
    expect(xyz[1]).toBeCloseTo(0.3, 6);
    expect(xyz[2]).toBeCloseTo(0.5, 6);
  });

  it("accepts a facet with no normal", () => {
    const mesh = parseAsciiStl(
      decodeAscii(
        asciiStl(
          [
            "  facet",
            "    outer loop",
            "      vertex 0 0 0",
            "      vertex 1 0 0",
            "      vertex 0 1 0",
            "    endloop",
            "  endfacet",
          ].join("\n"),
        ),
      ),
    );
    expect(mesh.triangleCount).toBe(1);
  });

  it("accepts `loop` without the `outer` keyword", () => {
    const mesh = parseAsciiStl(
      decodeAscii(
        asciiStl(
          [
            "  facet normal 0 0 1",
            "    loop",
            "      vertex 0 0 0",
            "      vertex 1 0 0",
            "      vertex 0 1 0",
            "    endloop",
            "  endfacet",
          ].join("\n"),
        ),
      ),
    );
    expect(mesh.triangleCount).toBe(1);
  });

  it("handles CRLF line endings", () => {
    const text = "solid s\r\n  facet normal 0 0 1\r\n    outer loop\r\n      vertex 0 0 0\r\n      vertex 1 0 0\r\n      vertex 0 1 0\r\n    endloop\r\n  endfacet\r\nendsolid s\r\n";
    const mesh = parseAsciiStl(text);
    expect(mesh.triangleCount).toBe(1);
  });

  it("tolerates a solid with no name", () => {
    const text = "solid\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid\n";
    expect(parseAsciiStl(text).triangleCount).toBe(1);
  });

  it("tolerates a non-ASCII solid name", () => {
    // A cp1252 export decoded as UTF-8 yields a replacement character in the
    // name. It must not swallow the rest of the file.
    const text =
      "solid caf\u00e9 \u2014 copy\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid caf\u00e9\n";
    expect(parseAsciiStl(text).triangleCount).toBe(1);
  });

  it("tolerates a name containing spaces and punctuation", () => {
    const text =
      'solid "my part" (v2) rev.A\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid "my part"\n';
    expect(parseAsciiStl(text).triangleCount).toBe(1);
  });

  it("rejects a file with no facets", () => {
    expect(() => parseAsciiStl("solid empty\nendsolid empty\n")).toThrowError(
      expect.objectContaining({ code: "no-facets" }),
    );
  });

  it("reports the line number of a malformed facet", () => {
    const text = [
      "solid s",
      "  facet normal 0 0 1",
      "    outer loop",
      "      vertex 0 0 0",
      "      vertex 1 0 0",
      "    endloop",
      "  endfacet",
      "endsolid s",
    ].join("\n");
    expect(() => parseAsciiStl(text)).toThrowError(
      expect.objectContaining({ code: "malformed-ascii" }),
    );
    try {
      parseAsciiStl(text);
    } catch (error) {
      expect((error as StlParseError).message).toMatch(/line 6/);
    }
  });

  it("rejects a coordinate that is not a number", () => {
    const text = [
      "solid s",
      "  facet normal 0 0 1",
      "    outer loop",
      "      vertex 0 0 0",
      "      vertex 1 zero 0",
      "      vertex 0 1 0",
      "    endloop",
      "  endfacet",
      "endsolid s",
    ].join("\n");
    expect(() => parseAsciiStl(text)).toThrowError(
      expect.objectContaining({ code: "bad-number" }),
    );
  });
});

/* ------------------------------------------------------------ parseStl() */

describe("parseStl", () => {
  it("routes to the ASCII parser", () => {
    const text = "solid s\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid s\n";
    const bytes = new TextEncoder().encode(text);
    const mesh = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(mesh.format).toBe("ascii");
    expect(mesh.triangleCount).toBe(1);
  });

  it("routes to the binary parser even when the header says 'solid'", () => {
    const mesh = parseStl(binaryStl(UNIT_SQUARE, "solid something"));
    expect(mesh.format).toBe("binary");
    expect(mesh.triangleCount).toBe(2);
  });

  it("propagates parse errors", () => {
    expect(() => parseStl(new ArrayBuffer(0))).toThrowError(StlParseError);
  });
});