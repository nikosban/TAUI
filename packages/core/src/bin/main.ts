/**
 * Unconditional Node executable for the `tui-designer` package bin.
 *
 * All command decisions live in the importable `cli.ts`; this file owns only real
 * process and filesystem IO. Package-manager shims and symlinks therefore need no
 * filename-sensitive entry detection.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ResourceLimitError } from "../index.js";
import { run } from "./cli.js";

const code = run(process.argv.slice(2), {
  readFile: (path, maxBytes) => {
    const bytes = statSync(path).size;
    if (bytes > maxBytes) {
      throw new ResourceLimitError(`input file is ${bytes} bytes; limit is ${maxBytes}`);
    }
    return readFileSync(path, "utf8");
  },
  writeFile: (path, data) => writeFileSync(path, data, "utf8"),
  stdout: (data) => process.stdout.write(data),
  stderr: (data) => process.stderr.write(data),
});
process.exitCode = code;
