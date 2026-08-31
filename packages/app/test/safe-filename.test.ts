import { describe, expect, it } from "vitest";
import {
  filenameProblem,
  SAFE_FILENAME_MAX_CHARS,
  safeDocumentFilename,
  safeFilename,
} from "../src/safe-filename.js";

describe("safeFilename", () => {
  it("normalises an extension and supplies a visible fallback", () => {
    expect(safeDocumentFilename("mockup")).toBe("mockup.tui");
    expect(safeDocumentFilename("mockup.TUI")).toBe("mockup.tui");
    expect(safeDocumentFilename(".tui")).toBe("untitled.tui");
    expect(safeDocumentFilename(null)).toBe("untitled.tui");
  });

  it("removes control and bidi-spoofing characters at the boundary", () => {
    expect(safeDocumentFilename("safe\u0000\u001f\u202Egnp")).toBe("safegnp.tui");
    expect(safeDocumentFilename("a\u2066b\u2069c")).toBe("abc.tui");
    expect(safeDocumentFilename("a\ud800b")).toBe("ab.tui");
  });

  it("turns paths and filesystem-reserved punctuation into one basename", () => {
    expect(safeDocumentFilename("../../folder\\name:bad?.tui")).toBe("-..-folder-name-bad-.tui");
  });

  it("avoids hidden and Windows device names", () => {
    expect(safeDocumentFilename("...secret...")).toBe("secret.tui");
    expect(safeDocumentFilename("CON")).toBe("CON-file.tui");
    expect(safeDocumentFilename("lpt9.notes")).toBe("lpt9.notes-file.tui");
  });

  it("bounds Unicode names without splitting surrogate pairs", () => {
    const result = safeDocumentFilename("😀".repeat(200));
    expect([...result]).toHaveLength(SAFE_FILENAME_MAX_CHARS);
    expect(result.endsWith(".tui")).toBe(true);
    expect(result).not.toContain("�");
  });

  it("supports the fixed export extensions and rejects invalid extensions", () => {
    expect(safeFilename("screen.tui", "svg")).toBe("screen.tui.svg");
    expect(() => safeFilename("screen", "../svg")).toThrow(/invalid filename extension/u);
  });
});

describe("filenameProblem", () => {
  it("rejects values the save dialog must not silently rewrite", () => {
    expect(filenameProblem(" ")).toMatch(/enter/iu);
    expect(filenameProblem("a/b")).toMatch(/separator/u);
    expect(filenameProblem("a?.tui")).toMatch(/reserved/u);
    expect(filenameProblem("safe\u202Egnp")).toMatch(/text-direction/u);
    expect(filenameProblem("x".repeat(SAFE_FILENAME_MAX_CHARS + 1))).toMatch(/120/u);
  });

  it("allows ordinary Unicode document names", () => {
    expect(filenameProblem("Σχέδιο οθόνης.tui")).toBeNull();
  });
});
