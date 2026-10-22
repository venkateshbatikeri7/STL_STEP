/**
 * Single clean conversion, used to measure peak heap and wall time per size.
 * Run in a fresh process each time so the heap starts from the same place.
 *
 *   npx vite-node scripts/measure.mts <triangles> [--caps]
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPipeline } from "../src/lib/occt/pipeline";
import { DEFAULT_OPTIONS } from "../src/lib/options";
import type { OpenCascadeInstance } from "replicad-opencascadejs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(root, "public", "occt");

const { default: init } = (await import(
  pathToFileURL(join(engineDir, "replicad_single.js")).href
)) as {
  default: (o: Record<string, unknown>) => Promise<OpenCascadeInstance>;
};
const occt = await init({
  wasmBinary: await readFile(join(engineDir, "replicad_single.wasm")),
  print: () => {},
  printErr: () => {},
});

const target = Number(process.argv[2] ?? 10000);
const withCaps = process.argv.includes("--caps");

// Pick a grid whose triangle count lands close to the target.
const rings = Math.max(2, Math.round(Math.sqrt(target / 6)));
const segments = Math.max(3, Math.round(target / 6 / rings));

const positions = [];
const radius = 20;
const height = 40;
const p = (a, y) => [Math.cos(a) * radius, y, Math.sin(a) * radius];
for (let r = 0; r < rings; r++) {
  const y0 = (r / rings) * height;
  const y1 = ((r + 1) / rings) * height;
  for (let s = 0; s < segments; s++) {
    const a0 = (s / segments) * Math.PI * 2;
    const a1 = ((s + 1) / segments) * Math.PI * 2;
    const v00 = p(a0, y0);
    const v10 = p(a1, y0);
    const v11 = p(a1, y1);
    const v01 = p(a0, y1);
    positions.push(...v00, ...v10, ...v11, ...v00, ...v11, ...v01);
  }
}
if (withCaps) {
  for (const [y, up] of [
    [0, -1],
    [height, 1],
  ] as const) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const centre = [0, y, 0];
      const e0 = p(a0, y);
      const e1 = p(a1, y);
      if (up > 0) positions.push(...centre, ...e0, ...e1);
      else positions.push(...centre, ...e1, ...e0);
    }
  }
}

const mesh = new Float32Array(positions);
const triangles = mesh.length / 9;
const base = occt.wasmMemory.buffer.byteLength;
const started = Date.now();

try {
  const result = runPipeline(occt, mesh, DEFAULT_OPTIONS, {
    onProgress: () => {},
    isCancelled: () => false,
  });
  const peak = occt.wasmMemory.buffer.byteLength;
  const seconds = (Date.now() - started) / 1000;
  const stepMb = result.step.byteLength / 1024 / 1024;
  console.log(
    `OK   ${triangles.toLocaleString("en-US").padStart(9)} tris  ` +
      `${seconds.toFixed(1).padStart(6)} s  ` +
      `heap ${(base / 1024 / 1024) | 0}->${(peak / 1024 / 1024) | 0} MB ` +
      `(+${(((peak - base) / triangles) / 1024).toFixed(1)} kB/tri)  ` +
      `STEP ${stepMb.toFixed(1)} MB (${((stepMb * 1024 * 1024) / triangles).toFixed(0)} B/tri)  ` +
      `solid=${result.stats.isSolid}`,
  );
} catch (error) {
  const peak = occt.wasmMemory.buffer.byteLength;
  console.log(
    `FAIL ${triangles.toLocaleString("en-US").padStart(9)} tris  ` +
      `${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ` +
      `heap ${(base / 1024 / 1024) | 0}->${(peak / 1024 / 1024) | 0} MB  ` +
      `${error?.constructor?.name ?? "?"} ${String(error?.message ?? error).slice(0, 90)}`,
  );
}