export type ProjectKind = "express4-cjs" | "express5-esm" | "nest-cjs" | "next-app";

export interface AcceptanceProject {
  readonly kind: ProjectKind;
  readonly projectCode: string;
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
}

const PROJECT_KINDS: readonly ProjectKind[] = ["express4-cjs", "express5-esm", "nest-cjs", "next-app"];

export function createAcceptanceProjects(): readonly AcceptanceProject[] {
  return PROJECT_KINDS.map(createProject);
}

function createProject(kind: ProjectKind): AcceptanceProject {
  const projectCode = `ei_acc_${kind.replaceAll("-", "_")}`;
  const commonPackage = { name: kind, version: "1.0.0", private: true };
  if (kind === "express4-cjs") return express4Project(projectCode, commonPackage);
  if (kind === "express5-esm") return express5Project(projectCode, commonPackage);
  if (kind === "nest-cjs") return nestProject(projectCode, commonPackage);
  return nextProject(projectCode, commonPackage);
}

function express4Project(projectCode: string, packageJson: Record<string, unknown>): AcceptanceProject {
  return {
    kind: "express4-cjs",
    projectCode,
    packageJson: { ...packageJson, type: "commonjs" },
    files: { "server.cjs": expressCommonJsServer() },
    dependencies: ["express@^4.21.2"],
    devDependencies: [],
  };
}

function express5Project(projectCode: string, packageJson: Record<string, unknown>): AcceptanceProject {
  return {
    kind: "express5-esm",
    projectCode,
    packageJson: { ...packageJson, type: "module" },
    files: { "server.mjs": expressEsmServer() },
    dependencies: ["express@^5.1.0"],
    devDependencies: [],
  };
}

function nestProject(projectCode: string, packageJson: Record<string, unknown>): AcceptanceProject {
  return {
    kind: "nest-cjs",
    projectCode,
    packageJson: {
      ...packageJson,
      type: "commonjs",
      scripts: { build: "tsc -p tsconfig.json" },
    },
    files: {
      "tsconfig.json": JSON.stringify(nestTsConfig, null, 2),
      "src/main.ts": nestMainSource,
      "src/app.module.ts": nestModuleSource,
    },
    dependencies: [
      "@nestjs/common@^11.0.0", "@nestjs/core@^11.0.0", "@nestjs/platform-express@^11.0.0",
      "reflect-metadata", "rxjs",
    ],
    devDependencies: ["typescript@^5.9.3", "@types/node@^22"],
  };
}

function nextProject(projectCode: string, packageJson: Record<string, unknown>): AcceptanceProject {
  return {
    kind: "next-app",
    projectCode,
    packageJson: {
      ...packageJson,
      type: "module",
      scripts: { build: "next build", start: "next start" },
    },
    files: nextAppFiles,
    dependencies: ["next@latest", "react@latest", "react-dom@latest"],
    devDependencies: ["typescript@^5.9.3", "@types/node@^22", "@types/react@latest", "@types/react-dom@latest"],
  };
}

function expressCommonJsServer(): string {
  return `const express = require("express");
const { createMysqlSink, resolveEnvironment } = require("@yeschef/error-intake");
const { createClientErrorHandler, errorIntakeErrorMiddleware } = require("@yeschef/error-intake/express");
const app = express();
const errorSink = createMysqlSink({
  url: process.env.ERROR_INTAKE_DATABASE_URL,
  project: process.env.ERROR_INTAKE_PROJECT,
  environment: resolveEnvironment(process.env),
});

app.get("/", (_request, response) => response.status(200).end(process.env.EI_ACCEPTANCE_READY_TOKEN));
app.get("/boom", (_request, _response, next) => next(new Error("EI_ACCEPTANCE_SERVER_FAILURE")));
app.get("/bad-request", (_request, _response, next) => {
  const error = new Error("EI_ACCEPTANCE_BAD_REQUEST");
  error.status = 400;
  next(error);
});
app.post("/error-intake", createClientErrorHandler(errorSink));
app.use(errorIntakeErrorMiddleware(errorSink));
app.use((error, _request, response, _next) => response.status(error.status || 500).end());

app.listen(Number(process.env.PORT), "127.0.0.1");
`;
}

