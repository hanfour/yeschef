// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installErrorReporter, reportError } from "../src/browser.js";

describe("browser reporter", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.unstubAllGlobals();
  });

  it("sends a repeated error only once during a page lifetime", () => {
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    uninstall = installErrorReporter({ endpoint: "/error-intake", release: "release-1" });
    const error = new TypeError("failed");

    reportError(error);
    reportError(error);
    window.dispatchEvent(new ErrorEvent("error", { error }));
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: new Error("rejected") });
    window.dispatchEvent(rejection);

    expect(beacon).toHaveBeenCalledTimes(2);
    expect(beacon.mock.calls[0]?.[0]).toBe("/error-intake");
  });

  it("limits reports to ten per minute and accepts reports in the next minute", () => {
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    uninstall = installErrorReporter({ endpoint: "/error-intake" });

    for (let index = 0; index < 11; index += 1) reportError(new Error(`unique-${index}`));
    expect(beacon).toHaveBeenCalledTimes(10);
    vi.setSystemTime(Date.now() + 60_000);
    reportError(new Error("next minute"));
    expect(beacon).toHaveBeenCalledTimes(11);
  });

  it("does not recursively report a failed beacon or fetch", async () => {
    const beacon = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    uninstall = installErrorReporter({ endpoint: "/error-intake" });

    reportError(new Error("original"));
    await Promise.resolve();
    await Promise.resolve();

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
