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
  if (prefer === "memory") return createMemoryFileStore({ picker: opts.picker });
  if (prefer === "opfs" || opfsAvailable()) {
    return createOpfsFileStore({ picker: opts.picker });
  }
  return createMemoryFileStore({ picker: opts.picker });
}
