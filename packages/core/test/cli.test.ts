/**
 * The CLI.
 *
 * IO is injected, so these tests touch no filesystem — which is the standing rule
 * for this package and also the only way to assert on stderr without capturing a
 * real process.
 */

import { describe, expect, it } from "vitest";
import { type Io, parseArgs, renderDocument, run } from "../src/bin/cli.js";
import {
  createDocument,
  drawBox,
  drawText,
  RESOURCE_LIMITS,
  sequentialIdGen,
  serialize,
} from "../src/index.js";

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;

/** An in-memory filesystem plus captured streams. */
function harness(files: Record<string, string> = {}) {
  const written = new Map<string, string>();
  let out = "";
  let err = "";
  const readLimits = new Map<string, number>();
  const io: Io = {
    readFile: (path, maxBytes) => {
      readLimits.set(path, maxBytes);
      const found = files[path];
      if (found === undefined) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    writeFile: (path, data) => {
      written.set(path, data);
    },
    stdout: (data) => {
      out += data;
    },
    stderr: (data) => {
      err += data;
    },
  };
  return {
    io,
    written,
    readLimits,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

/** A small bordered document, serialized as a .tui file would be. */
function fixture(): string {
  let doc = createDocument(12, 4, { colorMode: "ansi256", idGen: sequentialIdGen() });
  doc = drawBox(
    doc,
    doc.activeLayerId,
    { top: 0, left: 0, rows: 4, cols: 12 },
    "light",
    true,
    STYLE,
  );
  doc = drawText(doc, doc.activeLayerId, 1, 2, "hi", {
    fg: { kind: "ansi16", index: 2 },
    bg: { kind: "default" },
  });
  return serialize(doc);
}

describe("parseArgs", () => {
  it("separates the command, positionals, flags, and options", () => {
    const args = parseArgs(["render", "a.tui", "--svg", "-o", "out.svg"]);
    expect(args.command).toBe("render");
    expect(args.positional).toEqual(["a.tui"]);
    expect(args.flags.has("svg")).toBe(true);
    expect(args.options.get("out")).toBe("out.svg");
  });

  it("accepts --out as well as -o", () => {
    expect(parseArgs(["render", "a", "--out", "b"]).options.get("out")).toBe("b");
  });

  it("normalises single and double dashes to the same flag name", () => {
    expect(parseArgs(["x", "-h"]).flags.has("h")).toBe(true);
    expect(parseArgs(["x", "--help"]).flags.has("help")).toBe(true);
  });

  it("reads --cols as an option, not a flag", () => {
    expect(parseArgs(["import", "a", "--cols", "80"]).options.get("cols")).toBe("80");
  });

  it("reports an option missing its value", () => {
    expect(() => parseArgs(["render", "a", "-o"])).toThrow("needs a filename");
    expect(() => parseArgs(["import", "a", "--cols"])).toThrow("needs a number");
  });
});

describe("usage", () => {
  it("prints usage and fails when given no command", () => {
    const h = harness();
    expect(run([], h.io)).toBe(2);
    expect(h.out).toContain("tui-designer render");
  });

  it("prints usage and succeeds for --help", () => {
    const h = harness();
    expect(run(["render", "--help"], h.io)).toBe(0);
    expect(h.out).toContain("Options");
  });

  it("rejects an unknown command", () => {
    const h = harness();
    expect(run(["frobnicate", "x"], h.io)).toBe(2);
    expect(h.err).toContain("unknown command");
  });

  it("rejects a bad option value before doing any work", () => {
    const h = harness();
    expect(run(["render", "a.tui", "-o"], h.io)).toBe(2);
    expect(h.err).toContain("needs a filename");
  });
});

describe("render", () => {
  it("writes ANSI to stdout by default", () => {
    const h = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui"], h.io)).toBe(0);
    // Escapes present, and the box drawn.
    expect(h.out).toContain("\x1b[");
    expect(h.out).toContain("┌");
  });

  it("writes plain text for --text, with no escapes at all", () => {
    const h = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui", "--text"], h.io)).toBe(0);
    expect(h.out).not.toContain("\x1b");
    expect(h.out.split("\n")[0]).toBe("┌──────────┐");
  });

  it("writes an SVG document for --svg", () => {
    const h = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui", "--svg"], h.io)).toBe(0);
    expect(h.out).toContain("<svg");
    expect(h.out.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("writes to a file when given -o, leaving stdout clean for piping", () => {
    const h = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui", "--svg", "-o", "out.svg"], h.io)).toBe(0);
    expect(h.out).toBe("");
    expect(h.written.get("out.svg")).toContain("<svg");
  });

  it("refuses two formats at once rather than silently picking one", () => {
    const h = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui", "--svg", "--text"], h.io)).toBe(2);
    expect(h.err).toContain("pick one format");
  });

  it("needs a file", () => {
    const h = harness();
    expect(run(["render"], h.io)).toBe(2);
    expect(h.err).toContain("render needs a file");
  });

  it("reports a missing file as a real error, not a usage error", () => {
    const h = harness();
    expect(run(["render", "nope.tui"], h.io)).toBe(1);
    expect(h.err).toContain("ENOENT");
  });

  it("reports malformed JSON as an error", () => {
    const h = harness({ "bad.tui": "{ not json" });
    expect(run(["render", "bad.tui"], h.io)).toBe(1);
    expect(h.err).toContain("error:");
  });

  it("passes deserialize warnings through to stderr, still rendering", () => {
    // The format repairs rather than rejects, so a repaired file must still
    // render — with the repair reported.
    const doc = JSON.parse(fixture());
    doc.activeLayerId = "does-not-exist";
    const h = harness({ "a.tui": JSON.stringify(doc) });
    expect(run(["render", "a.tui", "--text"], h.io)).toBe(0);
    expect(h.err).toContain("warning:");
    expect(h.out).toContain("┌");
  });

  it("escapes hostile layer ids in warnings before writing to the terminal", () => {
    const doc = JSON.parse(fixture());
    doc.layers[0].id = "\x1b]8;;https://evil.invalid\x07click";
    doc.activeLayerId = "missing";
    const h = harness({ "a.tui": JSON.stringify(doc) });
    expect(run(["render", "a.tui", "--text"], h.io)).toBe(0);
    expect(h.err).not.toContain("\x1b");
    expect(h.err).not.toContain("\x07");
    expect(h.err).toContain("\\u001b");
  });

  it("requests a bounded preflight read for document files", () => {
    const h = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui", "--text"], h.io)).toBe(0);
    expect(h.readLimits.get("a.tui")).toBe(RESOURCE_LIMITS.documentTextChars);
  });
});

describe("import", () => {
  it("requests the stricter import preflight limit", () => {
    const h = harness({ "cap.txt": "x" });
    expect(run(["import", "cap.txt"], h.io)).toBe(0);
    expect(h.readLimits.get("cap.txt")).toBe(RESOURCE_LIMITS.importTextChars);
  });
  it("parses an ANSI capture into a .tui document", () => {
    const h = harness({ "cap.ans": "\x1b[31mred\x1b[0m\nplain\n" });
    expect(run(["import", "cap.ans", "-o", "out.tui"], h.io)).toBe(0);
    const written = h.written.get("out.tui") ?? "";
    expect(written).toContain(`"name": "imported"`);
    expect(written).toContain(`"ansi16"`);
    expect(h.err).toContain("imported 5×2");
  });

  it("treats a capture with no escapes as plain text", () => {
    // parseText keeps whitespace transparent; parseAnsi would too, but choosing
    // by content means an ASCII-art file does not pay for escape scanning.
    const h = harness({ "art.txt": "┌──┐\n│ab│\n└──┘\n" });
    expect(run(["import", "art.txt", "-o", "out.tui"], h.io)).toBe(0);
    expect(h.err).toContain("imported 4×3");
  });

  it("writes to stdout when no -o is given, keeping warnings on stderr", () => {
    const h = harness({ "cap.ans": "hi\n" });
    expect(run(["import", "cap.ans"], h.io)).toBe(0);
    // stdout is pure JSON, so `tui-designer import x > y.tui` works.
    expect(() => JSON.parse(h.out)).not.toThrow();
    expect(h.err).toContain("imported");
  });

  it("honours --cols, which also makes erase-to-EOL exact", () => {
    const h = harness({ "cap.ans": "\x1b[44m\x1b[K" });
    expect(run(["import", "cap.ans", "--cols", "10", "-o", "o.tui"], h.io)).toBe(0);
    const doc = JSON.parse(h.written.get("o.tui") ?? "{}");
    expect(doc.cols).toBe(10);
    // The whole row carries the erase's background.
    expect(Object.keys(doc.layers[0].cells)).toHaveLength(10);
  });

  it("honours --cols on the plain-text path too", () => {
    // The format is chosen by content, so --cols has to reach both parsers.
    const h = harness({ "art.txt": "abcdefgh\n" });
    expect(run(["import", "art.txt", "--cols", "4", "-o", "o.tui"], h.io)).toBe(0);
    expect(JSON.parse(h.written.get("o.tui") ?? "{}").cols).toBe(4);
  });

  it("rejects a non-numeric --cols", () => {
    const h = harness({ "cap.ans": "x" });
    expect(run(["import", "cap.ans", "--cols", "wide"], h.io)).toBe(2);
    expect(h.err).toContain("must be a positive integer");
  });

  it("rejects a zero or negative --cols", () => {
    const h = harness({ "cap.ans": "x" });
    expect(run(["import", "cap.ans", "--cols", "0"], h.io)).toBe(2);
    expect(run(["import", "cap.ans", "--cols", "-4"], h.io)).toBe(2);
  });

  it("needs a file", () => {
    const h = harness();
    expect(run(["import"], h.io)).toBe(2);
    expect(h.err).toContain("import needs a file");
  });

  it("reports import warnings without failing", () => {
    const h = harness({ "cap.ans": "a\x1b[53mb" });
    expect(run(["import", "cap.ans", "-o", "o.tui"], h.io)).toBe(0);
    expect(h.err).toContain("warning: unsupported SGR parameter 53");
  });
});

describe("round trip through the CLI", () => {
  it("render --ansi then import reproduces the same text", () => {
    // The end-to-end claim: a document survives a trip out to a terminal capture
    // and back in.
    const h1 = harness({ "a.tui": fixture() });
    expect(run(["render", "a.tui", "--ansi", "-o", "cap.ans"], h1.io)).toBe(0);
    const capture = h1.written.get("cap.ans") ?? "";

    const h2 = harness({ "cap.ans": capture });
    expect(run(["import", "cap.ans", "--cols", "12", "-o", "b.tui"], h2.io)).toBe(0);

    const h3 = harness({ "b.tui": h2.written.get("b.tui") ?? "" });
    expect(run(["render", "b.tui", "--text", "-o", "b.txt"], h3.io)).toBe(0);

    const h4 = harness({ "a.tui": fixture() });
    run(["render", "a.tui", "--text", "-o", "a.txt"], h4.io);

    expect(h3.written.get("b.txt")).toBe(h4.written.get("a.txt"));
  });
});

describe("renderDocument", () => {
  it("terminates ansi and text output with a newline, so a shell prompt lands clean", () => {
    const doc = createDocument(3, 1, { idGen: sequentialIdGen() });
    expect(renderDocument(doc, "ansi").endsWith("\n")).toBe(true);
    expect(renderDocument(doc, "text").endsWith("\n")).toBe(true);
    expect(renderDocument(doc, "svg").endsWith("\n")).toBe(true);
  });
});
