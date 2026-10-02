import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckReporter } from "./report.js";
import { createAcceptanceProjects } from "./projects.js";

export async function reportReadmeAlignment(packageRoot: string, reporter: CheckReporter): Promise<void> {
  try {
    const readme = await readFile(join(packageRoot, "README.md"), "utf8");
    const projects = createAcceptanceProjects();
    const nest = projects.find((project) => project.kind === "nest-cjs");
    const express4 = projects.find((project) => project.kind === "express4-cjs");
    const express5 = projects.find((project) => project.kind === "express5-esm");
    const next = projects.find((project) => project.kind === "next-app");
    const aligned = Boolean(nest && express4 && express5 && next) && [
      readme.includes('app.use("/error-intake", createClientErrorHandler(errorSink));'),
      readme.includes("removes the `/api` prefix"),
      readme.includes('require("@yeschef/error-intake/express")'),
      readme.includes("const errorSink = createMysqlSink({"),
      readme.includes('import { createClientErrorHandler, errorIntakeErrorMiddleware } from "@yeschef/error-intake/express";'),
      readme.includes("createOnRequestError(errorSink)"),
      readme.includes("createClientErrorRoute(errorSink)"),
      readme.includes('endpoint: "/api/error-intake"'),
      nest?.files["src/main.ts"]?.includes('app.use("/error-intake", createClientErrorHandler(errorSink))'),
      express4?.files["server.cjs"]?.includes('app.post("/error-intake", createClientErrorHandler(errorSink))'),
      express5?.files["server.mjs"]?.includes('app.post("/error-intake", createClientErrorHandler(errorSink))'),
      next?.files["app/api/error-intake/route.ts"]?.includes("createClientErrorRoute(errorSink)"),
      next?.files["app/reporter.tsx"]?.includes('endpoint: "/api/error-intake"'),
    ].every(Boolean);
    reporter.add("README 問題", "fixture code follows README", aligned, aligned ? "no fixture deviations; proxy-stripped routes and Next.js endpoint match" : "fixture and README differ; review this as a README problem");
  } catch {
    reporter.add("README 問題", "fixture code follows README", false, "README could not be checked against the fixture code");
  }
}
