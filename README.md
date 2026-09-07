# TAUI

TAUI is a browser-first design tool for terminal user interfaces. It combines an exact-cell canvas with structured document operations, safe import/export boundaries, and deterministic renderers for ANSI, plain text, and SVG.

> **Status:** active pre-alpha development. The editor and its file formats may change before the first public release.

## What works today

- Exact terminal-cell drawing, text, fill, selection, layers, and palette editing
- Undo/redo, keyboard command discovery, and accessible modal workflows
- Browser persistence with recovery, overwrite protection, and conflict detection
- Bounded `.tui`, ANSI, and plain-text import paths
- ANSI, text, SVG, and PNG export from the browser editor
- A DOM-free TypeScript core with deterministic serialization and rendering
- A `tui-designer` CLI for importing captures and rendering `.tui` documents

The longer-term direction is a semantic `.taui` project format for multi-screen terminal design and structured developer handoff.

## Repository layout

| Package | Purpose |
| --- | --- |
| `packages/app` | React and Vite browser editor |
| `packages/core` | Pure TypeScript document, parser, history, drawing, inspection, and rendering engine |

The core package does not depend on the DOM. Browser APIs and persistence are kept behind adapters in the app package.

## Requirements

- Node.js 22.13 or newer for workspace development
- pnpm 11.19.0, as pinned by the repository

## Getting started

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @tui-designer/app dev
```

Vite prints the local editor URL after startup.

## CLI

The core package provides the `tui-designer` executable when installed as a package. From this repository, build the workspace and invoke the generated entry point directly:

```sh
pnpm build
node packages/core/dist/bin/main.js render design.tui --ansi
node packages/core/dist/bin/main.js render design.tui --svg -o design.svg
node packages/core/dist/bin/main.js import capture.ans -o imported.tui
```

Installed-package behavior is exercised separately in an isolated temporary project by the test suite.

## Verification

The required GitHub Actions gate runs the build, unit and component tests, browser smoke tests, coverage thresholds, type checks, formatting and lint rules, architecture and unused-code checks, generated-file validation, dependency audits, and packed-package validation.

Useful local commands:

```sh
pnpm build
pnpm test
pnpm test:e2e
pnpm test:coverage
pnpm typecheck
pnpm check
pnpm check:arch
pnpm check:unused
pnpm audit
```

Run the focused command that matches your change during development; the complete gate is enforced in CI.

## Browser storage and files

When supported, the editor persists projects in the browser's origin-private file system. It falls back explicitly when persistent storage is unavailable. Use export/download for user-controlled copies and treat browser data as local application state rather than a backup.

Imported documents and terminal captures are untrusted input. Parsers, serializers, renderers, filenames, and resource usage are validated or bounded at their respective trust boundaries.

## Contributing

Issues and focused pull requests are welcome. Keep the core framework-neutral and DOM-free, preserve deterministic output, and include regression coverage for behavior changes.
