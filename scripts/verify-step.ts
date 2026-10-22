/**
 * End-to-end check of the conversion pipeline, without a browser.
 *
 * Loads the same OpenCascade build the app ships, runs `runPipeline` over the
 * sample STLs, and then inspects the resulting STEP text for the entities a
 * CAD kernel actually needs. This is the fastest way to catch a broken
 * pipeline before opening the UI — the emitted files are written to
 * `verify-output/` so they can also be opened in FreeCAD by hand.
 *
 *   npm run verify:step
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPipeline } from "../src/lib/occt/pipeline";
import { parseStl } from "../src/lib/stl";
import { DEFAULT_OPTIONS } from "../src/lib/options";
import type { OpenCascadeInstance } from "replicad-opencascadejs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(root, "public", "occt");
const samplesDir = join(root, "public", "samples");
const outDir = join(root, "verify-output");

async function loadEngine(): Promise<OpenCascadeInstance> {
  const glueUrl = pathToFileURL(join(engineDir, "replicad_single.js")).href;
  const { default: init } = (await import(glueUrl)) as {
    default: (options: Record<string, unknown>) => Promise<OpenCascadeInstance>;
  };
  const bytes = await readFile(join(engineDir, "replicad_single.wasm"));
  return init({ wasmBinary: bytes, print: () => {}, printErr: () => {} });
}

/** Structural assertions on the emitted STEP. */
function inspect(text: string) {
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  return {
    header: text.startsWith("ISO-10303-21;"),
    footer: text.trimEnd().endsWith("END-ISO-10303-21;"),
    schema: /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/.exec(text)?.[1] ?? null,
    advancedFace: count(/ADVANCED_FACE\s*\(/g),
    facetedBrep: count(/FACETED_BREP\s*\(/g),
    manifoldSolidBrep: count(/MANIFOLD_SOLID_BREP\s*\(/g),
    closedShell: count(/CLOSED_SHELL\s*\(/g),
    openShell: count(/OPEN_SHELL\s*\(/g),
    plane: count(/\bPLANE\s*\(/g),
    cartesianPoint: count(/CARTESIAN_POINT\s*\(/g),
    lengthUnit: /\bSI_UNIT\s*\(\s*\.([A-Z]+)\.\s*,\s*\.([A-Z]+)\.\s*\)/.exec(text)?.slice(1) ?? null,
  namedUnits: [...text.matchAll(/CONVERSION_BASED_UNIT\(\s*'([^']+)'/g)].map((m) => m[1]),
  };
}

const expectations: Array<{ file: string; faces: number; solid: boolean }> = [
  { file: "cube.stl", faces: 12, solid: true },
  { file: "cube-ascii.stl", faces: 12, solid: true },
  { file: "cylinder.stl", faces: 256, solid: true },
  { file: "cylinder-ascii.stl", faces: 256, solid: true },
  // Open cone: side wall only, no caps -> shell, not a solid.
  { file: "open-cone.stl", faces: 32, solid: false },
];

await mkdir(outDir, { recursive: true });

console.log("Loading the OpenCascade engine…\n");
const occt = await loadEngine();

let failures = 0;

for (const expected of expectations) {
  const buffer = await readFile(join(samplesDir, expected.file));
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const mesh = parseStl(arrayBuffer);

  const started = Date.now();
  const result = runPipeline(occt, mesh.positions, DEFAULT_OPTIONS, {
    onProgress: () => {},
    isCancelled: () => false,
  });
  const elapsed = Date.now() - started;

  const text = new TextDecoder().decode(result.step);
  const info = inspect(text);
  const outPath = join(outDir, expected.file.replace(/\.stl$/, ".step"));
  await writeFile(outPath, text);

  const problems: string[] = [];
  if (!info.header) problems.push("missing ISO-10303-21 header");
  if (!info.footer) problems.push("missing END-ISO-10303-21 footer");
  if (info.schema === null) problems.push("no FILE_SCHEMA");
  if (info.lengthUnit === null) problems.push("no SI unit");
  if (info.advancedFace !== expected.faces) {
    problems.push(`expected ${expected.faces} ADVANCED_FACE, found ${info.advancedFace}`);
  }
  if (info.cartesianPoint === 0) problems.push("no CARTESIAN_POINT");
  if (result.stats.isSolid !== expected.solid) {
    problems.push(`expected isSolid=${expected.solid}, got ${result.stats.isSolid}`);
  }
  if (expected.solid && info.manifoldSolidBrep === 0 && info.closedShell === 0) {
    problems.push("expected a closed shell or manifold solid brep");
  }

  const status = problems.length === 0 ? "PASS" : "FAIL";
  if (problems.length > 0) failures++;

  console.log(
    `${status}  ${expected.file.padEnd(20)} ` +
      `${mesh.triangleCount} tris -> ${info.advancedFace} faces, ` +
      `solid=${result.stats.isSolid}, ` +
      `${(result.step.byteLength / 1024).toFixed(0)} kB, ${elapsed} ms`,
  );
  console.log(
    `      schema=${info.schema} unit=${info.lengthUnit?.join("/")} ` +
      `planes=${info.plane} points=${info.cartesianPoint} ` +
      `closedShell=${info.closedShell} openShell=${info.openShell} ` +
      `uniqueVerts=${result.stats.uniqueVertexCount}`,
  );
  for (const warning of result.stats.warnings) {
    console.log(`      ! ${warning.message}`);
  }
  for (const problem of problems) {
    console.log(`      x ${problem}`);
  }
  console.log("");
}

console.log(`Wrote STEP files to ${outDir}`);

// ---------------------------------------------------------------------------
// Unit handling: inch output must be the millimetre numbers / 25.4 and must
// declare SI_UNIT(.INCH.).
// ---------------------------------------------------------------------------
{
  const buffer = await readFile(join(samplesDir, "cube.stl"));
  const mesh = parseStl(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  const { step, stats } = runPipeline(
    occt,
    mesh.positions,
    { ...DEFAULT_OPTIONS, unit: "inch" },
    { onProgress: () => {}, isCancelled: () => false },
  );
  const text = new TextDecoder().decode(step);
  const info = inspect(text);
  // The cube is 20 mm wide, so 20/25.4 = 0.7874 inch.
  const widest = Math.max(...Array.from(mesh.bbox.size)) / 25.4;
  // Inches come out as CONVERSION_BASED_UNIT('INCH', ...) layered on the mm
  // SI base, which is how STEP represents a named non-SI unit.
  const declaresInch = info.namedUnits.includes("INCH");
  const scaledCorrectly = text.includes(widest.toFixed(6).slice(0, 7));

  const ok = declaresInch && scaledCorrectly && stats.faceCount === 12;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  cube.stl (inch)       20 mm -> ${widest.toFixed(6)} in, ` +
      `unit=${info.lengthUnit?.join("/")}+[${info.namedUnits.join(",")}], ` +
      `coordinates rescaled=${scaledCorrectly}`,
  );
  await writeFile(join(outDir, "cube-inch.step"), text);
}

// ---------------------------------------------------------------------------
// Throughput on a synthetic mesh, so the README's numbers are measured rather
// than guessed.
// ---------------------------------------------------------------------------
{
  const SEGMENTS = 128;
  const RINGS = 100;
  const positions: number[] = [];
  const radius = 10;
  const height = 30;
  for (let ring = 0; ring < RINGS; ring++) {
    const y0 = (ring / RINGS) * height;
    const y1 = ((ring + 1) / RINGS) * height;
    for (let segment = 0; segment < SEGMENTS; segment++) {
      const a0 = (segment / SEGMENTS) * Math.PI * 2;
      const a1 = ((segment + 1) / SEGMENTS) * Math.PI * 2;
      const p = (angle: number, y: number) => [
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius,
      ];
      const v00 = p(a0, y0);
      const v10 = p(a1, y0);
      const v11 = p(a1, y1);
      const v01 = p(a0, y1);
      positions.push(...v00, ...v10, ...v11, ...v00, ...v11, ...v01);
    }
  }

  // Cap both ends, otherwise the tube is an open shell and never reaches the
  // MakeSolid path we want to time.
  for (const [y, up] of [
    [0, -1],
    [height, 1],
  ] as const) {
    for (let segment = 0; segment < SEGMENTS; segment++) {
      const a0 = (segment / SEGMENTS) * Math.PI * 2;
      const a1 = ((segment + 1) / SEGMENTS) * Math.PI * 2;
      const centre: [number, number, number] = [0, y, 0];
      const edge0: [number, number, number] = [
        Math.cos(a0) * radius,
        y,
        Math.sin(a0) * radius,
      ];
      const edge1: [number, number, number] = [
        Math.cos(a1) * radius,
        y,
        Math.sin(a1) * radius,
      ];
      // Wind the top cap anticlockwise seen from +Y and the bottom from -Y.
      if (up > 0) positions.push(...centre, ...edge0, ...edge1);
      else positions.push(...centre, ...edge1, ...edge0);
    }
  }

  const meshPositions = new Float32Array(positions);
  const triangles = meshPositions.length / 9;

  const started = Date.now();
  const result = runPipeline(occt, meshPositions, DEFAULT_OPTIONS, {
    onProgress: () => {},
    isCancelled: () => false,
  });
  const elapsed = Date.now() - started;

  const ok = result.stats.faceCount === triangles && result.stats.isSolid;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${triangles.toLocaleString("en-US")} triangle tube   ` +
      `${result.stats.faceCount} faces, solid=${result.stats.isSolid}, ` +
      `${(result.step.byteLength / 1024 / 1024).toFixed(1)} MB STEP, ${elapsed} ms ` +
      `(~${Math.round((triangles / elapsed) * 1000).toLocaleString("en-US")} tris/s, ` +
      `Node on this machine)`,
  );
}

console.log(
  failures === 0
    ? "\nAll checks passed. Open a .step in FreeCAD to confirm."
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);