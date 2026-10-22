import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { Preview2D } from "./Preview2D";
import { CompareOverlay } from "./CompareOverlay";

export interface PreviewCanvasProps {
  /**
   * The raw STL bytes. Read in place — Three.js's loader does not detach the
   * buffer — so the app can keep it for conversion.
   */
  stlBuffer: ArrayBuffer;
  /**
   * Positions from our own parser, used only if Three.js cannot read the file.
   * Lets the preview degrade instead of failing.
   */
  fallbackPositions: Float32Array;
  /** Human-readable size, shown next to the reset button. */
  sizeLabel?: string;
  /** Show the STL / STEP before-and-after swipe once a result exists. */
  comparison?: boolean;
}

const BACKGROUND = 0x0d1014;
const GRID_COLOUR = 0x262b33;

/** A GPU process that is still starting can hand out a failed first context. */
const MAX_CONTEXT_ATTEMPTS = 3;

/** Above this, drawing every triangle edge costs more than it explains. */
const MAX_COMPARE_EDGE_TRIANGLES = 80_000;

interface SceneHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  api: { resetView: () => void };
  sphere: THREE.Sphere;
}

/**
 * Three.js preview.
 *
 * Deliberately plain: one shaded mesh, a grid and an axis hint, with
 * OrbitControls for orbit / zoom / pan. None of this is involved in the
 * conversion — it exists so the user can confirm they picked the right file.
 *
 * WebGL is treated as a nice-to-have. Rather than asking the browser up front
 * whether it can render (a bare `getContext` probe is stricter than Three.js
 * and its verdict would have to be cached, so one unlucky answer would disable
 * the preview for the whole session), we build the real renderer and only fall
 * back to the placeholder if that actually throws.
 */
