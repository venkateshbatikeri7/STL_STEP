import { computeBBox, type ParsedMesh } from "../mesh";
import { TRIANGLE_HARD_LIMIT } from "../limits";
import { StlParseError } from "./errors";
import { Float32Buffer } from "./float32-buffer";

/** Words that introduce a block, so we can tell `solid cube` from `solid facet`. */
const KEYWORDS = new Set([
  "solid",
  "endsolid",
  "facet",
  "endfacet",
  "outer",
  "loop",
  "endloop",
  "vertex",
]);

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

function isLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * A forward-only scanner over the decoded ASCII STL.
 *
 * We deliberately do *not* tokenise the whole file into an array of strings:
 * a 100k-triangle ASCII STL is ~5 MB of text and would turn into a few million
 * short-lived allocations. Reading token by token keeps the peak footprint at
 * "one string plus the output buffer".
 */
class AsciiScanner {
  #text: string;
  #pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  get atEnd(): boolean {
    this.#skipSpace();
    return this.#pos >= this.#text.length;
  }

  /** Reads the next bare word, or returns null at EOF / on a non-letter. */
  tryReadWord(): string | null {
    this.#skipSpace();
    if (this.#pos >= this.#text.length) return null;
    const start = this.#pos;
    let i = start;
    const text = this.#text;
    while (i < text.length && isLetter(text.charCodeAt(i))) i++;
    if (i === start) return null;
    this.#pos = i;
    return text.slice(start, i);
  }

  /** Reads the next word and requires it to match `expected`. */
  expectWord(expected: string): void {
    // Skip whitespace *before* recording the offset, so an error points at the
    // offending token's line rather than the end of the previous one.
    this.#skipSpace();
    const at = this.#pos;
    const word = this.tryReadWord();
    if (word === null) {
      throw this.#malformed(`Expected "${expected}"`, at, "reached end of file");
    }
    if (word.toLowerCase() !== expected) {
      throw this.#malformed(`Expected "${expected}"`, at, `found "${word}"`);
    }
  }

  /** Looks at the next word without consuming it. */
  peekWord(): string | null {
    const saved = this.#pos;
    const word = this.tryReadWord();
    this.#pos = saved;
    return word;
  }

  /**
   * Advance to just past the next line break.
   *
   * Used to step over the solid's name, which is free text and may contain
   * characters our word scanner rejects — a cp1252-exported "solid é" decodes
   * to a replacement character, which would otherwise look like the end of the
   * name and truncate the file to zero triangles.
   */
  skipToLineEnd(): void {
    const text = this.#text;
    let i = this.#pos;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 10 || code === 13) {
        i++;
        // Treat CRLF as one break.
        if (text.charCodeAt(i) === 10 && code === 13) i++;
        break;
      }
      i++;
    }
    this.#pos = i;
  }

  readNumber(): number {
    this.#skipSpace();
    const text = this.#text;
    const start = this.#pos;
    let i = start;
    let sawDigit = false;

    if (text.charCodeAt(i) === 43 || text.charCodeAt(i) === 45) i++; // + / -

    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (isDigit(code)) {
        sawDigit = true;
        i++;
      } else if (code === 46) {
        i++; // "."
      } else {
        break;
      }
    }

    // Optional exponent.
    if (i < text.length) {
      const marker = text.charCodeAt(i);
      if (marker === 101 || marker === 69) {
        // "e" / "E"
        let j = i + 1;
        if (text.charCodeAt(j) === 43 || text.charCodeAt(j) === 45) j++;
        let sawExponentDigit = false;
        while (j < text.length && isDigit(text.charCodeAt(j))) {
          sawExponentDigit = true;
          j++;
        }
        if (sawExponentDigit) i = j;
      }
    }

    const raw = text.slice(start, i);
    const value = Number.parseFloat(raw);
    if (!sawDigit || !Number.isFinite(value)) {
      const snippet = raw.length > 0 ? raw : text.slice(start, start + 16);
      throw new StlParseError(
        "bad-number",
        `Expected a number on line ${this.#lineAt(start)} but found "${snippet}".`,
      );
    }
    this.#pos = i;
    return value;
  }

  #skipSpace(): void {
    const text = this.#text;
    let i = this.#pos;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    this.#pos = i;
  }

  #lineAt(pos: number): number {
    let line = 1;
    const end = Math.min(pos, this.#text.length);
    for (let i = 0; i < end; i++) {
      if (this.#text.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  #malformed(what: string, at: number, got: string): StlParseError {
    return new StlParseError(
      "malformed-ascii",
      `${what} on line ${this.#lineAt(at)}, but ${got}.`,
    );
  }
}

/**
 * Read one `vertex x y z` record.
 *
 * Kept as a helper so the three coordinates stay grouped in a single tuple —
 * flattening them into nine loose variables makes the call site unreadable.
 */
function readVertex(scanner: AsciiScanner): [number, number, number] {
  scanner.expectWord("vertex");
  return [scanner.readNumber(), scanner.readNumber(), scanner.readNumber()];
}

/**
 * Read an ASCII STL.
 *
 * Accepts the common variations found in the wild: a missing facet normal, a
 * missing `outer` before `loop`, and multi-line formatting. Anything it cannot
 * make sense of raises a `malformed-ascii` error pointing at the offending line.
 */
export function parseAsciiStl(text: string): ParsedMesh {
  const scanner = new AsciiScanner(text);
  const out = new Float32Buffer();

  // Optional `solid <name>` header.
  const first = scanner.tryReadWord();
  if (first === null) {
    throw new StlParseError("no-facets", "The ASCII STL contains no facets.");
  }
  const firstKey = first.toLowerCase();
  if (firstKey === "solid") {
    const next = scanner.peekWord();
    if (next !== null && !KEYWORDS.has(next.toLowerCase())) {
      scanner.tryReadWord(); // the solid's name
    }
    // Whatever is left on this line belongs to the solid's name.
    scanner.skipToLineEnd();
  } else if (firstKey !== "facet") {
    throw new StlParseError(
      "malformed-ascii",
      `Expected "solid" or "facet" on line 1, but found "${first}".`,
    );
  }

  while (!scanner.atEnd) {
    const word = scanner.tryReadWord();
    if (word === null) break;

    const keyword = word.toLowerCase();
    if (keyword === "endsolid") break;
    if (keyword === "solid") continue; // stray re-opening of the solid
    if (keyword !== "facet") {
      throw new StlParseError(
        "malformed-ascii",
        `Expected "facet" or "endsolid", but found "${word}".`,
      );
    }

    // `facet normal nx ny nz` — the normal is optional in the wild.
    if (scanner.peekWord()?.toLowerCase() === "normal") {
      scanner.tryReadWord();
      scanner.readNumber();
      scanner.readNumber();
      scanner.readNumber();
    }

    // `outer` is required by the spec but missing from plenty of real files.
    if (scanner.peekWord()?.toLowerCase() === "outer") {
      scanner.tryReadWord();
    }
    scanner.expectWord("loop");

    const p0 = readVertex(scanner);
    const p1 = readVertex(scanner);
    const p2 = readVertex(scanner);
    out.push9(
      p0[0], p0[1], p0[2],
      p1[0], p1[1], p1[2],
      p2[0], p2[1], p2[2],
    );

    scanner.expectWord("endloop");
    scanner.expectWord("endfacet");

    if (out.length / 9 > TRIANGLE_HARD_LIMIT) {
      throw new StlParseError(
        "too-many-triangles",
        `The ASCII STL has more than ${TRIANGLE_HARD_LIMIT.toLocaleString("en-US")} triangles.`,
      );
    }
  }

  const triangleCount = out.length / 9;
  if (triangleCount === 0) {
    throw new StlParseError("no-facets", "The ASCII STL contains no facets.");
  }

  const positions = out.toFloat32Array();
  return {
    format: "ascii",
    positions,
    triangleCount,
    bbox: computeBBox(positions),
    trailingBytes: 0,
  };
}

export function decodeAscii(buffer: ArrayBuffer): string {
  // `ignoreBOM: false` (the default) strips a leading UTF-8 BOM, which some
  // Windows exporters emit.
  return new TextDecoder("utf-8").decode(buffer);
}