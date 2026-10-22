import { useCallback, useEffect, useRef, useState } from "react";

import type { ConvertOptions } from "../lib/options";
import type {
  ConversionStage,
  ConversionStats,
  MainToWorker,
  WorkerToMain,
} from "../lib/protocol";

export type JobPhase =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface JobProgress {
  stage: ConversionStage;
  /** 0..1 inside the current stage, or null when indeterminate. */
  fraction: number | null;
}

export interface JobError {
  title: string;
  message: string;
  detail?: string;
}

export interface JobResult {
  blobUrl: string;
  fileName: string;
  byteLength: number;
  stats: ConversionStats;
}

export interface EngineDownload {
  loaded: number;
  total: number;
}

const STAGE_LABELS: Record<ConversionStage, string> = {
  "loading-engine": "Downloading the OpenCascade engine",
  welding: "Merging vertices",
  "building-faces": "Building STEP faces",
  sewing: "Sewing faces into a shell",
  writing: "Writing the STEP file",
  done: "Done",
};

/**
 * Owns the conversion worker and exposes a small promise-like API for it.
 *
 * The worker is created lazily on the first conversion so that a visitor who
 * only looks at the preview never pays for the engine download.
 */
export function useConverter() {
  const workerRef = useRef<Worker | null>(null);
  const jobIdRef = useRef(0);

  const [phase, setPhase] = useState<JobPhase>("idle");
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [engine, setEngine] = useState<EngineDownload | null>(null);
  const [error, setError] = useState<JobError | null>(null);
  const [result, setResult] = useState<JobResult | null>(null);

  // Object URLs are cheap but leak if never revoked.
  const resultUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (resultUrlRef.current !== null) URL.revokeObjectURL(resultUrlRef.current);
      workerRef.current?.terminate();
    };
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current !== null) return workerRef.current;
    const worker = new Worker(
      new URL("../worker/convert.worker.ts", import.meta.url),
      { type: "module", name: "stl-to-step-converter" },
    );
    workerRef.current = worker;
    return worker;
  }, []);

  const cancel = useCallback(() => {
    const worker = workerRef.current;
    if (worker === null) return;
    worker.postMessage({
      type: "cancel",
      jobId: jobIdRef.current,
    } satisfies MainToWorker);
    // Ask nicely first, then terminate outright: a long-running pipeline would
    // otherwise keep building faces until it reached the next stage boundary.
    worker.terminate();
    workerRef.current = null;
    setPhase("cancelled");
    setProgress(null);
    setEngine(null);
  }, []);

  const convert = useCallback(
    (positions: ArrayBuffer, baseName: string, options: ConvertOptions) => {
      const worker = ensureWorker();
      const jobId = ++jobIdRef.current;

      // Resolved from the site root, because the worker chunk itself lives in
      // /assets and a relative URL from there would be wrong.
      const engineBaseUrl = new URL(
        `${import.meta.env.BASE_URL}occt/`,
        window.location.href,
      ).href;

      setPhase("running");
      setProgress({ stage: "loading-engine", fraction: null });
      setEngine(null);
      setError(null);
      if (resultUrlRef.current !== null) {
        URL.revokeObjectURL(resultUrlRef.current);
        resultUrlRef.current = null;
      }
      setResult(null);

      const onMessage = (event: MessageEvent<WorkerToMain>) => {
        const message = event.data;
        if (message.type === "ready") return;
        if (message.jobId !== jobId) return;

        switch (message.type) {
          case "engine-progress":
            setEngine({ loaded: message.loaded, total: message.total });
            break;

          case "progress":
            setProgress({ stage: message.stage, fraction: message.fraction });
            break;

          case "done": {
            const blob = new Blob([message.step], { type: "application/step" });
            const url = URL.createObjectURL(blob);
            resultUrlRef.current = url;
            setResult({
              blobUrl: url,
              fileName: `${baseName}.step`,
              byteLength: blob.size,
              stats: message.stats,
            });
            setProgress({ stage: "done", fraction: 1 });
            setPhase("done");
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            break;
          }

          case "error": {
            if (message.kind === "cancelled") {
              setPhase("cancelled");
            } else {
              setError({
                title: ERROR_TITLES[message.kind],
                message: message.message,
                detail: message.detail,
              });
              setPhase("error");
            }
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            break;
          }
        }
      };

      const onError = (event: ErrorEvent) => {
        setError({
          title: "The conversion worker crashed.",
          message: event.message || "An unexpected error stopped the worker.",
          detail:
            "This usually means the browser rejected the ~22 MB WebAssembly module. " +
            "Check that WebAssembly is enabled and reload the page.",
        });
        setPhase("error");
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);

      worker.postMessage(
        {
          type: "convert",
          jobId,
          engineBaseUrl,
          positions,
          options,
        } satisfies MainToWorker,
        [positions],
      );
    },
    [ensureWorker],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setProgress(null);
    setEngine(null);
    setError(null);
    if (resultUrlRef.current !== null) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setResult(null);
  }, []);

  return {
    phase,
    progress,
    engine,
    error,
    result,
    stageLabel: progress ? STAGE_LABELS[progress.stage] : null,
    isRunning: phase === "running",
    convert,
    cancel,
    reset,
  };
}

const ERROR_TITLES: Record<string, string> = {
  "engine-load": "Could not load the OpenCascade engine.",
  "out-of-memory": "Out of memory.",
  geometry: "Could not build the STEP model.",
  write: "Could not write the STEP file.",
  cancelled: "Conversion cancelled.",
  unknown: "The conversion failed.",
};