function expressEsmServer(): string {
  return `import express from "express";
import { createMysqlSink, resolveEnvironment } from "@yeschef/error-intake";
import { createClientErrorHandler, errorIntakeErrorMiddleware } from "@yeschef/error-intake/express";
const app = express();
const errorSink = createMysqlSink({
  url: process.env.ERROR_INTAKE_DATABASE_URL,
  project: process.env.ERROR_INTAKE_PROJECT,
  environment: resolveEnvironment(process.env),
});

app.get("/", (_request, response) => response.status(200).end(process.env.EI_ACCEPTANCE_READY_TOKEN));
app.get("/boom", (_request, _response, next) => next(new Error("EI_ACCEPTANCE_SERVER_FAILURE")));
app.get("/bad-request", (_request, _response, next) => {
  const error = new Error("EI_ACCEPTANCE_BAD_REQUEST");
  error.status = 400;
  next(error);
});
app.post("/error-intake", createClientErrorHandler(errorSink));
app.use(errorIntakeErrorMiddleware(errorSink));
app.use((error, _request, response, _next) => response.status(error.status || 500).end());

app.listen(Number(process.env.PORT), "127.0.0.1");
`;
}

const nestTsConfig = {
  compilerOptions: {
    target: "ES2022",
    module: "Node16",
    moduleResolution: "Node16",
    rootDir: "src",
    outDir: "dist",
    strict: true,
    esModuleInterop: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
};

const nestMainSource = `import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { HttpAdapterHost } from "@nestjs/core";
import { createMysqlSink, resolveEnvironment } from "@yeschef/error-intake";
import { createClientErrorHandler, ErrorIntakeExceptionFilter } from "@yeschef/error-intake/nestjs";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const errorSink = createMysqlSink({
    url: process.env.ERROR_INTAKE_DATABASE_URL!,
    project: process.env.ERROR_INTAKE_PROJECT!,
    environment: resolveEnvironment(process.env),
  });
  app.useGlobalFilters(new ErrorIntakeExceptionFilter(errorSink, app.get(HttpAdapterHost)));
  app.use("/error-intake", createClientErrorHandler(errorSink));
  await app.listen(Number(process.env.PORT), "127.0.0.1");
}

void bootstrap();
`;

const nestModuleSource = `import { BadRequestException, Controller, Get, Module } from "@nestjs/common";

@Controller()
class AcceptanceController {
  @Get()
  ready(): string {
    return process.env.EI_ACCEPTANCE_READY_TOKEN ?? "";
  }

  @Get("boom")
  boom(): never {
    throw new Error("EI_ACCEPTANCE_SERVER_FAILURE");
  }

  @Get("bad-request")
  badRequest(): never {
    throw new BadRequestException("EI_ACCEPTANCE_BAD_REQUEST");
  }
}

@Module({ controllers: [AcceptanceController] })
export class AppModule {}
`;

const nextAppFiles: Readonly<Record<string, string>> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", strict: true, noEmit: true, esModuleInterop: true, module: "ESNext", moduleResolution: "Bundler", jsx: "preserve", plugins: [{ name: "next" }], paths: { "@/*": ["./*"] } }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] }, null, 2),
  "next-env.d.ts": "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n",
  "instrumentation.ts": `import { createOnRequestError } from "@yeschef/error-intake/next";
import { errorSink } from "./src/lib/error-sink";

export const onRequestError = createOnRequestError(errorSink);
`,
  "src/lib/error-sink.ts": `import { createMysqlSink, resolveEnvironment } from "@yeschef/error-intake";

export const errorSink = createMysqlSink({
  url: process.env.ERROR_INTAKE_DATABASE_URL!,
  project: process.env.ERROR_INTAKE_PROJECT!,
  environment: resolveEnvironment(process.env),
});
`,
  "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/page.tsx": `import { ErrorReporter } from "./reporter";

export default function Home() {
  return <main><ErrorReporter /></main>;
}
`,
  "app/reporter.tsx": `"use client";

import { useEffect } from "react";
import { installErrorReporter } from "@yeschef/error-intake/browser";

export function ErrorReporter() {
  useEffect(() => {
    installErrorReporter({ endpoint: "/api/error-intake", release: "acceptance" });
    window.setTimeout(() => { throw new Error("EI_ACCEPTANCE_BROWSER_FAILURE"); }, 1500);
  }, []);
  return <p>ready</p>;
}
`,
  "app/boom/page.tsx": `export const dynamic = "force-dynamic";

export default function BoomPage(): never {
  throw new Error("EI_ACCEPTANCE_NEXT_SERVER_FAILURE");
}
`,
  "app/bad-request/route.ts": `export async function GET(): Promise<Response> {
  return new Response(null, { status: 400 });
}
`,
  "app/api/error-intake/route.ts": `import { createClientErrorRoute } from "@yeschef/error-intake/next";
import { errorSink } from "@/src/lib/error-sink";

export const runtime = "nodejs";
export const { POST } = createClientErrorRoute(errorSink);
`,
  "app/api/acceptance-ready/route.ts": `export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response(process.env.EI_ACCEPTANCE_READY_TOKEN ?? "");
}
`,
};
