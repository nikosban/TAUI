/**
 * Emits `src/ops/box-table.ts` from the Unicode names in `box-names.ts`.
 *
 * Dev-only: this is one of the few files permitted to touch Node APIs, and it is
 * never bundled. Run with `pnpm gen:box-table`.
 *
 * The emitted file is committed so the runtime needs no parser and reviewers can
 * see the table. `test/box-table.test.ts` re-derives it from the same names and
 * asserts deep equality, so a stale or hand-edited table fails CI.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIRECTIONS } from "../src/ops/arms.js";
import { buildTable } from "./box-names.js";

const SHORT: Record<string, string> = { none: "-", light: "L", heavy: "H", double: "D" };

function main(): void {
  const entries = buildTable().sort((a, b) => a.codePoint - b.codePoint);

  const codes = new Set(entries.map((e) => e.code));
  if (codes.size !== entries.length) {
    throw new Error(
      `Arms -> char mapping is not injective: ${entries.length} entries, ${codes.size} distinct codes`,
    );
  }

  const rows = entries.map((e) => {
    const armsPicture = DIRECTIONS.map((d) => SHORT[e.arms[d]] ?? "?").join("");
    const hex = e.code.toString(16).padStart(2, "0");
    const cp = e.codePoint.toString(16).toUpperCase().padStart(4, "0");
    return `  [0x${hex}, "${e.char}"], // U+${cp}  ${armsPicture}  ${e.name}`;
  });

  const output = `/**
 * GENERATED — do not edit by hand. Run \`pnpm gen:box-table\` to regenerate.
 *
 * The ${entries.length} arm-bearing characters of U+2500–U+257F, derived from their Unicode
 * names by \`scripts/box-names.ts\`. The ${128 - entries.length} excluded glyphs are the dash, arc,
 * and diagonal variants, which carry no junction semantics.
 *
 * Each entry is \`[ArmsCode, char]\`. The comment shows the decoded arms in
 * up/down/left/right order, where \`-\`=none, \`L\`=light, \`H\`=heavy, \`D\`=double.
 *
 * The mapping is a **bijection**: ${entries.length} characters, ${codes.size} distinct codes, no
 * collisions. That is why the reverse lookup needs no tie-breaking policy.
 */

import type { ArmsCode } from "./arms.js";

export const BOX_TABLE: readonly (readonly [ArmsCode, string])[] = [
${rows.join("\n")}
];
`;

  const here = dirname(fileURLToPath(import.meta.url));
  const target = join(here, "..", "src", "ops", "box-table.ts");
  writeFileSync(target, output, "utf8");
  process.stdout.write(
    `wrote ${entries.length} entries to ${target}\n` +
      `run \`pnpm biome format --write ${target}\` if formatting drifts\n`,
  );
}

main();
