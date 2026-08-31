/**
 * Safe, total parsing for the optional URL-driven launch configuration.
 *
 * Query strings are untrusted input even in a local editor: copied links, test
 * harnesses, and browser extensions can all supply them. This parser therefore
 * returns a complete valid configuration and never asks the rest of the app to
 * interpret raw strings or non-finite numbers.
 */

import { ZOOM_MAX, ZOOM_MIN } from "./canvas/metrics.js";
import type { ToolId } from "./gestures/gesture.js";
import {
  DEFAULT_PREFS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
} from "./stores/prefs-store.js";
import { TEMPLATES } from "./templates.js";

type LaunchStore = "auto" | "memory";

export interface LaunchConfig {
  readonly template: string;
  readonly font: string;
  readonly fontSize: number;
  readonly lineHeightFactor: number;
  readonly zoom: number;
  readonly showGrid: boolean;
  readonly tool: ToolId;
  readonly store: LaunchStore;
}

export const DEFAULT_LAUNCH_CONFIG: LaunchConfig = {
  template: "dashboard",
  font: DEFAULT_PREFS.previewFont,
  fontSize: DEFAULT_PREFS.fontSize,
  lineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
  zoom: DEFAULT_PREFS.zoom,
  showGrid: DEFAULT_PREFS.showGrid,
  tool: "box",
  store: "auto",
};

const TEMPLATE_IDS = new Set(TEMPLATES.map((template) => template.id));
const TOOLS = new Set<ToolId>(["pencil", "box", "line", "text", "select", "fill", "eyedropper"]);
const STORES = new Set<LaunchStore>(["auto", "memory"]);
const UNSAFE_FONT_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const MAX_FONT_FAMILY_CHARS = 100;

function finiteInRange(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function member<T extends string>(raw: string | null, values: ReadonlySet<T>, fallback: T): T {
  return raw !== null && values.has(raw as T) ? (raw as T) : fallback;
}

function fontFamily(raw: string | null): string {
  if (raw === null) return DEFAULT_LAUNCH_CONFIG.font;
  const value = raw.trim().normalize("NFC");
  if (
    value.length === 0 ||
    [...value].length > MAX_FONT_FAMILY_CHARS ||
    UNSAFE_FONT_CHARACTERS.test(value)
  ) {
    return DEFAULT_LAUNCH_CONFIG.font;
  }
  return value;
}

export function parseLaunchConfig(search: string): LaunchConfig {
  const params = new URLSearchParams(search);
  return {
    template: member(params.get("template"), TEMPLATE_IDS, DEFAULT_LAUNCH_CONFIG.template),
    font: fontFamily(params.get("font")),
    fontSize: finiteInRange(
      params.get("size"),
      DEFAULT_LAUNCH_CONFIG.fontSize,
      FONT_SIZE_MIN,
      FONT_SIZE_MAX,
    ),
    lineHeightFactor: finiteInRange(
      params.get("lh"),
      DEFAULT_LAUNCH_CONFIG.lineHeightFactor,
      LINE_HEIGHT_MIN,
      LINE_HEIGHT_MAX,
    ),
    zoom: finiteInRange(params.get("zoom"), DEFAULT_LAUNCH_CONFIG.zoom, ZOOM_MIN, ZOOM_MAX),
    showGrid: member(params.get("grid"), new Set(["0", "1"]), "1") === "1",
    tool: member(params.get("tool"), TOOLS, DEFAULT_LAUNCH_CONFIG.tool),
    store: member(params.get("store"), STORES, DEFAULT_LAUNCH_CONFIG.store),
  };
}
