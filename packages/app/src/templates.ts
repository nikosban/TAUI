/**
 * Bundled document templates.
 *
 * Authored as ASCII art and parsed with `parseText`, which is exactly why that
 * function was pulled forward into M1 — hand-writing `.tui` JSON is miserable.
 * These double as engine fixtures.
 */

import { createDocument, parseText, type TuiDocument } from "@tui-designer/core";

const DASHBOARD = [
  "┌─ system ───────────────┬─ memory ──────────────┐",
  "│ cpu    42%             │ used     5.2 / 16 GB  │",
  "│ load   1.24 0.98 0.71  │ swap     0.0 / 2 GB   │",
  "├────────────────────────┴───────────────────────┤",
  "│ requests/sec                                   │",
  "│                                                │",
  "│    ▂▃▅▇█▇▅▃▂▁▂▃▅▇█▇▅▃▂▁▂▃▅▇█▇▅▃▂▁              │",
  "│                                                │",
  "╞════════════════════════════════════════════════╡",
  "│ status: ok        uptime 14d 6h      ● healthy │",
  "└────────────────────────────────────────────────┘",
].join("\n");

const FORM = [
  "┌─ new connection ───────────────────┐",
  "│                                    │",
  "│  Host      [                    ]  │",
  "│  Port      [     ]                 │",
  "│  Username  [                    ]  │",
  "│  Password  [                    ]  │",
  "│                                    │",
  "│  [x] Use TLS                       │",
  "│  [ ] Save credentials              │",
  "│                                    │",
  "│              ┌────────┐ ┌────────┐ │",
  "│              │ Cancel │ │  Save  │ │",
  "│              └────────┘ └────────┘ │",
  "└────────────────────────────────────┘",
].join("\n");

const FILE_MANAGER = [
  "┌──────────────────┬──────────────────────────────────┐",
  "│ ▾ src            │  name              size   modified│",
  "│   ▾ model        │ ─────────────────────────────────│",
  "│     cell.ts      │  cell.ts          4.1K   10:24   │",
  "│     color.ts     │  color.ts         2.8K   09:57   │",
  "│     layer.ts     │  layer.ts         1.2K   09:31   │",
  "│   ▸ ops          │  document.ts      3.4K   11:02   │",
  "│   ▸ render       │  draft.ts         3.9K   11:18   │",
  "│ ▸ test           │                                  │",
  "├──────────────────┴──────────────────────────────────┤",
  "│ 5 files, 15.4K                          src/model/  │",
  "└─────────────────────────────────────────────────────┘",
].join("\n");

export interface Template {
  readonly id: string;
  readonly name: string;
  build(): TuiDocument;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "dashboard",
    name: "Dashboard",
    build: () => parseText(DASHBOARD).doc,
  },
  {
    id: "form",
    name: "Form",
    build: () => parseText(FORM).doc,
  },
  {
    id: "file-manager",
    name: "File manager",
    build: () => parseText(FILE_MANAGER).doc,
  },
  {
    id: "empty",
    name: "Empty 80×24",
    build: () => createDocument(80, 24),
  },
];

export function templateById(id: string): Template {
  const found = TEMPLATES.find((t) => t.id === id);
  if (found === undefined) throw new Error(`unknown template: ${id}`);
  return found;
}
