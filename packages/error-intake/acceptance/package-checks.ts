import { runCommand, isolatedNodeEnv } from "./processes.js";
import { validatePackFilePaths } from "./pure.js";
import type { CheckReporter } from "./report.js";

interface PackJsonEntry {
  readonly files?: readonly { readonly path?: unknown }[];
}

export async function runPackageChecks(packageRoot: string, nodePath: string, cacheDir: string, reporter: CheckReporter): Promise<void> {
  const env = isolatedNodeEnv(nodePath, { npm_config_cache: cacheDir });
  const pack = await runCommand("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    env,
    timeoutMs: 120_000,
  });
  const packOk = succeeded(pack);
  reporter.add("package", "npm pack --dry-run --json", packOk, packOk ? "command completed" : "command failed or timed out");
  const paths = packOk ? packFilePaths(pack.stdout) : [];
  const inventory = validatePackFilePaths(paths);
  reporter.add("package", "archive file allowlist", packOk && inventory.ok, `files=${paths.length}; unexpected=${inventory.unexpectedCount}; required missing=${inventory.missingRequiredCount}`);

  const publish = await runCommand("npm", ["publish", "--dry-run"], {
    cwd: packageRoot,
    env,
    timeoutMs: 120_000,
  });
  const publishOk = succeeded(publish);
  reporter.add("package", "npm publish --dry-run", publishOk, publishOk ? "command completed" : "command failed or timed out");
}

function packFilePaths(stdout: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    const entry = parsed[0] as PackJsonEntry | undefined;
    return entry?.files?.flatMap((file) => typeof file.path === "string" ? [file.path] : []) ?? [];
  } catch {
    return [];
  }
}

function succeeded(result: { readonly code: number | null; readonly timedOut: boolean; readonly spawnError: string | undefined }): boolean {
  return result.code === 0 && !result.timedOut && result.spawnError === undefined;
}
