/**
 * Architectural constraints that need to read source, and so cannot live in the
 * test suite. Run with `pnpm check:arch`. Exits non-zero on violation.
 *
 * The type system already makes `commit(drawBox(...))` impossible. These rules
 * cover the remaining ways someone could route around it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly detail: string;
}

const violations: Violation[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/u.test(entry)) out.push(full);
  }
  return out;
}

/** Strips comments so prose may legitimately mention a restricted name. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");

interface Rule {
  readonly name: string;
  /** What to look for in the importing file's code. */
  readonly pattern: RegExp;
  /** Paths (relative to src/, posix) permitted to match. */
  readonly allow: readonly RegExp[];
  readonly why: string;
}

const RULES: readonly Rule[] = [
  {
    name: "sealCommit-confined-to-gestures",
    pattern: /\bsealCommit\b/u,
    allow: [/^gestures\//u],
    why:
      "sealCommit is the only way to brand a CommittedDoc. Confining it to the " +
      "gesture machinery is what makes 'one gesture = one history entry' hold.",
  },
  {
    name: "push-confined-to-document-store",
    pattern: /^\s*import\s+\{[^}]*\bpush\b[^}]*\}\s+from\s+"@tui-designer\/core"/mu,
    allow: [/^stores\/document-store\.ts$/u],
    why: "core's history push must have exactly one call site in the app.",
  },
  {
    name: "layer-index-inversion-confined-to-panel-model",
    // `length - 1 - i` is the display↔array reflection written out by hand.
    pattern: /length\s*-\s*1\s*-/u,
    allow: [/^layers\/panel-model\.ts$/u],
    why:
      "doc.layers is bottom-up while the panel lists top-first. Re-deriving that " +
      "inversion inline is how a plausible-looking index silently reorders a " +
      "document; route it through arrayIndexFromDisplay, which is tested.",
  },
  {
    name: "adapters-confined-to-ports-index",
    // Importing a concrete backend rather than the FileStore interface.
    pattern: /from\s+"[^"]*(memory-file-store|opfs-file-store|tauri-file-store)/u,
    allow: [/^ports\/index\.ts$/u],
    why:
      "ports/index.ts is the only module that may know which backend exists. " +
      "That is what makes adding the Tauri adapter a one-file change; a direct " +
      "import from elsewhere quietly pins a caller to one implementation.",
  },
  {
    name: "tauri-confined-to-ports",
    pattern: /from\s+"@tauri-apps\//u,
    allow: [/^ports\//u],
    why: "Keeping Tauri imports inside ports/ is what makes the G4 swap one file.",
  },
];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split("\\").join("/");
  const code = codeOnly(readFileSync(file, "utf8"));
  for (const rule of RULES) {
    if (!rule.pattern.test(code)) continue;
    if (rule.allow.some((allowed) => allowed.test(rel))) continue;
    violations.push({ rule: rule.name, file: rel, detail: rule.why });
  }
}

// Sanity: the checker must actually be looking at files, or it would pass vacuously.
const scanned = walk(SRC).length;
if (scanned < 5) {
  violations.push({
    rule: "sanity",
    file: "src/",
    detail: `only ${scanned} source files found — wrong path?`,
  });
}

if (violations.length > 0) {
  process.stderr.write("architectural check FAILED\n\n");
  for (const v of violations) {
    process.stderr.write(`  [${v.rule}] ${v.file}\n      ${v.detail}\n`);
  }
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write(`architectural checks passed (${scanned} files)\n`);
