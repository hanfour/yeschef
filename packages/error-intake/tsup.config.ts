import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    nestjs: "src/nestjs.ts",
    express: "src/express.ts",
    next: "src/next.ts",
    browser: "src/browser.ts",
  },
  format: ["esm", "cjs"],
  target: "node20",
  splitting: false,
  sourcemap: false,
  // 型別宣告由 tsup 一起產生：ESM 用 .d.ts、CommonJS 用 .d.cts。CommonJS 的 TypeScript 專案
  // 拿到 ESM 格式的型別會報 TS1479。
  dts: true,
  clean: true,
  external: ["mysql2", "mysql2/promise", "zod", "@nestjs/common", "@nestjs/core", "express", "next"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
