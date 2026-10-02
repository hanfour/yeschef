import { processBrowserRequest } from "./receiver.js";
import { errorText, topFrameFromStack } from "./shared.js";
import type { ErrorSink } from "./types.js";

export interface NextRequestErrorContext {
  readonly routePath?: string;
  readonly path?: string;
  readonly routeType?: string;
}

/** Next.js 傳給 onRequestError 的 request：普通物件，不是 Web Request。 */
export interface NextRequestErrorRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

function headerValue(headers: NextRequestErrorRequest["headers"], name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

export function createOnRequestError(sink: ErrorSink): (
  error: unknown,
  request: NextRequestErrorRequest,
  context: NextRequestErrorContext,
) => Promise<void> {
  return async (error, request, context) => {
    try {
      const details = errorText(error);
      await sink.record({
        source: "server",
        ...details,
        topFrame: topFrameFromStack(details.stack, "server"),
        // 只留路徑樣板或不含 query 的路徑。
        route: context.routePath ?? request.path.split("?", 1)[0] ?? request.path,
        requestMethod: request.method,
        statusCode: 500,
        userAgent: headerValue(request.headers, "user-agent"),
      });
    } catch {
      return;
    }
  };
}

export function createClientErrorRoute(sink: ErrorSink): {
  readonly POST: (request: Request) => Promise<Response>;
} {
  return {
    async POST(request) {
      const forwardedFor = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
      const status = await processBrowserRequest({
        sink,
        body: request.body,
        ip: forwardedFor || "unknown",
        userAgent: request.headers.get("user-agent"),
      });
      return new Response(null, { status });
    },
  };
}
