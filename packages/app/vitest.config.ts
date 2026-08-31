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
