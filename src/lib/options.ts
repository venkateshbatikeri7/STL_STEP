/**
 * Conversion options shared between the UI and the worker.
 */

import { DEFAULT_SEW_TOLERANCE } from "./limits";

/**
 * STL carries no unit information, so we state the assumption explicitly and
 * preserve the part's real-world size when switching to inches.
 */
export type OutputUnit = "mm" | "inch";

export interface ConvertOptions {
  /** Welding and sewing tolerance, in the source file's units (mm). */
  sewTolerance: number;
  unit: OutputUnit;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  sewTolerance: DEFAULT_SEW_TOLERANCE,
  unit: "mm",
};

export const MM_PER_INCH = 25.4;

/** Factor applied to every coordinate so the STEP numbers match `unit`. */
export function unitScale(unit: OutputUnit): number {
  return unit === "inch" ? 1 / MM_PER_INCH : 1;
}

/** The token OpenCascade's STEP writer expects for `write.step.unit`. */
export function stepUnitName(unit: OutputUnit): "MM" | "INCH" {
  return unit === "inch" ? "INCH" : "MM";
}

/** Convert a length expressed in millimetres into the requested unit. */
export function mmToUnit(mm: number, unit: OutputUnit): number {
  return unit === "inch" ? mm / MM_PER_INCH : mm;
}

export function unitToMm(value: number, unit: OutputUnit): number {
  return unit === "inch" ? value * MM_PER_INCH : value;
}

/** Strip anything that would be awkward in a filename. */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.stl$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[.\s_]+/, "")
    .replace(/[.\s_]+$/, "")
    .slice(0, 80);
  // "///" and friends sanitise to just punctuation, which is not a usable name.
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "model";
}