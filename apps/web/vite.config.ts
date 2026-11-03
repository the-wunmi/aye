/**
 * Cross-origin isolation (COOP/COEP) is on in dev and preview so SharedArrayBuffer is
 * available when the sim↔renderer channel moves to shared memory.
 *
 * In development the API (and the realm's WebSocket) is proxied under /api, so the game, its
 * session cookie and its socket all share one origin, as they do in production.
 *
 * The strict CSP is applied to `preview` (production build) only: Vite's dev server needs
 * inline scripts (React refresh preamble) and a websocket for HMR. Production hosting must
 * send the same CSP header as `preview` below.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig({
  plugins: [react()],
  server: {
    headers: isolation,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    headers: {
      ...isolation,
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
  worker: { format: "es" },
  build: {
    target: "es2024",
    sourcemap: true,
    rolldownOptions: {
      output: {
        // three.js changes far less often than app code: give it its own long-cached chunk.
        codeSplitting: {
          groups: [
            { name: "three", test: /node_modules[\\/]three[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
