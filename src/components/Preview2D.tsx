import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CompareOverlay } from "./CompareOverlay";

export interface Preview2DProps {
  /** Flat XYZ triples, 9 floats per triangle. */
  positions: Float32Array;
  /** Human-readable size, shown next to the reset button. */
  sizeLabel?: string;
  /** Show the STL / STEP before-and-after swipe once a result exists. */
  comparison?: boolean;
}

/**
 * A 3D preview drawn with the Canvas 2D API.
 *
 * This exists because WebGL is not universally available: Chrome disables it
 * under enterprise policy, when "Use graphics acceleration" is off, in VMs and
 * on remote desktops, and on machines with no usable driver. The conversion
 * pipeline needs no WebGL at all, but a dead preview panel is a poor answer, so
 * this renders the mesh on the CPU instead.
 *
 * It is an orthographic projection with a painter's-algorithm depth sort:
 * rotate, project, sort far-to-near, fill. That is a real renderer rather than
 * a wireframe sketch, and Canvas 2D is the same API the browser already uses to
 * paint the page, so it cannot be switched off.
 */

const BACKGROUND = "#0d1014";
const BOUNDS_COLOUR = "rgba(120, 140, 175, 0.38)";
const BASE_COLOUR: [number, number, number] = [159, 180, 208];
/** The brighter, cleaner surface used on the STEP side of the comparison. */
const AFTER_COLOUR: [number, number, number] = [203, 214, 230];
const MESH_EDGE_COLOUR = "rgba(147, 170, 203, 0.38)";

/** Above this, shaded triangles get too slow; draw a point cloud instead. */
const MAX_SHADED_TRIANGLES = 30_000;
/** Upper bound on drawn points in point-cloud mode. */
const MAX_POINTS = 45_000;

const LIGHT = (() => {
  const x = 0.35;
  const y = 0.6;
  const z = 0.72;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length] as const;
})();

