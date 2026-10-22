/**
 * Copies the OpenCascade Emscripten glue and its WASM binary out of
 * node_modules and into `public/occt/` so that Vite serves them as plain
 * static assets and ships them to `dist/`.
 *
 * Why not import the glue from node_modules directly?
 *  - the binary is ~22 MB, far too large to inline into the JS bundle;
 *  - Vite statically rewrites `new URL("...wasm", import.meta.url)` inside the
 *    glue and would emit a *second* copy of the binary into `dist/assets`;
 *  - keeping both files side by side means the glue's own fallback
 *    `new URL("replicad_single.wasm", import.meta.url)` resolves correctly;
 *  - static hosts need the binary as a plain file (Cloudflare Pages caps a
 *    single asset at 25 MiB, which is why we use the `single` build and not a
 *    multi-threaded one).
 *
 * Runs automatically via `predev` / `prebuild`.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SOURCE_DIR = join(root, "node_modules", "replicad-opencascadejs", "dist");
const TARGET_DIR = join(root, "public", "occt");
const ASSETS = ["replicad_single.js", "replicad_single.wasm"];

/** Cloudflare Pages rejects any single asset above this size. */
const HOST_ASSET_LIMIT = 25 * 1024 * 1024;

async function main() {
  const wasmSource = join(SOURCE_DIR, "replicad_single.wasm");

  let size;
  try {
    size = (await stat(wasmSource)).size;
  } catch {
    console.error(
      "[sync-occt-wasm] Could not find %s.\n" +
        "                 Run `npm install` first, or check that the\n" +
        "                 `replicad-opencascadejs` package installed correctly.",
      wasmSource,
    );
    // Exit 0 so that `npm install` is not broken by this convenience script;
    // `npm run dev` / `npm run build` will fail loudly instead.
    process.exit(0);
  }

  if (size > HOST_ASSET_LIMIT) {
    console.error(
      "[sync-occt-wasm] %s is %s MiB, over the %s MiB single-asset limit of " +
        "Cloudflare Pages. Switch to a smaller OpenCascade build before deploying there.",
      wasmSource,
      (size / 1024 / 1024).toFixed(1),
      (HOST_ASSET_LIMIT / 1024 / 1024).toFixed(0),
    );
    process.exit(1);
  }

  await mkdir(TARGET_DIR, { recursive: true });
  for (const asset of ASSETS) {
    await copyFile(join(SOURCE_DIR, asset), join(TARGET_DIR, asset));
  }

  console.log(
    "[sync-occt-wasm] opencascade engine ready (%s MiB wasm) -> public/occt/",
    (size / 1024 / 1024).toFixed(1),
  );
}

await main();