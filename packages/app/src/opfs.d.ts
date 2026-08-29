/**
 * Async-iteration members of `FileSystemDirectoryHandle`.
 *
 * Shipping in every target browser but absent from the installed TypeScript DOM
 * lib. Declared minimally rather than cast at each use site: a cast would also
 * silence a genuine typo in the member name, and this way the compiler still
 * checks the shape.
 */
interface FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
}
