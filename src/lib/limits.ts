/**
 * Guard rails for browser-side conversion.
 *
 * These numbers are measured, not guessed — `npm run verify:step` and
 * `node scripts/measure.mts <triangles>` reproduce them.
 *
 * The binding constraint is **memory**, not time. Every triangle becomes a BRep
 * face with its own plane, wire and three edges, and all of it stays resident
 * while sewing runs. Measured on a 2023 laptop, clean process:
 *
 *   20,200 triangles  ->  454 MB    27 s    48 MB STEP
 *   40,328 triangles  ->  813 MB    30 s    98 MB STEP
 *  100,350 triangles  -> 1739 MB    71 s   246 MB STEP
 *  200,344 triangles  -> 3327 MB   290 s   496 MB STEP
 *
 * That is ~16.7 kB of WebAssembly heap and ~2.6 kB of STEP per triangle.
 * WebAssembly is capped at a 4 GB address space, and a browser tab gets less
 * than that, so anything above ~100k is a gamble on the visitor's machine. The
 * pipeline catches the failure and says so rather than dying silently.
 */

/** Above this we warn that conversion will be slow and memory-hungry. */
export const TRIANGLE_WARN_THRESHOLD = 100_000;

/** Above this we refuse to start; see `LIMIT_MESSAGE`. */
export const TRIANGLE_HARD_LIMIT = 200_000;

/** Cheap pre-check so we never try to read a multi-gigabyte file into memory. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

/** Default welding / sewing tolerance, in millimetres. */
export const DEFAULT_SEW_TOLERANCE = 1e-4;

/** Measured costs, used to give the user a realistic estimate before starting. */
export const MS_PER_TRIANGLE = 0.7;
export const KB_HEAP_PER_TRIANGLE = 17;

export const LIMIT_MESSAGE =
  `STLs with more than ${TRIANGLE_HARD_LIMIT.toLocaleString("en-US")} triangles ` +
  "cannot be converted in a browser. Each triangle becomes a full BRep face, and at " +
  "roughly 17 kB per face that is more memory than a WebAssembly tab can be given. " +
  "Decimate the mesh (MeshLab, Blender, …) or use a desktop CAD tool.";