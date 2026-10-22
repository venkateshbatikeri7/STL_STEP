import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  mmToUnit,
  sanitiseFileName,
  stepUnitName,
  unitScale,
  unitToMm,
} from "./options";

describe("unit conversion", () => {
  it("keeps millimetres untouched", () => {
    expect(unitScale("mm")).toBe(1);
    expect(stepUnitName("mm")).toBe("MM");
    expect(mmToUnit(25.4, "mm")).toBe(25.4);
    expect(unitToMm(25.4, "mm")).toBe(25.4);
  });

  it("scales inches so the part measures the same", () => {
    expect(unitScale("inch")).toBeCloseTo(1 / 25.4, 12);
    expect(stepUnitName("inch")).toBe("INCH");
    expect(mmToUnit(25.4, "inch")).toBeCloseTo(1, 12);
    expect(unitToMm(1, "inch")).toBeCloseTo(25.4, 12);
  });

  it("round-trips through both units", () => {
    expect(mmToUnit(unitToMm(7.5, "inch"), "inch")).toBeCloseTo(7.5, 12);
    expect(unitToMm(mmToUnit(7.5, "mm"), "mm")).toBe(7.5);
  });
});

describe("sanitiseFileName", () => {
  it("drops the .stl extension", () => {
    expect(sanitiseFileName("widget.stl")).toBe("widget");
    expect(sanitiseFileName("WIDGET.STL")).toBe("WIDGET");
  });

  it("replaces path-hostile characters", () => {
    expect(sanitiseFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("collapses whitespace and trims length", () => {
    expect(sanitiseFileName("  my   model  ")).toBe("my_model");
    expect(sanitiseFileName("x".repeat(200)).length).toBe(80);
  });

  it("falls back for names that sanitise to nothing", () => {
    expect(sanitiseFileName("///")).toBe("model");
    expect(sanitiseFileName("   ")).toBe("model");
  });
});

describe("default options", () => {
  it("uses the documented sewing tolerance", () => {
    expect(DEFAULT_OPTIONS.sewTolerance).toBe(1e-4);
    expect(DEFAULT_OPTIONS.unit).toBe("mm");
  });
});