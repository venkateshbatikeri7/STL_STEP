import { formatBytes } from "../lib/mesh";

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />
    </svg>
  );
}

export interface ProgressBarProps {
  /** 0..1, or null for an indeterminate bar. */
  fraction: number | null;
  label: string;
  detail?: string;
  onCancel?: () => void;
}

export function ProgressBar({ fraction, label, detail, onCancel }: ProgressBarProps) {
  const indeterminate = fraction === null;
  const percent = indeterminate
    ? undefined
    : Math.round(Math.min(Math.max(fraction, 0), 1) * 100);

  return (
    <div className="progress">
      <div className="progress__head">
        <span className="progress__label">{label}</span>
        <span className="progress__head-end">
          {!indeterminate && <span className="progress__percent">{percent}%</span>}
          {onCancel !== undefined && (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </span>
      </div>

      <div
        className="progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
        aria-valuetext={indeterminate ? "working" : `${percent}%`}
        data-indeterminate={indeterminate}
      >
        <div
          className="progress__bar"
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>

      {detail !== undefined && <p className="progress__detail">{detail}</p>}
      {!indeterminate && (
        <span className="visually-hidden" aria-live="polite">
          {percent}% — {label}
        </span>
      )}
    </div>
  );
}

export interface ResultCardProps {
  fileName: string;
  byteLength: number;
  downloadUrl: string;
  onReset: () => void;
  children?: React.ReactNode;
}

export function ResultCard({
  fileName,
  byteLength,
  downloadUrl,
  onReset,
  children,
}: ResultCardProps) {
  return (
    <section className="result" aria-labelledby="result-heading">
      <div className="result__head">
        <span className="result__icon">
          <CheckIcon />
        </span>
        <div>
          <h2 id="result-heading" className="result__title">
            STEP file ready
          </h2>
          <p className="result__meta">
            <span className="result__name">{fileName}</span>
            <span aria-hidden="true">·</span>
            <span className="result__size">{formatBytes(byteLength)}</span>
          </p>
        </div>
      </div>

      {children}

      <div className="result__actions">
        <a
          className="button button--primary button--lg"
          href={downloadUrl}
          download={fileName}
          aria-label={`Download ${fileName}`}
        >
          Download STEP
          <DownloadIcon />
        </a>
        <button type="button" className="button button--plain" onClick={onReset}>
          Convert another file
        </button>
      </div>
    </section>
  );
}

export interface AlertProps {
  tone: "error" | "warn" | "info";
  title: string;
  children?: React.ReactNode;
  onDismiss?: () => void;
}

export function Alert({ tone, title, children, onDismiss }: AlertProps) {
  return (
    <div className={`alert alert--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="alert__body">
        <p className="alert__title">{title}</p>
        {children}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          className="alert__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss this message"
        >
          ×
        </button>
      )}
    </div>
  );
}
