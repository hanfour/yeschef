import { z } from "zod";
import { mask, normalizeRoute, topFrameFromStack, truncateUtf8 } from "./shared.js";
import type { ErrorSink } from "./types.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUESTS_PER_MINUTE = 30;
const rateLimits = new Map<string, { readonly window: number; readonly count: number }>();
const browserReportSchema = z.object({
  errorType: z.string().min(1).max(200),
  message: z.string().max(1000),
  stack: z.string().max(8192),
  route: z.string().max(300).optional(),
  release: z.string().max(100).optional(),
}).strict();

export interface BrowserRequestInput {
  readonly sink: ErrorSink;
  readonly body: unknown;
  readonly ip: string;
  readonly userAgent?: string | null | undefined;
}

export type BrowserResponseStatus = 204 | 429;

export async function processBrowserRequest(input: BrowserRequestInput): Promise<BrowserResponseStatus> {
  try {
    if (!consumeRateLimit(input.ip)) {
      await discardStream(input.body);
      return 429;
    }
    const body = await readBody(input.body);
    if (!body.ok) return 204;
    const parsed = parseJson(body.value);
    if (!parsed.ok) return 204;
    const report = browserReportSchema.safeParse(parsed.value);
    if (!report.success) return 204;
    const data = report.data;
    await input.sink.record({
      source: "browser",
      errorType: mask(data.errorType),
      message: mask(data.message),
      stack: truncateUtf8(mask(data.stack), 8192),
      topFrame: topFrameFromStack(mask(data.stack), "browser"),
      route: data.route ? normalizeRoute(mask(data.route)) : null,
      release: data.release ? mask(data.release) : null,
      userAgent: safeUserAgent(input.userAgent),
    });
    return 204;
  } catch {
    return 204;
  }
}

async function readBody(body: unknown): Promise<{ readonly ok: true; readonly value: string | unknown } | { readonly ok: false }> {
  if (typeof body === "string") return utf8Size(body) <= MAX_BODY_BYTES ? { ok: true, value: body } : { ok: false };
  if (isWebStream(body) || isAsyncStream(body)) {
    const stream = await readStream(body);
    return stream.ok && utf8Size(stream.value) <= MAX_BODY_BYTES ? stream : { ok: false };
  }
  if (body === undefined || body === null) return { ok: false };
  try {
    const json = JSON.stringify(body);
    return json !== undefined && utf8Size(json) <= MAX_BODY_BYTES ? { ok: true, value: body } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function readStream(body: object): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of streamChunks(body)) {
      const bytes = toBytes(chunk);
      size += bytes.byteLength;
      if (size > MAX_BODY_BYTES) return { ok: false };
      chunks.push(bytes);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: new TextDecoder().decode(merged) };
  } catch {
    return { ok: false };
  }
}

async function* streamChunks(body: object): AsyncGenerator<unknown> {
  if (isWebStream(body)) {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        yield item.value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  const stream = body as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
  if (stream[Symbol.asyncIterator]) yield* stream as AsyncIterable<unknown>;
}

async function discardStream(body: unknown): Promise<void> {
  if (!isWebStream(body) && !isAsyncStream(body)) return;
  try {
    for await (const _chunk of streamChunks(body)) { /* 丟棄遭限流的請求本文。 */ }
  } catch {
    return;
  }
}

function parseJson(value: string | unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (typeof value !== "string") return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function consumeRateLimit(ip: string): boolean {
  const now = Date.now();
  const window = Math.floor(now / 60_000) * 60_000;
  for (const [key, value] of rateLimits) {
    if (value.window !== window) rateLimits.delete(key);
  }
  const previous = rateLimits.get(ip);
  if (previous?.window === window && previous.count >= MAX_REQUESTS_PER_MINUTE) return false;
  rateLimits.set(ip, { window, count: previous?.window === window ? previous.count + 1 : 1 });
  return true;
}

function safeUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = browserVersion(userAgent);
  const os = /Android/i.test(userAgent) ? "Android" :
    /iPhone|iPad|iPod/i.test(userAgent) ? "iOS" :
    /Windows/i.test(userAgent) ? "Windows" :
    /Mac OS X|Macintosh/i.test(userAgent) ? "macOS" :
    /Linux/i.test(userAgent) ? "Linux" : "Unknown OS";
  return `${browser.name} ${browser.version} / ${os}`.slice(0, 300);
}

function browserVersion(userAgent: string): { readonly name: string; readonly version: string } {
  const variants = [
    { name: "Edge", pattern: /\bEdg(?:e|A|iOS)?\/([0-9]+)/i },
    { name: "Opera", pattern: /\bOPR\/([0-9]+)/i },
    { name: "Firefox", pattern: /\b(?:Firefox|FxiOS)\/([0-9]+)/i },
    { name: "Chrome", pattern: /\b(?:Chrome|CriOS)\/([0-9]+)/i },
    { name: "Safari", pattern: /\bVersion\/([0-9]+)/i },
  ];
  for (const variant of variants) {
    const version = userAgent.match(variant.pattern)?.[1];
    if (version) return { name: variant.name, version };
  }
  return { name: "Browser", version: "0" };
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError("Unsupported request stream chunk");
}

function isWebStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && "getReader" in value && typeof value.getReader === "function";
}

function isAsyncStream(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}
