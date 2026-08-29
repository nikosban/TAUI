/**
 * Proves the shipped library entry is genuinely browser-safe, three ways.
 *
 * `grep -r "require("` proves nothing here — it misses a `node:fs` imported by a
 * transitive module, and it flags harmless strings. Each check below catches
 * something the others cannot:
 *
 * 1. **No Node builtin is imported**, read from the build's metafile. This covers
 *    transitive imports, and it names the importer so one run reports every
 *    offender with a path instead of failing on the first.
 * 2. **Executing the bundle touches no Node global**, with `require` and
 *    `process` shadowed by throwing proxies. This is the only check that catches
 *    a *dynamic* `await import("node:fs")`, invisible to static analysis.
 * 3. **The CLI is unreachable** from `index.ts` — no metafile input matches
 *    `bin/cli`. The CLI legitimately imports `node:fs`, so without this check the
 *    first one would have to tolerate Node builtins everywhere.
 *
 * Deliberately reads `dist/` rather than re-bundling: this tests the artifact
 * that actually ships, under the exact settings it ships with. Run `pnpm build`
 * first — the script says so if the metafile is missing.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The shape of the metafile fields this script uses. */
interface Metafile {
  readonly inputs: Record<string, { readonly imports?: readonly { readonly path: string }[] }>;
  readonly outputs: Record<string, { readonly entryPoint?: string }>;
}

const NODE_BUILTIN =
  /^(node:|(fs|path|os|crypto|util|stream|events|url|child_process|worker_threads|http|https|net|tls|zlib|assert|buffer|readline|tty|v8|vm|module|perf_hooks)$)/u;

const failures: string[] = [];
const metaPath = "dist/metafile-esm.json";

if (!existsSync(metaPath)) {
  process.stderr.write(`missing ${metaPath} — run \`pnpm build\` first\n`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Metafile;
const inputs = Object.keys(meta.inputs);

// ---- Check 3: the CLI is unreachable from the library entry ----
// Reported first: a reachable CLI would also trip check 1, and this is the more
// actionable message.
const cliInputs = inputs.filter((input) => /bin[/\\]cli/u.test(input));
if (cliInputs.length > 0) {
  failures.push(
    `index.ts reaches the CLI (${cliInputs.join(", ")}). The CLI may import Node ` +
      `APIs; the library entry may not, so it must stay unreachable from index.ts.`,
  );
}

// ---- Check 1: no Node builtin is imported, transitively or otherwise ----
for (const [input, info] of Object.entries(meta.inputs)) {
  for (const imported of info.imports ?? []) {
    if (NODE_BUILTIN.test(imported.path)) {
      failures.push(`${input} imports Node builtin "${imported.path}"`);
    }
  }
}

// ---- Check 2: executing the bundle touches no Node global ----
const bundle = readFileSync("dist/index.js", "utf8");
const scratch = join(tmpdir(), `tui-bundle-check-${process.pid}.mjs`);
try {
  // Shadowed with module-scope `const`s rather than function parameters: the
  // bundle's own `export` statements must stay at the top level, so it cannot be
  // wrapped in a function. Shadowing beats deleting the globals — it is scoped to
  // this throwaway module, and it throws at the moment of use rather than
  // resolving to undefined and failing somewhere less obvious.
  const trap = (name: string) => `new Proxy(function(){}, {
    get: (_t, p) => { throw new Error("bundle read ${name}." + String(p)); },
    apply: () => { throw new Error("bundle called ${name}"); },
  })`;
  const shadows = ["require", "process", "module", "exports", "__dirname", "__filename"]
    .map((name) => `const ${name} = ${trap(name)};`)
    .join("\n");
  writeFileSync(scratch, `${shadows}\n${bundle}\n`, "utf8");
  await import(scratch);
} catch (error) {
  failures.push(`executing dist/index.js failed: ${(error as Error).message}`);
} finally {
  rmSync(scratch, { force: true });
}

if (failures.length > 0) {
  process.stderr.write("\nbundle check FAILED\n\n");
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write(
  `bundle check passed (${inputs.length} inputs, no Node builtins, CLI unreachable)\n`,
);
