import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps the build portable: the same `dist/` works when served
// from a domain root, from a GitHub Pages sub-path, or from a preview folder.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    // Three.js + React + the OpenCascade glue live in separate chunks already;
    // this just silences the (expected) warning for the occt glue chunk.
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: "es",
  },
  server: {
    // The OpenCascade wasm is served from /public. During dev Vite streams it
    // correctly; these headers only matter for some proxies.
    headers: {
      "Cache-Control": "no-store",
    },
  },
});