import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { MIGRATIONS } from "../src/migrations.js";
import { mask } from "../src/shared.js";

it("exports an immutable ordered migration list", () => {
  expect(Object.isFrozen(MIGRATIONS)).toBe(true);
  expect(MIGRATIONS[0]).toContain("error_intake_meta");
  expect(MIGRATIONS.at(-1)).toContain("schema_version");
});

describe("mask", () => {
  it("removes common secrets and identifiers from text and URLs", () => {
    const input = "user jane@example.com Bearer abc.def.ghi jwt eyJhbGci.eyJzdWI.abc https://gateway.example.test/route?key=gateway-secret#fragment id=1234567890 password=hunter2 access_token=refresh-me verificationCode=123456789 code:9876 state=xyz";
    const output = mask(input);

    expect(output).toContain("<email>");
    expect(output).toContain("<token>");
    expect(output).toContain("https://gateway.example.test/route");
    expect(output).toContain("<number>");
    expect(output).toContain("password=<redacted>");
    expect(output).toContain("token=<redacted>");
    expect(output).toContain("access_token=<redacted>");
    expect(output).toContain("verificationCode=<redacted>");
    expect(output).toContain("code:<redacted>");
    expect(output).toContain("state=<redacted>");
    expect(output).not.toMatch(/gateway-secret|hunter2|refresh-me|123456789|abc123|9876|jane@example\.com|#fragment/);
  });

  it("masks query-only secret fields in gateway URLs", () => {
    expect(mask("https://gateway.test/intake?key=leaked-value&safe=1"))
      .toBe("https://gateway.test/intake");
  });
});

describe("fingerprint", () => {
  const base = {
    source: "server" as const,
    errorType: "TypeError",
    message: "Cannot load user 12345",
    topFrame: "at load (/app/chunk-a1b2c3d4.js:10:2)",
    route: "/users/:id",
  };

  it("ignores stack line and column changes", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base, topFrame: "at load (/app/chunk-a1b2c3d4.js:87:14)" }));
  });

  it("ignores hashed bundle filenames", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base, topFrame: "at load (/app/chunk-f9e8d7c6.js:10:2)" }));
  });

  it("normalizes URL hosts to their paths", () => {
    expect(fingerprint({ ...base, message: "GET https://one.test/items/123 failed" }))
      .toBe(fingerprint({ ...base, message: "GET https://two.test/items/123 failed" }));
  });
});
