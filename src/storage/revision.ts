import { createHash } from "node:crypto";

export function revisionOf(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