export function PreviewCanvas({
  stlBuffer,
  fallbackPositions,
  sizeLabel,
  comparison = false,
}: PreviewCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<SceneHandles | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const edgesRef = useRef<THREE.LineSegments | null>(null);
  const beforeMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const afterMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const comparisonRef = useRef(comparison);
  const splitRef = useRef(0.5);

  const [attempt, setAttempt] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [split, setSplit] = useState(0.5);

  useEffect(() => {
    comparisonRef.current = comparison;
  }, [comparison]);

  useEffect(() => {
    splitRef.current = split;
  }, [split]);

  // Three.js does the STL decoding for the preview. That is a second,
  // independent implementation from ours, so a disagreement between the two
  // shows up as a visibly wrong model rather than a silently bad one. If
  // Three.js chokes on a file ours accepted, fall back to our own positions
  // rather than losing the preview.
  const positions = useMemo(() => {
    try {
      const geometry = new STLLoader().parse(stlBuffer);
      const attribute = geometry.attributes.position;
      if (attribute === undefined || attribute.count === 0) return fallbackPositions;
      const array = new Float32Array(attribute.array as Float32Array);
      geometry.dispose();
      return array;
    } catch (error) {
      console.warn("Three.js could not read this STL; using our own parser.", error);
      return fallbackPositions;
    }
  }, [stlBuffer, fallbackPositions]);

  // --- scene setup --------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    let cleanUp: (() => void) | null = null;

    const build = () => {
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true });
      } catch (error) {
        console.warn("Could not create a WebGL context.", error);
        return false;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(BACKGROUND, 1);
      // The comparison view renders each half of the canvas with its own
      // scissor rect, so clearing has to be explicit and happen once.
      renderer.autoClear = false;
      renderer.domElement.setAttribute("aria-hidden", "true");
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(BACKGROUND);

      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100_000);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.9;

      scene.add(new THREE.HemisphereLight(0xdfe7f5, 0x1b2130, 2.2));

      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(1, 1.4, 1);
      scene.add(key);

      const fill = new THREE.DirectionalLight(0x88aaff, 0.55);
      fill.position.set(-1.2, 0.3, -0.8);
      scene.add(fill);

      // Built at unit size and scaled to the model in resetView(), so the grid
      // reads the same whatever the part's dimensions are.
      const grid = new THREE.GridHelper(1, 10, GRID_COLOUR, GRID_COLOUR);
      scene.add(grid);

      const axes = new THREE.Group();
      const axisColours = [0xd9534f, 0x5cb85c, 0x4a90d9];
      const axisDirections = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
      ];
      axisDirections.forEach((direction, index) => {
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          direction,
        ]);
        axes.add(
          new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({ color: axisColours[index] }),
          ),
        );
      });
      scene.add(axes);

      const sphere = new THREE.Sphere(new THREE.Vector3(), 1);

      const api = {
        resetView() {
          const radius = Math.max(sphere.radius, 1e-4);
          const centre = sphere.center;

          // Sit the ground plane just under the model instead of through it.
          grid.position.set(centre.x, centre.y - radius, centre.z);
          grid.scale.setScalar(radius * 4);
          axes.position.copy(grid.position);
          axes.scale.setScalar(radius * 4);

          const distance = radius * 3.2;
          const offset = new THREE.Vector3(1.1, 0.8, 1.3)
            .normalize()
            .multiplyScalar(distance);

          camera.position.copy(centre).add(offset);
          camera.near = Math.max(distance / 500, 1e-4);
          camera.far = distance * 20;
          camera.updateProjectionMatrix();

          controls.target.copy(centre);
          controls.minDistance = distance / 100;
          controls.maxDistance = distance * 15;
          controls.update();
        },
      };

      handlesRef.current = { scene, camera, api, sphere };

      const resize = () => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (width === 0 || height === 0) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();

      const observer = new ResizeObserver(resize);
      observer.observe(host);

      const drawScene = () => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (width === 0 || height === 0) return;

        renderer.setScissorTest(false);
        renderer.clear();

        const mesh = meshRef.current;
        const edges = edgesRef.current;

        if (comparisonRef.current && mesh !== null) {
          const splitX = Math.round(
            Math.min(0.98, Math.max(0.02, splitRef.current)) * width,
          );

          // Left: the raw STL mesh, with every triangle edge drawn.
          mesh.material = beforeMaterialRef.current ?? mesh.material;
          if (edges !== null) edges.visible = true;
          renderer.setScissorTest(true);
          renderer.setScissor(0, 0, splitX, height);
          renderer.render(scene, camera);

          // Right: the STEP output, cleanly shaded without the mesh lattice.
          mesh.material = afterMaterialRef.current ?? mesh.material;
          if (edges !== null) edges.visible = false;
          renderer.setScissor(splitX, 0, width - splitX, height);
          renderer.render(scene, camera);

          renderer.setScissorTest(false);
          if (edges !== null) edges.visible = true;
          return;
        }

        if (mesh !== null && beforeMaterialRef.current !== null) {
          mesh.material = beforeMaterialRef.current;
        }
        if (edges !== null) edges.visible = false;
        renderer.render(scene, camera);
      };

      let frame = requestAnimationFrame(function animate() {
        frame = requestAnimationFrame(animate);
        controls.update();
        drawScene();
      });

      cleanUp = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
            object.geometry.dispose();
            const material = object.material as THREE.Material | THREE.Material[];
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material.dispose();
          }
        });
        beforeMaterialRef.current?.dispose();
        afterMaterialRef.current?.dispose();
        beforeMaterialRef.current = null;
        afterMaterialRef.current = null;
        edgesRef.current = null;
        renderer.dispose();
        renderer.domElement.remove();
        handlesRef.current = null;
        meshRef.current = null;
      };

      return true;
    };

    const succeeded = build();

    if (succeeded) {
      setSceneReady(true);
    } else if (!cancelled) {
      if (attempt + 1 < MAX_CONTEXT_ATTEMPTS) {
        // Retry: the common cause is a GPU process that is still coming up, and
        // waiting a beat makes the preview work in cases it otherwise would
        // not. Crucially the canvas host has to stay mounted during this, so
        // `webglFailed` is only set once the attempts are exhausted.
        const timer = window.setTimeout(() => {
          if (!cancelled) setAttempt(attempt + 1);
        }, 250);
        cleanUp = () => window.clearTimeout(timer);
      } else {
        setWebglFailed(true);
      }
    }

    return () => {
      cancelled = true;
      setSceneReady(false);
      cleanUp?.();
    };
  }, [attempt]);

  // --- mesh update: runs for a new file, and whenever the scene appears ----
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;

    const previous = meshRef.current;
    if (previous !== null) {
      handles.scene.remove(previous);
      previous.geometry.dispose();
      (previous.material as THREE.Material).dispose();
      beforeMaterialRef.current?.dispose();
      afterMaterialRef.current?.dispose();
      beforeMaterialRef.current = null;
      afterMaterialRef.current = null;
      meshRef.current = null;
    }

    if (positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // Left of the comparison divider: the raw STL surface.
    const beforeMaterial = new THREE.MeshStandardMaterial({
      color: 0x9fb4d0,
      metalness: 0.08,
      roughness: 0.62,
      flatShading: true,
      // STL meshes routinely have inconsistent winding; both sides keeps the
      // preview readable instead of half-invisible.
      side: THREE.DoubleSide,
    });

    // Right of the divider: the same faceted geometry presented as a clean,
    // machined solid — what the STEP file holds.
    const afterMaterial = new THREE.MeshStandardMaterial({
      color: 0xcbd6e6,
      metalness: 0.22,
      roughness: 0.4,
      flatShading: true,
      side: THREE.DoubleSide,
    });

    beforeMaterialRef.current = beforeMaterial;
    afterMaterialRef.current = afterMaterial;

    const mesh = new THREE.Mesh(geometry, beforeMaterial);
    handles.scene.add(mesh);
    meshRef.current = mesh;

    handles.sphere.copy(geometry.boundingSphere!);
    handles.api.resetView();
  }, [positions, sceneReady]);

  // The triangle lattice is what makes the input side read as a mesh. Skip it
  // above the threshold: the lines are invisible at that density anyway, and
  // the geometry would cost more memory than the file itself.
  useEffect(() => {
    const handles = handlesRef.current;
    const mesh = meshRef.current;
    if (handles === null || mesh === null || !comparison) return;

    const triangleCount = (mesh.geometry.getAttribute("position")?.count ?? 0) / 3;
    if (triangleCount === 0 || triangleCount > MAX_COMPARE_EDGE_TRIANGLES) return;

    const wireframe = new THREE.WireframeGeometry(mesh.geometry);
    const edges = new THREE.LineSegments(
      wireframe,
      new THREE.LineBasicMaterial({
        color: 0x93aacb,
        transparent: true,
        opacity: 0.32,
      }),
    );
    edges.renderOrder = 1;
    handles.scene.add(edges);
    edgesRef.current = edges;

    return () => {
      handles.scene.remove(edges);
      wireframe.dispose();
      (edges.material as THREE.Material).dispose();
      if (edgesRef.current === edges) edgesRef.current = null;
    };
  }, [comparison, positions, sceneReady]);

  const resetView = useCallback(() => handlesRef.current?.api.resetView(), []);

  if (webglFailed) {
    // WebGL is blocked or unavailable. Rather than showing a dead panel, fall
    // back to a CPU renderer built on Canvas 2D, which every browser can do.
    return (
      <Preview2D
        positions={positions}
        sizeLabel={sizeLabel}
        comparison={comparison}
      />
    );
  }

  return (
    <div className="preview">
      <div className="preview__canvas" ref={hostRef} />
      <div className="preview__overlay">
        {sizeLabel !== undefined && <span className="preview__size">{sizeLabel}</span>}
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={resetView}
        >
          Reset view
        </button>
      </div>
      {comparison && <CompareOverlay split={split} onSplitChange={setSplit} />}
      <p className="preview__hint">
        {comparison
          ? "Drag the handle to compare · drag the model to orbit"
          : "Drag to orbit · scroll to zoom · right-drag to pan"}
      </p>
    </div>
  );
}