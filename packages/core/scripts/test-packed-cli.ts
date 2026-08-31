/**
 * Exercises the package users actually install, rather than importing the CLI
 * command body from source. The tarball is installed into a fresh pnpm project,
 * then invoked through pnpm's bin shim and through a direct symlink to the
 * installed executable.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

const packageRoot = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "tui-packed-cli-"));
const consumer = join(scratch, "consumer");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function execute(command: string, args: readonly string[], cwd = consumer): Result {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    timeout: 20_000,
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function expectResult(
  result: Result,
  expected: { readonly status: number; readonly stdout?: RegExp; readonly stderr?: RegExp },
): void {
  assert.equal(
    result.status,
    expected.status,
    `unexpected stderr: ${JSON.stringify(result.stderr)}`,
  );
  if (expected.stdout !== undefined) assert.match(result.stdout, expected.stdout);
  if (expected.stderr !== undefined) assert.match(result.stderr, expected.stderr);
}

try {
  const packed = execute(
    packageManager,
    ["pack", "--json", "--pack-destination", scratch],
    packageRoot,
  );
  expectResult(packed, { status: 0 });
  const packInfo = JSON.parse(packed.stdout) as PackResult;
  const packedPaths = packInfo.files.map((file) => file.path);

  assert.equal(
    packedPaths.some((path) => /(^|[/\\])metafile(?:-[^/\\]+)?\.json$/u.test(path)),
    false,
    `package leaked build metafiles: ${packedPaths.join(", ")}`,
  );
  assert.equal(
    packedPaths.some((path) => path.endsWith(".tsbuildinfo")),
    false,
    `package leaked TypeScript build state: ${packedPaths.join(", ")}`,
  );
  assert.ok(packedPaths.includes("dist/bin/main.js"), "package omitted the CLI executable");

  const tarball = resolve(packageRoot, packInfo.filename);
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, name: "packed-cli-consumer" }, null, 2)}\n`,
  );
  // A local tarball plus offline mode keeps the harness independent of both the
  // caller's workspace and registry availability.
  const install = execute(
    packageManager,
    ["add", "--ignore-scripts", "--offline", tarball],
    consumer,
  );
  expectResult(install, { status: 0 });

  const installedRoot = join(consumer, "node_modules", "@tui-designer", "core");
  const installedEntry = join(installedRoot, "dist", "bin", "main.js");
  const directLink = join(
    consumer,
    process.platform === "win32" ? "tui-designer.js" : "tui-designer",
  );
  symlinkSync(installedEntry, directLink, process.platform === "win32" ? "file" : undefined);

  const throughShim = (args: readonly string[]): Result =>
    execute(packageManager, ["exec", "tui-designer", ...args]);
  // POSIX executes the shebang and packed mode bits exactly as a shell would.
  // Windows has no executable symlink convention, so Node opens the same link.
  const throughDirectLink = (args: readonly string[]): Result =>
    process.platform === "win32"
      ? execute(process.execPath, [directLink, ...args])
      : execute(directLink, args);

  for (const invoke of [throughShim, throughDirectLink]) {
    const help = invoke(["--help"]);
    expectResult(help, { status: 0, stdout: /tui-designer — TUI Designer document tools/u });
    assert.equal(help.stderr, "");
  }

  const art = "┌──┐\n│hi│\n└──┘\n";
  writeFileSync(join(consumer, "art.txt"), art);
  const imported = throughShim(["import", "art.txt", "--cols", "4", "-o", "art.tui"]);
  expectResult(imported, { status: 0, stderr: /imported 4×3, colorMode ansi256/u });
  assert.equal(imported.stdout, "");
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(consumer, "art.tui"), "utf8")));

  const text = throughDirectLink(["render", "art.tui", "--text"]);
  expectResult(text, { status: 0 });
  assert.equal(text.stdout, art);
  assert.equal(text.stderr, "");

  const ansi = throughShim(["render", "art.tui", "--ansi"]);
  expectResult(ansi, { status: 0 });
  assert.ok(ansi.stdout.includes("\u001b["), "ANSI render omitted terminal escapes");
  assert.equal(ansi.stderr, "");

  const svg = throughDirectLink(["render", "art.tui", "--svg"]);
  expectResult(svg, { status: 0, stdout: /^<svg[\s\S]*<\/svg>\n$/u });
  assert.equal(svg.stderr, "");

  writeFileSync(join(consumer, "bad.tui"), "{ not json\n");
  const malformed = throughShim(["render", "bad.tui", "--text"]);
  expectResult(malformed, { status: 1, stderr: /^error:/u });
  assert.equal(malformed.stdout, "");

  const usageError = throughDirectLink(["unknown-command"]);
  expectResult(usageError, { status: 2, stderr: /unknown command/u });
  assert.equal(usageError.stdout, "");

  const hostile = JSON.parse(readFileSync(join(consumer, "art.tui"), "utf8"));
  hostile.layers[0].id = "\u001b]8;;https://evil.invalid\u0007click";
  hostile.activeLayerId = "missing";
  writeFileSync(join(consumer, "hostile.tui"), `${JSON.stringify(hostile)}\n`);
  const warned = throughShim(["render", "hostile.tui", "--text"]);
  expectResult(warned, { status: 0, stderr: /warning:/u });
  assert.equal(warned.stderr.includes("\u001b"), false, "stderr contained a raw escape byte");
  assert.equal(warned.stderr.includes("\u0007"), false, "stderr contained a raw bell byte");
  assert.equal(
    warned.stdout.includes("\u001b"),
    false,
    "plain-text stdout contained an escape byte",
  );

  process.stdout.write(
    `packed CLI check passed (${basename(tarball)}, pnpm shim + direct symlink)\n`,
  );
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
