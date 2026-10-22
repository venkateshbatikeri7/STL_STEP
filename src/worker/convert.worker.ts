/// <reference lib="webworker" />

/**
 * Conversion worker.
 *
 * Everything expensive lives here: the ~22 MB OpenCascade engine, the vertex
 * merge and the BRep construction. The UI thread only ever exchanges small
 * messages, so the page never freezes.
 */

import {
  EngineLoadError,
  engineAssetUrls,
  loadEngine,
} from "../lib/occt/engine";
import { CancelledError, GeometryError, runPipeline } from "../lib/occt/pipeline";
import type {
  ConvertRequest,
  MainToWorker,
  WorkerToMain,
  WorkerErrorKind,
} from "../lib/protocol";

/** Job ids the UI has asked us to abandon. */
const cancelled = new Set<number>();

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function postError(
  jobId: number,
  kind: WorkerErrorKind,
  message: string,
  detail?: string,
): void {
  post({ type: "error", jobId, kind, message, detail });
}

/**
 * OpenCascade aborts with an out-of-memory / unreachable trap rather than a
 * catchable exception when the WebAssembly heap is exhausted.
 */
function isMemoryFailure(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /out of memory|memory access out of bounds|unreachable|abort/i.test(message);
}

async function handleConvert(request: ConvertRequest): Promise<void> {
  const { jobId, engineBaseUrl, positions, options } = request;

  try {
    const positionsView = new Float32Array(positions);

    // The engine is only fetched on the first conversion, which is what keeps
    // the initial page load small.
    post({ type: "progress", jobId, stage: "loading-engine", fraction: 0 });

    const occt = await loadEngine(
      engineAssetUrls(engineBaseUrl),
      ({ loaded, total }) => {
        post({ type: "engine-progress", jobId, loaded, total });
      },
    );

    if (cancelled.has(jobId)) throw new CancelledError();

    const result = runPipeline(occt, positionsView, options, {
      onProgress: (stage, fraction) => {
        post({ type: "progress", jobId, stage, fraction });
      },
      isCancelled: () => cancelled.has(jobId),
    });

    post(
      { type: "done", jobId, step: result.step, stats: result.stats },
      [result.step],
    );
  } catch (error) {
    if (error instanceof CancelledError || cancelled.has(jobId)) {
      postError(jobId, "cancelled", "Conversion cancelled.");
      return;
    }

    if (error instanceof GeometryError) {
      postError(jobId, "geometry", error.message);
      return;
    }

    if (error instanceof EngineLoadError) {
      postError(jobId, "engine-load", error.message, error.stack);
      return;
    }

    if (isMemoryFailure(error)) {
      postError(
        jobId,
        "out-of-memory",
        "The browser ran out of memory while building the STEP model.",
        "OpenCascade creates a full BRep face per triangle and WebAssembly can only " +
          "address 4 GB. Try a mesh with fewer triangles, or a more aggressive sewing tolerance.",
      );
      return;
    }

    postError(
      jobId,
      "unknown",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    cancelled.delete(jobId);
  }
}

self.addEventListener("message", (event: MessageEvent<MainToWorker>) => {
  const message = event.data;

  if (message.type === "cancel") {
    // The flag covers both cases: if the job is still downloading the engine
    // `handleConvert` checks it right after the load, and if it is already in
    // the pipeline the per-stage `isCancelled` polls pick it up.
    cancelled.add(message.jobId);
    return;
  }

  if (message.type === "convert") {
    void handleConvert(message);
  }
});

post({ type: "ready" });