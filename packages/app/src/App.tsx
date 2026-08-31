import {
  assertDocumentDimensions,
  cellsLostOnResize,
  colorRefEquals,
  RESOURCE_LIMITS,
  type Rect,
  resizeDocument,
  setActiveLayer,
  type TuiDocument,
  toText,
} from "@tui-designer/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyCoverage, coverageWarning } from "./canvas/coverage.js";
import { availableFonts, measureFont, measureProbes } from "./canvas/measure.js";
import {
  type CellPos,
  clampViewport,
  type FontSpec,
  type GridSize,
  type Viewport,
  zoomAt,
} from "./canvas/metrics.js";
import type { Overlays } from "./canvas/paint-plan.js";
import { cssColor } from "./canvas/paint-plan.js";
import { DARK_THEME } from "./canvas/theme.js";
import { useCanvasPainter } from "./canvas/use-canvas.js";
import { ExportDialog } from "./files/ExportDialog.js";
import { PickerDialog, RecoveryDialog, usePicker } from "./files/FileDialogs.js";
import { createReplacementPolicy } from "./files/replacement-policy.js";
import { createGestureController, type PointerEventLike } from "./gestures/controller.js";
import type { Modifiers, ToolId } from "./gestures/gesture.js";
import { InspectorPanel } from "./inspect/InspectorPanel.js";
import { LayersPanel } from "./layers/LayersPanel.js";
import { activeLayerNotice, cycleActiveId } from "./layers/panel-model.js";
import { PalettePanel } from "./palette/PalettePanel.js";
import { createFileActions } from "./ports/file-actions.js";
import type { RecoveryInfo } from "./ports/file-store.js";
import { createFileStore } from "./ports/index.js";
import { matchShortcut, SHORTCUTS, shortcutHint } from "./shortcuts.js";
import { createDocumentStore } from "./stores/document-store.js";
import { usePrefsStore } from "./stores/prefs-store.js";
import { BRUSH_CHARS, SWATCHES, useToolStore } from "./stores/tool-store.js";
import { TEMPLATES, templateById } from "./templates.js";

/**
 * URL parameters, so a headless browser can drive the app for visual checks:
 * `?template=form&font=Monaco&size=20&lh=1.2&zoom=2&grid=0&tool=box`.
 */
const params = new URLSearchParams(window.location.search);
const documentStore = createDocumentStore(
  templateById(params.get("template") ?? "dashboard").build(),
);

/** Test hook. Visual assertions become string assertions. */
declare global {
  interface Window {
    __tui?: {
      toText(): string;
      present(): unknown;
      revision(): number;
      /** The document currently on screen — the scratch during a drag. */
      renderedText(): string;
    };
  }
}

const TOOL_RAIL: readonly { tool: ToolId; glyph: string; label: string; ready: boolean }[] = [
  { tool: "pencil", glyph: "✎", label: "Pencil", ready: true },
  { tool: "box", glyph: "▭", label: "Box", ready: true },
  { tool: "line", glyph: "╱", label: "Line", ready: true },
  { tool: "select", glyph: "⬚", label: "Select", ready: true },
  { tool: "text", glyph: "T", label: "Text", ready: true },
  { tool: "fill", glyph: "▨", label: "Fill", ready: true },
  { tool: "eyedropper", glyph: "⌇", label: "Eyedropper", ready: true },
];

/** What the active tool does, shown in the inspector so modes are discoverable. */
const TOOL_HINTS: Record<ToolId, string> = {
  pencil: "Drag to paint the brush character. Shift constrains to one axis.",
  box: "Drag a rectangle. Alt suppresses junction merging.",
  line: "Drag; snaps to the dominant axis. Alt suppresses merging.",
  select: "Drag a marquee. Drag inside it to move, Alt+drag to duplicate, ⌘C/⌘X/⌘V for clipboard.",
  text: "Click to place the caret, then type. Enter returns to the starting column.",
  fill: "Click to flood the region with the brush background. Shift fills with the whole brush cell — pick a background above, or a default background changes nothing.",
  eyedropper:
    "Click a cell to pick its character and colours into the brush. Samples what you see — the topmost visible layer, not the active one. Right-click does the same from any tool.",
};

const hintFor = (tool: ToolId): string => {
  const found = SHORTCUTS.find((s) => s.id === `tool.${tool}`);
  return found === undefined ? "" : shortcutHint(found);
};

