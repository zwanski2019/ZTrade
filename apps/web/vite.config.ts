import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keeps the browser same-origin in dev, so no CORS dance and the
      // WebSocket upgrade works through the same host.
      "/api": { target: "http://127.0.0.1:8788", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8788", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