interface View {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

const DEFAULT_VIEW: View = {
  yaw: 0.6,
  pitch: 0.45,
  zoom: 1,
  panX: 0,
  panY: 0,
};

export function Preview2D({ positions, sizeLabel, comparison = false }: Preview2DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ ...DEFAULT_VIEW });
  const autoRotateRef = useRef(true);
  const frameRef = useRef(0);
  const comparisonRef = useRef(comparison);
  const splitRef = useRef(0.5);
  const [split, setSplit] = useState(0.5);

  useEffect(() => {
    comparisonRef.current = comparison;
  }, [comparison]);

  useEffect(() => {
    splitRef.current = split;
  }, [split]);

  // Centre the model on the origin once, so orbiting feels natural.
  const model = useMemo(() => {
    const triangleCount = Math.floor(positions.length / 9);
    if (triangleCount === 0) return null;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < positions.length; i += 3) {
      cx += positions[i]!;
      cy += positions[i + 1]!;
      cz += positions[i + 2]!;
    }
    const count = positions.length / 3;
    cx /= count;
    cy /= count;
    cz /= count;

    const centred = new Float32Array(positions.length);
    let radius = 0;
    // Per-axis extents, so the reference box hugs the model instead of the
    // bounding sphere (which is noticeably larger for a cube or a long part).
    let maxX = 0;
    let maxY = 0;
    let maxZ = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]! - cx;
      const y = positions[i + 1]! - cy;
      const z = positions[i + 2]! - cz;
      centred[i] = x;
      centred[i + 1] = y;
      centred[i + 2] = z;
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      const az = Math.abs(z);
      if (ax > maxX) maxX = ax;
      if (ay > maxY) maxY = ay;
      if (az > maxZ) maxZ = az;
      const distance = Math.hypot(x, y, z);
      if (distance > radius) radius = distance;
    }

    return {
      centred,
      radius: Math.max(radius, 1e-6),
      half: [Math.max(maxX, 1e-6), Math.max(maxY, 1e-6), Math.max(maxZ, 1e-6)] as const,
      triangleCount,
    };
  }, [positions]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null || model === null) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width === 0 || height === 0) return;

    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    const view = viewRef.current;
    const cosY = Math.cos(view.yaw);
    const sinY = Math.sin(view.yaw);
    const cosP = Math.cos(view.pitch);
    const sinP = Math.sin(view.pitch);

    // Orthographic fit, with a little headroom.
    const scale = (Math.min(width, height) * 0.4 * view.zoom) / model.radius;
    const originX = width / 2 + view.panX;
    const originY = height / 2 + view.panY;

    const project = (x: number, y: number, z: number): [number, number, number] => {
      // Yaw about Y, then pitch about X.
      const rx = x * cosY + z * sinY;
      const rz = -x * sinY + z * cosY;
      const ry = y * cosP - rz * sinP;
      const rz2 = y * sinP + rz * cosP;
      return [originX + rx * scale, originY - ry * scale, rz2];
    };

    // --- bounding box, so orientation and scale are readable -------------
    const [hx, hy, hz] = model.half;
    const corners: Array<[number, number, number]> = [];
    for (const sx of [-hx, hx]) {
      for (const sy of [-hy, hy]) {
        for (const sz of [-hz, hz]) corners.push([sx, sy, sz]);
      }
    }
    const bounds = [
      [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
      [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
    ];
    const box = new Path2D();
    for (const [a, b] of bounds) {
      const pa = project(...corners[a]!);
      const pb = project(...corners[b]!);
      box.moveTo(pa[0], pa[1]);
      box.lineTo(pb[0], pb[1]);
    }

    const pointCloud = model.triangleCount > MAX_SHADED_TRIANGLES;

    // --- shaded triangles -------------------------------------------------
    interface Face {
      depth: number;
      shade: number;
      a: [number, number];
      b: [number, number];
      c: [number, number];
    }
    const faces: Face[] = [];

    if (!pointCloud) {
      const data = model.centred;
      for (let t = 0; t < model.triangleCount; t++) {
        const i = t * 9;
        const p0 = project(data[i]!, data[i + 1]!, data[i + 2]!);
        const p1 = project(data[i + 3]!, data[i + 4]!, data[i + 5]!);
        const p2 = project(data[i + 6]!, data[i + 7]!, data[i + 8]!);

        // Face normal in rotated space.
        const ux = p1[0] - p0[0];
        const uy = p1[1] - p0[1];
        const uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0];
        const vy = p2[1] - p0[1];
        const vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);

        let shade: number;
        if (length === 0) {
          shade = 0.55; // degenerate triangle
        } else {
          nx /= length;
          ny /= length;
          nz /= length;
          // Point the normal at the camera so inconsistent STL winding still
          // lights sensibly.
          if (nz < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
          const diffuse = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
          shade = 0.24 + 0.76 * Math.max(0, diffuse);
        }

        faces.push({
          depth: (p0[2] + p1[2] + p2[2]) / 3,
          shade,
          a: [p0[0], p0[1]],
          b: [p1[0], p1[1]],
          c: [p2[0], p2[1]],
        });
      }

      // Painter's algorithm: the camera sits at +Z, so smaller z is farther.
      faces.sort((left, right) => left.depth - right.depth);
    }

    /**
     * Paint one vertical slice of the scene. The comparison view calls this
     * twice with the input and output styles; the normal view calls it once
     * across the full width.
     */
    const paint = (from: number, to: number, meshStyle: boolean) => {
      if (to <= from) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(from, 0, to - from, height);
      ctx.clip();

      ctx.strokeStyle = BOUNDS_COLOUR;
      ctx.lineWidth = 1;
      ctx.stroke(box);

      const [br, bg, bb] = meshStyle ? BASE_COLOUR : AFTER_COLOUR;

      if (pointCloud) {
        const pointCount = model.centred.length / 3;
        const stride = Math.max(1, Math.ceil(pointCount / MAX_POINTS));
        ctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
        const size = stride > 4 ? 2 : 1;
        for (let i = 0; i < model.centred.length; i += 3 * stride) {
          const p = project(
            model.centred[i]!,
            model.centred[i + 1]!,
            model.centred[i + 2]!,
          );
          ctx.fillRect(p[0], p[1], size, size);
        }
        ctx.restore();
        return;
      }

      for (const face of faces) {
        const level = face.shade;
        ctx.fillStyle = `rgb(${Math.round(br * level)}, ${Math.round(bg * level)}, ${Math.round(bb * level)})`;
        ctx.beginPath();
        ctx.moveTo(face.a[0], face.a[1]);
        ctx.lineTo(face.b[0], face.b[1]);
        ctx.lineTo(face.c[0], face.c[1]);
        ctx.closePath();
        ctx.fill();

        // Stroking inside the painter loop keeps far edges behind nearer
        // surfaces instead of drawing the whole lattice on top.
        if (meshStyle) {
          ctx.strokeStyle = MESH_EDGE_COLOUR;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }

      ctx.restore();
    };

    if (comparisonRef.current) {
      const splitX = Math.round(
        Math.min(0.98, Math.max(0.02, splitRef.current)) * width,
      );
      paint(0, splitX, true);
      paint(splitX, width, false);
    } else {
      paint(0, width, false);
    }
  }, [model]);

  // Redraw on demand, and keep spinning gently until the first interaction.
  const schedule = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    viewRef.current = { ...DEFAULT_VIEW };
    autoRotateRef.current = true;
    schedule();

    const tick = () => {
      if (!autoRotateRef.current) return;
      viewRef.current.yaw += 0.006;
      draw();
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    const observer = new ResizeObserver(() => schedule());
    const host = hostRef.current;
    if (host !== null) observer.observe(host);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [draw, schedule, model]);

  const stopAutoRotate = () => {
    autoRotateRef.current = false;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  };

  useEffect(() => {
    if (comparison) {
      stopAutoRotate();
    }
  }, [comparison]);

  const resetView = () => {
    stopAutoRotate();
    viewRef.current = { ...DEFAULT_VIEW };
    schedule();
  };

  return (
    <div className="preview">
      <div
        className="preview__canvas preview__canvas--grab"
        ref={hostRef}
        role="img"
        aria-label="3D preview of the loaded model"
        onPointerDown={(event) => {
          stopAutoRotate();
          const startX = event.clientX;
          const startY = event.clientY;
          const startYaw = viewRef.current.yaw;
          const startPitch = viewRef.current.pitch;
          const startPanX = viewRef.current.panX;
          const startPanY = viewRef.current.panY;
          const panning = event.shiftKey || event.button === 2;
          // Held in a closure: a `window` listener's currentTarget is the
          // window, not this element.
          const surface = event.currentTarget;

          surface.setPointerCapture(event.pointerId);

          const onMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (panning) {
              viewRef.current.panX = startPanX + dx;
              viewRef.current.panY = startPanY + dy;
            } else {
              viewRef.current.yaw = startYaw + dx * 0.01;
              viewRef.current.pitch = Math.max(
                Math.min(startPitch + dy * 0.01, Math.PI / 2 - 0.02),
                -Math.PI / 2 + 0.02,
              );
            }
            schedule();
          };

          const onUp = () => {
            if (surface.hasPointerCapture?.(event.pointerId)) {
              surface.releasePointerCapture(event.pointerId);
            }
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };

          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
        onWheel={(event) => {
          stopAutoRotate();
          const next = viewRef.current.zoom * (event.deltaY > 0 ? 0.92 : 1.087);
          viewRef.current.zoom = Math.max(0.05, Math.min(next, 40));
          schedule();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={canvasRef} className="preview__canvas2d" aria-hidden="true" />
      </div>

      <div className="preview__overlay">
        {sizeLabel !== undefined && <span className="preview__size">{sizeLabel}</span>}
        <button type="button" className="button button--ghost button--small" onClick={resetView}>
          Reset view
        </button>
      </div>
      {comparison && <CompareOverlay split={split} onSplitChange={setSplit} />}
      <p className="preview__hint">
        {comparison
          ? "Drag the handle to compare · drag the model to orbit"
          : "Drag to orbit · scroll to zoom · shift-drag to pan"}
      </p>
    </div>
  );
}