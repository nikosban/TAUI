import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Production is a closed local application: no remote connections, frames,
 * plugins, workers, or inline scripts. Dynamic swatch colours are React style
 * attributes, so `style-src-attr` is the one narrowly-scoped inline exception;
 * stylesheet elements still have to come from this origin.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Vite development needs its inline React-refresh preamble, injected style
 * elements, and one local HMR WebSocket. Those exceptions never enter the built
 * HTML; `scripts/check-production.ts` makes that separation a build invariant.
 */
const DEVELOPMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:5273 ws://localhost:5273",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`;

/**
 * Future Tauri boundary: reuse PRODUCTION_CSP in `app.security.csp`, add
 * `frame-ancestors 'none'` as an HTTP/native header, and grant only the main
 * window's dialog-scoped open/save capability. Do not enable shell, network, or
 * broad filesystem scopes; native paths remain adapter-owned and canonicalized.
 */
export default defineConfig({
  plugins: [
    react(),
    {
      name: "taui-production-csp",
      transformIndexHtml: {
        order: "pre",
        handler(html, context) {
          if (context.server !== undefined) return html;
          return html.replace(
            "<!-- TAUI_PRODUCTION_CSP: replaced by Vite during production builds. -->",
            cspMeta,
          );
        },
      },
    },
  ],
  resolve: {
    // Consume core from source in dev so edits are picked up without a rebuild.
    // The published `exports` map is exercised separately by `pnpm lint:pkg`.
    alias: { "@tui-designer/core": new URL("../core/src/index.ts", import.meta.url).pathname },
  },
  server: {
    port: 5273,
    strictPort: true,
    headers: { "Content-Security-Policy": DEVELOPMENT_CSP },
  },
  preview: {
    port: 5273,
    strictPort: true,
    headers: {
      "Content-Security-Policy": `${PRODUCTION_CSP}; frame-ancestors 'none'`,
    },
  },
});
