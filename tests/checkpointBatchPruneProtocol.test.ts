import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ChangeSetRegistry,
  type ChangeSetPlan,
} from "../src/changeSets.js";
import {
  checkpointPruneBatchPreviewToolOutputSchema,
} from "../src/outputSchemas/changeSets.js";
import {
  checkpointPruneBatchApplyResultOutputSchema,
} from "../src/outputSchemas/common.js";
import {
  applyCheckpointPruneBatch,
  CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
  CHECKPOINT_PRUNE_BATCH_ORDERING,
  CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT,
  CHECKPOINT_PRUNE_BATCH_WARNING,
  checkpointPruneBatchOperationPreview,
  planCheckpointPruneBatch,
  type CheckpointPruneBatchPlan,
} from "../src/storage/checkpointBatchPrune.js";
import type {
  CheckpointBatchPruneExpectation,
  CheckpointBatchPruneResult,
  DocumentStore,
} from "../src/storage/documentStore.js";

const FIRST_ID =
  "aaaaaaaa-0000-4000-8000-000000000001";
const SECOND_ID =
  "bbbbbbbb-0000-4000-8000-000000000002";
const THIRD_ID =
  "cccccccc-0000-4000-8000-000000000003";
const FIRST_REVISION = revision("1");
const SECOND_REVISION = revision("2");
const FIRST_AFTER_REVISION = revision("a");
const SECOND_AFTER_REVISION = revision("b");

