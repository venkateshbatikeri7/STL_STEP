import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dropzone } from "./components/Dropzone";
import { Alert, ProgressBar, ResultCard } from "./components/Feedback";
import { OptionsPanel, triangleAdvisory } from "./components/OptionsPanel";
import {
  DEFAULT_OPTIONS,
  mmToUnit,
  sanitiseFileName,
  type ConvertOptions,
} from "./lib/options";
import { formatBytes, formatCount, type ParsedMesh } from "./lib/mesh";
import {
  LIMIT_MESSAGE,
  MAX_INPUT_BYTES,
  TRIANGLE_HARD_LIMIT,
  TRIANGLE_WARN_THRESHOLD,
} from "./lib/limits";
import { describeStlError, parseStl } from "./lib/stl";
import { useConverter } from "./state/use-converter";
import { useTheme } from "./state/use-theme";

// Three.js is ~560 kB and is only useful once a file has been picked, so it is
// kept out of the initial bundle.
const PreviewCanvas = lazy(() =>
  import("./components/PreviewCanvas").then((module) => ({
    default: module.PreviewCanvas,
  })),
);

interface LoadedFile {
  name: string;
  size: number;
  /** Parsed stats. Safe to keep after the buffers are handed to the worker. */
  mesh: ParsedMesh;
  /**
   * The original file bytes, read in place by the Three.js preview.
   * Never transferred.
   */
  buffer: ArrayBuffer;
  /**
   * Flat XYZ triples from our own parser — what the conversion pipeline
   * consumes. A copy is transferred per run, so the caller can convert again
   * with different options.
   */
  positions: Float32Array;
}

/* ------------------------------------------------------------------ icons -- */

function CubeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4z" />
      <path d="M3.5 7.4 12 12l8.5-4.6M12 12v9.2" />
    </svg>
  );
}

function ArrowRightIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14m-5.5-5.5L19 12l-5.5 5.5" />
    </svg>
  );
}

function CheckIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function InfoIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function LockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

/* -------------------------------------------------------------------- app -- */

