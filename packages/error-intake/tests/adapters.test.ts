import { HttpException, type ArgumentsHost } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import type { ErrorRequestHandler, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { errorIntakeErrorMiddleware } from "../src/express.js";
import { ErrorIntakeExceptionFilter } from "../src/nestjs.js";
import { createClientErrorRoute, createOnRequestError } from "../src/next.js";
import type { ErrorReport, ErrorSink } from "../src/types.js";

describe("framework adapters", () => {
  it("lets Nest handle client exceptions normally and records server failures", () => {
    const sink = createSink();
    const replies: { readonly body: unknown; readonly status: number }[] = [];
    const adapter = {
      isHeadersSent: () => false,
      reply: (_response: unknown, body: unknown, status: number) => replies.push({ body, status }),
      end: vi.fn(),
    };
    const filter = new ErrorIntakeExceptionFilter(sink, { httpAdapter: adapter } as unknown as HttpAdapterHost);
    const request = { method: "GET", baseUrl: "", route: { path: "/items/:id" }, headers: {} };
    const response = {};
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getArgByIndex: (index: number) => index === 1 ? response : request,
    } as unknown as ArgumentsHost;

    filter.catch(new HttpException("not found", 404), host);
    expect(sink.record).not.toHaveBeenCalled();
    filter.catch(new HttpException("server failed", 500), host);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      source: "server",
      route: "/items/:id",
      statusCode: 500,
    }));
    expect(replies.at(-1)?.status).toBe(500);
  });

  it("records only Express 5xx errors and always calls next", () => {
    const sink = createSink();
    const next = vi.fn();
    const request = {
      method: "GET",
      baseUrl: "",
      route: { path: "/items/:id" },
      get: () => undefined,
    } as unknown as Request;
    const middleware = errorIntakeErrorMiddleware(sink) as ErrorRequestHandler;

    middleware({ status: 400 }, request, {} as Response, next);
    expect(sink.record).not.toHaveBeenCalled();
    middleware({ status: 500, message: "server failure" }, request, {} as Response, next);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, route: "/items/:id" }));
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("provides Next request-error and App Router handlers", async () => {
    const sink = createSink();
    const onRequestError = createOnRequestError(sink);
    // Next.js 傳給 onRequestError 的 request 是普通物件，不是 Web Request（實機驗證時發現，原本的寫法一筆都沒記錄）。
    const request = { path: "/api/items/42?secret=value", method: "GET", headers: { "user-agent": "Chrome/123.0 Linux", "x-forwarded-for": "192.0.2.1" } };
    await onRequestError(new Error("request failed"), request, { routePath: "/api/items/:id" });
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ route: "/api/items/:id", statusCode: 500, requestMethod: "GET", userAgent: "Chrome/123.0 Linux" }));
    // 沒有 routePath 時用 path，且不帶 query。
    await onRequestError(new Error("request failed"), { path: "/plain?token=x", method: "POST", headers: {} }, {});
    expect(sink.record).toHaveBeenLastCalledWith(expect.objectContaining({ route: "/plain", requestMethod: "POST" }));

    const route = createClientErrorRoute(sink);
    const response = await route.POST(new Request("https://app.test/api/error-intake", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-forwarded-for": "192.0.2.2" },
      body: JSON.stringify({ errorType: "TypeError", message: "client failure", stack: "" }),
    }));
    expect(response.status).toBe(204);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ source: "browser", message: "client failure" }));
  });
});

function createSink(): ErrorSink & { readonly record: ReturnType<typeof vi.fn<(report: ErrorReport) => Promise<void>>> } {
  return { record: vi.fn<(report: ErrorReport) => Promise<void>>().mockResolvedValue(undefined) };
}
