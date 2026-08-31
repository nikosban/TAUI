import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@tui-designer/core": new URL("../core/src/index.ts", import.meta.url).pathname },
  },
  test: {
    // "node", not jsdom: every module under test here is deliberately DOM-free.
    // A test that reaches for `document` should fail rather than pass by accident.
    // Component tests opt into jsdom per file, keeping every pure test honest.
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    // CI runs the full suite before its pure-module coverage pass. Loading App
    // from a second jsdom worker during V8 coverage creates duplicate source-map
    // branch records in unrelated port modules, while the React/a11y surface is
    // deliberately outside the coverage include list below. Avoid repeating the
    // slower axe suite in that duplicate pass; ordinary `pnpm test` still gates it.
    exclude: process.argv.includes("--coverage") ? ["test/accessibility.test.tsx"] : undefined,
    coverage: {
      provider: "v8",
      // Every pure module. `renderer.ts`, `measure.ts`, and the React components
      // are the only untested-by-unit code, per the GUI spec.
      include: [
        "src/canvas/metrics.ts",
        "src/canvas/paint-plan.ts",
        "src/canvas/coverage.ts",
        "src/gestures/**/*.ts",
        "src/layers/panel-model.ts",
        "src/files/export.ts",
        "src/inspect/inspect-model.ts",
        "src/palette/palette-model.ts",
        "src/shortcuts.ts",
        "src/ports/**/*.ts",
      ],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
