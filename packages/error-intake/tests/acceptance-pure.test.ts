import { describe, expect, it } from "vitest";
import {
  containsAny,
  validatePackFilePaths,
  validateRootDatabaseUrl,
} from "../acceptance/pure.js";

describe("acceptance pure checks", () => {
  it("accepts only a root MySQL URL for the dedicated acceptance database", () => {
    expect(validateRootDatabaseUrl("mysql://root:secret@127.0.0.1:3306/ei_pkg_accept")).toEqual({ ok: true });
    expect(validateRootDatabaseUrl("mysql://writer:secret@127.0.0.1:3306/ei_pkg_accept").ok).toBe(false);
    expect(validateRootDatabaseUrl("mysql://root:secret@127.0.0.1:3306/other_db").ok).toBe(false);
    expect(validateRootDatabaseUrl("not-a-url").ok).toBe(false);
    expect(validateRootDatabaseUrl(undefined).ok).toBe(false);
  });

  it("allows only distribution files in the package archive", () => {
    expect(validatePackFilePaths(["package.json", "README.md", "dist/index.js", "LICENSE"]).ok).toBe(true);
    expect(validatePackFilePaths(["package.json", "README.md", "dist/index.js", "acceptance/run.ts"]).ok).toBe(false);
    expect(validatePackFilePaths(["package.json", "README.md", "dist/../src/index.ts"]).ok).toBe(false);
    expect(validatePackFilePaths(["package.json", "README.md"]).ok).toBe(false);
  });

  it("detects raw sensitive markers without changing the checked value", () => {
    expect(containsAny("stored message <email> <token>", ["jane@example.com", "Bearer abc.def.ghi"])).toBe(false);
    expect(containsAny("stored message jane@example.com", ["jane@example.com"])).toBe(true);
    expect(containsAny("any value", [""])).toBe(false);
  });
});
