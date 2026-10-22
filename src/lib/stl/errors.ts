/**
 * Errors raised while reading an STL file.
 *
 * Each error carries a machine-readable `code` so the UI can show a specific,
 * actionable message instead of "something went wrong".
 */

export type StlErrorCode =
  | "empty-file"
  | "too-small"
  | "not-an-stl"
  | "truncated"
  | "trailing-garbage"
  | "malformed-ascii"
  | "bad-number"
  | "no-facets"
  | "too-many-triangles";

export class StlParseError extends Error {
  readonly code: StlErrorCode;
  /** Extra technical context shown in the "details" disclosure. */
  readonly detail?: string;

  constructor(code: StlErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "StlParseError";
    this.code = code;
    this.detail = detail;
  }
}

const MESSAGES: Record<StlErrorCode, string> = {
  "empty-file": "That file is empty (0 bytes).",
  "too-small":
    "That file is too small to be an STL. A binary STL needs at least 84 bytes; an ASCII STL needs a `solid … endsolid` block.",
  "not-an-stl":
    "That doesn't look like an STL file. Expected a binary STL (80-byte header + triangle count) or an ASCII STL starting with `solid`.",
  truncated:
    "That file looks truncated — the declared triangle count does not match the file size, so it was probably cut short during a copy or download.",
  "trailing-garbage":
    "That binary STL has extra bytes after the last triangle. The readable triangles were used, but the file may be corrupted.",
  "malformed-ascii":
    "That ASCII STL is malformed — the `solid` / `facet` / `outer loop` structure is broken.",
  "bad-number":
    "That ASCII STL contains a coordinate that isn't a valid number.",
  "no-facets": "That STL contains no triangles, so there is nothing to convert.",
  "too-many-triangles":
    "That STL has more triangles than this browser-based converter can handle.",
};

export function describeStlError(error: unknown): {
  title: string;
  message: string;
  detail?: string;
} {
  if (error instanceof StlParseError) {
    return {
      title: MESSAGES[error.code],
      message: error.message,
      detail: error.detail,
    };
  }
  return {
    title: "Could not read that STL file.",
    message: error instanceof Error ? error.message : String(error),
  };
}