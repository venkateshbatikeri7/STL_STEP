/**
 * The STL -> STEP pipeline, running inside the worker.
 *
 * Stages, in order:
 *   1. weld       merge vertices that are within the tolerance
 *   2. faces      one planar BRep face per triangle
 *   3. sewing     stitch the faces into a shell
 *   4. solid      try to close the shell into a solid, fall back to the shell
 *   5. write      STEPControl_Writer -> bytes
 *
 * Every stage checks for cancellation, because a 500k-triangle mesh can spend
 * a long time in step 2.
 */

import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Vertex,
} from "replicad-opencascadejs";

import { stepUnitName, unitScale, type ConvertOptions } from "../options";
import type { ConversionStage, ConversionStats, ConversionWarning } from "../protocol";
import { weld } from "../stl/weld";

/** Emitted every N triangles so the UI stays responsive. */
const PROGRESS_EVERY_TRIANGLES = 512;

export class CancelledError extends Error {
  constructor() {
    super("Conversion cancelled.");
    this.name = "CancelledError";
  }
}

export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeometryError";
  }
}

export interface PipelineHooks {
  onProgress(stage: ConversionStage, fraction: number | null): void;
  isCancelled(): boolean;
}

export interface PipelineResult {
  step: ArrayBuffer;
  stats: ConversionStats;
}

/** Where the writer drops the file inside Emscripten's in-memory filesystem. */
const STEP_TEMP_PATH = "/stl2step-output.step";

