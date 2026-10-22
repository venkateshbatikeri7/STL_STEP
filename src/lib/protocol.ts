/**
 * Message contract between the UI and the conversion worker.
 *
 * Every message carries a `jobId` so a cancelled job whose worker is being
 * torn down can never resolve a newer job's promise.
 */

import type { ConvertOptions } from "./options";

export type ConversionStage =
  | "loading-engine"
  | "welding"
  | "building-faces"
  | "sewing"
  | "writing"
  | "done";

export interface ConversionWarning {
  kind: "degenerate" | "non-manifold" | "open-shell" | "trailing-bytes";
  message: string;
}

export interface ConversionStats {
  triangleCount: number;
  uniqueVertexCount: number;
  faceCount: number;
  freeEdgeCount: number;
  multipleEdgeCount: number;
  isSolid: boolean;
  warnings: ConversionWarning[];
  elapsedMs: number;
}

export interface ConvertRequest {
  type: "convert";
  jobId: number;
  /**
   * Absolute URL of the folder holding the copied OpenCascade assets, with a
   * trailing slash. Resolved on the main thread because the worker chunk lives
   * in /assets, so a relative URL from there would point at the wrong place.
   */
  engineBaseUrl: string;
  /** Flat XYZ triples, 9 floats per triangle. Transferred, not copied. */
  positions: ArrayBuffer;
  options: ConvertOptions;
}

export interface CancelRequest {
  type: "cancel";
  jobId: number;
}

export type MainToWorker = ConvertRequest | CancelRequest;

export type WorkerErrorKind =
  | "engine-load"
  | "out-of-memory"
  | "geometry"
  | "write"
  | "cancelled"
  | "unknown";

export type WorkerToMain =
  | { type: "ready" }
  | { type: "engine-progress"; jobId: number; loaded: number; total: number }
  | {
      type: "progress";
      jobId: number;
      stage: ConversionStage;
      /** 0..1 within the current stage, or null when indeterminate. */
      fraction: number | null;
    }
  | {
      type: "done";
      jobId: number;
      /** STEP file bytes. Transferred, not copied. */
      step: ArrayBuffer;
      stats: ConversionStats;
    }
  | {
      type: "error";
      jobId: number;
      kind: WorkerErrorKind;
      message: string;
      detail?: string;
    };