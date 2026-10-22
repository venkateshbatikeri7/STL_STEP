import { useId } from "react";

import type { ConvertOptions, OutputUnit } from "../lib/options";
import {
  KB_HEAP_PER_TRIANGLE,
  MS_PER_TRIANGLE,
  TRIANGLE_HARD_LIMIT,
  TRIANGLE_WARN_THRESHOLD,
} from "../lib/limits";
import { formatCount } from "../lib/mesh";

export interface OptionsPanelProps {
  options: ConvertOptions;
  onChange: (options: ConvertOptions) => void;
  fileName: string;
  onFileNameChange: (name: string) => void;
  triangleCount: number;
  disabled: boolean;
}

const TOLERANCE_PRESETS = [
  { label: "Very fine", value: 1e-5 },
  { label: "Fine", value: 1e-4 },
  { label: "Loose", value: 1e-3 },
];

function toleranceLabel(tolerance: number): string {
  const preset = TOLERANCE_PRESETS.find((item) => item.value === tolerance);
  return preset ? preset.label : "Custom";
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      className="icon advanced__chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function OptionsPanel({
  options,
  onChange,
  fileName,
  onFileNameChange,
  triangleCount,
  disabled,
}: OptionsPanelProps) {
  const toleranceId = useId();
  const unitId = useId();
  const nameId = useId();
  const toleranceHelpId = useId();

  return (
    <div className="options-panel">
      <div className="field">
        <label className="field__label" htmlFor={nameId}>
          Output file name
        </label>
        <div className="field__row">
          <input
            id={nameId}
            className="field__input"
            type="text"
            value={fileName}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onFileNameChange(event.target.value)}
          />
          <span className="field__unit">.step</span>
        </div>
        <p className="field__help">The extension is added automatically.</p>
      </div>

      <fieldset className="field field--fieldset" disabled={disabled}>
        <legend className="field__label" id={unitId}>
          Output units
        </legend>
        <div className="segmented" role="radiogroup" aria-labelledby={unitId}>
          {(["mm", "inch"] as const).map((unit: OutputUnit) => (
            <label
              key={unit}
              className="segmented__option"
              data-checked={options.unit === unit}
            >
              <input
                type="radio"
                name="output-unit"
                value={unit}
                checked={options.unit === unit}
                onChange={() => onChange({ ...options, unit })}
              />
              <span>{unit === "mm" ? "Millimetres" : "Inches"}</span>
            </label>
          ))}
        </div>
        <p className="field__help">
          STL carries no units, so the numbers are read as millimetres. Inches
          rescale the model so it measures the same in CAD.
        </p>
      </fieldset>

      <details className="advanced">
        <summary className="advanced__summary">
          <span>Advanced</span>
          <span className="advanced__value">
            {toleranceLabel(options.sewTolerance)} ·{" "}
            {options.sewTolerance.toExponential(0)} mm
          </span>
          <ChevronIcon />
        </summary>

        <div className="advanced__body">
          <div className="field">
            <label className="field__label" htmlFor={toleranceId}>
              Sewing tolerance
            </label>
            <div className="field__row">
              <input
                id={toleranceId}
                className="field__input"
                type="number"
                min={0}
                step={1e-6}
                value={options.sewTolerance}
                disabled={disabled}
                aria-describedby={toleranceHelpId}
                onChange={(event) => {
                  const parsed = Number.parseFloat(event.target.value);
                  if (!Number.isFinite(parsed) || parsed < 0) return;
                  onChange({ ...options, sewTolerance: parsed });
                }}
              />
              <span className="field__unit">mm</span>
            </div>
            <p id={toleranceHelpId} className="field__help">
              Vertices closer than this are merged before faces are sewn. Raise it
              for floating-point noise or split seams; lower it if distinct edges
              are being swallowed.
            </p>
            <div className="chips" role="group" aria-label="Tolerance presets">
              {TOLERANCE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="chip"
                  disabled={disabled}
                  aria-pressed={options.sewTolerance === preset.value}
                  onClick={() => onChange({ ...options, sewTolerance: preset.value })}
                >
                  {preset.label}
                  <span className="chip__value">{preset.value.toExponential(0)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </details>

      <p className="fineprint">
        Faceted output — one flat STEP face per triangle
        {triangleCount > 0 ? ` (${formatCount(triangleCount)} here)` : ""}. No
        cylinders, fillets or feature history are invented.
      </p>
    </div>
  );
}

export function triangleAdvisory(triangleCount: number): {
  level: "none" | "info" | "warn" | "block";
  message: string;
} {
  if (triangleCount > TRIANGLE_HARD_LIMIT) {
    return { level: "block", message: "This mesh is over the browser limit." };
  }
  if (triangleCount > TRIANGLE_WARN_THRESHOLD) {
    const seconds = Math.round((triangleCount * MS_PER_TRIANGLE) / 1000);
    const megabytes = Math.round((triangleCount * KB_HEAP_PER_TRIANGLE) / 1024);
    return {
      level: "warn",
      message:
        `${formatCount(triangleCount)} triangles — expect roughly ${seconds} s and ` +
        `${megabytes.toLocaleString("en-US")} MB of memory. Browsers have to be able to ` +
        `give a tab that much, so this may fail on smaller machines.`,
    };
  }
  return { level: "info", message: `${formatCount(triangleCount)} triangles` };
}
