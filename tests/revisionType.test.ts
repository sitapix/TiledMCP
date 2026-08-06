import { describe, expect, it } from "vitest";

import {
  isRevision,
  revisionOf,
  type Revision,
} from "../src/storage/revision.js";
import type { InternalDirectory } from "../src/storage/documentStore.js";

/**
 * `Revision` is adopted only where it was free and where it earns its keep:
 * the producer, and the un-checkpointed `.tiledmcp` write path. Narrowing the
 * whole codebase was measured at 21 cascading errors whose honest fix is to
 * type the wire schema -- which is serialized into the byte-exact contract --
 * so it was left as `string` there, guarded at runtime by the CAS comparison.
 *
 * These assertions pin what IS adopted so it cannot silently widen back.
 */

// A revision literal is assignable; an arbitrary string is not.
const ok: Revision = "sha256:abc";
void ok;
// @ts-expect-error a bare string is not a revision
const notRevision: Revision = "abc";
void notRevision;
// @ts-expect-error a change-set id is not a revision either
const wrongPrefix: Revision = "changeset:0000";
void wrongPrefix;

// The producer's return type is narrowed, so this needs no assertion.
const produced: Revision = revisionOf(
  Buffer.from("x"),
);
void produced;

// A Revision is still a string, so existing `string` consumers keep working.
const widened: string = produced;
void widened;

// Same guard on the internal-directory type it sits alongside.
const dir: InternalDirectory = ".tiledmcp";
void dir;
// @ts-expect-error project paths cannot reach the un-checkpointed write path
const projectDir: InternalDirectory = "maps";
void projectDir;

describe("revision", () => {
  it("produces the sha256-prefixed digest of the bytes", () => {
    const revision = revisionOf(
      Buffer.from("hello", "utf8"),
    );
    expect(revision).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(revision).toBe(
      revisionOf(Buffer.from("hello", "utf8")),
    );
    expect(revision).not.toBe(
      revisionOf(Buffer.from("hell0", "utf8")),
    );
  });

  it("narrows only well-formed revisions", () => {
    expect(
      isRevision(revisionOf(Buffer.from("x"))),
    ).toBe(true);
    // The type alone cannot express "64 hex digits"; the guard can, and this
    // is why values arriving from outside must go through it.
    expect(isRevision("sha256:abc")).toBe(false);
    expect(isRevision("abc")).toBe(false);
    expect(
      isRevision(
        `sha256:${"A".repeat(64)}`.toUpperCase(),
      ),
    ).toBe(false);
  });
});
