import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { BaseExceptionFilter, type HttpAdapterHost } from "@nestjs/core";
import { processBrowserRequest } from "./receiver.js";
import { errorText, topFrameFromStack } from "./shared.js";
import type { ErrorSink } from "./types.js";

interface NestRequest {
  readonly method?: string;
  readonly baseUrl?: string;
  readonly route?: { readonly path?: string | string[] };
  readonly originalUrl?: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly ip?: string;
  readonly socket?: { readonly remoteAddress?: string };
}

@Catch()
export class ErrorIntakeExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  constructor(private readonly sink: ErrorSink, adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    if (statusCode < 500) {
      super.catch(exception, host);
      return;
    }
    const request = host.switchToHttp().getRequest<NestRequest>();
    const details = errorText(exception);
    const stack = details.stack;
    void recordWithoutThrow(this.sink, {
      source: "server",
      ...details,
      stack,
      topFrame: topFrameFromStack(stack, "server"),
      route: nestRoute(request),
      requestMethod: request.method,
      statusCode,
      userAgent: firstHeader(request.headers?.["user-agent"]),
    });
    super.catch(exception, host);
  }
}

export function createClientErrorHandler(sink: ErrorSink): (request: NestRequest & ReadableStreamRequest, response: NodeResponse, next: MiddlewareNext) => void {
  return (request, response, _next) => {
    void processBrowserRequest({
      sink,
      body: request.body !== undefined ? request.body : request,
      ip: request.ip ?? request.socket?.remoteAddress ?? "unknown",
      userAgent: firstHeader(request.headers?.["user-agent"]),
    }).then((status) => response.status(status).end(), () => response.status(204).end());
  };
}

interface ReadableStreamRequest {
  readonly body?: unknown;
  readonly [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  resume?(): void;
}

interface NodeResponse {
  status(code: number): NodeResponse;
  end(): void;
}

type MiddlewareNext = (error?: unknown) => void;

function nestRoute(request: NestRequest): string | undefined {
  const route = request.route?.path;
  if (typeof route === "string") return `${request.baseUrl ?? ""}${route}`;
  if (Array.isArray(route)) return `${request.baseUrl ?? ""}${route[0] ?? ""}`;
  return request.originalUrl?.split(/[?#]/, 1)[0];
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

async function recordWithoutThrow(sink: ErrorSink, report: Parameters<ErrorSink["record"]>[0]): Promise<void> {
  try {
    await sink.record(report);
  } catch {
    return;
  }
}
