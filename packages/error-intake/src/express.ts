import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { processBrowserRequest } from "./receiver.js";
import { errorText, topFrameFromStack } from "./shared.js";
import type { ErrorSink } from "./types.js";

export function errorIntakeErrorMiddleware(sink: ErrorSink): ErrorRequestHandler {
  return (error: unknown, request: Request, _response: Response, next) => {
    const statusCode = errorStatus(error);
    if (statusCode >= 500) {
      const details = errorText(error);
      void recordWithoutThrow(sink, {
        source: "server",
        ...details,
        topFrame: topFrameFromStack(details.stack, "server"),
        route: expressRoute(request),
        requestMethod: request.method,
        statusCode,
        userAgent: request.get("user-agent"),
      });
    }
    next(error);
  };
}

export function createClientErrorHandler(sink: ErrorSink): RequestHandler {
  return (request, response, _next) => {
    const body = request.body !== undefined ? request.body : request;
    void processBrowserRequest({
      sink,
      body,
      ip: request.ip || request.socket.remoteAddress || "unknown",
      userAgent: request.get("user-agent"),
    }).then((status) => response.status(status).end(), () => response.status(204).end());
  };
}

function expressRoute(request: Request): string | undefined {
  const path = request.route?.path;
  const route = Array.isArray(path) ? path[0] : path;
  return typeof route === "string" ? `${request.baseUrl}${route}` : undefined;
}

function errorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  const candidate = error as { readonly status?: unknown; readonly statusCode?: unknown };
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : candidate.status;
  return typeof status === "number" ? status : 500;
}

async function recordWithoutThrow(sink: ErrorSink, report: Parameters<ErrorSink["record"]>[0]): Promise<void> {
  try {
    await sink.record(report);
  } catch {
    return;
  }
}
