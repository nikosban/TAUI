/**
 * Minimal ambient declarations for the two platform globals this package uses.
 *
 * Both are WinterCG-standard and present in Node 20+, every target browser, and
 * Tauri's webview. They are declared by hand rather than by adding the `DOM` lib
 * to tsconfig, because `lib: ["ES2022"]` with no DOM is exactly what enforces
 * design principle 1 — a stray `document.querySelector` must not typecheck.
 */

declare const crypto: {
  randomUUID(): string;
};

declare const performance: {
  now(): number;
};
