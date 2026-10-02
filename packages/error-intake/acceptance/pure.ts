export const ACCEPTANCE_DATABASE = "ei_pkg_accept";

export type RootUrlValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

const EXPECTED_PACKAGE_FILES = ["package.json", "README.md"] as const;

export function validateRootDatabaseUrl(value: string | undefined): RootUrlValidation {
  if (!value) return { ok: false, detail: "EI_PKG_ROOT_URL is required" };

  try {
    const parsed = new URL(value);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (parsed.protocol !== "mysql:" || decodeURIComponent(parsed.username) !== "root") {
      return { ok: false, detail: "EI_PKG_ROOT_URL must use mysql:// with the root account" };
    }
    if (database !== ACCEPTANCE_DATABASE) {
      return { ok: false, detail: `EI_PKG_ROOT_URL must name ${ACCEPTANCE_DATABASE}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, detail: "EI_PKG_ROOT_URL is not a valid MySQL URL" };
  }
}

export function validatePackFilePaths(paths: readonly string[]): {
  readonly ok: boolean;
  readonly unexpectedCount: number;
  readonly missingRequiredCount: number;
} {
  const unexpectedCount = paths.filter((path) => !isPublishedPath(path)).length;
  const missingRequiredCount = EXPECTED_PACKAGE_FILES.filter((path) => !paths.includes(path)).length;
  const hasDistFiles = paths.some((path) => path.startsWith("dist/") && path.length > "dist/".length);
  return {
    ok: unexpectedCount === 0 && missingRequiredCount === 0 && hasDistFiles,
    unexpectedCount,
    missingRequiredCount: missingRequiredCount + Number(!hasDistFiles),
  };
}

export function containsAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => candidate.length > 0 && value.includes(candidate));
}

function isPublishedPath(path: string): boolean {
  const safeDistPath = path.startsWith("dist/") && !path.includes("\\") && !path.split("/").includes("..");
  return path === "package.json" || path === "README.md" || path === "LICENSE" || safeDistPath;
}
