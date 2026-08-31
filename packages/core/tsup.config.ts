import { defineConfig } from "tsup";

/**
 * Two entries, deliberately different platforms.
 *
 * The library entry is `platform: "browser"` so esbuild *errors* on any import of
 * a Node builtin — design principle 1 (no DOM, no Node) enforced at build time
 * rather than by review. The CLI's `main.ts` shell is the single source file
 * allowed to touch Node.
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
    // no Node builtin and never pulls in a bin module.
    metafile: true,
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
  {
    // The single file permitted to touch Node APIs, hence its own platform. Its
    // command body imports only from index.ts, while `scripts/check-bundle.ts`
    // asserts the library entry never reaches either bin module.
    entry: { "bin/main": "src/bin/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: false,
    sourcemap: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
