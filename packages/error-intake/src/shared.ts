import type { FingerprintInput } from "./types.js";

const SECRET_FIELD = /\b([a-z0-9_-]*?)(key|token|secret|password|passwd|code|state|authorization)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;)}\]]+)/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const URL_QUERY = /((?:https?:\/\/|\/)[^\s"'<>?#]*)[?#][^\s"']*/gi;

export function mask(text: string): string {
  return text
    .replace(SECRET_FIELD, "$1$2$3<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "<token>")
    .replace(JWT, "<token>")
    .replace(EMAIL, "<email>")
    .replace(URL_QUERY, "$1")
    .replace(/\b\d{8,}\b/g, "<number>");
}

export function normalizeMessage(message: string): string {
  return mask(message)
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^/\s"'<>]+/gi, "")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/gi, "<id>")
    .replace(/\b[cC][a-zA-Z0-9]{23,24}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/("[^"\r\n]*"|'[^'\r\n]*')/g, "<str>");
}

export function normalizeTopFrame(frame: string): string {
  return frame
    .replace(/([.-])[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9]+)(?=[:)]|$)/g, "$1<hash>$2")
    .replace(/:\d+(?::\d+)?(?=[)\s]|$)/g, "")
    .trim();
}

export function normalizeRoute(route: string | null | undefined): string {
  if (!route) return "";
  const path = route.split(/[?#]/, 1)[0] ?? "";
  return mask(path)
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/gi, ":id")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ":id")
    .replace(/\b\d{3,}\b/g, ":id")
    .slice(0, 300);
}

export function fingerprintSeed(input: FingerprintInput): string {
  return JSON.stringify([
    input.source,
    mask(input.errorType).slice(0, 200),
    normalizeMessage(input.message),
    normalizeTopFrame(mask(input.topFrame)),
    normalizeRoute(input.route),
  ]);
}

export function topFrameFromStack(stack: string, source: "server" | "browser"): string {
  const frames = stack.split("\n").map((line) => line.trim());
  const frame = frames.find((line) =>
    /^(?:at\s|.*@.*:\d+(?::\d+)?$)/.test(line) && !line.includes("node_modules"),
  );
  if (frame) return normalizeTopFrame(frame);
  return source === "browser" ? "browser:unknown" : "server:unknown";
}

export function errorText(error: unknown): { readonly errorType: string; readonly message: string; readonly stack: string } {
  if (error instanceof Error) {
    return {
      errorType: error.name || "Error",
      message: error.message || error.name || "Error",
      stack: error.stack ?? "",
    };
  }
  return { errorType: "Error", message: typeof error === "string" ? error : "Unhandled error", stack: "" };
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}
