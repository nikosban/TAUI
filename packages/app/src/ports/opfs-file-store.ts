/**
 * The Origin Private File System backend.
 *
 * **Not localStorage**, deliberately: a 5MB quota against pretty-printed JSON is a
 * real ceiling for a full-screen mockup with a recovery history behind it, and it
 * fails as a thrown `QuotaExceededError` in the middle of an autosave — the worst
 * possible moment. OPFS gets a share of actual disk.
 *
 * The layout is chosen so it maps almost 1:1 onto `@tauri-apps/plugin-fs`, which
 * is what keeps the Tauri swap at G4 to one file:
 *
 * ```
 * docs/<name>.tui                  the documents
 * recovery/<name>.tui/<seq>.json   autosave history, one file per snapshot
 * meta/recent.json                 recent-file list
 * ```
 *
 * One snapshot per *file* rather than one file holding an array: appending then
 * costs a single write instead of read-modify-write, and a torn write can only
 * corrupt the newest snapshot rather than the whole history. That matters here
 * precisely because the thing being defended against is a crash.
 */

import { safeDocumentFilename } from "../safe-filename.js";
import {
  type Clock,
  type DocHandle,
  type FileStore,
  FileStoreError,
  MAX_DOCUMENT_BYTES,
  type OpenResult,
  type PickerFn,
  RECOVERY_HISTORY_LIMIT,
  RECOVERY_STARTUP_BYTES,
  RECOVERY_TOTAL_BYTES,
  RECOVERY_TOTAL_LIMIT,
  type RecentEntry,
  type RecoveryInfo,
  type SavePickerChoice,
} from "./file-store.js";

const DOCS_DIR = "docs";
const RECOVERY_DIR = "recovery";
const META_DIR = "meta";
const RECENT_FILE = "recent.json";
const RECENT_LIMIT = 12;
const RECOVERY_FILE = /^(\d{6})\.json$/u;

export interface OpfsFileStoreOptions {
  /** Chooses a document; OPFS has no native dialog. */
  readonly picker: PickerFn;
  readonly now?: Clock;
  /** Injected for tests; defaults to the real OPFS root. */
  readonly root?: () => Promise<FileSystemDirectoryHandle>;
}

export interface OpfsFileStore extends FileStore {
  readonly kind: "opfs";
}

const handleFor = (name: string): DocHandle => ({
  key: name,
  label: safeDocumentFilename(name),
  display: `${safeDocumentFilename(name)} (browser storage)`,
});

const isSavePickerChoice = (
  choice: DocHandle | string | SavePickerChoice,
): choice is SavePickerChoice =>
  typeof choice === "object" && choice !== null && "overwrite" in choice && "handle" in choice;

/** Wraps a native failure, mapping the codes worth distinguishing. */
function wrap(error: unknown, fallback: string): FileStoreError {
  if (error instanceof FileStoreError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotFoundError") {
    return new FileStoreError("not-found", fallback, { cause: error });
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new FileStoreError("permission-denied", fallback, { cause: error });
  }
  return new FileStoreError("io", fallback, { cause: error });
}

