/**
 * The CLI: a thin wrapper so `.tui` documents can live in a repo and render in
 * CI or a docs pipeline.
 *
 * This module is the importable command body. The tiny executable shell lives in
 * `bin/main.ts`, so importing `run` in a test can never inspect argv or touch the
 * filesystem. Both import solely from `index.ts`, which doubles as a public-API
 * completeness check.
 *
 * PNG export is deliberately absent. Rasterising needs font rendering, which is
 * three lines in the GUI (canvas → blob) and a dependency tarpit headlessly.
 */

import {
  deserialize,
  parseAnsi,
  parseText,
  RESOURCE_LIMITS,
  serialize,
  type TuiDocument,
  toAnsi,
  toSvg,
  toText,
} from "../index.js";

const USAGE = `tui-designer — TUI Designer document tools

  tui-designer render <file.tui> [--ansi|--svg|--text]
  tui-designer import <capture.ans|capture.txt> [-o <out.tui>] [--cols N]

Options
  --ansi        ANSI escapes, ready to cat or printf (default for render)
  --svg         standalone SVG
  --text        characters only, no colour
  -o <file>     write to a file instead of stdout
  --cols N      fix the grid width on import (also makes erase-to-EOL exact)
  -h, --help    this message
`;

/** A parse failure the user caused, as opposed to a crash. */
class UsageError extends Error {}

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
}

/** Splits argv. Kept separate from `main` so it is testable without a process. */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-o" || arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a filename`);
      options.set("out", value);
      i++;
    } else if (arg === "--cols") {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError("--cols needs a number");
      options.set("cols", value);
      i++;
    } else if (arg.startsWith("-")) {
      flags.add(arg.replace(/^--?/u, ""));
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] ?? "", positional: positional.slice(1), flags, options };
}

/** The single output format, rejecting a request for two at once. */
function formatOf(flags: ReadonlySet<string>): "ansi" | "svg" | "text" {
  const chosen = (["ansi", "svg", "text"] as const).filter((f) => flags.has(f));
  if (chosen.length > 1) {
    throw new UsageError(`pick one format, got: ${chosen.map((f) => `--${f}`).join(" ")}`);
  }
  // ANSI is the default because `tui-designer render x.tui` in a terminal should
  // show you the thing, in colour.
  return chosen[0] ?? "ansi";
}

function positiveInt(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Renders a document to the requested format. Pure; exported for tests. */
export function renderDocument(doc: TuiDocument, format: "ansi" | "svg" | "text"): string {
  if (format === "svg") return toSvg(doc);
  if (format === "text") return `${toText(doc)}\n`;
  return `${toAnsi(doc)}\n`;
}

/** True when the capture looks like it contains ANSI escapes. */
const hasEscapes = (input: string): boolean => input.includes("\x1b");

export interface Io {
  /** Implementations should reject the file before reading when it exceeds maxBytes. */
  readonly readFile: (path: string, maxBytes: number) => string;
  readonly writeFile: (path: string, data: string) => void;
  readonly stdout: (data: string) => void;
  readonly stderr: (data: string) => void;
}

/**
 * The CLI body, with IO injected.
 *
 * Returns the process exit code rather than calling `process.exit`, so tests
 * drive it directly with in-memory IO and no filesystem.
 */
export function run(argv: readonly string[], io: Io): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }

  const helpRequested = args.flags.has("h") || args.flags.has("help");
  if (helpRequested || args.command === "") {
    io.stdout(USAGE);
    return helpRequested ? 0 : 2;
  }

  try {
    switch (args.command) {
      case "render": {
        const path = args.positional[0];
        if (path === undefined) throw new UsageError("render needs a file");
        const { doc, warnings } = deserialize(io.readFile(path, RESOURCE_LIMITS.documentTextChars));
        for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
        const output = renderDocument(doc, formatOf(args.flags));
        const out = args.options.get("out");
        if (out === undefined) io.stdout(output);
        else io.writeFile(out, output);
        return 0;
      }

      case "import": {
        const path = args.positional[0];
        if (path === undefined) throw new UsageError("import needs a file");
        const raw = io.readFile(path, RESOURCE_LIMITS.importTextChars);
        const colsRaw = args.options.get("cols");
        const cols = colsRaw === undefined ? undefined : positiveInt(colsRaw, "--cols");
        // A capture with no escapes is plain ASCII art, and parseText keeps its
        // whitespace transparent rather than painting every space.
        const { doc, warnings } = hasEscapes(raw)
          ? parseAnsi(raw, cols === undefined ? {} : { cols })
          : parseText(raw, cols === undefined ? {} : { cols });
        for (const warning of warnings) io.stderr(`warning: ${warning}\n`);

        const out = args.options.get("out");
        const serialized = serialize(doc);
        if (out === undefined) io.stdout(serialized);
        else io.writeFile(out, serialized);
        io.stderr(`imported ${doc.cols}×${doc.rows}, colorMode ${doc.colorMode}\n`);
        return 0;
      }

      default:
        throw new UsageError(`unknown command ${JSON.stringify(args.command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    // A genuine failure: an unreadable file, or malformed JSON.
    io.stderr(`error: ${(error as Error).message}\n`);
    return 1;
  }
}
