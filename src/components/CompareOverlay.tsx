import { useCallback, useRef } from "react";

export interface CompareOverlayProps {
  /** 0..1 — the share of the width showing the input. */
  split: number;
  onSplitChange: (split: number) => void;
}

const MIN_SPLIT = 0.02;
const MAX_SPLIT = 0.98;

function clamp(value: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
}

/**
 * Divider for the post-conversion before/after view.
 *
 * The handle is a real slider for keyboard and screen-reader users; pointer
 * dragging is captured on the handle alone so orbiting the model still works
 * everywhere else on the canvas.
 */
export function CompareOverlay({ split, onSplitChange }: CompareOverlayProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const percent = Math.round(split * 100);

  const setFromClientX = useCallback(
    (clientX: number) => {
      const container = handleRef.current?.closest<HTMLElement>(".preview");
      if (container === null || container === undefined) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      onSplitChange(clamp((clientX - rect.left) / rect.width));
    },
    [onSplitChange],
  );

  return (
    <>
      <span className="compare__tag compare__tag--before" aria-hidden="true">
        STL input
      </span>
      <span className="compare__tag compare__tag--after" aria-hidden="true">
        STEP output
      </span>

      <div className="compare__divider" style={{ left: `${split * 100}%` }}>
        <div
          ref={handleRef}
          className="compare__handle"
          role="slider"
          tabIndex={0}
          aria-label="Compare the STL input with the STEP output"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% input, ${100 - percent}% output`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            draggingRef.current = true;
            setFromClientX(event.clientX);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            setFromClientX(event.clientX);
          }}
          onPointerUp={(event) => {
            draggingRef.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 0.1 : 0.02;
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              onSplitChange(clamp(split - step));
            } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              onSplitChange(clamp(split + step));
            } else if (event.key === "Home") {
              event.preventDefault();
              onSplitChange(MIN_SPLIT);
            } else if (event.key === "End") {
              event.preventDefault();
              onSplitChange(MAX_SPLIT);
            }
          }}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6-4 6 4 6M15 6l4 6-4 6" />
          </svg>
        </div>
      </div>
    </>
  );
}
