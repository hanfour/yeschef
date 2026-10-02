export type ErrorSource = "server" | "browser";
export type ErrorEnvironment = "local" | "staging" | "production";

export interface ErrorReport {
  readonly source: ErrorSource;
  readonly errorType: string;
  readonly message: string;
  readonly stack?: string | undefined;
  readonly topFrame?: string | undefined;
  readonly route?: string | null | undefined;
  readonly occurredAt?: Date | undefined;
  readonly release?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  readonly requestMethod?: string | null | undefined;
  readonly statusCode?: number | null | undefined;
}

export interface ErrorSink {
  record(report: ErrorReport): Promise<void>;
}

export type ErrorIntakeLogger = (message: string) => void;

export interface FingerprintInput {
  readonly source: ErrorSource;
  readonly errorType: string;
  readonly message: string;
  readonly topFrame: string;
  readonly route?: string | null;
}