export function runPipeline(
  occt: OpenCascadeInstance,
  positions: Float32Array,
  options: ConvertOptions,
  hooks: PipelineHooks,
): PipelineResult {
  const startedAt = Date.now();
  const warnings: ConversionWarning[] = [];
  const checkCancel = (): void => {
    if (hooks.isCancelled()) throw new CancelledError();
  };

  const triangleCount = Math.floor(positions.length / 9);

  // ---------------------------------------------------------------- 1. weld
  hooks.onProgress("welding", 0);
  const welded = weld(positions, {
    tolerance: options.sewTolerance,
    onProgress: (done, total) => hooks.onProgress("welding", done / total),
  });
  checkCancel();

  if (welded.degenerateCount > 0) {
    warnings.push({
      kind: "degenerate",
      message:
        `${welded.degenerateCount.toLocaleString("en-US")} of ` +
        `${triangleCount.toLocaleString("en-US")} triangles collapsed to zero area ` +
        `once vertices were merged (within ${options.sewTolerance} mm) and were skipped.`,
    });
  }

  if (welded.uniqueVertexCount === 0) {
    throw new GeometryError(
      "Every triangle collapsed while merging vertices. Try a smaller sewing tolerance.",
    );
  }

  // --------------------------------------------------------------- 2. faces
  hooks.onProgress("building-faces", 0);

  // Coordinates are written in the requested unit while STL numbers are read
  // as millimetres, so the part keeps its real-world size either way.
  const scale = unitScale(options.unit);
  const vertices: TopoDS_Vertex[] = [];
  const progressRange = new occt.Message_ProgressRange();

  for (let i = 0; i < welded.positions.length; i += 3) {
    const point = new occt.gp_Pnt(
      welded.positions[i]! * scale,
      welded.positions[i + 1]! * scale,
      welded.positions[i + 2]! * scale,
    );
    const builder = new occt.BRepBuilderAPI_MakeVertex(point);
    vertices.push(builder.Vertex());
    builder.delete();
    point.delete();
  }

  const sewing = new occt.BRepBuilderAPI_Sewing(
    options.sewTolerance,
    true, // option1: perform the sewing
    true, // option2: analyse degenerated shapes
    // option3: cutting of free edges. Left off deliberately — we want to
    // *report* an open boundary, not have the seamer cut holes in it.
    false,
    true, // option4: non-manifold mode
  );

  const { indices } = welded;
  let faceCount = 0;

  for (let t = 0; t < triangleCount; t++) {
    if (t % PROGRESS_EVERY_TRIANGLES === 0) {
      checkCancel();
      hooks.onProgress("building-faces", t / triangleCount);
    }

    const slot = t * 3;
    const a = vertices[indices[slot]!]!;
    const b = vertices[indices[slot + 1]!]!;
    const c = vertices[indices[slot + 2]!]!;

    // Triangles whose corners merged onto each other cannot bound a face.
    if (a === b || b === c || a === c) continue;

    // Each triangle gets its own three edges.
    //
    // Caching them per vertex pair does save ~20% of the WebAssembly heap,
    // because a closed manifold only needs ~1.5N edges rather than 3N — but it
    // breaks `BRepBuilderAPI_Sewing`. The seamer indexes its input shapes by
    // TShape, so an edge already shared between two faces is counted as being
    // used once, and `NbFreeEdges()` then reports every edge as free. The
    // non-manifold and open-surface warnings that drive the solid/shell
    // decision are worth more than the 20%.
    const edgeAB = new occt.BRepBuilderAPI_MakeEdge(a, b);
    const edgeBC = new occt.BRepBuilderAPI_MakeEdge(b, c);
    const edgeCA = new occt.BRepBuilderAPI_MakeEdge(c, a);
    const wire = new occt.BRepBuilderAPI_MakeWire(
      edgeAB.Edge(),
      edgeBC.Edge(),
      edgeCA.Edge(),
    );

    if (wire.IsDone()) {
      const face = new occt.BRepBuilderAPI_MakeFace(wire.Wire(), true);
      if (face.IsDone()) {
        sewing.Add(face.Face());
        faceCount++;
      }
      face.delete();
    }

    // The wire owns copies of these handles, so they can go immediately.
    wire.delete();
    edgeCA.delete();
    edgeBC.delete();
    edgeAB.delete();
  }

  vertices.length = 0;

  if (faceCount === 0) {
    throw new GeometryError(
      "No usable triangle faces could be built. The mesh is likely degenerate or corrupt.",
    );
  }
  checkCancel();

  // -------------------------------------------------------------- 3. sewing
  hooks.onProgress("sewing", null);
  sewing.Perform(progressRange);
  const sewnShape: TopoDS_Shape = sewing.SewedShape();

  const freeEdgeCount = sewing.NbFreeEdges();
  const multipleEdgeCount = sewing.NbMultipleEdges();
  sewing.delete();

  if (sewnShape.IsNull()) {
    throw new GeometryError(
      "Sewing the faces produced nothing. The mesh may be entirely disconnected.",
    );
  }

  if (multipleEdgeCount > 0) {
    warnings.push({
      kind: "non-manifold",
      message:
        `${multipleEdgeCount.toLocaleString("en-US")} edge(s) are shared by more than two faces. ` +
        `This mesh is non-manifold, so the STEP output will not be a valid solid.`,
    });
  }

  if (freeEdgeCount > 0) {
    warnings.push({
      kind: "open-shell",
      message:
        `${freeEdgeCount.toLocaleString("en-US")} edge(s) are used by only one face, so the surface is open ` +
        `(a missing face or a boundary). The STEP output is a shell rather than a solid.`,
    });
  }

  // --------------------------------------------------------------- 4. solid
  hooks.onProgress("sewing", 1);
  let shape: TopoDS_Shape = sewnShape;
  let isSolid = false;

  // `BRepBuilderAPI_MakeSolid` performs no validation: it happily wraps an
  // open shell, which would produce a STEP solid that CAD kernels reject.
  // Only attempt it once sewing reports a properly closed surface.
  if (freeEdgeCount === 0 && multipleEdgeCount === 0) {
    const shell = findFirstShell(occt, sewnShape);
    if (shell !== null) {
      const solid = new occt.BRepBuilderAPI_MakeSolid(shell);
      if (solid.IsDone()) {
        shape = solid.Shape();
        isSolid = true;
      }
      solid.delete();
    }

    if (!isSolid) {
      warnings.push({
        kind: "open-shell",
        message:
          "The surface is closed but OpenCascade could not turn it into a solid. " +
          "The STEP output contains the sewn shell instead.",
      });
    }
  }

  // ---------------------------------------------------------------- 5. write
  hooks.onProgress("writing", null);
  checkCancel();

  occt.Interface_Static.SetCVal("write.step.unit", stepUnitName(options.unit));

  const writer = new occt.STEPControl_Writer();
  const transferStatus = writer.Transfer(
    shape,
    occt.STEPControl_StepModelType.STEPControl_AsIs,
    true, // compute the assembly graph
    progressRange,
  );

  if (transferStatus !== occt.IFSelect_ReturnStatus.IFSelect_RetDone) {
    writer.delete();
    throw new GeometryError(
      `OpenCascade could not translate the shape to STEP (${transferStatus}).`,
    );
  }

  const writeStatus = writer.Write(STEP_TEMP_PATH);
  if (writeStatus !== occt.IFSelect_ReturnStatus.IFSelect_RetDone) {
    writer.delete();
    throw new GeometryError(
      `OpenCascade could not write the STEP file (${writeStatus}).`,
    );
  }
  writer.delete();

  const written = occt.FS.readFile(STEP_TEMP_PATH, { encoding: "binary" });
  const step = new ArrayBuffer(written.length);
  new Uint8Array(step).set(written);
  occt.FS.unlink(STEP_TEMP_PATH);
  progressRange.delete();

  const stats: ConversionStats = {
    triangleCount,
    uniqueVertexCount: welded.uniqueVertexCount,
    faceCount,
    freeEdgeCount,
    multipleEdgeCount,
    isSolid,
    warnings,
    elapsedMs: Date.now() - startedAt,
  };

  return { step, stats };
}

/** Depth-first search for the first shell inside a sewn shape. */
function findFirstShell(
  occt: OpenCascadeInstance,
  shape: TopoDS_Shape,
): ReturnType<OpenCascadeInstance["TopoDS"]["Shell"]> | null {
  const explorer = new occt.TopExp_Explorer(
    shape,
    occt.TopAbs_ShapeEnum.TopAbs_SHELL,
    occt.TopAbs_ShapeEnum.TopAbs_SHELL,
  );
  try {
    if (!explorer.More()) return null;
    return occt.TopoDS.Shell(explorer.Current());
  } finally {
    explorer.delete();
  }
}