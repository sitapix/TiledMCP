import { createHash } from "node:crypto";

/**
 * A content revision: the SHA-256 of a document's bytes, `sha256:` prefixed.
 *
 * Revisions, paths, change-set ids and asset ids are all `string` at runtime
 * and are threaded through the same call sites, so the template literal is
 * there to stop one being passed where another is meant. It is deliberately
 * `sha256:${string}` rather than a full 64-hex-digit shape: TypeScript cannot
 * express "exactly 64 hex characters", and a type that only half-checks is
 * better than a comment claiming it does. {@link isRevision} does the real
 * validation for values arriving from outside.
 */
export type Revision = `sha256:${string}`;

export function revisionOf(
  content: Uint8Array,
): Revision {
  return `sha256:${createHash("sha256")
    .update(content)
    .digest("hex")}`;
}

const REVISION_PATTERN =
  /^sha256:[0-9a-f]{64}$/u;

/**
 * Narrow an untrusted string to a {@link Revision}.
 *
 * This is the checked entry point the type cannot provide on its own -- use it
 * on anything crossing the wire, not on values produced by {@link revisionOf}.
 */
export function isRevision(
  value: string,
): value is Revision {
  return REVISION_PATTERN.test(value);
}

export function shortHash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 24);
}