export function createOpfsFileStore(opts: OpfsFileStoreOptions): OpfsFileStore {
  /* c8 ignore start -- the two lines that need a real browser; tests inject both. */
  const now: Clock = opts.now ?? (() => Date.now());
  const getRoot =
    opts.root ?? (() => navigator.storage.getDirectory() as Promise<FileSystemDirectoryHandle>);
  /* c8 ignore stop */

  /** Serializes the compare-and-write window across tabs when Web Locks exists. */
  const withDocumentLock = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const locks = globalThis.navigator?.locks;
    if (locks === undefined) return work();
    return locks.request(`taui:opfs:${key}`, work);
  };

  /** A subdirectory of the root, optionally created for a write path. */
  const dir = async (create: boolean, ...path: string[]): Promise<FileSystemDirectoryHandle> => {
    let current = await getRoot();
    for (const segment of path) {
      current = await current.getDirectoryHandle(segment, { create });
    }
    return current;
  };

  const existingDir = async (...path: string[]): Promise<FileSystemDirectoryHandle | null> => {
    try {
      return await dir(false, ...path);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "NotFoundError") return null;
      throw error;
    }
  };

  const readText = async (
    directory: FileSystemDirectoryHandle,
    name: string,
    maxBytes?: number,
  ): Promise<{ text: string; modifiedAt: number }> => {
    const fileHandle = await directory.getFileHandle(name);
    const file = await fileHandle.getFile();
    if (maxBytes !== undefined && file.size > maxBytes) {
      throw new FileStoreError("io", `${name} exceeds the ${maxBytes}-byte document size limit`);
    }
    return { text: await file.text(), modifiedAt: file.lastModified };
  };

  const modifiedAt = async (
    directory: FileSystemDirectoryHandle,
    name: string,
  ): Promise<number> => {
    const fileHandle = await directory.getFileHandle(name);
    return (await fileHandle.getFile()).lastModified;
  };

  const writeText = async (
    directory: FileSystemDirectoryHandle,
    name: string,
    content: string,
  ): Promise<void> => {
    const fileHandle = await directory.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the write failure; abort is best-effort cleanup.
      }
      throw error;
    }
  };

  /** Entry names in a directory. Empty when the directory does not exist. */
  const namesIn = async (directory: FileSystemDirectoryHandle): Promise<string[]> => {
    const names: string[] = [];
    for await (const name of directory.keys()) names.push(name);
    return names;
  };

  const listDocNames = async (): Promise<string[]> => {
    const docs = await existingDir(DOCS_DIR);
    if (docs === null) return [];
    const names = await namesIn(docs);
    return names.sort((a, b) => a.localeCompare(b));
  };

  const readRecent = async (): Promise<RecentEntry[]> => {
    try {
      const meta = await existingDir(META_DIR);
      if (meta === null) return [];
      const { text } = await readText(meta, RECENT_FILE);
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      // Hand-editable storage: keep only entries that still look right rather than
      // throwing, since a corrupt recent list must never block opening a document.
      return parsed
        .filter(
          (entry): entry is RecentEntry =>
            typeof (entry as RecentEntry)?.handle?.key === "string" &&
            typeof (entry as RecentEntry)?.openedAt === "number",
        )
        .map((entry) => ({ ...entry, handle: handleFor(entry.handle.key) }));
    } catch {
      return [];
    }
  };

  /** The document's snapshot directory. Names are zero-padded so they sort. */
  const recoveryDirFor = (key: string, create: boolean) => dir(create, RECOVERY_DIR, key);

  const recoveryNames = async (directory: FileSystemDirectoryHandle): Promise<string[]> =>
    (await namesIn(directory)).filter((name) => RECOVERY_FILE.test(name)).sort();

  interface StoredRecovery {
    readonly directory: FileSystemDirectoryHandle;
    readonly key: string;
    readonly name: string;
    readonly size: number;
    readonly modifiedAt: number;
  }

  const storedRecoveries = async (parent: FileSystemDirectoryHandle): Promise<StoredRecovery[]> => {
    const found: StoredRecovery[] = [];
    for await (const [key, entry] of parent.entries()) {
      if (entry.kind !== "directory") continue;
      const directory = entry as FileSystemDirectoryHandle;
      for (const name of await recoveryNames(directory)) {
        try {
          const file = await (await directory.getFileHandle(name)).getFile();
          found.push({ directory, key, name, size: file.size, modifiedAt: file.lastModified });
        } catch {
          // It may have been removed by another tab between enumeration and stat.
        }
      }
    }
    return found;
  };

  const pruneStoredRecoveries = async (): Promise<void> => {
    const parent = await existingDir(RECOVERY_DIR);
    if (parent === null) return;
    const found = (await storedRecoveries(parent)).sort(
      (a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name),
    );
    let bytes = found.reduce((sum, item) => sum + item.size, 0);
    while (found.length > RECOVERY_TOTAL_LIMIT || bytes > RECOVERY_TOTAL_BYTES) {
      const oldest = found.shift();
      if (oldest === undefined) break;
      await oldest.directory.removeEntry(oldest.name);
      bytes -= oldest.size;
    }
  };

  const store: OpfsFileStore = {
    kind: "opfs",
    capabilities: {
      nativeDialogs: false,
      persistent: true,
      modifiedTimes: true,
    },

    async openWithPicker() {
      const names = await listDocNames();
      const choice = await opts.picker(names.map(handleFor), "open");
      if (choice === null) throw new FileStoreError("cancelled", "open cancelled");
      const target = isSavePickerChoice(choice) ? choice.handle : choice;
      const key = typeof target === "string" ? safeDocumentFilename(target) : target.key;
      return store.openHandle(handleFor(key));
    },

    async openHandle(handle) {
      try {
        const { text, modifiedAt } = await readText(
          await dir(false, DOCS_DIR),
          handle.key,
          MAX_DOCUMENT_BYTES,
        );
        return { handle: handleFor(handle.key), content: text, modifiedAt } satisfies OpenResult;
      } catch (error) {
        throw wrap(error, `cannot open ${handle.label}`);
      }
    },

    async save(handle, content, options) {
      try {
        return await withDocumentLock(handle.key, async () => {
          const docs = await dir(true, DOCS_DIR);
          if (options?.force !== true && options?.expectedModifiedAt !== undefined) {
            let currentModifiedAt: number | null = null;
            try {
              currentModifiedAt = await modifiedAt(docs, handle.key);
            } catch (error) {
              if ((error as { name?: string } | null)?.name !== "NotFoundError") throw error;
            }
            if (currentModifiedAt !== options.expectedModifiedAt) {
              throw new FileStoreError("conflict", `${handle.label} changed since it was opened`);
            }
          }
          await writeText(docs, handle.key, content);
          const { modifiedAt: writtenAt } = await readText(docs, handle.key);
          return { modifiedAt: writtenAt };
        });
      } catch (error) {
        throw wrap(error, `cannot save ${handle.label}`);
      }
    },

    async saveAs(content, suggestedName) {
      const names = await listDocNames();
      const choice = await opts.picker(
        names.map(handleFor),
        "save",
        safeDocumentFilename(suggestedName),
      );
      if (choice === null) throw new FileStoreError("cancelled", "save cancelled");
      const target = isSavePickerChoice(choice) ? choice.handle : choice;
      const overwrite = isSavePickerChoice(choice) && choice.overwrite;
      const key = typeof target === "string" ? safeDocumentFilename(target) : target.key;
      const handle = handleFor(key);
      const docs = await dir(true, DOCS_DIR);
      try {
        await docs.getFileHandle(key);
        if (!overwrite) {
          throw new FileStoreError("already-exists", `${handle.label} already exists`);
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "NotFoundError") throw error;
      }
      const { modifiedAt } = await store.save(
        handle,
        content,
        overwrite ? { force: true } : { expectedModifiedAt: null },
      );
      return { handle, modifiedAt };
    },

    async writeRecovery(key, content) {
      try {
        const payload = JSON.stringify({ content, savedAt: now() });
        if (new TextEncoder().encode(payload).byteLength > MAX_DOCUMENT_BYTES) {
          throw new FileStoreError(
            "io",
            `recovery for ${key} exceeds the ${MAX_DOCUMENT_BYTES}-byte size limit`,
          );
        }
        const directory = await recoveryDirFor(key, true);
        const existing = await recoveryNames(directory);
        // Sequence from the highest existing name, so a torn write cannot make two
        // snapshots collide.
        const last = Number(existing.at(-1)?.match(RECOVERY_FILE)?.[1] ?? "0");
        let next = last + 1;
        if (!Number.isSafeInteger(next) || next > 999_999) {
          const used = new Set(existing);
          next = 1;
          while (used.has(`${String(next).padStart(6, "0")}.json`)) next++;
        }
        const seq = String(next).padStart(6, "0");
        await writeText(directory, `${seq}.json`, payload);

        // Prune oldest-first. Done after the write, so a failure here leaves an
        // over-long history rather than losing the snapshot just taken.
        const after = await recoveryNames(directory);
        const byAge: Array<{ name: string; modifiedAt: number }> = [];
        for (const name of after) {
          const file = await (await directory.getFileHandle(name)).getFile();
          byAge.push({ name, modifiedAt: file.lastModified });
        }
        byAge.sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name));
        for (const entry of byAge.slice(0, Math.max(0, byAge.length - RECOVERY_HISTORY_LIMIT))) {
          await directory.removeEntry(entry.name);
        }
        await pruneStoredRecoveries();
      } catch (error) {
        throw wrap(error, `cannot write recovery for ${key}`);
      }
    },

    async clearRecovery(key) {
      try {
        const parent = await existingDir(RECOVERY_DIR);
        if (parent === null) return;
        await parent.removeEntry(key, { recursive: true });
      } catch (error) {
        // Nothing to clear is the common case, not a failure.
        if ((error as { name?: string } | null)?.name === "NotFoundError") return;
        throw wrap(error, `cannot clear recovery for ${key}`);
      }
    },

    async dropRecovery(id) {
      const { key, file } = splitRecoveryId(id);
      if (key === null || !RECOVERY_FILE.test(file)) return;
      try {
        const directory = await existingDir(RECOVERY_DIR, key);
        if (directory === null) return;
        await directory.removeEntry(file);
        // Drop the now-empty directory too, so listRecoveries stops walking it.
        if ((await namesIn(directory)).length === 0) {
          const parent = await existingDir(RECOVERY_DIR);
          await parent?.removeEntry(key, { recursive: true });
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "NotFoundError") return;
        throw wrap(error, `cannot drop recovery ${id}`);
      }
    },

    async listRecoveries() {
      const out: RecoveryInfo[] = [];
      const parent = await existingDir(RECOVERY_DIR);
      if (parent === null) return [];
      const docsDir = await existingDir(DOCS_DIR);

      // Stat first, then read newest-first under a byte ceiling. This bounds the
      // strings retained by the startup prompt even if storage was hand-edited.
      const candidates = (await storedRecoveries(parent)).sort(
        (a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name),
      );
      const sourceTimes = new Map<string, number | null>();
      let retainedBytes = 0;
      for (const candidate of candidates.slice(0, RECOVERY_TOTAL_LIMIT)) {
        if (retainedBytes + candidate.size > RECOVERY_STARTUP_BYTES) continue;

        let sourceModifiedAt = sourceTimes.get(candidate.key);
        if (sourceModifiedAt === undefined) {
          sourceModifiedAt = null;
          try {
            if (docsDir !== null) sourceModifiedAt = await modifiedAt(docsDir, candidate.key);
          } catch {
            // Never saved, or deleted since — every snapshot is then worth offering.
          }
          sourceTimes.set(candidate.key, sourceModifiedAt);
        }

        let parsed: { content?: unknown; savedAt?: unknown };
        try {
          parsed = JSON.parse(
            (await readText(candidate.directory, candidate.name, MAX_DOCUMENT_BYTES)).text,
          ) as typeof parsed;
        } catch {
          // A torn write: skip this snapshot, keep the rest of the history.
          continue;
        }
        if (
          typeof parsed.content !== "string" ||
          typeof parsed.savedAt !== "number" ||
          !Number.isFinite(parsed.savedAt)
        ) {
          continue;
        }
        if (sourceModifiedAt !== null && sourceModifiedAt >= parsed.savedAt) continue;

        retainedBytes += candidate.size;
        out.push({
          id: recoveryId(candidate.key, candidate.name),
          handle: handleFor(candidate.key),
          content: parsed.content,
          recoveredAt: parsed.savedAt,
          sourceModifiedAt,
        });
      }

      return out.sort((a, b) => b.recoveredAt - a.recoveredAt);
    },

    async listRecent() {
      const entries = await readRecent();
      return entries.sort((a, b) => b.openedAt - a.openedAt);
    },

    async pushRecent(handle) {
      const entries = (await readRecent()).filter((e) => e.handle.key !== handle.key);
      entries.unshift({ handle: handleFor(handle.key), openedAt: now() });
      try {
        await writeText(
          await dir(true, META_DIR),
          RECENT_FILE,
          JSON.stringify(entries.slice(0, RECENT_LIMIT)),
        );
      } catch (error) {
        throw wrap(error, "cannot update the recent-file list");
      }
    },
  };

  return store;
}

/**
 * A snapshot id encodes its own location: `<document key>/<snapshot file>`.
 *
 * `/` is the separator because no filesystem — OPFS included — permits it inside
 * a single name, so the split is unambiguous. Split on the **last** occurrence:
 * a document key may itself contain slashes (under Tauri it is an absolute path),
 * while the snapshot filename never can.
 */
const ID_SEPARATOR = "/";

const recoveryId = (key: string, file: string): string => `${key}${ID_SEPARATOR}${file}`;

function splitRecoveryId(id: string): { key: string | null; file: string } {
  const index = id.lastIndexOf(ID_SEPARATOR);
  if (index <= 0) return { key: null, file: "" };
  return { key: id.slice(0, index), file: id.slice(index + 1) };
}
