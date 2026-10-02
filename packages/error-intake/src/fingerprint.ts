import { createHash } from "node:crypto";
import { fingerprintSeed } from "./shared.js";
import type { FingerprintInput } from "./types.js";

export function fingerprint(input: FingerprintInput): string {
  return createHash("sha256").update(fingerprintSeed(input)).digest("hex");
}
