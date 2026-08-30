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

import {
  type Clock,
  type DocHandle,
  type FileStore,
  FileStoreError,
  MAX_DOCUMENT_BYTES,
  type OpenResult,
  type PickerFn,
  RECOVERY_HISTORY_LIMIT,
  type RecentEntry,
  type RecoveryInfo,
} from "./file-store.js";

const DOCS_DIR = "docs";
const RECOVERY_DIR = "recovery";
const META_DIR = "meta";
const RECENT_FILE = "recent.json";
const RECENT_LIMIT = 12;

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
  label: name,
  display: `${name} (browser storage)`,
});

/** Ensures `.tui`, so a name typed without it still lands somewhere sensible. */
const withExtension = (name: string): string => (name.endsWith(".tui") ? name : `${name}.tui`);

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

  /** A subdirectory of the root, created on demand. */
  const dir = async (...path: string[]): Promise<FileSystemDirectoryHandle> => {
    let current = await getRoot();
    for (const segment of path) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
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
    await writable.write(content);
    await writable.close();
  };

  /** Entry names in a directory. Empty when the directory does not exist. */
  const namesIn = async (directory: FileSystemDirectoryHandle): Promise<string[]> => {
    const names: string[] = [];
    for await (const name of directory.keys()) names.push(name);
    return names;
  };

  const listDocNames = async (): Promise<string[]> => {
    const names = await namesIn(await dir(DOCS_DIR));
    return names.sort((a, b) => a.localeCompare(b));
  };

  const readRecent = async (): Promise<RecentEntry[]> => {
    try {
      const { text } = await readText(await dir(META_DIR), RECENT_FILE);
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      // Hand-editable storage: keep only entries that still look right rather than
      // throwing, since a corrupt recent list must never block opening a document.
      return parsed.filter(
        (entry): entry is RecentEntry =>
          typeof (entry as RecentEntry)?.handle?.key === "string" &&
          typeof (entry as RecentEntry)?.openedAt === "number",
      );
    } catch {
      return [];
    }
  };

  /** The document's snapshot directory. Names are zero-padded so they sort. */
  const recoveryDirFor = (key: string) => dir(RECOVERY_DIR, key);

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
      const key = typeof choice === "string" ? withExtension(choice) : choice.key;
      return store.openHandle(handleFor(key));
    },

    async openHandle(handle) {
      try {
        const { text, modifiedAt } = await readText(
          await dir(DOCS_DIR),
          handle.key,
          MAX_DOCUMENT_BYTES,
        );
        return { handle, content: text, modifiedAt } satisfies OpenResult;
      } catch (error) {
        throw wrap(error, `cannot open ${handle.label}`);
      }
    },

    async save(handle, content) {
      try {
        await writeText(await dir(DOCS_DIR), handle.key, content);
        const { modifiedAt } = await readText(await dir(DOCS_DIR), handle.key);
        return { modifiedAt };
      } catch (error) {
        throw wrap(error, `cannot save ${handle.label}`);
      }
    },

    async saveAs(content, suggestedName) {
      const names = await listDocNames();
      const choice = await opts.picker(names.map(handleFor), "save", suggestedName);
      if (choice === null) throw new FileStoreError("cancelled", "save cancelled");
      const key = withExtension(typeof choice === "string" ? choice : choice.key);
      const handle = handleFor(key);
      const { modifiedAt } = await store.save(handle, content);
      return { handle, modifiedAt };
    },

    async writeRecovery(key, content) {
      try {
        const directory = await recoveryDirFor(key);
        const existing = (await namesIn(directory)).sort();
        // Sequence from the highest existing name, so a torn write cannot make two
        // snapshots collide.
        const last = existing.at(-1)?.replace(/\.json$/u, "") ?? "0";
        const seq = String(Number(last) + 1).padStart(6, "0");
        await writeText(directory, `${seq}.json`, JSON.stringify({ content, savedAt: now() }));

        // Prune oldest-first. Done after the write, so a failure here leaves an
        // over-long history rather than losing the snapshot just taken.
        const after = (await namesIn(directory)).sort();
        for (const name of after.slice(0, Math.max(0, after.length - RECOVERY_HISTORY_LIMIT))) {
          await directory.removeEntry(name);
        }
      } catch (error) {
        throw wrap(error, `cannot write recovery for ${key}`);
      }
    },

    async clearRecovery(key) {
      try {
        const parent = await dir(RECOVERY_DIR);
        await parent.removeEntry(key, { recursive: true });
      } catch (error) {
        // Nothing to clear is the common case, not a failure.
        if ((error as { name?: string } | null)?.name === "NotFoundError") return;
        throw wrap(error, `cannot clear recovery for ${key}`);
      }
    },

    async dropRecovery(id) {
      const { key, file } = splitRecoveryId(id);
      if (key === null) return;
      try {
        const directory = await recoveryDirFor(key);
        await directory.removeEntry(file);
        // Drop the now-empty directory too, so listRecoveries stops walking it.
        if ((await namesIn(directory)).length === 0) {
          await (await dir(RECOVERY_DIR)).removeEntry(key, { recursive: true });
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "NotFoundError") return;
        throw wrap(error, `cannot drop recovery ${id}`);
      }
    },

    async listRecoveries() {
      const out: RecoveryInfo[] = [];
      const parent = await dir(RECOVERY_DIR);
      const docsDir = await dir(DOCS_DIR);

      for await (const [key, entry] of parent.entries()) {
        if (entry.kind !== "directory") continue;

        // The source's mtime decides whether any of this is worth offering.
        let sourceModifiedAt: number | null = null;
        try {
          sourceModifiedAt = await modifiedAt(docsDir, key);
        } catch {
          // Never saved, or deleted since — every snapshot is then worth offering.
        }

        const directory = entry as FileSystemDirectoryHandle;
        for (const file of (await namesIn(directory)).sort()) {
          let parsed: { content?: unknown; savedAt?: unknown };
          try {
            parsed = JSON.parse(
              (await readText(directory, file, MAX_DOCUMENT_BYTES)).text,
            ) as typeof parsed;
          } catch {
            // A torn write: skip this snapshot, keep the rest of the history.
            continue;
          }
          if (typeof parsed.content !== "string" || typeof parsed.savedAt !== "number") continue;
          if (sourceModifiedAt !== null && sourceModifiedAt >= parsed.savedAt) continue;

          out.push({
            id: recoveryId(key, file),
            handle: handleFor(key),
            content: parsed.content,
            recoveredAt: parsed.savedAt,
            sourceModifiedAt,
          });
        }
      }

      return out.sort((a, b) => b.recoveredAt - a.recoveredAt);
    },

    async listRecent() {
      const entries = await readRecent();
      return entries.sort((a, b) => b.openedAt - a.openedAt);
    },

    async pushRecent(handle) {
      const entries = (await readRecent()).filter((e) => e.handle.key !== handle.key);
      entries.unshift({ handle, openedAt: now() });
      try {
        await writeText(
          await dir(META_DIR),
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
