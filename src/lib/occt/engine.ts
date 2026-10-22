/**
 * Lazy loader for the OpenCascade WebAssembly module.
 *
 * The binary is ~22 MB, so it is never part of the JS bundle: it is fetched on
 * demand from `public/occt/` and handed to Emscripten as a pre-downloaded
 * `wasmBinary`. Fetching it ourselves (rather than letting Emscripten fetch it)
 * buys two things — a real progress bar, and no risk of a second download.
 *
 * The instance is cached for the lifetime of the worker, so a second
 * conversion starts immediately.
 */

import type { OpenCascadeInstance } from "replicad-opencascadejs";

let cached: Promise<OpenCascadeInstance> | null = null;

export interface EngineProgress {
  loaded: number;
  total: number;
}

/** Absolute URL of the directory holding the copied glue + wasm. */
export interface EngineAssets {
  glue: string;
  wasm: string;
}

export function engineAssetUrls(baseUrl: string): EngineAssets {
  return {
    glue: `${baseUrl}replicad_single.js`,
    wasm: `${baseUrl}replicad_single.wasm`,
  };
}

type EngineFactory = (options: Record<string, unknown>) => Promise<OpenCascadeInstance>;

/** Thrown when the WASM module itself cannot start. */
export class EngineLoadError extends Error {
  readonly stack: string | undefined;

  constructor(message: string, stack?: string) {
    super(message);
    this.name = "EngineLoadError";
    this.stack = stack;
  }
}

/**
 * The Emscripten glue lives in `public/occt/` rather than being bundled.
 *
 * Bundling it would make Vite rewrite its internal
 * `new URL("replicad_single.wasm", import.meta.url)` and emit a second copy of
 * the 22 MB binary, so we import it at runtime instead. `@vite-ignore` keeps
 * the bundler from trying to resolve the URL.
 */
async function importGlue(url: string): Promise<EngineFactory> {
  const module = (await import(/* @vite-ignore */ url)) as { default: EngineFactory };
  return module.default;
}

async function downloadWithProgress(
  url: string,
  onProgress: (progress: EngineProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    signal,
    // The wasm is content-addressed by name, never by content, so we let the
    // HTTP cache do its job: after the first visit this is served locally.
    cache: "default",
  });

  if (!response.ok) {
    throw new Error(
      `Could not download the OpenCascade engine (HTTP ${response.status} ${response.statusText}).`,
    );
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  const total = declared > 0 ? declared : 0;

  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    onProgress({ loaded: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes.buffer;
}

/**
 * Compile and instantiate the engine. Concurrent calls share one promise.
 */
export function loadEngine(
  assets: EngineAssets,
  onProgress: (progress: EngineProgress) => void,
  signal?: AbortSignal,
): Promise<OpenCascadeInstance> {
  if (cached !== null) {
    // Already loaded (or loading): the caller can proceed immediately.
    return cached;
  }

  cached = (async () => {
    const bytes = await downloadWithProgress(assets.wasm, onProgress, signal);
    const init = await importGlue(assets.glue);

    // Emscripten reports fatal problems through printErr and then throws a
    // bare `WebAssembly.Exception`, whose `toString()` is the useless
    // "[object WebAssembly.Exception]". Capturing the log lets us report the
    // real reason.
    const log: string[] = [];
    try {
      return await init({
        // Hand Emscripten the bytes we already downloaded instead of letting it
        // issue its own request.
        wasmBinary: bytes,
        // Fallback path, if the binary is ever loaded without `wasmBinary`.
        locateFile: () => assets.wasm,
        print: () => {},
        printErr: (...args: unknown[]) => {
          log.push(args.map(String).join(" "));
        },
      });
    } catch (error) {
      const detail = log.join("\n").trim();
      const message = detail.length > 0 ? detail : String(error);
      throw new EngineLoadError(
        `The OpenCascade engine failed to start: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  })();

  // A failed load must not poison the cache: the user may retry.
  cached.catch(() => {
    cached = null;
  });

  return cached;
}

/** Drop the cached instance. Used by tests and by the retry path. */
export function resetEngineCache(): void {
  cached = null;
}

/** True once the engine has finished loading in this worker. */
export function isEngineLoaded(): boolean {
  return cached !== null;
}