export function App(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const prefs = usePrefsStore();
  const tools = useToolStore();
  const [fonts] = useState<string[]>(() => availableFonts());
  const [dpr, setDpr] = useState(() => window.devicePixelRatio);
  const [box, setBox] = useState({ w: 800, h: 500 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  /** Held Space enables pan-on-drag, the standard design-tool convention. */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * The captured pointer currently owned by the canvas.
   *
   * Clearing this before a normal pointer-up is what distinguishes the expected
   * `lostpointercapture` event from an unexpected capture loss that must cancel a
   * preview. Without that distinction, clicking with the text tool would place a
   * caret and then immediately cancel it when capture is released.
   */
  const pointerSessionRef = useRef<{
    readonly pointerId: number;
    readonly mode: "gesture" | "pan";
  } | null>(null);
  /**
   * Repaint trigger, not a value. The canvas paints itself from `getDoc()` in its
   * own rAF loop; this only nudges React so the *chrome* (status bar, overlay
   * props) re-evaluates after a store change or a preview frame.
   */
  const [, forceRerender] = useState(0);
  const bump = useCallback(() => forceRerender((n) => n + 1), []);
  const [hover, setHover] = useState<CellPos | null>(null);

  /** In-progress preview. Rendered instead of the present; never in history. */
  const scratchRef = useRef<TuiDocument | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [caret, setCaret] = useState<CellPos | null>(null);
  const [anchor, setAnchor] = useState<"top-left" | "center">("top-left");
  const [templateId, setTemplateId] = useState(params.get("template") ?? "dashboard");

  /**
   * True while the keyboard belongs to the text tool rather than to shortcuts.
   *
   * The text tool has two modes — *editing* (a caret is placed; letters type) and
   * *placing* (no caret; letters switch tools). Deriving the mode from one
   * expression rather than re-testing `activeTool && caret` at each site keeps the
   * key handler, the Space-pan guard, and the status readout in agreement.
   */
  const editingText = tools.activeTool === "text" && caret !== null;

  /**
   * Confirmation prompt, wrapped rather than passed by reference.
   *
   * `confirm={window.confirm}` would capture whatever the global was at render
   * time. Calling through a wrapper always reaches the current one, which is both
   * more honest and what lets a test substitute it.
   */
  const askConfirm = useCallback((message: string) => window.confirm(message), []);

  const doc = documentStore.getState().history.present;
  const size: GridSize = useMemo(() => ({ cols: doc.cols, rows: doc.rows }), [doc.cols, doc.rows]);

  useEffect(() => documentStore.subscribe(bump), [bump]);

  useEffect(() => {
    const store = usePrefsStore.getState();
    const font = params.get("font");
    const sizeParam = params.get("size");
    const lh = params.get("lh");
    const zoom = params.get("zoom");
    const grid = params.get("grid");
    const tool = params.get("tool");
    if (font !== null) store.setFont(font);
    if (sizeParam !== null) store.setFontSize(Number(sizeParam));
    if (lh !== null) store.setLineHeightFactor(Number(lh));
    if (zoom !== null) store.setZoom(Number(zoom));
    if (grid !== null) store.setShowGrid(grid !== "0");
    if (tool !== null) useToolStore.getState().setTool(tool as ToolId);
  }, []);

  const font: FontSpec = useMemo(
    () => ({
      family: prefs.previewFont,
      sizePx: prefs.fontSize,
      lineHeightFactor: prefs.lineHeightFactor,
    }),
    [prefs.previewFont, prefs.fontSize, prefs.lineHeightFactor],
  );

  const metrics = useMemo(() => measureFont(font, dpr), [font, dpr]);

  useEffect(() => {
    const probeFont: FontSpec = {
      family: prefs.previewFont,
      sizePx: prefs.fontSize,
      lineHeightFactor: prefs.requestedLineHeightFactor,
    };
    const m = measureFont(probeFont, dpr);
    usePrefsStore
      .getState()
      .applyCoverage(
        classifyCoverage(measureProbes(probeFont), m.cellW, m.cellH, probeFont.sizePx),
      );
  }, [prefs.previewFont, prefs.fontSize, prefs.requestedLineHeightFactor, dpr]);

  useEffect(() => {
    const el = viewportRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    const media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = () => setDpr(window.devicePixelRatio);
    media.addEventListener("change", onDpr);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onDpr);
    };
  }, []);

  const viewport: Viewport = useMemo(
    () =>
      clampViewport(
        { scrollX: scroll.x, scrollY: scroll.y, widthPx: box.w, heightPx: box.h, zoom: prefs.zoom },
        metrics,
        size,
      ),
    [scroll.x, scroll.y, box.w, box.h, prefs.zoom, metrics, size],
  );

  useEffect(() => {
    if (viewport.scrollX !== scroll.x || viewport.scrollY !== scroll.y) {
      setScroll({ x: viewport.scrollX, y: viewport.scrollY });
    }
  }, [viewport.scrollX, viewport.scrollY, scroll.x, scroll.y]);

  // Geometry is read fresh on every pointer event, via a ref so the controller
  // is created once rather than on every resize.
  const geometryRef = useRef({ metrics, viewport, size });
  geometryRef.current = { metrics, viewport, size };

  const controller = useMemo(
    () =>
      createGestureController({
        documentStore,
        toolStore: useToolStore,
        geometry: () => geometryRef.current,
        setScratch: (next) => {
          scratchRef.current = next;
          bump();
        },
        setDragRect,
        setCaret,
        now: () => performance.now(),
      }),
    [bump],
  );

  /** Clears app bookkeeping and releases browser capture for a canceled session. */
  const releasePointerSession = useCallback((): void => {
    const session = pointerSessionRef.current;
    const wasPanning = panRef.current !== null;
    pointerSessionRef.current = null;
    panRef.current = null;
    const canvas = canvasRef.current;
    if (session !== null && canvas?.hasPointerCapture(session.pointerId)) {
      try {
        canvas.releasePointerCapture(session.pointerId);
      } catch {
        // Capture may have been released between the check and the call. The app
        // bookkeeping is already clear, which is the state that matters.
      }
    }
    if (wasPanning) bump();
  }, [bump]);

  // Detects the 1s typing-idle flush. A poll rather than a per-keystroke timer:
  // cheap, and it cannot leak a pending timeout on unmount.
  useEffect(() => {
    const id = setInterval(() => controller.tick(), 250);
    return () => clearInterval(id);
  }, [controller]);

  // ---- files ----

  const { picker, request: pickerRequest } = usePicker();
  /**
   * Transient messages, each with an id.
   *
   * An id rather than the array index: two identical warnings — the same
   * deserialize repair twice — would otherwise share a React key and the second
   * would not render.
   */
  const [notices, setNotices] = useState<{ id: number; message: string }[]>([]);
  const noticeSeq = useRef(0);
  const [recoveries, setRecoveries] = useState<readonly RecoveryInfo[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const notify = useCallback((message: string) => {
    // Newest last, and capped: a burst of deserialize warnings should not push the
    // canvas off screen.
    noticeSeq.current += 1;
    const entry = { id: noticeSeq.current, message };
    setNotices((prev) => [...prev, entry].slice(-4));
  }, []);

  const store = useMemo(
    () =>
      createFileStore({
        picker,
        ...(params.get("store") === "memory" ? { prefer: "memory" as const } : {}),
      }),
    [picker],
  );

  /**
   * The single adoption boundary for opened files, templates, and recoveries.
   *
   * A file picker is allowed to fail or be cancelled before reaching here. Once a
   * valid replacement arrives, the dirty prompt runs before any interaction state
   * changes. Accepted replacements flush typing, cancel pointer previews, and clear
   * every transient tied to the old grid.
   */
  const replacement = useMemo(
    () =>
      createReplacementPolicy({
        hasUnsavedChanges: () => documentStore.getState().dirty || scratchRef.current !== null,
        confirmDiscard: askConfirm,
        settleInteractions: () => controller.settleDocumentReplacement(),
        clearTransientState: () => {
          scratchRef.current = null;
          setDragRect(null);
          setCaret(null);
          setHover(null);
          setSpaceHeld(false);
          releasePointerSession();
          const toolStore = useToolStore.getState();
          toolStore.setSelection(null);
          // A clipboard is document-relative; carrying it across files makes a
          // replacement appear to retain hidden state from the old document.
          toolStore.setClipboard(null);
        },
        adopt: (next, handle, opts) => {
          documentStore.getState().load(next, handle);
          if (opts?.dirty === true) documentStore.getState().markDirty();
        },
      }),
    [askConfirm, controller, releasePointerSession],
  );

  const files = useMemo(
    () =>
      createFileActions({
        store,
        snapshot: () => {
          const state = documentStore.getState();
          return {
            doc: state.history.present,
            handle: state.handle,
            dirty: state.dirty,
            revision: state.revision,
            generation: state.generation,
            // Typing counts as busy: `preview` bumps the revision per keystroke,
            // so a burst would otherwise look like a settled state and get
            // snapshotted half-typed.
            busy: controller.isActive() || controller.isTyping(),
          };
        },
        load: (next, handle, opts) => replacement.replace(next, handle, opts),
        markSaved: (handle, revision, generation) =>
          documentStore.getState().markSaved(handle, revision, generation),
        now: () => Date.now(),
        notify,
      }),
    [store, controller, notify, replacement],
  );
  const [fileStatus, setFileStatus] = useState(() => files.status());

  useEffect(() => {
    setFileStatus(files.status());
    return files.subscribe(setFileStatus);
  }, [files]);

  /** Autosave poll. Separate from the gesture tick: minutes, not milliseconds. */
  useEffect(() => {
    const id = setInterval(() => void files.tick(), 5_000);
    return () => clearInterval(id);
  }, [files]);

  /** Offers recovery once, at startup. */
  useEffect(() => {
    void files.listRecoveries().then((found) => {
      if (found.length > 0) setRecoveries(found);
    });
  }, [files]);

  /**
   * Warns before a reload discards unsaved work.
   *
   * Autosave narrows the window but does not close it — an edit in the last few
   * seconds has no snapshot yet.
   */
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!documentStore.getState().dirty) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const getDoc = useCallback(
    () => scratchRef.current ?? documentStore.getState().history.present,
    [],
  );

  const overlays: Overlays = useMemo(
    () => ({
      showGrid: prefs.showGrid,
      selection: tools.selection,
      // While typing, the caret is the cursor — a hover outline as well would be
      // two competing indicators on the same cell.
      cursor: caret === null ? hover : null,
      marqueePhase: 0,
      dragRect,
      caret,
    }),
    [prefs.showGrid, tools.selection, hover, dragRect, caret],
  );

  useCanvasPainter({
    canvasRef,
    getDoc,
    metrics,
    viewport,
    overlays,
    theme: DARK_THEME,
    animate: tools.selection !== null,
  });

  useEffect(() => {
    window.__tui = {
      toText: () => toText(documentStore.getState().history.present),
      present: () => documentStore.getState().history.present,
      revision: () => documentStore.getState().revision,
      renderedText: () => toText(getDoc()),
    };
  }, [getDoc]);

  // Global shortcuts, routed through the one registry.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      // Never steal keys from a form control.
      if (target !== null && /^(INPUT|SELECT|TEXTAREA)$/u.test(target.tagName)) return;

      const mods: Modifiers = {
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
      };
      // The text tool owns the keyboard while its caret is placed, so typing "b"
      // writes a character rather than switching to the Box tool. Esc, undo/redo,
      // and zoom still reach the registry below.
      if (editingText) {
        const reserved =
          e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z");
        if (!reserved && !e.metaKey && !e.ctrlKey) {
          controller.onKey(e.key, mods);
          e.preventDefault();
          return;
        }
      }

      const id = matchShortcut({ key: e.key, mods });
      if (id === null) return;

      const recoveryModalOpen = recoveries !== null && recoveries.length > 0;
      if (recoveryModalOpen || pickerRequest !== null || exporting) {
        // A modal owns the keyboard. Escape deliberately settles that one modal;
        // every other global command waits, so shortcuts cannot stack dialogs or
        // mutate the document behind one.
        if (id === "edit.cancel") {
          if (pickerRequest !== null) pickerRequest.resolve(null);
          else if (exporting) setExporting(false);
          else setRecoveries(null);
        }
        e.preventDefault();
        return;
      }

      // A picker may already have closed while its read/write is still running.
      // Keep file commands and export single-flight until that operation settles.
      if (fileStatus.busy && id.startsWith("file.")) {
        e.preventDefault();
        return;
      }

      const prefsStore = usePrefsStore.getState();
      const toolStore = useToolStore.getState();

      if (id.startsWith("tool.")) {
        // Switching tools mid-gesture cancels it first, per the spec.
        controller.flushTyping("tool-change");
        if (controller.isActive()) {
          releasePointerSession();
          controller.cancel();
        }
        setCaret(null);
        toolStore.setTool(id.slice("tool.".length) as ToolId);
      } else if (id === "edit.undo") {
        releasePointerSession();
        controller.history("undo");
      } else if (id === "edit.redo") {
        releasePointerSession();
        controller.history("redo");
      } else if (id === "edit.cancel") {
        /**
         * Esc unwinds one level of modality at a time, as in Figma.
         *
         * Editing text → stop editing and *select what was just typed*, under the
         * Select tool. That is the useful next state: the run can be moved,
         * duplicated, or deleted immediately, and every keyboard shortcut works
         * again. A second Esc then clears the selection.
         */
        if (editingText) {
          const typed = controller.endTextEditing();
          if (typed !== null) {
            toolStore.setSelection(typed);
            toolStore.setTool("select");
          }
        } else if (toolStore.selection !== null && !controller.isActive()) {
          toolStore.setSelection(null);
        } else {
          releasePointerSession();
          controller.cancel();
          setCaret(null);
        }
      } else if (id === "file.export") {
        controller.flushTyping("save");
        setExporting(true);
      } else if (id === "file.save" || id === "file.saveAs") {
        // Flush any burst so the document being written includes the last
        // characters typed, and close a gesture so a preview is not saved.
        controller.flushTyping("save");
        if (controller.isActive()) {
          releasePointerSession();
          controller.cancel();
        }
        setCaret(null);
        if (id === "file.save") void files.save();
        else void files.saveAs();
      } else if (id === "file.open") {
        // Do not touch typing or gesture state before the picker resolves. A
        // cancelled or failed open must leave the current editing session intact;
        // a valid document reaches the shared replacement policy above.
        void files.open();
      } else if (id === "edit.copy" || id === "edit.cut" || id === "edit.paste") {
        // Editing text and placing a paste are both modal states that own the
        // pointer or the keyboard, so leaving edit mode first keeps them from
        // overlapping. The selection is left alone — unlike Esc, a clipboard
        // command is not a request to select what was typed.
        if (editingText) controller.endTextEditing();
        controller.clipboard(id.slice("edit.".length) as "copy" | "cut" | "paste");
      } else if (id === "edit.delete" && toolStore.activeTool !== "text") {
        controller.onKey("Delete", mods);
      } else if (id === "view.zoomIn") {
        prefsStore.zoomIn();
      } else if (id === "view.zoomOut") {
        prefsStore.zoomOut();
      } else if (id === "view.zoomReset") {
        prefsStore.resetZoom();
      } else if (id === "view.toggleGrid") {
        prefsStore.setShowGrid(!prefsStore.showGrid);
      } else if (id === "layer.next" || id === "layer.previous") {
        // Switching the target layer mid-gesture would commit the preview onto the
        // wrong one, so any open gesture or burst is closed first.
        controller.flushTyping("tool-change");
        if (controller.isActive()) {
          releasePointerSession();
          controller.cancel();
        }
        setCaret(null);
        const current = documentStore.getState().present();
        controller.commitEdit(
          setActiveLayer(current, cycleActiveId(current, id === "layer.next" ? 1 : -1)),
        );
      } else {
        return;
      }
      e.preventDefault();
    };

    // Space is a held modifier for panning, not a shortcut, so it is tracked
    // separately from the registry.
    const onSpaceDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && /^(INPUT|SELECT|TEXTAREA)$/u.test(target.tagName)) return;
      // While a text caret is placed, Space is a character, not a pan modifier —
      // otherwise typing a space silently arms Space+drag and the next click pans
      // instead of moving the caret. Wheel and middle-drag panning still work.
      if (e.code === "Space" && !editingText) {
        setSpaceHeld(true);
        e.preventDefault();
      }
    };
    const onSpaceUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") setSpaceHeld(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onSpaceDown);
    window.addEventListener("keyup", onSpaceUp);
    const onBlur = () => {
      releasePointerSession();
      controller.cancel();
      // A Space release can be lost while unfocused, which would leave the canvas
      // stuck in pan mode.
      setSpaceHeld(false);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onSpaceDown);
      window.removeEventListener("keyup", onSpaceUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    controller,
    editingText,
    exporting,
    files,
    fileStatus.busy,
    pickerRequest,
    recoveries,
    releasePointerSession,
  ]);

  /**
   * Resizes the document, confirming first when cells would be discarded.
   *
   * Shrinking is destructive — the dropped cells are only recoverable through
   * undo — so the count is shown before it happens rather than after.
   */
  const applyResize = (cols: number, rows: number): void => {
    try {
      assertDocumentDimensions(cols, rows);
    } catch (error) {
      notify(`Resize rejected: ${(error as Error).message}`);
      return;
    }
    const current = documentStore.getState().present();
    const lost = cellsLostOnResize(current, cols, rows, anchor);
    if (lost > 0) {
      const ok = window.confirm(
        `Resizing to ${cols}×${rows} discards ${lost} painted cell${lost === 1 ? "" : "s"}. Continue?`,
      );
      if (!ok) return;
    }
    controller.flushTyping("tool-change");
    setCaret(null);
    useToolStore.getState().setSelection(null);
    controller.commitEdit(resizeDocument(current, cols, rows, anchor));
  };

  /**
   * Canvas-relative CSS pixels from the client position.
   *
   * Computed against the bounding rect rather than read from `offsetX`/`offsetY`,
   * which are padding-box-relative and would break if the canvas ever gained a
   * border — and which are not reliably populated on dispatched events.
   */
  const toPointer = (e: React.PointerEvent<HTMLCanvasElement>): PointerEventLike => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      button: e.button,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
    };
  };

  const warning =
    prefs.coverage === null ? null : coverageWarning(prefs.coverage, prefs.previewFont);
  const clamped = prefs.lineHeightFactor !== prefs.requestedLineHeightFactor;
  const lockFlashing = tools.lockFlashAt !== null && performance.now() - tools.lockFlashAt < 600;
  const activeLayer = doc.layers.find((l) => l.id === doc.activeLayerId);
  const layerNotice = activeLayerNotice(doc);

  /**
   * Applies a layer edit as one history entry.
   *
   * Layer operations are not gestures, so they go through `commitEdit` — which
   * also flushes any open typing burst, keeping the edit *after* the characters
   * typed rather than swallowing them. Core no-ops return the same document, so a
   * toggle that changes nothing adds no history entry.
   */
  const applyLayerEdit = useCallback(
    (next: TuiDocument): void => {
      controller.commitEdit(next);
    },
    [controller],
  );

  return (
    <div className="app">
      <header className="menubar">
        <strong>tui-designer</strong>
        <span className="muted">G2 — tools</span>
        <div className="spacer" />
        <label>
          template{" "}
          <select
            value={templateId}
            onChange={(e) => {
              const nextId = e.target.value;
              if (replacement.replace(templateById(nextId).build(), null)) setTemplateId(nextId);
            }}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          font{" "}
          <select value={prefs.previewFont} onChange={(e) => prefs.setFont(e.target.value)}>
            {fonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          size{" "}
          <input
            type="number"
            min={8}
            max={40}
            value={prefs.fontSize}
            onChange={(e) => prefs.setFontSize(Number(e.target.value))}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={prefs.showGrid}
            onChange={(e) => prefs.setShowGrid(e.target.checked)}
          />{" "}
          grid
        </label>
      </header>

      {warning !== null && <div className="banner warn">{warning}</div>}
      {clamped && (
        <div className="banner info">
          Line height clamped to {prefs.lineHeightFactor.toFixed(2)} — beyond that,{" "}
          {prefs.previewFont}&apos;s vertical box characters stop meeting between rows.
        </div>
      )}

      <div className="workspace">
        <nav className={`toolrail${lockFlashing ? " lock-flash" : ""}`}>
          {TOOL_RAIL.map(({ tool, glyph, label, ready }) => (
            <button
              key={tool}
              type="button"
              className={tools.activeTool === tool ? "tool active" : "tool"}
              title={`${label} (${hintFor(tool)})${ready ? "" : " — G3"}`}
              disabled={!ready}
              onClick={() => {
                if (controller.isActive()) {
                  releasePointerSession();
                  controller.cancel();
                }
                tools.setTool(tool);
              }}
            >
              <span className="glyph">{glyph}</span>
              <span className="key">{hintFor(tool)}</span>
            </button>
          ))}
        </nav>

        <div
          className="canvas-viewport"
          ref={viewportRef}
          onWheel={(e) => {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
              // Zoom, anchored so the cell under the cursor stays put. A trackpad
              // pinch also arrives here as ctrl+wheel.
              const rect = e.currentTarget.getBoundingClientRect();
              const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
              const factor = Math.exp(-e.deltaY * 0.0035);
              const next = zoomAt(metrics, viewport, size, prefs.zoom * factor, pointer);
              usePrefsStore.getState().setZoom(next.zoom);
              setScroll({ x: next.scrollX, y: next.scrollY });
            } else {
              setScroll((s) => ({ x: s.x + e.deltaX, y: s.y + e.deltaY }));
            }
          }}
        >
          <canvas
            ref={canvasRef}
            className={spaceHeld || panRef.current !== null ? "panning" : undefined}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              // This editor has one caret/gesture at a time. Ignoring additional
              // contacts avoids replacing the only cancellation token and
              // stranding the first pointer's preview.
              if (pointerSessionRef.current !== null) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              // Middle button or held Space pans instead of drawing.
              if (e.button === 1 || spaceHeld) {
                pointerSessionRef.current = { pointerId: e.pointerId, mode: "pan" };
                panRef.current = { x: e.clientX, y: e.clientY };
                bump();
                return;
              }
              pointerSessionRef.current = { pointerId: e.pointerId, mode: "gesture" };
              controller.onPointerDown(toPointer(e));
            }}
            onPointerMove={(e) => {
              const pan = panRef.current;
              if (pan !== null) {
                setScroll((s) => ({ x: s.x - (e.clientX - pan.x), y: s.y - (e.clientY - pan.y) }));
                panRef.current = { x: e.clientX, y: e.clientY };
                return;
              }
              controller.onPointerMove(toPointer(e));
              setHover(controller.hoverCell());
            }}
            onPointerUp={(e) => {
              const session = pointerSessionRef.current;
              if (session === null || session.pointerId !== e.pointerId) return;
              // Clear first: the browser releases capture after pointer-up and
              // emits lostpointercapture, which is expected and must be a no-op.
              pointerSessionRef.current = null;
              if (session.mode === "pan") {
                panRef.current = null;
                bump();
                return;
              }
              controller.onPointerUp(toPointer(e));
            }}
            onPointerCancel={(e) => {
              const session = pointerSessionRef.current;
              if (session === null || session.pointerId !== e.pointerId) return;
              pointerSessionRef.current = null;
              panRef.current = null;
              if (session.mode === "gesture") controller.cancel();
              else bump();
            }}
            onLostPointerCapture={(e) => {
              const session = pointerSessionRef.current;
              if (session === null || session.pointerId !== e.pointerId) return;
              pointerSessionRef.current = null;
              panRef.current = null;
              if (session.mode === "gesture") controller.cancel();
              else bump();
            }}
            onPointerLeave={() => setHover(null)}
          />
        </div>

        <aside className="inspector">
          <InspectorPanel
            doc={doc}
            selection={tools.selection}
            hover={hover}
            theme={DARK_THEME}
            onCopy={(payload) => {
              void navigator.clipboard
                .writeText(payload)
                .then(() => notify("Measurements copied as JSON."))
                .catch(() => notify("Could not reach the clipboard."));
            }}
          />

          <LayersPanel doc={doc} onEdit={applyLayerEdit} confirm={askConfirm} />
          {layerNotice !== null && <p className="notice small">{layerNotice}</p>}

          <h2>Brush</h2>
          <div className="charGrid">
            {BRUSH_CHARS.map((char) => (
              <button
                key={char}
                type="button"
                className={tools.brush.char === char ? "chip active" : "chip"}
                onClick={() => tools.setBrushChar(char)}
              >
                {char === " " ? "␠" : char}
              </button>
            ))}
          </div>
          <h2>Colour</h2>
          <div className="swatchRow">
            <span className="swatchLabel">fg</span>
            {SWATCHES.map((s) => (
              <button
                key={`fg-${s.label}`}
                type="button"
                title={s.label}
                aria-label={`foreground ${s.label}`}
                className={colorRefEquals(tools.brush.fg, s.color) ? "swatch active" : "swatch"}
                style={{ background: cssColor(s.color, "fg", DARK_THEME) }}
                onClick={() => tools.setBrush({ fg: s.color })}
              >
                {s.color.kind === "default" ? "×" : ""}
              </button>
            ))}
          </div>
          <div className="swatchRow">
            <span className="swatchLabel">bg</span>
            {SWATCHES.map((s) => (
              <button
                key={`bg-${s.label}`}
                type="button"
                title={s.label}
                aria-label={`background ${s.label}`}
                className={colorRefEquals(tools.brush.bg, s.color) ? "swatch active" : "swatch"}
                style={{ background: cssColor(s.color, "bg", DARK_THEME) }}
                onClick={() => tools.setBrush({ bg: s.color })}
              >
                {s.color.kind === "default" ? "×" : ""}
              </button>
            ))}
          </div>

          <PalettePanel
            doc={doc}
            brush={tools.brush}
            theme={DARK_THEME}
            onEdit={applyLayerEdit}
            onBrush={(patch) => tools.setBrush(patch)}
            confirm={askConfirm}
          />

          <h2>Line style</h2>
          <div className="row">
            {(["light", "heavy", "double"] as const).map((style) => (
              <button
                key={style}
                type="button"
                className={tools.lineStyle === style ? "chip wide active" : "chip wide"}
                onClick={() => tools.setLineStyle(style)}
              >
                {style === "light" ? "─ light" : style === "heavy" ? "━ heavy" : "═ double"}
              </button>
            ))}
          </div>
          <h2>Document</h2>
          <div className="sizeRow">
            <label>
              cols{" "}
              <input
                type="number"
                min={1}
                max={RESOURCE_LIMITS.documentCols}
                value={doc.cols}
                onChange={(e) => applyResize(Number(e.target.value), doc.rows)}
              />
            </label>
            <label>
              rows{" "}
              <input
                type="number"
                min={1}
                max={RESOURCE_LIMITS.documentRows}
                value={doc.rows}
                onChange={(e) => applyResize(doc.cols, Number(e.target.value))}
              />
            </label>
          </div>
          <div className="row">
            {(["top-left", "center"] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={anchor === a ? "chip wide active" : "chip wide"}
                onClick={() => setAnchor(a)}
              >
                anchor: {a}
              </button>
            ))}
          </div>

          <p className="muted small">
            <strong>
              {editingText
                ? "Typing — Esc stops editing and selects what you typed."
                : TOOL_HINTS[tools.activeTool]}
            </strong>
          </p>
          <p className="muted small">
            ⌘C/⌘X copy and cut the selection; ⌘V then follows the pointer — click to drop it, Esc to
            abandon. Right-click eyedrops from any tool. Esc cancels. ⌘/Ctrl+wheel zooms at the
            pointer; wheel, middle-drag, or Space+drag pans.
          </p>
        </aside>
      </div>

      {/*
        Exactly one modal, chosen by priority rather than stacked.
        Recovery first because it is a startup decision that must be answered
        before the document it concerns is edited; the picker next because a file
        operation is already in flight behind it; export last. Rendering them
        independently let export appear on top of the recovery prompt.
      */}
      {recoveries !== null && recoveries.length > 0 ? (
        <RecoveryDialog
          snapshots={recoveries}
          now={Date.now()}
          onRestore={(info) => {
            void files.restore(info).then((restored) => {
              if (restored) setRecoveries(null);
            });
          }}
          onDiscardAll={() => {
            void files.discardAll().then(() => setRecoveries(null));
          }}
          onDismiss={() => setRecoveries(null)}
        />
      ) : pickerRequest !== null ? (
        <PickerDialog request={pickerRequest} />
      ) : exporting ? (
        <ExportDialog
          doc={documentStore.getState().history.present}
          documentLabel={documentStore.getState().handle?.label ?? null}
          metrics={metrics}
          theme={DARK_THEME}
          onClose={() => setExporting(false)}
          onError={notify}
        />
      ) : null}

      {notices.length > 0 && (
        <div className="notices">
          {notices.map((notice) => (
            <p key={notice.id}>{notice.message}</p>
          ))}
          <button type="button" className="chip tiny" onClick={() => setNotices([])}>
            dismiss
          </button>
        </div>
      )}

      <footer className="statusbar">
        <span>{hover === null ? "cell —,—" : `cell ${hover.row},${hover.col}`}</span>
        <span className={editingText ? "editing" : undefined}>
          tool: {tools.activeTool}
          {editingText ? " (editing)" : ""}
        </span>
        <span>layer: {activeLayer?.name ?? "—"}</span>
        <span>
          {doc.cols}×{doc.rows}
        </span>
        <span>mode: {doc.colorMode}</span>
        <span>
          {tools.selection === null
            ? "no selection"
            : `sel ${tools.selection.rows}×${tools.selection.cols}`}
        </span>
        <div className="spacer" />
        {fileStatus.busy && <span>file: {fileStatus.kind}…</span>}
        <button
          type="button"
          disabled={!documentStore.getState().canUndo()}
          onClick={() => {
            releasePointerSession();
            controller.history("undo");
          }}
        >
          undo
        </button>
        <button
          type="button"
          disabled={!documentStore.getState().canRedo()}
          onClick={() => {
            releasePointerSession();
            controller.history("redo");
          }}
        >
          redo
        </button>
        <span>{documentStore.getState().history.past.length} steps</span>
        <button type="button" onClick={() => prefs.zoomOut()}>
          −
        </button>
        <span>{Math.round(prefs.zoom * 100)}%</span>
        <button type="button" onClick={() => prefs.zoomIn()}>
          +
        </button>
        <span className={documentStore.getState().dirty ? "dot dirty" : "dot"}>
          {documentStore.getState().dirty ? "● unsaved" : "○ saved"}
        </span>
        {/* The document revision, not the repaint counter — the latter also ticks
            on every drag-preview frame and would be meaningless here. */}
        <span className="muted">rev {documentStore.getState().revision}</span>
        <span className="muted" title={documentStore.getState().handle?.display ?? "Never saved"}>
          {documentStore.getState().handle?.label ?? "untitled"}
        </span>
        {!store.capabilities.persistent && (
          <span
            className="warn"
            title="This browser has no usable storage; nothing will survive a reload."
          >
            not persistent
          </span>
        )}
      </footer>
    </div>
  );
}
