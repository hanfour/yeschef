import { fingerprintSeed, mask, normalizeRoute, topFrameFromStack, truncateUtf8 } from "./shared.js";
import { errorText } from "./shared.js";

export interface InstallErrorReporterOptions {
  readonly endpoint: string;
  readonly release?: string;
}

interface BrowserReporter {
  readonly options: InstallErrorReporterOptions;
  readonly seen: Set<string>;
  readonly errorListener: (event: Event) => void;
  readonly rejectionListener: (event: PromiseRejectionEvent) => void;
  windowStart: number;
  count: number;
}

let activeReporter: BrowserReporter | undefined;

export function installErrorReporter(options: InstallErrorReporterOptions): () => void {
  uninstallActiveReporter();
  const reporter: BrowserReporter = {
    options,
    seen: new Set(),
    windowStart: minuteStart(Date.now()),
    count: 0,
    errorListener: (event) => {
      const errorEvent = event as ErrorEvent;
      reportWithReporter(reporter, errorEvent.error ?? new Error("Unhandled browser error"));
    },
    rejectionListener: (event) => reportWithReporter(reporter, event.reason),
  };
  activeReporter = reporter;
  window.addEventListener("error", reporter.errorListener);
  window.addEventListener("unhandledrejection", reporter.rejectionListener);
  return () => uninstallReporter(reporter);
}

export function reportError(error: unknown): void {
  if (!activeReporter) return;
  try {
    reportWithReporter(activeReporter, error);
  } catch {
    return;
  }
}

function reportWithReporter(reporter: BrowserReporter, error: unknown): void {
  try {
    const details = errorText(error);
    const message = truncateUtf8(mask(details.message), 1000);
    const stack = truncateUtf8(mask(details.stack), 8192);
    const route = normalizeRoute(window.location.pathname).slice(0, 300);
    const errorType = truncateUtf8(mask(details.errorType), 200) || "Error";
    const topFrame = topFrameFromStack(stack, "browser");
    const key = fingerprintSeed({ source: "browser", errorType, message, topFrame, route });
    if (reporter.seen.has(key) || !consumeBrowserLimit(reporter)) return;
    reporter.seen.add(key);
    const payload = JSON.stringify({ errorType, message, stack, route, release: reporter.options.release });
    void sendReport(reporter.options.endpoint, payload);
  } catch {
    return;
  }
}

function consumeBrowserLimit(reporter: BrowserReporter): boolean {
  const current = minuteStart(Date.now());
  if (current !== reporter.windowStart) {
    reporter.windowStart = current;
    reporter.count = 0;
  }
  if (reporter.count >= 10) return false;
  reporter.count += 1;
  return true;
}

async function sendReport(endpoint: string, payload: string): Promise<void> {
  try {
    const beacon = navigator.sendBeacon;
    if (typeof beacon === "function" && beacon.call(navigator, endpoint, new Blob([payload], { type: "text/plain;charset=UTF-8" }))) return;
  } catch {
    // beacon 失敗時改走 keepalive fetch。
  }
  try {
    if (typeof globalThis.fetch !== "function") return;
    await globalThis.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: payload,
      keepalive: true,
      credentials: "omit",
    });
  } catch {
    return;
  }
}

function uninstallActiveReporter(): void {
  if (activeReporter) uninstallReporter(activeReporter);
}

function uninstallReporter(reporter: BrowserReporter): void {
  window.removeEventListener("error", reporter.errorListener);
  window.removeEventListener("unhandledrejection", reporter.rejectionListener);
  if (activeReporter === reporter) activeReporter = undefined;
}

function minuteStart(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000;
}
