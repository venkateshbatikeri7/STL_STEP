/**
 * Generates the sample STL files under `public/samples/`.
 *
 * Run with `npm run samples`. Everything is written from scratch so the files
 * are reproducible byte-for-byte, which makes them safe to commit.
 *
 * We emit the cube in both flavours on purpose: `cube.stl` is binary and
 * `cube-ascii.stl` is ASCII, so the two code paths are exercised by the
 * samples themselves.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public", "samples");

/** @type {[number, number, number][]} */
const v = (x, y, z) => [x, y, z];

/** Unit cube, 20 mm on a side, centred on the origin. CCW outward winding. */
function cubeTriangles(size = 20) {
  const h = size / 2;
  const c = [
    v(-h, -h, -h),
    v(h, -h, -h),
    v(h, h, -h),
    v(-h, h, -h),
    v(-h, -h, h),
    v(h, -h, h),
    v(h, h, h),
    v(-h, h, h),
  ];
  // [i0, i1, i2, i3] per face -> two triangles each.
  return [
    [4, 5, 6, 7], // front  (+Z)
    [1, 0, 3, 2], // back   (-Z)
    [5, 1, 2, 6], // right  (+X)
    [0, 4, 7, 3], // left   (-X)
    [7, 6, 2, 3], // top    (+Y)
    [0, 1, 5, 4], // bottom (-Y)
  ].flatMap(([a, b, cc, d]) => [
    [c[a], c[b], c[cc]],
    [c[a], c[cc], c[d]],
  ]);
}

/** Closed cylinder: radius 10, height 30, 64 segments. */
function cylinderTriangles(radius = 10, height = 30, segments = 64) {
  const triangles = [];
  const z0 = 0;
  const z1 = height;

  // Side wall.
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0) * radius;
    const s0 = Math.sin(a0) * radius;
    const c1 = Math.cos(a1) * radius;
    const s1 = Math.sin(a1) * radius;

    // Outward normal, CCW seen from outside.
    triangles.push([v(c0, s0, z0), v(c1, s1, z0), v(c1, s1, z1)]);
    triangles.push([v(c0, s0, z0), v(c1, s1, z1), v(c0, s0, z1)]);
  }

  // Caps, fanned from the centre vertex.
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0) * radius;
    const s0 = Math.sin(a0) * radius;
    const c1 = Math.cos(a1) * radius;
    const s1 = Math.sin(a1) * radius;

    triangles.push([v(0, 0, z1), v(c0, s0, z1), v(c1, s1, z1)]); // top, +Z
    triangles.push([v(0, 0, z0), v(c1, s1, z0), v(c0, s0, z0)]); // bottom, -Z
  }

  return triangles;
}

/** A sphere-ish shape with open boundaries, to exercise the shell fallback. */
function openConeTriangles(radius = 10, height = 20, segments = 32) {
  const triangles = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0) * radius;
    const s0 = Math.sin(a0) * radius;
    const c1 = Math.cos(a1) * radius;
    const s1 = Math.sin(a1) * radius;
    triangles.push([v(c0, s0, 0), v(c1, s1, 0), v(0, 0, height)]);
  }
  return triangles;
}

function faceNormal([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * w[2] - u[2] * w[1],
    u[2] * w[0] - u[0] * w[2],
    u[0] * w[1] - u[1] * w[0],
  ];
  const length = Math.hypot(n[0], n[1], n[2]);
  return length === 0 ? [0, 0, 0] : [n[0] / length, n[1] / length, n[2] / length];
}

function toBinary(triangles, headerText) {
  const header = Buffer.alloc(80);
  header.write(headerText.slice(0, 79), 0, "ascii");

  const body = Buffer.alloc(50 * triangles.length);
  triangles.forEach((triangle, index) => {
    const offset = index * 50;
    const [nx, ny, nz] = faceNormal(triangle);
    body.writeFloatLE(nx, offset);
    body.writeFloatLE(ny, offset + 4);
    body.writeFloatLE(nz, offset + 8);
    triangle.forEach(([x, y, z], corner) => {
      body.writeFloatLE(x, offset + 12 + corner * 12);
      body.writeFloatLE(y, offset + 16 + corner * 12);
      body.writeFloatLE(z, offset + 20 + corner * 12);
    });
    body.writeUInt16LE(0, offset + 48); // attribute byte count
  });

  const count = Buffer.alloc(4);
  count.writeUInt32LE(triangles.length, 0);

  return Buffer.concat([header, count, body]);
}

function toAscii(triangles, name) {
  const lines = [`solid ${name}`];
  for (const triangle of triangles) {
    const [nx, ny, nz] = faceNormal(triangle);
    lines.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
    lines.push("    outer loop");
    for (const [x, y, z] of triangle) {
      lines.push(`      vertex ${fmt(x)} ${fmt(y)} ${fmt(z)}`);
    }
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join("\n")}\n`;
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(6));

await mkdir(outDir, { recursive: true });

const files = [
  ["cube.stl", toBinary(cubeTriangles(), "stl2step sample: unit cube, binary")],
  ["cube-ascii.stl", toAscii(cubeTriangles(), "cube")],
  ["cylinder.stl", toBinary(cylinderTriangles(), "stl2step sample: cylinder, binary")],
  ["cylinder-ascii.stl", toAscii(cylinderTriangles(), "cylinder")],
  ["open-cone.stl", toBinary(openConeTriangles(), "stl2step sample: open cone")],
  // Not a valid STL: used to check the error path in the UI.
  ["corrupt.stl", Buffer.from("this is definitely not an stl file\n")],
];

for (const [name, data] of files) {
  await writeFile(join(outDir, name), data);
  console.log(`  ${name.padEnd(22)} ${String(data.length).padStart(8)} bytes`);
}

console.log(`\nWrote ${files.length} sample files to public/samples/`);