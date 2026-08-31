/**
 * The single filename policy for browser documents and exported artefacts.
 *
 * It deliberately produces a filename, never a path. Adapters that eventually
 * work with native paths must apply it only to the basename chosen by the user.
 */

export const SAFE_FILENAME_MAX_CHARS = 120;

// Unicode bidi controls can make `invoice.exe.tui` appear in the opposite order.
// Most are Cf, but spelling the ranges out documents the security boundary and
// keeps the policy intact if the broader format-character policy changes.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const CONTROL_OR_FORMAT_GLOBAL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const PATH_OR_RESERVED = /[/\\:*?"<>|]/u;
const PATH_OR_RESERVED_GLOBAL = /[/\\:*?"<>|]+/gu;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function filenameProblem(input: string): string | null {
  const value = input.trim();
  if (value === "") return "Enter a file name.";
  if (BIDI_CONTROLS.test(value) || CONTROL_OR_FORMAT.test(value)) {
    return "File names cannot contain control or text-direction characters.";
  }
  if (PATH_OR_RESERVED.test(value)) {
    return "File names cannot contain path separators or filesystem-reserved characters.";
  }
  if ([...value].length > SAFE_FILENAME_MAX_CHARS) {
    return `File names must be ${SAFE_FILENAME_MAX_CHARS} characters or fewer.`;
  }
  return null;
}

/**
 * Returns a bounded, non-empty filename with one canonical extension.
 * Unsafe characters are removed/replaced here even when a caller bypasses the
 * normal dialog validation (custom picker, recovered metadata, or test port).
 */
export function safeFilename(input: string | null, extension: string): string {
  if (!/^[a-z0-9]{1,8}$/u.test(extension)) {
    throw new Error(`invalid filename extension: ${extension}`);
  }

  let stem = (input ?? "untitled").normalize("NFC").trim();
  const suffix = `.${extension}`;
  if (stem.toLocaleLowerCase("en-US").endsWith(suffix)) stem = stem.slice(0, -suffix.length);
  stem = stem
    .replace(CONTROL_OR_FORMAT_GLOBAL, "")
    .replace(PATH_OR_RESERVED_GLOBAL, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[\s.]+|[\s.]+$/gu, "");

  if (stem === "" || stem === "." || stem === "..") stem = "untitled";
  if (WINDOWS_DEVICE.test(stem)) stem = `${stem}-file`;

  const maxStemChars = SAFE_FILENAME_MAX_CHARS - [...suffix].length;
  stem = [...stem]
    .slice(0, maxStemChars)
    .join("")
    .replace(/[\s.]+$/gu, "");
  if (stem === "") stem = "untitled";
  return `${stem}${suffix}`;
}

export const safeDocumentFilename = (input: string | null): string => safeFilename(input, "tui");
