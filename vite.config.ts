import { defineConfig } from "vite";

export default defineConfig({
  // Model files are cached per origin (scheme + host + port). A drifting port
  // would mean a fresh multi-hundred-MB download, so never fall back to another.
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: "es" },
});
