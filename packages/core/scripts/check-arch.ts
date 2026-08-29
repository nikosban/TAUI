/**
 * Architectural constraints that need to read source, and therefore cannot live
 * in the test suite (no test in this package may touch the filesystem).
 *
 * Run with `pnpm check:arch`. Exits non-zero on violation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Violation {
  readonly rule: string;
  readonly detail: string;
}

const violations: Violation[] = [];

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Strips comments so a doc comment may legitimately name a character. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
}

/**
 * Rule 1: junction logic lives in exactly one module.
 *
 * `box.ts` and `line.ts` are pure geometry — they compute arms and delegate to
 * `applyArmStamps`. If either names a box-drawing character in code, someone has
 * started reimplementing junction resolution locally, which is precisely what the
 * spec forbids.
 */
for (const file of ["src/ops/box.ts", "src/ops/line.ts"]) {
  const source = read(file);
  if (source.length < 200) {
    violations.push({ rule: "sanity", detail: `${file} is suspiciously short — bad path?` });
    continue;
  }
  const offenders = [...codeOnly(source)].filter((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0x2500 && cp <= 0x257f;
  });
  if (offenders.length > 0) {
    violations.push({
      rule: "no-box-chars-outside-box-merge",
      detail: `${file} contains box-drawing characters in code: ${[...new Set(offenders)].join(" ")}`,
    });
  }
}

/**
 * Rule 2: the mutable draft never escapes into the public API.
 *
 * `model/draft.ts` hands out a mutable view of one layer. If it were exported from
 * `index.ts`, callers could mutate a document in place and every immutability
 * guarantee in the package would be void.
 */
{
  const index = read("src/index.ts");
  if (/from\s+"\.\/model\/draft\.js"/u.test(index)) {
    violations.push({
      rule: "draft-stays-internal",
      detail: "src/index.ts re-exports model/draft.js; the mutable draft must not escape",
    });
  }
}

/**
 * Rule 3: the library half touches no Node APIs.
 *
 * tsup's `platform: "browser"` catches static imports at build time, but only for
 * code reachable from the entry point. This covers everything under src/.
 */
{
  const files = [
    "src/index.ts",
    "src/io/file.ts",
    "src/io/text-import.ts",
    "src/model/cell.ts",
    "src/model/color.ts",
    "src/model/document.ts",
    "src/model/draft.ts",
    "src/model/layer.ts",
    "src/ops/arms.ts",
    "src/ops/box.ts",
    "src/ops/box-merge.ts",
    "src/ops/draw.ts",
    "src/ops/line.ts",
    "src/ops/region.ts",
    "src/render/composite.ts",
    "src/render/text.ts",
  ];
  for (const file of files) {
    let source: string;
    try {
      source = read(file);
    } catch {
      continue; // not all modules exist at every milestone
    }
    const match = /from\s+"(node:[^"]+)"/u.exec(codeOnly(source));
    if (match !== null) {
      violations.push({
        rule: "no-node-apis-in-src",
        detail: `${file} imports ${match[1]}`,
      });
    }
  }
}

if (violations.length > 0) {
  process.stderr.write("architectural check FAILED\n\n");
  for (const { rule, detail } of violations) {
    process.stderr.write(`  [${rule}] ${detail}\n`);
  }
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write("architectural checks passed\n");
