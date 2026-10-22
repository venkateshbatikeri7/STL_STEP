import { useCallback, useId, useRef, useState } from "react";

export interface DropzoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
  compact?: boolean;
}

const ACCEPT = ".stl,model/stl,application/sla";
const MAX_BYTES = 100 * 1024 * 1024;

/** Reject by content too: an .stl that is actually a .obj should not get in. */
function looksLikeStl(file: File): boolean {
  if (/\.stl$/i.test(file.name)) return true;
  const type = file.type.toLowerCase();
  return type.includes("stl") || type.includes("sla");
}

export function Dropzone({ onFile, disabled = false, compact = false }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();

  const handleFiles = useCallback(
    (files: FileList | null) => {
      setRejected(null);
      const file = files?.[0];
      if (file === undefined) return;

      if (!looksLikeStl(file)) {
        setRejected(
          `“${file.name}” is not an STL file. This tool only reads .stl (both binary and ASCII).`,
        );
        return;
      }
      if (file.size > MAX_BYTES) {
        setRejected(
          `“${file.name}” is ${(file.size / 1e6).toFixed(0)} MB, which is too large to read in a browser tab.`,
        );
        return;
      }
      if (file.size === 0) {
        setRejected(`“${file.name}” is empty (0 bytes).`);
        return;
      }
      onFile(file);
    },
    [onFile],
  );

  return (
    <div
      className={
        compact ? "dropzone-wrapper dropzone-wrapper--compact" : "dropzone-wrapper"
      }
    >
      <div
        className={[
          "dropzone",
          compact ? "dropzone--compact" : "",
          isOver ? "dropzone--over" : "",
          disabled ? "dropzone--disabled" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setIsOver(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setIsOver(false);
        }}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setIsOver(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        {/* The real input stays in the DOM (and focusable) so the control is
            keyboard- and screen-reader-native; only its box is replaced. */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPT}
          className="visually-hidden"
          disabled={disabled}
          aria-describedby={compact ? undefined : hintId}
          onChange={(event) => {
            handleFiles(event.target.files);
            // Allow re-picking the same file after a failure.
            event.target.value = "";
          }}
        />
        <label htmlFor={inputId} className="dropzone__label">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="dropzone__icon">
            <path
              d="M12 16V4m0 0L8 8m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="dropzone__title">
            {compact ? "Replace file" : "Drop an STL file here"}
          </span>
          <span className="dropzone__hint">
            or <span className="dropzone__browse">browse your files</span>
          </span>
        </label>
      </div>

      {!compact && (
        <p id={hintId} className="dropzone__meta">
          Binary and ASCII STL are both supported. Nothing is uploaded.
        </p>
      )}

      {rejected !== null && (
        <p className="dropzone__error" role="alert">
          {rejected}
        </p>
      )}
    </div>
  );
}