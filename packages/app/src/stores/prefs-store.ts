/**
 * Preferences. Transient in G1; persisted to the Tauri app-config dir at G4.
 *
 * `lineHeightFactor` is **clamped to what the font can actually draw**. The G0
 * spike found that a vertical box character connects between rows only if its ink
 * spans the full cell height — Menlo's `│` spans 1.2744 × font size, so a user
 * setting 1.5 silently breaks every wall in the document. The clamp is applied
 * here rather than in the UI so it holds no matter who sets the value.
 */

import { create } from "zustand";
import { clampLineHeightFactor, type GlyphCoverage } from "../canvas/coverage.js";
import { ZOOM_MAX, ZOOM_MIN, zoomIn, zoomOut } from "../canvas/metrics.js";

export interface PrefsState {
  previewFont: string;
  fontSize: number;
  /** The value the user asked for, before clamping. */
  requestedLineHeightFactor: number;
  /** What is actually used: the request, clamped to the font's ink extent. */
  lineHeightFactor: number;
  showGrid: boolean;
  zoom: number;
  /** Latest coverage verdict for the selected font, or null before measurement. */
  coverage: GlyphCoverage | null;

  setFont(family: string): void;
  setFontSize(sizePx: number): void;
  setLineHeightFactor(factor: number): void;
  setShowGrid(show: boolean): void;
  setZoom(zoom: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  /** Called after measuring; re-applies the clamp against the new font. */
  applyCoverage(coverage: GlyphCoverage): void;
}

export const DEFAULT_PREFS = {
  // Menlo is the only installed font that passes both coverage checks on macOS;
  // `monospace` resolves to it. See spike/g0-metrics/FINDINGS.md.
  previewFont: "Menlo",
  fontSize: 14,
  lineHeightFactor: 1.2,
  showGrid: true,
  zoom: 1,
} as const;

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 40;
export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 3;

const clampSize = (n: number): number => Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
const clampLineHeightRequest = (n: number): number =>
  Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, n));

export const usePrefsStore = create<PrefsState>((set, get) => ({
  previewFont: DEFAULT_PREFS.previewFont,
  fontSize: DEFAULT_PREFS.fontSize,
  requestedLineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
  lineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
  showGrid: DEFAULT_PREFS.showGrid,
  zoom: DEFAULT_PREFS.zoom,
  coverage: null,

  setFont(family) {
    // Coverage is font-specific, so it is invalidated until re-measured.
    set({ previewFont: family, coverage: null });
  },
  setFontSize(sizePx) {
    if (!Number.isFinite(sizePx)) return;
    set({ fontSize: clampSize(sizePx), coverage: null });
  },
  setLineHeightFactor(factor) {
    if (!Number.isFinite(factor)) return;
    const request = clampLineHeightRequest(factor);
    const coverage = get().coverage;
    set({
      requestedLineHeightFactor: request,
      lineHeightFactor: coverage === null ? request : clampLineHeightFactor(request, coverage),
    });
  },
  setShowGrid(show) {
    set({ showGrid: show });
  },
  setZoom(zoom) {
    if (!Number.isFinite(zoom)) return;
    set({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)) });
  },
  zoomIn() {
    set({ zoom: zoomIn(get().zoom) });
  },
  zoomOut() {
    set({ zoom: zoomOut(get().zoom) });
  },
  resetZoom() {
    set({ zoom: 1 });
  },
  applyCoverage(coverage) {
    set({
      coverage,
      lineHeightFactor: clampLineHeightFactor(get().requestedLineHeightFactor, coverage),
    });
  },
}));
