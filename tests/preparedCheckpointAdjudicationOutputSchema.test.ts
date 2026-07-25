import { describe, expect, it } from "vitest";

import {
  preparedCheckpointAbandonApplyResultOutputSchema,
  preparedCheckpointCommitApplyResultOutputSchema,
} from "../src/outputSchemas/common.js";

const REVISION = `sha256:${"a".repeat(64)}`;
const OTHER_REVISION = `sha256:${"b".repeat(64)}`;
const CHANGE_SET_ID = `changeset:${"c".repeat(64)}`;

const commitResult = {
  kind: "preparedCheckpointCommit",
  changeSetId: CHANGE_SET_ID,
  checkpoint: {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-25T00:00:00.000Z",
    path: "maps/ambiguous-create.tmj",
    status: "committed",
    before: { existed: false },
    afterRevision: REVISION,
  },
  previousStatus: "prepared",
  target: {
    existed: true,
    revision: REVISION,
    size: 42,
  },
  conflict: "create-target-matches-after",
  manifestCommitted: true,
  projectAssetModified: false,
  durability: "confirmed",
} as const;

const failedAbandonResult = {
  kind: "preparedCheckpointAbandon",
  changeSetId: CHANGE_SET_ID,
  checkpoint: {
    version: 1,
    id: "00000000-0000-4000-8000-000000000002",
    createdAt: "2026-07-25T00:00:00.000Z",
    path: "maps/ambiguous-create.tmj",
    status: "prepared",
    before: { existed: false },
    afterRevision: REVISION,
  },
  target: {
    existed: true,
    revision: OTHER_REVISION,
    size: 43,
  },
  conflict: "create-target-unrelated",
  manifestDeleted: true,
  projectAssetModified: false,
  garbageCollection: {
    status: "failed",
    failureCode: "INTERNAL_ERROR",
    deletionOutcome: "unknown-partial-or-none",
  },
} as const;

describe("prepared checkpoint adjudication output schemas", () => {
  it("requires a warning when commit durability is unconfirmed", () => {
    expect(
      preparedCheckpointCommitApplyResultOutputSchema.safeParse(
        {
          ...commitResult,
          durability: "unconfirmed",
        },
      ).success,
    ).toBe(false);
    expect(
      preparedCheckpointCommitApplyResultOutputSchema.safeParse(
        {
          ...commitResult,
          durability: "unconfirmed",
          warnings: [
            "The manifest was renamed, but durability could not be confirmed.",
          ],
        },
      ).success,
    ).toBe(true);
  });

  it("rejects uncertainty warnings on a confirmed commit", () => {
    expect(
      preparedCheckpointCommitApplyResultOutputSchema.safeParse(
        {
          ...commitResult,
          warnings: ["unexpected warning"],
        },
      ).success,
    ).toBe(false);
  });

  it("requires a warning when abandon garbage collection is not completed", () => {
    expect(
      preparedCheckpointAbandonApplyResultOutputSchema.safeParse(
        failedAbandonResult,
      ).success,
    ).toBe(false);
    expect(
      preparedCheckpointAbandonApplyResultOutputSchema.safeParse(
        {
          ...failedAbandonResult,
          warnings: [
            "The manifest was deleted, but garbage collection failed.",
          ],
        },
      ).success,
    ).toBe(true);
  });

  it("rejects an existing before revision that does not match its object hash", () => {
    expect(
      preparedCheckpointAbandonApplyResultOutputSchema.safeParse(
        {
          ...failedAbandonResult,
          checkpoint: {
            ...failedAbandonResult.checkpoint,
            before: {
              existed: true,
              revision: REVISION,
              objectHash: "b".repeat(64),
              size: 42,
            },
          },
          target: {
            existed: false,
          },
          conflict: "existing-target-missing",
          warnings: [
            "The manifest was deleted, but garbage collection failed.",
          ],
        },
      ).success,
    ).toBe(false);
  });
});
