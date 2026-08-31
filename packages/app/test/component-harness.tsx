import { type RenderResult, render } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { type Mock, vi } from "vitest";
import { App, type AppDependencies, createAppDependencies } from "../src/App.js";
import { GLYPH_PROBES, VERTICAL_PROBES } from "../src/canvas/coverage.js";
import type { CellMetrics, FontSpec } from "../src/canvas/metrics.js";
import { DEFAULT_LAUNCH_CONFIG } from "../src/launch-config.js";
import type { FileStore } from "../src/ports/file-store.js";
import { createMemoryFileStore, type MemoryFileStore } from "../src/ports/memory-file-store.js";
import { createDocumentStore } from "../src/stores/document-store.js";
import { DEFAULT_PREFS, usePrefsStore } from "../src/stores/prefs-store.js";
import { DEFAULT_BRUSH, useToolStore } from "../src/stores/tool-store.js";
import { templateById } from "../src/templates.js";

const TEST_METRICS = (font: FontSpec, dpr: number): CellMetrics => ({
  cellW: 8,
  cellH: 16,
  dpr,
  baselineY: 12,
  font,
});

export interface ComponentHarnessOptions {
  readonly documentStore?: ReturnType<typeof createDocumentStore>;
  readonly fileStore?: FileStore;
  readonly confirm?: Mock<(message: string) => boolean>;
  readonly now?: Mock<() => number>;
  readonly monotonicNow?: Mock<() => number>;
  readonly writeClipboard?: Mock<(text: string) => Promise<void>>;
}

export interface ComponentHarness {
  readonly view: RenderResult;
  readonly user: UserEvent;
  readonly dependencies: AppDependencies;
  readonly documentStore: ReturnType<typeof createDocumentStore>;
  readonly fileStore: FileStore;
  readonly memoryFileStore: MemoryFileStore | null;
  readonly confirm: Mock<(message: string) => boolean>;
  readonly writeClipboard: Mock<(text: string) => Promise<void>>;
}

/** Resets the two intentionally-global preference/tool stores between mounts. */
export function resetComponentStores(): void {
  usePrefsStore.setState({
    previewFont: DEFAULT_PREFS.previewFont,
    fontSize: DEFAULT_PREFS.fontSize,
    requestedLineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
    lineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
    showGrid: DEFAULT_PREFS.showGrid,
    zoom: DEFAULT_PREFS.zoom,
    coverage: null,
  });
  useToolStore.setState({
    activeTool: "box",
    brush: DEFAULT_BRUSH,
    lineStyle: "light",
    selection: null,
    clipboard: null,
    lockFlashAt: null,
  });
}

/** Installs only the mechanical canvas/rAF surface; behavior stays injected. */
export function installComponentBrowserShell(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

export function renderApp(options: ComponentHarnessOptions = {}): ComponentHarness {
  const documentStore =
    options.documentStore ??
    createDocumentStore(templateById(DEFAULT_LAUNCH_CONFIG.template).build());
  const confirm = options.confirm ?? vi.fn(() => true);
  const now = options.now ?? vi.fn(() => 100_000);
  const monotonicNow = options.monotonicNow ?? vi.fn(() => 500);
  const writeClipboard = options.writeClipboard ?? vi.fn(async () => undefined);
  let fileStore: FileStore | null = options.fileStore ?? null;
  let memoryFileStore: MemoryFileStore | null = null;

  const dependencies = createAppDependencies({
    launchConfig: { ...DEFAULT_LAUNCH_CONFIG, store: "memory" },
    documentStore,
    createFileStore: ({ picker }) => {
      if (fileStore === null) {
        memoryFileStore = createMemoryFileStore({ picker, now });
        fileStore = memoryFileStore;
      }
      return fileStore;
    },
    confirm,
    now,
    monotonicNow,
    availableFonts: () => [DEFAULT_PREFS.previewFont],
    measureFont: TEST_METRICS,
    measureProbes: () => {
      const vertical = new Set(VERTICAL_PROBES);
      return GLYPH_PROBES.map((glyph) => ({
        glyph,
        advance: 8,
        ...(vertical.has(glyph) ? { inkHeight: 16 } : {}),
      }));
    },
    browser: {
      devicePixelRatio: () => 1,
      observeViewport: () => () => undefined,
      writeClipboard,
    },
  });

  const view = render(<App dependencies={dependencies} />);
  if (fileStore === null) throw new Error("App did not create its file store");
  return {
    view,
    user: userEvent.setup(),
    dependencies,
    documentStore,
    fileStore,
    memoryFileStore,
    confirm,
    writeClipboard,
  };
}

export function memoryStore(
  options: Parameters<typeof createMemoryFileStore>[0] = {},
): MemoryFileStore {
  return createMemoryFileStore(options);
}
