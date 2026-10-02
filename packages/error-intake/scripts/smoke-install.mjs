// Installs a packed tarball into an empty project and loads every entry with ESM and CommonJS.
// Used by CI on Node versions the dev toolchain (vitest, jsdom) does not support.
// Usage: node scripts/smoke-install.mjs <absolute path to .tgz>
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const ENTRIES = ["", "/nestjs", "/express", "/next", "/browser"];
const PACKAGE = "@yeschef/error-intake";
const PEERS = ["@nestjs/common@11", "@nestjs/core@11", "reflect-metadata", "rxjs"];

const tarball = process.argv[2];
if (!tarball || !isAbsolute(tarball)) {
  console.error("usage: node scripts/smoke-install.mjs <absolute path to .tgz>");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "error-intake-smoke-"));
const run = (command, args) => execFileSync(command, args, { cwd: dir, stdio: "inherit" });

try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  run("npm", ["install", "--no-audit", "--no-fund", tarball, ...PEERS]);

  const esm = ENTRIES.map((entry) => `await import("${PACKAGE}${entry}");`).join("\n");
  writeFileSync(join(dir, "esm.mjs"), `${esm}
const { createMysqlSink } = await import("${PACKAGE}");
const sink = createMysqlSink({ url: "mysql://user:pass@127.0.0.1:1/db", project: "smoke", environment: "local" });
await sink.close();
console.log("esm ok");
`);
  const cjs = ENTRIES.map((entry) => `require("${PACKAGE}${entry}");`).join("\n");
  writeFileSync(join(dir, "cjs.cjs"), `${cjs}\nconsole.log("cjs ok");\n`);

  run(process.execPath, ["esm.mjs"]);
  run(process.execPath, ["cjs.cjs"]);
  console.log(`smoke install passed on Node ${process.version}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
