/**
 * The only module that knows which file backend exists.
 *
 * That is the whole point: every caller depends on the `FileStore` interface, so
 * adding the Tauri adapter is an edit here and nowhere else. `pnpm check:arch`
 * enforces it — importing an adapter directly from outside this file fails the
 * build.
 */

import type { FileStore, PickerFn } from "./file-store.js";
import { createMemoryFileStore } from "./memory-file-store.js";
import { createOpfsFileStore } from "./opfs-file-store.js";

export interface CreateFileStoreOptions {
  /** Chooses a document when the backend has no native dialog. */
  readonly picker: PickerFn;
  /**
   * Forces a backend, for tests and for the `?store=memory` escape hatch.
   *
   * Worth having beyond testing: if OPFS is present but broken — a corrupt
   * origin, a browser in a strange private mode — the memory store still gives a
   * usable editor rather than a blank screen.
   */
  readonly prefer?: FileStore["kind"];
  /** Reports a rejected OPFS root before the adapter falls back to memory. */
  readonly onFallback?: (message: string) => void;
  /** Browser persistence/quota information for the status bar. */
  readonly onStorageStatus?: (status: BrowserStorageStatus) => void;
}

export interface BrowserStorageStatus {
  readonly backend: "memory" | "opfs";
  readonly persistence: "granted" | "not-granted" | "unavailable";
  readonly usage: number | null;
  readonly quota: number | null;
}

/** True when this environment can actually give us an OPFS root. */
function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    // Present but unusable in some sandboxed iframes, where the getter exists and
    // the call rejects. Cheap to check, and the alternative is a failed open on
    // the user's first save.
    typeof FileSystemDirectoryHandle !== "undefined"
  );
}

/**
 * Builds the best available store.
 *
 * Falls back to memory rather than throwing: a session with no persistence is
 * degraded, but a session that will not start is useless. The caller reads
 * `capabilities.persistent` to warn the user.
 */
export function createFileStore(opts: CreateFileStoreOptions): FileStore {
  const prefer = opts.prefer;
  const memory = createMemoryFileStore({ picker: opts.picker });
  if (prefer === "memory") {
    emitStorageStatus(opts, {
      backend: "memory",
      persistence: "unavailable",
      usage: null,
      quota: null,
    });
    return memory;
  }
  if (!opfsAvailable()) {
    // Tests and future non-browser shells may deliberately construct the adapter
    // despite lacking browser globals; preserve that explicit escape hatch.
    if (prefer === "opfs") return createOpfsFileStore({ picker: opts.picker });
    emitStorageStatus(opts, {
      backend: "memory",
      persistence: "unavailable",
      usage: null,
      quota: null,
    });
    return memory;
  }

  /* c8 ignore start -- browser defaults; tests install the same APIs. */
  const storage = navigator.storage;
  const root = storage.getDirectory() as Promise<FileSystemDirectoryHandle>;
  /* c8 ignore stop */
  const opfs = createOpfsFileStore({ picker: opts.picker, root: () => root });
  let selected: FileStore = opfs;

  const reportStorage = async (): Promise<void> => {
    let persistence: BrowserStorageStatus["persistence"] = "unavailable";
    let usage: number | null = null;
    let quota: number | null = null;

    try {
      if (typeof storage.persist === "function") {
        persistence = (await storage.persist()) ? "granted" : "not-granted";
      } else if (typeof storage.persisted === "function") {
        persistence = (await storage.persisted()) ? "granted" : "not-granted";
      }
    } catch {
      // Persistence is advisory. An unavailable permission API must not disable
      // an otherwise working OPFS backend.
    }

    try {
      const estimate = await storage.estimate?.();
      usage = finiteBytes(estimate?.usage);
      quota = finiteBytes(estimate?.quota);
    } catch {
      // Quota reporting is likewise advisory and differs across browsers.
    }

    emitStorageStatus(opts, { backend: "opfs", persistence, usage, quota });
  };

  const backend = root.then(
    () => {
      void reportStorage();
      return opfs;
    },
    (error: unknown) => {
      selected = memory;
      opts.onFallback?.(
        `Browser storage is unavailable; this session will not survive a reload (${errorMessage(error)}).`,
      );
      emitStorageStatus(opts, {
        backend: "memory",
        persistence: "unavailable",
        usage: null,
        quota: null,
      });
      return memory;
    },
  );

  // The façade makes every operation wait for the actual root probe. Nothing can
  // be written to a pretend-persistent backend and then disappear when its first
  // asynchronous root lookup rejects.
  return {
    get kind() {
      return selected.kind;
    },
    get capabilities() {
      return selected.capabilities;
    },
    async openWithPicker() {
      return (await backend).openWithPicker();
    },
    async openHandle(handle) {
      return (await backend).openHandle(handle);
    },
    async save(handle, content) {
      return (await backend).save(handle, content);
    },
    async saveAs(content, suggestedName) {
      return (await backend).saveAs(content, suggestedName);
    },
    async writeRecovery(key, content) {
      return (await backend).writeRecovery(key, content);
    },
    async clearRecovery(key) {
      return (await backend).clearRecovery(key);
    },
    async listRecoveries() {
      return (await backend).listRecoveries();
    },
    async dropRecovery(id) {
      return (await backend).dropRecovery(id);
    },
    async listRecent() {
      return (await backend).listRecent();
    },
    async pushRecent(handle) {
      return (await backend).pushRecent(handle);
    },
  };
}

function finiteBytes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function emitStorageStatus(opts: CreateFileStoreOptions, status: BrowserStorageStatus): void {
  if (opts.onStorageStatus === undefined) return;
  queueMicrotask(() => opts.onStorageStatus?.(status));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return typeof error === "string" && error.trim() !== "" ? error : "access was rejected";
}
