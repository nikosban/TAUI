import { defineConfig } from "tsup";

/**
 * Two entries, deliberately different platforms.
 *
 * The library entry is `platform: "browser"` so esbuild *errors* on any import of
 * a Node builtin — design principle 1 (no DOM, no Node) enforced at build time
 * rather than by review. The CLI is the single file allowed to touch Node.
 */
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    platform: "browser",
    target: "es2022",
    dts: true,
    sourcemap: true,
    treeshake: true,
    clean: true,
    // Read by scripts/check-bundle.ts, which asserts the shipped artifact reaches
    // no Node builtin and never pulls in bin/cli.
    metafile: true,
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
  {
    // The single file permitted to touch Node APIs, hence its own platform. It
    // imports only from index.ts, which `scripts/check-bundle.ts` relies on to
    // assert the library entry never reaches `bin/cli`.
    entry: { "bin/cli": "src/bin/cli.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: false,
    sourcemap: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