describe("checkpoint prune batch protocol", () => {
  it("canonicalizes input, binds an order-independent plan, previews one operation, and caches apply", async () => {
    const checkpoints = fixtureCheckpoints();
    const inspectCheckpointBatchPrune =
      vi.fn(
        async (
          checkpointIds: readonly string[],
        ) => {
          expect(checkpointIds).toEqual([
            FIRST_ID,
            SECOND_ID,
          ]);
          return {
            kind:
              "checkpointPruneBatch" as const,
            checkpoints,
          };
        },
      );
    const storageResult =
      completedStorageResult();
    const pruneCheckpointBatchPlanned =
      vi.fn(
        async (
          expected: readonly CheckpointBatchPruneExpectation[],
        ) => {
          expect(
            expected.map(({ id }) => id),
          ).toEqual([FIRST_ID, SECOND_ID]);
          return storageResult;
        },
      );
    const store = {
      inspectCheckpointBatchPrune,
      pruneCheckpointBatchPlanned,
    } as unknown as DocumentStore;

    const plan =
      await planCheckpointPruneBatch(
        store,
        [
          SECOND_ID.toUpperCase(),
          FIRST_ID,
        ],
      );
    const reorderedPlan =
      await planCheckpointPruneBatch(
        store,
        [FIRST_ID, SECOND_ID],
      );

    expect(plan.id).toBe(reorderedPlan.id);
    expect(plan.baseRevision).toBe(
      reorderedPlan.baseRevision,
    );
    expect(plan).toMatchObject({
      kind: "checkpointPruneBatch",
      version: 1,
      id: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      baseRevision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      checkpoints: [
        {
          id: FIRST_ID,
          version: 1,
          path: "maps/z.tmj",
        },
        {
          id: SECOND_ID,
          version: 2,
          path: "maps/a.tmj",
          retention: {
            class: "rolling",
            ordinal: 7,
          },
        },
      ],
      summary: {
        operationCount: 1,
        checkpointCount: 2,
        destructive: true,
        checkpointIds: [
          FIRST_ID,
          SECOND_ID,
        ],
        targetCount: 2,
        targetPaths: [
          "maps/a.tmj",
          "maps/z.tmj",
        ],
        status: "committed",
        manifestBytes: 30,
        removesRecoveryPointCount: 2,
        removesProjectAssets: false,
        ordering:
          CHECKPOINT_PRUNE_BATCH_ORDERING,
        atomic: false,
        stopOnFirstFailure: true,
        partialResult:
          CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT,
        garbageCollection:
          CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
        warning:
          CHECKPOINT_PRUNE_BATCH_WARNING,
      },
    });
    expect(
      checkpointPruneBatchOperationPreview(
        plan,
      ),
    ).toEqual({
      type: "pruneCheckpointBatch",
      destructive: true,
      warning:
        CHECKPOINT_PRUNE_BATCH_WARNING,
      checkpointCount: 2,
      checkpointIds: [
        FIRST_ID,
        SECOND_ID,
      ],
      targetCount: 2,
      targetPaths: [
        "maps/a.tmj",
        "maps/z.tmj",
      ],
      status: "committed",
      manifestBytes: 30,
      removesRecoveryPointCount: 2,
      removesProjectAssets: false,
      ordering:
        CHECKPOINT_PRUNE_BATCH_ORDERING,
      atomic: false,
      stopOnFirstFailure: true,
      partialResult:
        CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT,
      garbageCollection:
        CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
    });

    const registry = new ChangeSetRegistry();
    const preview = registry.put(plan);
    expect(preview).toMatchObject({
      kind: "checkpointPruneBatch",
      planDigest: plan.id,
      expectedRevision:
        plan.baseRevision,
      targetPaths: [
        "maps/a.tmj",
        "maps/z.tmj",
      ],
      snapshotConsistency:
        "checkpoint-store-locked-manifest-set",
      checkpoints: [
        {
          id: FIRST_ID,
          version: 1,
          manifest: {
            revision: FIRST_REVISION,
            size: 10,
          },
        },
        {
          id: SECOND_ID,
          version: 2,
          retention: {
            class: "rolling",
            ordinal: 7,
          },
          manifest: {
            revision: SECOND_REVISION,
            size: 20,
          },
        },
      ],
      operations: [
        {
          type: "pruneCheckpointBatch",
        },
      ],
    });
    if (
      preview.kind !==
      "checkpointPruneBatch"
    ) {
      throw new Error(
        "Expected a checkpoint prune batch preview.",
      );
    }
    expect(
      checkpointPruneBatchPreviewToolOutputSchema.safeParse(
        { result: preview },
      ).success,
    ).toBe(true);

    const nonCanonicalCheckpoints =
      structuredClone(preview);
    nonCanonicalCheckpoints.checkpoints.reverse();
    const mismatchedSummary =
      structuredClone(preview);
    mismatchedSummary.summary.manifestBytes +=
      1;
    const mismatchedOperation =
      structuredClone(preview);
    const batchOperation =
      mismatchedOperation.operations[0];
    if (
      batchOperation?.type !==
      "pruneCheckpointBatch"
    ) {
      throw new Error(
        "Expected a checkpoint prune batch operation preview.",
      );
    }
    mismatchedOperation.operations[0] = {
      ...batchOperation,
      targetPaths: ["maps/z.tmj"],
      targetCount: 1,
    };
    const mismatchedTopLevelTargets =
      structuredClone(preview);
    mismatchedTopLevelTargets.targetPaths.reverse();
    for (const candidate of [
      nonCanonicalCheckpoints,
      mismatchedSummary,
      mismatchedOperation,
      mismatchedTopLevelTargets,
    ]) {
      expect(
        checkpointPruneBatchPreviewToolOutputSchema.safeParse(
          { result: candidate },
        ).success,
      ).toBe(false);
    }

    const operation = async (
      candidate: ChangeSetPlan,
    ) => {
      if (
        candidate.kind !==
        "checkpointPruneBatch"
      ) {
        throw new Error(
          "Expected a checkpoint prune batch plan.",
        );
      }
      return applyCheckpointPruneBatch(
        store,
        candidate,
      );
    };
    const firstResult = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );
    const replayResult = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );

    expect(firstResult).toEqual({
      ...storageResult,
      changeSetId: preview.changeSetId,
    });
    expect(replayResult).toEqual(firstResult);
    expect(
      pruneCheckpointBatchPlanned,
    ).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate normalized UUIDs before inspection", async () => {
    const inspectCheckpointBatchPrune =
      vi.fn();
    const store = {
      inspectCheckpointBatchPrune,
    } as unknown as DocumentStore;

    await expect(
      planCheckpointPruneBatch(store, [
        FIRST_ID,
        FIRST_ID.toUpperCase(),
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(
        "duplicate UUIDs",
      ),
    });
    expect(
      inspectCheckpointBatchPrune,
    ).not.toHaveBeenCalled();
  });

  it("rejects plan digest, summary, ordering, and unexpected-field tampering before storage apply", async () => {
    const checkpoints = fixtureCheckpoints();
    const pruneCheckpointBatchPlanned =
      vi.fn();
    const store = {
      inspectCheckpointBatchPrune:
        async () => ({
          kind:
            "checkpointPruneBatch" as const,
          checkpoints,
        }),
      pruneCheckpointBatchPlanned,
    } as unknown as DocumentStore;
    const plan =
      await planCheckpointPruneBatch(
        store,
        [FIRST_ID, SECOND_ID],
      );
    const candidates: CheckpointPruneBatchPlan[] =
      [
        {
          ...plan,
          id: `changeset:${"0".repeat(64)}`,
        },
        {
          ...plan,
          summary: {
            ...plan.summary,
            warning: `${plan.summary.warning} changed`,
          },
        },
        {
          ...plan,
          checkpoints: [
            plan.checkpoints[1] as CheckpointBatchPruneExpectation,
            plan.checkpoints[0] as CheckpointBatchPruneExpectation,
          ],
        },
        {
          ...plan,
          summary: {
            ...plan.summary,
            unexpected: true,
          },
        } as CheckpointPruneBatchPlan,
      ];

    for (const candidate of candidates) {
      await expect(
        applyCheckpointPruneBatch(
          store,
          candidate,
        ),
      ).rejects.toMatchObject({
        code: "INVALID_CHANGE_SET",
      });
    }
    expect(
      pruneCheckpointBatchPlanned,
    ).not.toHaveBeenCalled();
  });

  it("accepts only count-consistent canonical completed and partial result shapes", () => {
    const changeSetId =
      `changeset:${"c".repeat(64)}`;
    const completed = {
      ...completedStorageResult(),
      changeSetId,
    };
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        completed,
      ).success,
    ).toBe(true);

    const partial = {
      kind:
        "checkpointPruneBatch" as const,
      changeSetId,
      status: "partial" as const,
      replayDisposition:
        "cached-final-no-resume" as const,
      requestedCheckpointCount: 3,
      manifestDeletedCount: 1,
      unresolvedCheckpointCount: 2,
      outcomes: [
        {
          checkpointId: FIRST_ID,
          path: "maps/z.tmj",
          outcome: "deleted" as const,
          manifestDeleted: true as const,
          durability:
            "confirmed" as const,
        },
        {
          checkpointId: SECOND_ID,
          path: "maps/a.tmj",
          outcome: "failed" as const,
          failureCode:
            "INTERNAL_ERROR" as const,
        },
        {
          checkpointId: THIRD_ID,
          path: "maps/b.tmj",
          outcome:
            "not-attempted" as const,
          reason:
            "batch-stopped-before-checkpoint" as const,
        },
      ],
      garbageCollection: {
        status: "not-run" as const,
        reason:
          "batch-stopped-before-garbage-collection" as const,
      },
    };
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        partial,
      ).success,
    ).toBe(true);
    const unconfirmedPartial = {
      ...partial,
      outcomes: [
        {
          ...partial.outcomes[0],
          durability:
            "unconfirmed" as const,
        },
        {
          ...partial.outcomes[2],
          checkpointId: SECOND_ID,
        },
        partial.outcomes[2],
      ],
    };
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        unconfirmedPartial,
      ).success,
    ).toBe(true);

    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...partial,
          manifestDeletedCount: 2,
          unresolvedCheckpointCount: 1,
        },
      ).success,
    ).toBe(false);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...partial,
          outcomes: [
            {
              ...partial.outcomes[0],
              durability:
                "unconfirmed" as const,
            },
            partial.outcomes[1],
            partial.outcomes[2],
          ],
        },
      ).success,
    ).toBe(false);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...completed,
          outcomes: completed.outcomes.map(
            (outcome, index) =>
              index ===
              completed.outcomes.length - 1
                ? {
                    ...outcome,
                    durability:
                      "unconfirmed" as const,
                  }
                : outcome,
          ),
        },
      ).success,
    ).toBe(false);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...completed,
          outcomes: completed.outcomes.map(
            (outcome, index) =>
              index ===
              completed.outcomes.length - 1
                ? {
                    ...outcome,
                    durability:
                      "unconfirmed" as const,
                  }
                : outcome,
          ),
          garbageCollection: {
            status: "failed",
            failureCode:
              "INTERNAL_ERROR",
            deletionOutcome:
              "unknown-partial-or-none",
          },
        },
      ).success,
    ).toBe(true);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...completed,
          outcomes: completed.outcomes.map(
            (outcome, index) =>
              index === 0
                ? {
                    ...outcome,
                    durability:
                      "unconfirmed" as const,
                  }
                : outcome,
          ),
        },
      ).success,
    ).toBe(false);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...completed,
          garbageCollection: {
            status: "not-run",
            reason:
              "batch-stopped-before-garbage-collection",
          },
        },
      ).success,
    ).toBe(false);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...partial,
          outcomes: [
            partial.outcomes[1],
            partial.outcomes[0],
            partial.outcomes[2],
          ],
        },
      ).success,
    ).toBe(false);
    expect(
      checkpointPruneBatchApplyResultOutputSchema.safeParse(
        {
          ...partial,
          outcomes: [
            partial.outcomes[0],
            partial.outcomes[2],
            partial.outcomes[1],
          ],
        },
      ).success,
    ).toBe(false);
  });
});