export default function App() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS);
  const [outputName, setOutputName] = useState("model");
  const [parseError, setParseError] = useState<{
    title: string;
    message: string;
    detail?: string;
  } | null>(null);
  const [reading, setReading] = useState(false);

  const converter = useConverter();
  const { theme, toggleTheme } = useTheme();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const statusAreaRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------ file intake
  const handleFile = useCallback(
    async (incoming: File) => {
      setReading(true);
      setParseError(null);
      converter.reset();

      try {
        const buffer = await incoming.arrayBuffer();
        const mesh = parseStl(buffer);

        if (mesh.triangleCount > TRIANGLE_HARD_LIMIT) {
          setFile(null);
          setParseError({ title: "This mesh is too large to convert.", message: LIMIT_MESSAGE });
          return;
        }

        // Three.js reads the buffer in the preview (see PreviewCanvas); the
        // worker gets a transferable copy at conversion time.
        setFile({
          name: incoming.name,
          size: incoming.size,
          mesh,
          buffer,
          positions: mesh.positions,
        });
        setOutputName(sanitiseFileName(incoming.name));
      } catch (error) {
        setFile(null);
        const described = describeStlError(error);
        setParseError({
          title: described.title,
          message: described.message,
          detail: described.detail,
        });
      } finally {
        setReading(false);
      }
    },
    [converter],
  );

  // ------------------------------------------------------------- converting
  const handleConvert = useCallback(() => {
    if (file === null || converter.isRunning) return;
    // `positions.slice()` allocates a fresh ArrayBuffer we can transfer; the
    // original stays intact so the user can convert again with new options.
    converter.convert(
      file.positions.slice().buffer,
      sanitiseFileName(outputName),
      options,
    );
  }, [converter, file, options, outputName]);

  const advisory = useMemo(
    () => (file === null ? null : triangleAdvisory(file.mesh.triangleCount)),
    [file],
  );

  const bboxLabel = useMemo(() => {
    if (file === null) return undefined;
    const [x, y, z] = file.mesh.bbox.size;
    const unit = options.unit;
    return `${mmToUnit(x, unit).toFixed(2)} × ${mmToUnit(y, unit).toFixed(2)} × ${mmToUnit(z, unit).toFixed(2)} ${unit}`;
  }, [file, options.unit]);

  const canConvert =
    file !== null &&
    !converter.isRunning &&
    !reading &&
    advisory?.level !== "block";

  // Announce phase changes for screen readers.
  useEffect(() => {
    const node = statusRef.current;
    if (node === null) return;
    if (converter.phase === "running" && converter.stageLabel !== null) {
      node.textContent = converter.stageLabel;
    } else if (converter.phase === "done") {
      node.textContent = "Conversion finished. The STEP file is ready to download.";
    } else if (converter.phase === "cancelled") {
      node.textContent = "Conversion cancelled.";
    }
  }, [converter.phase, converter.stageLabel]);

  // The result and error panels sit under the form. On a short window, or with
  // Advanced open, they can land just below the fold — nudge them into view.
  useEffect(() => {
    if (
      converter.phase !== "done" &&
      converter.phase !== "error" &&
      converter.phase !== "cancelled"
    ) {
      return;
    }
    const node = statusAreaRef.current;
    if (node === null) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [converter.phase]);

  const warnings = converter.result?.stats.warnings ?? [];

  const hasStatus =
    reading ||
    converter.phase === "running" ||
    converter.phase === "cancelled" ||
    converter.phase === "error" ||
    (converter.phase === "done" && converter.result !== null);

  return (
    <div className="app">
      <p ref={statusRef} className="visually-hidden" role="status" aria-live="polite" />

      <header className="site-header">
        <div className="brand">
          <span className="brand__mark">
            <CubeIcon size={17} />
          </span>
          <span className="brand__name">
            stl<span aria-hidden="true">→</span>step
          </span>
          <span className="brand__tag">on-device</span>
        </div>

        <div className="site-header__actions">
          <span className="local-note">Files stay on this device</span>
          <button
            type="button"
            className="icon-button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      {file === null ? (
        <main className="landing">
          <section className="landing__copy" aria-labelledby="page-heading">
            <p className="eyebrow">STL → STEP · local conversion</p>
            <h1 id="page-heading" className="landing__title">
              STL to STEP,
              <span>without uploads.</span>
            </h1>
            <p className="landing__lede">
              Drop a mesh and get a CAD-ready STEP file. No account, no queue, no file leaving your
              device.
            </p>

            <ul className="points">
              <li>
                <CheckIcon />
                Runs on WebAssembly in a background worker
              </li>
              <li>
                <CheckIcon />
                Binary or ASCII STL, up to 200,000 triangles
              </li>
              <li>
                <CheckIcon />
                AP214 output in millimetres or inches
              </li>
            </ul>
          </section>

          <section className="landing__intake" aria-labelledby="input-heading">
            <h2 id="input-heading" className="visually-hidden">
              Choose an STL file
            </h2>

            <Dropzone
              onFile={(incoming) => void handleFile(incoming)}
              disabled={reading}
            />

            {reading && (
              <p className="intake__note" role="status">
                Reading file…
              </p>
            )}

            {parseError !== null && (
              <Alert
                tone="error"
                title={parseError.title}
                onDismiss={() => setParseError(null)}
              >
                <p className="alert__detail">{parseError.message}</p>
                {parseError.detail !== undefined && (
                  <p className="alert__meta">{parseError.detail}</p>
                )}
              </Alert>
            )}

            <dl className="intake__specs">
              <div className="intake__spec">
                <dt>Input</dt>
                <dd>STL · binary or ASCII</dd>
              </div>
              <div className="intake__spec">
                <dt>Limit</dt>
                <dd>
                  {formatBytes(MAX_INPUT_BYTES)} / {formatCount(TRIANGLE_HARD_LIMIT)} tris
                </dd>
              </div>
            </dl>

            <p className="intake__note">
              <InfoIcon />
              The first conversion downloads a 22 MB engine; it is cached for the
              next one.
            </p>
          </section>
        </main>
      ) : (
        <main className="workspace">
          <h1 className="visually-hidden">STL to STEP converter — {file.name}</h1>

          <section className="panel panel--preview" aria-labelledby="preview-heading">
            <header className="panel__bar">
              <div className="file">
                <span className="file__icon">
                  <CubeIcon size={17} />
                </span>
                <span className="file__text">
                  <span className="file__name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="file__meta">
                    {file.mesh.format === "binary" ? "Binary STL" : "ASCII STL"} ·{" "}
                    {formatCount(file.mesh.triangleCount)} triangles
                  </span>
                </span>
              </div>

              <Dropzone
                compact
                onFile={(incoming) => void handleFile(incoming)}
                disabled={converter.isRunning || reading}
              />
            </header>

            <h2 id="preview-heading" className="visually-hidden">
              Model preview
            </h2>

            <Suspense
              fallback={
                <div className="preview preview--empty">
                  <div className="preview__placeholder">
                    <CubeIcon size={28} />
                    <p>Loading the 3D viewer…</p>
                  </div>
                </div>
              }
            >
              <PreviewCanvas
                stlBuffer={file.buffer}
                fallbackPositions={file.positions}
                sizeLabel={bboxLabel}
                comparison={converter.phase === "done" && converter.result !== null}
              />
            </Suspense>
          </section>

          <aside className="panel panel--side">
            <div className="panel__block">
              <h2 className="panel__title">File details</h2>
              <dl className="facts">
                <div className="facts__item">
                  <dt>Triangles</dt>
                  <dd>{formatCount(file.mesh.triangleCount)}</dd>
                </div>
                <div className="facts__item">
                  <dt>File size</dt>
                  <dd>{formatBytes(file.size)}</dd>
                </div>
                <div className="facts__item">
                  <dt>Format</dt>
                  <dd>{file.mesh.format === "binary" ? "Binary" : "ASCII"}</dd>
                </div>
                <div className="facts__item">
                  <dt>Tolerance</dt>
                  <dd>{options.sewTolerance.toExponential(0)} mm</dd>
                </div>
                <div className="facts__item facts__item--wide">
                  <dt>Bounding box</dt>
                  <dd title={bboxLabel}>{bboxLabel}</dd>
                </div>
              </dl>

              {(advisory?.level === "warn" || file.mesh.trailingBytes > 0) && (
                <div className="panel__alerts">
                  {advisory !== null && advisory.level === "warn" && (
                    <Alert tone="warn" title="Large mesh">
                      <p className="alert__detail">{advisory.message}</p>
                    </Alert>
                  )}

                  {file.mesh.trailingBytes > 0 && (
                    <Alert tone="warn" title="The file has extra data at the end">
                      <p className="alert__detail">
                        {formatBytes(file.mesh.trailingBytes)} follow the last
                        triangle, so the file is longer than its header declares. The{" "}
                        {formatCount(file.mesh.triangleCount)} readable triangles were
                        read, but the file may be corrupted.
                      </p>
                    </Alert>
                  )}
                </div>
              )}
            </div>

            <div className="panel__block">
              <h2 className="panel__title">Export</h2>
              <OptionsPanel
                options={options}
                onChange={setOptions}
                fileName={outputName}
                onFileNameChange={setOutputName}
                triangleCount={file.mesh.triangleCount}
                disabled={converter.isRunning}
              />
            </div>

            <div className="panel__action">
              <button
                type="button"
                className="button button--primary button--lg"
                onClick={handleConvert}
                disabled={!canConvert}
              >
                {converter.phase === "done" ? "Convert again" : "Convert to STEP"}
                <ArrowRightIcon />
              </button>
              <p className="action-hint">
                <LockIcon />
                Runs locally. Cancel any time.
              </p>
            </div>

            {hasStatus && (
              <div className="status-area" ref={statusAreaRef}>
                {reading && (
                  <p className="progress__detail" role="status">
                    Reading file…
                  </p>
                )}

                {converter.phase === "running" && (
                  <ProgressBar
                    fraction={
                      converter.engine !== null &&
                      converter.progress?.stage === "loading-engine"
                        ? converter.engine.total > 0
                          ? converter.engine.loaded / converter.engine.total
                          : null
                        : converter.progress?.fraction ?? null
                    }
                    label={converter.stageLabel ?? "Working…"}
                    detail={
                      converter.engine !== null &&
                      converter.progress?.stage === "loading-engine"
                        ? `${formatBytes(converter.engine.loaded)} of ${formatBytes(
                            converter.engine.total || 22_000_000,
                          )} — cached after the first run`
                        : undefined
                    }
                    onCancel={converter.cancel}
                  />
                )}

                {converter.phase === "cancelled" && (
                  <Alert tone="info" title="Conversion cancelled">
                    <p className="alert__detail">
                      Nothing was changed. You can start again.
                    </p>
                  </Alert>
                )}

                {converter.phase === "error" && converter.error !== null && (
                  <Alert tone="error" title={converter.error.title}>
                    <p className="alert__detail">{converter.error.message}</p>
                    {converter.error.detail !== undefined && (
                      <p className="alert__meta">{converter.error.detail}</p>
                    )}
                  </Alert>
                )}

                {converter.phase === "done" && converter.result !== null && (
                  <ResultCard
                    fileName={converter.result.fileName}
                    byteLength={converter.result.byteLength}
                    downloadUrl={converter.result.blobUrl}
                    onReset={() => {
                      converter.reset();
                      setFile(null);
                      setParseError(null);
                    }}
                  >
                    <ul className="result__stats">
                      <li>
                        {formatCount(converter.result.stats.faceCount)} STEP faces from{" "}
                        {formatCount(converter.result.stats.triangleCount)} triangles
                      </li>
                      <li>
                        {converter.result.stats.isSolid
                          ? "Closed solid"
                          : "Open shell (not a solid)"}
                      </li>
                      <li>
                        Converted in{" "}
                        {(converter.result.stats.elapsedMs / 1000).toFixed(1)} s
                      </li>
                    </ul>
                    {warnings.length > 0 && (
                      <div className="result__warnings">
                        {warnings.map((warning) => (
                          <Alert key={warning.kind} tone="warn" title="Mesh warning">
                            <p className="alert__detail">{warning.message}</p>
                          </Alert>
                        ))}
                      </div>
                    )}
                  </ResultCard>
                )}
              </div>
            )}
          </aside>
        </main>
      )}

      <footer className="site-footer">
        <p className="privacy">
          <LockIcon />
          Your file never leaves your device.
        </p>
        <ul className="limits">
          <li>Up to {formatCount(TRIANGLE_HARD_LIMIT)} triangles</li>
          <li>Up to {formatBytes(MAX_INPUT_BYTES)} per file</li>
          <li>Warns above {formatCount(TRIANGLE_WARN_THRESHOLD)}</li>
        </ul>
      </footer>
    </div>
  );
}
