/**
 * The file-I/O port.
 *
 * Modelled on **what the app needs**, not on `fs` — the browser has no paths, and
 * faking them would leak into every caller. The port speaks **strings**, not
 * `TuiDocument`: `serialize`/`deserialize` stay in core and are called by the
 * store, so adapters are testable with plain strings and never import core.
 *
 * Three implementations are planned: `MemoryFileStore` (here, and the test double
 * everywhere), an OPFS one, and a Tauri one at G4. `ports/index.ts` is the only
 * module that knows which exists, which is what keeps the G4 swap to one file.
 */

/**
 * Opaque location of a document.
 *
 * `key` is the stable identity used for autosave and recent-file bookkeeping.
 * Under Tauri it is the absolute path; in the browser an OPFS name or an
 * in-memory id. Nothing outside an adapter may parse it.
 */
export interface DocHandle {
  readonly key: string;
  /** For display in a title bar, e.g. "mockup.tui". */
  readonly label: string;
  /** Longer form for tooltips: a full path, or "mockup.tui (browser storage)". */
  readonly display: string;
}

export interface OpenResult {
  readonly handle: DocHandle;
  readonly content: string;
  /** Epoch ms, or null when the backend has no notion of modification time. */
  readonly modifiedAt: number | null;
}

export interface RecentEntry {
  readonly handle: DocHandle;
  readonly openedAt: number;
}

/**
 * How many autosave snapshots are kept per document.
 *
 * A rolling history rather than one slot, because the single-slot version fails
 * in the case people actually hit: the last autosave captured a *bad* state — a
 * layer cleared by accident, a fill that went everywhere — and then the crash
 * left that as the only thing to recover. Depth turns "recover or lose it" into
 * "step back a minute".
 *
 * Ten is deliberately shallow. Autosave is revision-guarded, so ten writes mean
 * ten genuinely distinct states, which spans far longer than ten intervals during
 * ordinary editing. `clearRecovery` on a successful save keeps saved documents
 * from accumulating history at all.
 */
export const RECOVERY_HISTORY_LIMIT = 10;

export interface RecoveryInfo {
  /**
   * Identity of this snapshot, unique across the whole store.
   *
   * Needed because a document now has several snapshots and the prompt has to
   * name which one is being restored. Opaque — only the adapter that minted it
   * may interpret it.
   */
  readonly id: string;
  /** The *source* document this recovers. */
  readonly handle: DocHandle;
  readonly content: string;
  readonly recoveredAt: number;
  readonly sourceModifiedAt: number | null;
}

export type FileStoreErrorCode =
  /** The user dismissed a dialog. Not an error state in the UI. */
  | "cancelled"
  | "not-found"
  | "permission-denied"
  | "io"
  /** e.g. saveAs on a backend with no dialogs. */
  | "unsupported";

export class FileStoreError extends Error {
  constructor(
    readonly code: FileStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FileStoreError";
  }
}

/**
 * Cancellation is an error, not a `null` return.
 *
 * With `null`, every call site needs a check that is easy to forget and
 * TypeScript cannot distinguish "cancelled" from "empty". As an error code, one
 * `catch` handles it and the happy path stays unbranched.
 */
export const isCancelled = (e: unknown): boolean =>
  e instanceof FileStoreError && e.code === "cancelled";

interface FileStoreCapabilities {
  /** False in the browser: no OS dialog, no real paths. */
  readonly nativeDialogs: boolean;
  /** False for the memory backend: nothing survives a reload. */
  readonly persistent: boolean;
  /** False when the backend cannot report mtimes — recovery then degrades. */
  readonly modifiedTimes: boolean;
}

export interface FileStore {
  readonly kind: "memory" | "opfs" | "tauri";
  readonly capabilities: FileStoreCapabilities;

  openWithPicker(): Promise<OpenResult>;
  openHandle(handle: DocHandle): Promise<OpenResult>;

  save(handle: DocHandle, content: string): Promise<{ modifiedAt: number | null }>;
  saveAs(
    content: string,
    suggestedName: string,
  ): Promise<{
    handle: DocHandle;
    modifiedAt: number | null;
  }>;

  /**
   * Appends an autosave snapshot, pruning the document's history to
   * {@link RECOVERY_HISTORY_LIMIT}.
   *
   * `key` is a handle key, or a synthetic "untitled-{ts}" for unsaved documents.
   * Appending rather than overwriting is what makes the history a history; the
   * caller is expected to have already decided the content is worth writing (see
   * `decideAutosave`), so this does not itself de-duplicate.
   */
  writeRecovery(key: string, content: string): Promise<void>;
  /** Drops **every** snapshot for `key`. Called after a successful save. */
  clearRecovery(key: string): Promise<void>;
  /**
   * Every snapshot worth offering, **newest first**: those newer than their
   * source, or whose source is missing entirely.
   *
   * The newer-than check needs backend knowledge, so it lives behind the port
   * rather than in the app. Snapshots for several documents may interleave; group
   * by `handle.key` to present them.
   */
  listRecoveries(): Promise<RecoveryInfo[]>;
  /** Discards one snapshot, for a "not this one" action in the prompt. */
  dropRecovery(id: string): Promise<void>;

  listRecent(): Promise<RecentEntry[]>;
  pushRecent(handle: DocHandle): Promise<void>;
}

/**
 * Chooses a document when the backend has no native picker.
 *
 * Injected so adapters stay DOM-free and testable: the React shell supplies a
 * dialog, tests supply a function.
 */
export type PickerFn = (
  entries: readonly DocHandle[],
  mode: "open" | "save",
  suggestedName?: string,
) => Promise<DocHandle | string | null>;

/** Injectable clock, so autosave and recovery tests need no fake timers. */
export type Clock = () => number;
