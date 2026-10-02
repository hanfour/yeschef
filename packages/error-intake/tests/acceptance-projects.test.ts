import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAcceptanceProjects } from "../acceptance/projects.js";
import { reportReadmeAlignment } from "../acceptance/readme-check.js";
import type { AcceptanceCheck, CheckReporter } from "../acceptance/report.js";

describe("acceptance project fixtures", () => {
  it("defines the four requested framework and module formats", () => {
    const projects = createAcceptanceProjects();
    expect(projects.map((project) => project.kind)).toEqual([
      "express4-cjs",
      "express5-esm",
      "nest-cjs",
      "next-app",
    ]);
    expect(projects[0]?.packageJson.type).toBe("commonjs");
    expect(projects[0]?.files["server.cjs"]).toContain("require(\"@yeschef/error-intake/express\")");
    expect(projects[1]?.packageJson.type).toBe("module");
    expect(projects[1]?.dependencies).toContain("express@^5.1.0");
    expect(projects[1]?.files["server.mjs"]).toContain("import express from \"express\"");
  });

  it("builds the Nest CommonJS and Node16 compiler fixture from the README adapters", () => {
    const nest = createAcceptanceProjects().find((project) => project.kind === "nest-cjs");
    expect(nest?.packageJson.type).toBe("commonjs");
    expect(nest?.dependencies).toContain("@nestjs/platform-express@^11.0.0");
    expect(JSON.parse(nest?.files["tsconfig.json"] ?? "{}").compilerOptions.module).toBe("Node16");
    expect(nest?.files["src/main.ts"]).toContain("app.use(\"/error-intake\", createClientErrorHandler(errorSink))");
  });

  it("uses the README Next.js adapters and browser endpoint", () => {
    const next = createAcceptanceProjects().find((project) => project.kind === "next-app");
    expect(next?.dependencies).toContain("next@latest");
    expect(next?.files["instrumentation.ts"]).toContain("createOnRequestError(errorSink)");
    expect(next?.files["app/api/error-intake/route.ts"]).toContain("createClientErrorRoute(errorSink)");
    expect(next?.files["app/reporter.tsx"]).toContain("installErrorReporter({ endpoint: \"/api/error-intake\"");
    expect(next?.files["app/boom/page.tsx"]).toContain("EI_ACCEPTANCE_NEXT_SERVER_FAILURE");
  });

  it("reports that generated adapter snippets match the README", async () => {
    const checks: AcceptanceCheck[] = [];
    const reporter = { add: (...args: [string, string, boolean, string]) => checks.push({ scenario: args[0], check: args[1], ok: args[2], detail: args[3] }) } as unknown as CheckReporter;
    await reportReadmeAlignment(fileURLToPath(new URL("..", import.meta.url)), reporter);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.scenario).toBe("README 問題");
    expect(checks[0]?.ok).toBe(true);
  });
});
