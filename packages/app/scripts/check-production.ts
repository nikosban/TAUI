/** Security assertions over the browser artifact that actually ships. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const htmlPath = "dist/index.html";
const html = readFileSync(htmlPath, "utf8");
const failures: string[] = [];

const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/u.exec(html);
if (meta === null) {
  failures.push(`${htmlPath} has no production Content-Security-Policy meta tag`);
} else {
  const policy = meta[1] as string;
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    if (!policy.split("; ").includes(directive)) failures.push(`CSP is missing ${directive}`);
  }
  if (/https?:|wss?:|script-src[^;]*'unsafe-(inline|eval)'/u.test(policy)) {
    failures.push("production CSP enables a remote source or unsafe script execution");
  }
}

if (html.includes("TAUI_PRODUCTION_CSP")) {
  failures.push("the production CSP placeholder was not replaced");
}

const assetsDir = "dist/assets";
const javascript = readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(assetsDir, name), "utf8"))
  .join("\n");
if (/\brenderedText\b|(?:window|globalThis)\.__tui\b/u.test(javascript)) {
  failures.push("production JavaScript still contains the browser test hook");
}

if (failures.length > 0) {
  process.stderr.write("production security check FAILED\n\n");
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write("production security check passed (strict CSP, no browser test hook)\n");
