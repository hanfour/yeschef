export interface AcceptanceCheck {
  readonly scenario: string;
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export class CheckReporter {
  readonly checks: AcceptanceCheck[] = [];

  add(scenario: string, check: string, ok: boolean, detail: string): void {
    const result = { scenario, check, ok, detail };
    this.checks.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  get passed(): boolean {
    return this.checks.every((check) => check.ok);
  }
}
