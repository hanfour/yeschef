import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { processBrowserRequest } from "../src/receiver.js";
import type { ErrorReport, ErrorSink } from "../src/types.js";

describe("browser intake receiver", () => {
  it("accepts a raw stream, a parsed string, and a parsed object", async () => {
    const record = vi.fn<(report: ErrorReport) => Promise<void>>().mockResolvedValue(undefined);
    const sink: ErrorSink = { record };
    const payload = JSON.stringify({ errorType: "TypeError", message: "failed", stack: "TypeError\n at app (/app/main.js:4:3)", route: "/items/12345", release: "v1" });
    const raw = Readable.from([Buffer.from(payload)]);

    expect(await processBrowserRequest({
      sink,
      body: raw,
      ip: "raw-stream",
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/122.0.0.0 Safari/537.36 Edg/123.0.0.0",
    })).toBe(204);
    expect(await processBrowserRequest({ sink, body: payload, ip: "parsed-string" })).toBe(204);
    expect(await processBrowserRequest({ sink, body: JSON.parse(payload) as unknown, ip: "parsed-object" })).toBe(204);
    expect(record).toHaveBeenCalledTimes(3);
    expect(record.mock.calls[0]?.[0].route).toBe("/items/:id");
    expect(record.mock.calls[0]?.[0].userAgent).toBe("Edge 123 / Windows");
  });

  it("drops payloads over sixteen kilobytes and invalid data with 204", async () => {
    const record = vi.fn<(report: ErrorReport) => Promise<void>>().mockResolvedValue(undefined);
    const sink: ErrorSink = { record };
    const payload = `${JSON.stringify({ errorType: "Error", message: "x", stack: "" })}${" ".repeat(16 * 1024)}`;
    expect(await processBrowserRequest({ sink, body: payload, ip: "oversize" })).toBe(204);
    expect(await processBrowserRequest({ sink, body: "not-json", ip: "invalid" })).toBe(204);
    expect(record).not.toHaveBeenCalled();
  });

  it("returns 429 after thirty requests from the same IP in one minute", async () => {
    const record = vi.fn<(report: ErrorReport) => Promise<void>>().mockResolvedValue(undefined);
    const sink: ErrorSink = { record };
    const body = { errorType: "Error", message: "failed", stack: "" };
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push(await processBrowserRequest({ sink, body, ip: "limited-client" }));
    }
    expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(record).toHaveBeenCalledTimes(30);
  });

  it("returns 204 if the sink itself rejects", async () => {
    const sink: ErrorSink = { record: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    expect(await processBrowserRequest({
      sink,
      body: { errorType: "Error", message: "failed", stack: "" },
      ip: "sink-failure",
    })).toBe(204);
  });
});