function fixtureCheckpoints(): CheckpointBatchPruneExpectation[] {
  return [
    {
      id: FIRST_ID,
      version: 1,
      createdAt:
        "2026-07-25T00:00:00.000Z",
      label: "first",
      path: "maps/z.tmj",
      status: "committed",
      before: { existed: false },
      afterRevision:
        FIRST_AFTER_REVISION,
      manifestRevision: FIRST_REVISION,
      manifestSize: 10,
    },
    {
      id: SECOND_ID,
      version: 2,
      createdAt:
        "2026-07-25T00:00:01.000Z",
      path: "maps/a.tmj",
      status: "committed",
      before: {
        existed: true,
        revision: revision("d"),
        objectHash: "d".repeat(64),
        size: 42,
      },
      afterRevision:
        SECOND_AFTER_REVISION,
      retention: {
        class: "rolling",
        ordinal: 7,
      },
      manifestRevision: SECOND_REVISION,
      manifestSize: 20,
    },
  ];
}

function completedStorageResult(): CheckpointBatchPruneResult {
  return {
    kind: "checkpointPruneBatch",
    status: "completed",
    replayDisposition:
      "cached-final-no-resume",
    requestedCheckpointCount: 2,
    manifestDeletedCount: 2,
    unresolvedCheckpointCount: 0,
    outcomes: [
      {
        checkpointId: FIRST_ID,
        path: "maps/z.tmj",
        outcome: "deleted",
        manifestDeleted: true,
        durability: "confirmed",
      },
      {
        checkpointId: SECOND_ID,
        path: "maps/a.tmj",
        outcome: "deleted",
        manifestDeleted: true,
        durability: "confirmed",
      },
    ],
    garbageCollection: {
      status: "completed",
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
      blockerCount: 0,
      blockers: [],
      blockersTruncated: false,
    },
  };
}

function revision(
  hexadecimalDigit: string,
): string {
  return `sha256:${hexadecimalDigit.repeat(64)}`;
}
