import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "node" rather than "jsdom" on purpose: a core test that reaches for the DOM
    // must FAIL, not pass by accident. Design principle 1.
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The spec mandates 100% of ops/ and render/. history/ is held to the same
      // bar because it is small, pure, and the GUI's undo correctness rests on it.
      // The spec mandates ops/ and render/. history/ and the two importers are
      // held to the same bar deliberately: history/ is what undo correctness
      // rests on, and a parser's uncovered branch is exactly where a mis-measured
      // escape sequence hides.
      //
      // `io/file.ts` is NOT here yet — its `deserialize` repair paths sit around
      // 78% branch coverage, and those are the very behaviours the README makes
      // specific promises about (dangling palette refs baked, activeLayerId
      // falling back, malformed cell keys dropped, v0 migration). Adding it needs
      // its own pass rather than a silently lowered threshold.
      include: [
        "src/ops/**",
        "src/render/**",
        "src/history/**",
        "src/io/ansi-import.ts",
        "src/io/text-import.ts",
        "src/handoff/**",
        "src/bin/**",
      ],
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
