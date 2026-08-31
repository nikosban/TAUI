import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "node" rather than "jsdom" on purpose: a core test that reaches for the DOM
    // must FAIL, not pass by accident. Design principle 1.
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The spec mandates 100% of ops/ and render/. The persisted-file boundary,
      // history, importers, handoff, and CLI are held to the same bar: an
      // uncovered parser or repair branch is exactly where hostile input or a
      // silent data-loss regression hides.
      include: [
        "src/ops/**",
        "src/render/**",
        "src/history/**",
        "src/io/ansi-import.ts",
        "src/io/file.ts",
        "src/io/text-import.ts",
        "src/handoff/**",
        "src/bin/**",
      ],
      // The tiny executable shim is exercised by spawned-process CLI tests;
      // V8 cannot merge that child process into this worker's coverage map.
      exclude: ["src/bin/main.ts"],
      thresholds: {
        // The spec requires 100% of ops/ and render/.
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
