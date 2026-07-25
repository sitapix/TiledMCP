import { z } from "zod";

import { TILED_MCP_APPLICATION_ERROR_CODES } from "../errorRegistry.js";
import type { JsonValue } from "../formats/json.js";
import {
  CHECKPOINT_ID_PATTERN,
  MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
  MAX_CHECKPOINT_OBSERVED_ENTRIES,
  MAX_CHECKPOINT_TIMESTAMP_LENGTH,
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
  MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
  ROLLING_CHECKPOINT_RETENTION_POLICY,
} from "../storage/checkpoints.js";

export const revisionOutputSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u);
export const assetIdOutputSchema = z
  .string()
  .regex(/^asset_[0-9a-f]{24}$/u);
export const changeSetIdOutputSchema = z
  .string()
  .regex(/^changeset:[0-9a-f]{64}$/u);
export const checkpointIdOutputSchema = z
  .string()
  .regex(CHECKPOINT_ID_PATTERN);
export const isoTimestampOutputSchema = z
  .string()
  .datetime({ offset: true });
export const checkpointTimestampOutputSchema = z
  .string()
  .min(1)
  .max(MAX_CHECKPOINT_TIMESTAMP_LENGTH);
export const projectPathOutputSchema = z
  .string()
  .min(1);

export const integerOutputSchema = z.number().int();
export const nonnegativeIntegerOutputSchema =
  integerOutputSchema.min(0);
export const positiveIntegerOutputSchema =
  integerOutputSchema.positive();

export const dependencyRevisionsOutputSchema = z.record(
  assetIdOutputSchema,
  revisionOutputSchema,
);

export const pixelSizeOutputSchema = z
  .object({
    width: nonnegativeIntegerOutputSchema,
    height: nonnegativeIntegerOutputSchema,
  })
  .strict();

export const integerRectOutputSchema = z
  .object({
    x: integerOutputSchema,
    y: integerOutputSchema,
    width: nonnegativeIntegerOutputSchema,
    height: nonnegativeIntegerOutputSchema,
  })
  .strict();

export const mapSnapshotOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
  })
  .strict();

export const tileTransformOutputSchema = z
  .object({
    kind: z.literal("orthogonal").optional(),
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
    flipD: z.boolean().optional(),
    rawFlags: z
      .number()
      .int()
      .min(0)
      .max(0xffffffff)
      .optional(),
  })
  .strict();

export const resolvedOrthogonalTransformOutputSchema =
  z
    .object({
      kind: z.literal("orthogonal"),
      flipH: z.boolean(),
      flipV: z.boolean(),
      flipD: z.boolean(),
      rawFlags: z
        .number()
        .int()
        .min(0)
        .max(0xffffffff),
    })
    .strict();

export const tileRefOutputSchema = z
  .object({
    tileset: z
      .object({
        kind: z.literal("external"),
        assetId: assetIdOutputSchema,
      })
      .strict(),
    localId: nonnegativeIntegerOutputSchema,
    transform: tileTransformOutputSchema.optional(),
  })
  .strict();

export const resolvedTileRefOutputSchema =
  tileRefOutputSchema.extend({
    transform:
      resolvedOrthogonalTransformOutputSchema,
  });

export const diagnosticOutputSchema = z
  .object({
    severity: z.enum([
      "info",
      "warning",
      "error",
    ]),
    code: z.string().min(1),
    message: z.string(),
    path: z.string().optional(),
    jsonPointer: z.string().optional(),
  })
  .strict();

const checkpointGarbageCollectionBlockerOutputSchema =
  z
    .object({
      directory: z.enum([
        "checkpoints",
        "objects",
      ]),
      fileName: z
        .string()
        .max(1_024)
        .optional(),
      reason: z.enum([
        "entry-inspection-failed",
        "byte-accounting-limit-exceeded",
        "malformed-manifest",
        "missing-referenced-object",
        "non-regular-entry",
        "scan-limit-exceeded",
        "symbolic-link",
        "unexpected-entry",
      ]),
      message: z.string().max(4_096),
    })
    .strict();

const checkpointGarbageCollectionCountOutputSchema =
  nonnegativeIntegerOutputSchema.max(
    Number.MAX_SAFE_INTEGER,
  );

const checkpointGarbageCollectionCompletedOutputSchema =
  z
    .object({
      status: z.literal("completed"),
      deletedBytes:
        checkpointGarbageCollectionCountOutputSchema,
      deletedEntries:
        checkpointGarbageCollectionCountOutputSchema,
      deletedObjects:
        checkpointGarbageCollectionCountOutputSchema,
      deletedTemporaryFiles:
        checkpointGarbageCollectionCountOutputSchema,
      blockerCount: z.literal(0),
      blockers: z.tuple([]),
      blockersTruncated: z.literal(false),
    })
    .strict();

const checkpointGarbageCollectionBlockedOutputSchema =
  z
    .object({
      status: z.literal("blocked"),
      deletedBytes: z.literal(0),
      deletedEntries: z.literal(0),
      deletedObjects: z.literal(0),
      deletedTemporaryFiles: z.literal(0),
      blockerCount:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      blockers: z
        .array(
          checkpointGarbageCollectionBlockerOutputSchema,
        )
        .min(1)
        .max(32),
      blockersTruncated: z.boolean(),
    })
    .strict();

const checkpointGarbageCollectionFailedOutputSchema =
  z
    .object({
      status: z.literal("failed"),
      failureCode: z.literal(
        "INTERNAL_ERROR",
      ),
      deletionOutcome: z.literal(
        "unknown-partial-or-none",
      ),
    })
    .strict();

const checkpointPruneBeforeOutputSchema = z.union([
  z
    .object({
      existed: z.literal(false),
    })
    .strict(),
  z
    .object({
      existed: z.literal(true),
      revision: revisionOutputSchema,
      objectHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/u),
      size: nonnegativeIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
    })
    .strict()
    .superRefine((before, context) => {
      if (
        before.revision !==
        `sha256:${before.objectHash}`
      ) {
        context.addIssue({
          code: "custom",
          path: ["revision"],
          message:
            "A checkpoint before revision must match its content-addressed object hash.",
        });
      }
    }),
]);

export const checkpointGarbageCollectionOutputSchema =
  z.union([
    checkpointGarbageCollectionCompletedOutputSchema,
    checkpointGarbageCollectionBlockedOutputSchema,
    checkpointGarbageCollectionFailedOutputSchema,
  ]);

const checkpointRetentionBaseOutputShape = {
  policy: z.literal(
    ROLLING_CHECKPOINT_RETENTION_POLICY,
  ),
  retainCommittedPerTarget: positiveIntegerOutputSchema
    .min(
      MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
    )
    .max(MAX_CHECKPOINT_OBSERVED_ENTRIES),
};

export const checkpointRetentionOutputSchema =
  z.discriminatedUnion("status", [
    z
      .object({
        ...checkpointRetentionBaseOutputShape,
        status: z.literal("not-needed"),
        manifestDeleted: z.literal(false),
        rollingCommittedCount:
          checkpointGarbageCollectionCountOutputSchema,
      })
      .strict(),
    z
      .object({
        ...checkpointRetentionBaseOutputShape,
        status: z.literal("blocked"),
        manifestDeleted: z.literal(false),
        reason: z.enum([
          "current-checkpoint-changed",
          "current-not-highest-rolling",
          "incomplete-inventory",
          "object-verification-failed",
          "prepared-checkpoint-present",
          "sequence-state-invalid",
          "target-validation-failed",
          "unsafe-lineage",
        ]),
        rollingCommittedCount:
          checkpointGarbageCollectionCountOutputSchema,
      })
      .strict(),
    z
      .object({
        ...checkpointRetentionBaseOutputShape,
        status: z.literal("deleted"),
        manifestDeleted: z.literal(true),
        deletedCheckpointId:
          checkpointIdOutputSchema,
        rollingCommittedCountBefore:
          positiveIntegerOutputSchema.max(
            Number.MAX_SAFE_INTEGER,
          ),
        garbageCollection:
          checkpointGarbageCollectionOutputSchema,
      })
      .strict(),
    z
      .object({
        ...checkpointRetentionBaseOutputShape,
        status: z.literal("failed"),
        manifestDeleted: z.literal(false),
        failureCode: z.literal(
          "INTERNAL_ERROR",
        ),
      })
      .strict(),
  ]);

export const commitResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    beforeRevision:
      revisionOutputSchema.nullable(),
    revision: revisionOutputSchema,
    checkpointId:
      checkpointIdOutputSchema.nullable(),
    changed: z.boolean(),
    checkpointRetention:
      checkpointRetentionOutputSchema.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export const documentApplyResultOutputSchema =
  commitResultOutputSchema.extend({
    changeSetId: changeSetIdOutputSchema,
  });

export const checkpointPruneApplyResultOutputSchema =
  z
    .object({
      kind: z.literal("checkpointPrune"),
      changeSetId: changeSetIdOutputSchema,
      checkpoint: z
        .object({
          id: checkpointIdOutputSchema,
          createdAt:
            checkpointTimestampOutputSchema,
          label: z
            .string()
            .max(1_024)
            .optional(),
          path: projectPathOutputSchema,
          status: z.literal("committed"),
          before:
            checkpointPruneBeforeOutputSchema,
          afterRevision:
            revisionOutputSchema,
        })
        .strict(),
      manifestDeleted: z.literal(true),
      garbageCollection:
        checkpointGarbageCollectionOutputSchema,
      warnings: z
        .array(z.string().max(4_096))
        .max(32)
        .optional(),
    })
    .strict();

const checkpointPruneBatchDeletedOutcomeOutputSchema =
  z
    .object({
      checkpointId:
        checkpointIdOutputSchema,
      path: projectPathOutputSchema,
      outcome: z.literal("deleted"),
      manifestDeleted: z.literal(true),
      durability: z.enum([
        "confirmed",
        "unconfirmed",
      ]),
    })
    .strict();

const checkpointPruneBatchRetainedOutcomeOutputSchema =
  z.union([
    z
      .object({
        checkpointId:
          checkpointIdOutputSchema,
        path: projectPathOutputSchema,
        outcome: z.literal("failed"),
        failureCode: z.literal(
          "INTERNAL_ERROR",
        ),
      })
      .strict(),
    z
      .object({
        checkpointId:
          checkpointIdOutputSchema,
        path: projectPathOutputSchema,
        outcome: z.literal(
          "not-attempted",
        ),
        reason: z.literal(
          "batch-stopped-before-checkpoint",
        ),
      })
      .strict(),
  ]);

const checkpointPruneBatchNotRunGarbageCollectionOutputSchema =
  z
    .object({
      status: z.literal("not-run"),
      reason: z.literal(
        "batch-stopped-before-garbage-collection",
      ),
    })
    .strict();

const checkpointPruneBatchApplyBaseOutputShape =
  {
    kind: z.literal(
      "checkpointPruneBatch",
    ),
    changeSetId: changeSetIdOutputSchema,
    replayDisposition: z.literal(
      "cached-final-no-resume",
    ),
    requestedCheckpointCount:
      positiveIntegerOutputSchema
        .min(
          MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
        )
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
    warnings: z
      .array(z.string().max(4_096))
      .max(64)
      .optional(),
  };

export const checkpointPruneBatchApplyResultOutputSchema =
  z
    .union([
    z
      .object({
        ...checkpointPruneBatchApplyBaseOutputShape,
        status: z.literal("completed"),
        manifestDeletedCount:
          positiveIntegerOutputSchema
            .min(
              MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
            )
            .max(
              MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
            ),
        unresolvedCheckpointCount:
          z.literal(0),
        outcomes: z
          .array(
            checkpointPruneBatchDeletedOutcomeOutputSchema,
          )
          .min(
            MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
          )
          .max(
            MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
          ),
        garbageCollection:
          checkpointGarbageCollectionOutputSchema,
      })
      .strict(),
    z
      .object({
        ...checkpointPruneBatchApplyBaseOutputShape,
        status: z.literal("partial"),
        manifestDeletedCount:
          positiveIntegerOutputSchema
            .min(1)
            .max(
              MAX_CHECKPOINT_BATCH_PRUNE_COUNT -
                1,
            ),
        unresolvedCheckpointCount:
          positiveIntegerOutputSchema
            .min(1)
            .max(
              MAX_CHECKPOINT_BATCH_PRUNE_COUNT -
                1,
            ),
        outcomes: z
          .array(
            z.union([
              checkpointPruneBatchDeletedOutcomeOutputSchema,
              checkpointPruneBatchRetainedOutcomeOutputSchema,
            ]),
          )
          .min(
            MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
          )
          .max(
            MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
          ),
        garbageCollection:
          checkpointPruneBatchNotRunGarbageCollectionOutputSchema,
      })
      .strict(),
    ])
    .superRefine(
      (
        result,
        context,
      ) => {
        const outcomeIds =
          result.outcomes.map(
            ({ checkpointId }) =>
              checkpointId,
          );
        const canonicalOutcomeIds = [
          ...outcomeIds,
        ].sort(compareOutputStrings);
        if (
          result.requestedCheckpointCount !==
            result.outcomes.length ||
          result.manifestDeletedCount +
              result.unresolvedCheckpointCount !==
            result.requestedCheckpointCount ||
          outcomeIds.some(
            (checkpointId, index) =>
              checkpointId !==
                canonicalOutcomeIds[index] ||
              (index > 0 &&
                checkpointId ===
                  outcomeIds[index - 1]),
          )
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Checkpoint prune batch counts and canonical outcome order must agree.",
          });
          return;
        }
        const unconfirmedDurabilityIndexes =
          result.outcomes.flatMap(
            (outcome, index) =>
              outcome.outcome === "deleted" &&
              outcome.durability === "unconfirmed"
                ? [index]
                : [],
          );
        if (
          unconfirmedDurabilityIndexes.length > 1 ||
          (unconfirmedDurabilityIndexes[0] !==
            undefined &&
            unconfirmedDurabilityIndexes[0] !==
              result.manifestDeletedCount - 1)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Unconfirmed checkpoint manifest durability must stop the batch at the final observed deletion.",
          });
          return;
        }
        if (
          unconfirmedDurabilityIndexes[0] !==
            undefined &&
          (result.outcomes
            .slice(
              result.manifestDeletedCount,
            )
            .some(
              ({ outcome }) =>
                outcome !==
                "not-attempted",
            ) ||
            (result.status === "completed" &&
              result.garbageCollection
                .status !== "failed"))
        ) {
          context.addIssue({
            code: "custom",
            message:
              "An unconfirmed manifest deletion must stop all later attempts and cannot be followed by garbage collection.",
          });
          return;
        }
        if (result.status === "completed") {
          if (
            result.manifestDeletedCount !==
              result.requestedCheckpointCount ||
            result.outcomes.some(
              ({ outcome }) =>
                outcome !== "deleted",
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A completed checkpoint prune batch must report every requested checkpoint as deleted.",
            });
          }
          return;
        }
        const deletedPrefix =
          result.outcomes.slice(
            0,
            result.manifestDeletedCount,
          );
        const retainedSuffix =
          result.outcomes.slice(
            result.manifestDeletedCount,
          );
        const failedIndexes =
          retainedSuffix.flatMap(
            (outcome, index) =>
              outcome.outcome ===
              "failed"
                ? [index]
                : [],
          );
        if (
          deletedPrefix.some(
            ({ outcome }) =>
              outcome !== "deleted",
          ) ||
          failedIndexes.length > 1 ||
          (failedIndexes[0] !== undefined &&
            failedIndexes[0] !== 0) ||
          retainedSuffix.some(
            (outcome, index) =>
              index >
                (failedIndexes[0] ??
                  -1) &&
              outcome.outcome !==
                "not-attempted",
          )
        ) {
          context.addIssue({
            code: "custom",
            message:
              "A partial checkpoint prune batch must contain a deleted prefix, at most one failed checkpoint, and then only not-attempted checkpoints.",
          });
        }
      },
    );

function compareOutputStrings(
  left: string,
  right: string,
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}

const preparedCheckpointTargetOutputSchema =
  z.union([
    z
      .object({
        existed: z.literal(false),
      })
      .strict(),
    z
      .object({
        existed: z.literal(true),
        revision: revisionOutputSchema,
        size: nonnegativeIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
  ]);

const checkpointManifestRetentionMetadataOutputSchema =
  z.union([
    z
      .object({
        class: z.literal("protected"),
      })
      .strict(),
    z
      .object({
        class: z.literal("rolling"),
        ordinal: positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
  ]);

function preparedCheckpointAdjudicationCheckpointOutputSchema<
  TStatus extends "prepared" | "committed",
>(status: TStatus) {
  const common = {
    id: checkpointIdOutputSchema,
    createdAt: checkpointTimestampOutputSchema,
    label: z
      .string()
      .max(1_024)
      .optional(),
    path: projectPathOutputSchema,
    status: z.literal(status),
    before: checkpointPruneBeforeOutputSchema,
    afterRevision: revisionOutputSchema,
  };
  return z.union([
    z
      .object({
        ...common,
        version: z.literal(1),
      })
      .strict(),
    z
      .object({
        ...common,
        version: z.literal(2),
        retention:
          checkpointManifestRetentionMetadataOutputSchema,
      })
      .strict(),
  ]);
}

const preparedCheckpointAdjudicationConflictOutputSchema =
  z.enum([
    "create-target-matches-after",
    "create-target-unrelated",
    "existing-target-missing",
    "existing-target-unrelated",
  ]);

export const preparedCheckpointCommitApplyResultOutputSchema =
  z
    .object({
      kind: z.literal(
        "preparedCheckpointCommit",
      ),
      changeSetId: changeSetIdOutputSchema,
      checkpoint:
        preparedCheckpointAdjudicationCheckpointOutputSchema(
          "committed",
        ),
      previousStatus: z.literal("prepared"),
      target: z
        .object({
          existed: z.literal(true),
          revision: revisionOutputSchema,
          size: nonnegativeIntegerOutputSchema.max(
            Number.MAX_SAFE_INTEGER,
          ),
        })
        .strict(),
      conflict: z.literal(
        "create-target-matches-after",
      ),
      manifestCommitted: z.literal(true),
      projectAssetModified: z.literal(false),
      durability: z.enum([
        "confirmed",
        "unconfirmed",
      ]),
      warnings: z
        .array(z.string().max(4_096))
        .min(1)
        .max(32)
        .optional(),
    })
    .strict()
    .superRefine((result, context) => {
      if (
        result.checkpoint.before.existed !==
          false ||
        result.target.revision !==
        result.checkpoint.afterRevision
      ) {
        context.addIssue({
          code: "custom",
          path: ["target", "revision"],
          message:
            "A committed prepared checkpoint target must retain the approved after revision.",
        });
      }
      if (
        result.durability === "unconfirmed" &&
        result.warnings === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["warnings"],
          message:
            "An unconfirmed prepared checkpoint commit must include at least one warning.",
        });
      }
      if (
        result.durability === "confirmed" &&
        result.warnings !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["warnings"],
          message:
            "A confirmed prepared checkpoint commit must not include uncertainty warnings.",
        });
      }
    });

export const preparedCheckpointAbandonApplyResultOutputSchema =
  z
    .object({
      kind: z.literal(
        "preparedCheckpointAbandon",
      ),
      changeSetId: changeSetIdOutputSchema,
      checkpoint:
        preparedCheckpointAdjudicationCheckpointOutputSchema(
          "prepared",
        ),
      target:
        preparedCheckpointTargetOutputSchema,
      conflict:
        preparedCheckpointAdjudicationConflictOutputSchema,
      manifestDeleted: z.literal(true),
      projectAssetModified: z.literal(false),
      garbageCollection:
        checkpointGarbageCollectionOutputSchema,
      warnings: z
        .array(z.string().max(4_096))
        .min(1)
        .max(32)
        .optional(),
    })
    .strict()
    .superRefine((result, context) => {
      const { checkpoint, target } = result;
      const conflictMatches =
        result.conflict ===
        "create-target-matches-after"
          ? checkpoint.before.existed ===
              false &&
            target.existed === true &&
            target.revision ===
              checkpoint.afterRevision
          : result.conflict ===
              "create-target-unrelated"
            ? checkpoint.before.existed ===
                false &&
              target.existed === true &&
              target.revision !==
                checkpoint.afterRevision
            : result.conflict ===
                "existing-target-missing"
              ? checkpoint.before.existed ===
                  true &&
                target.existed === false
              : checkpoint.before.existed ===
                  true &&
                target.existed === true &&
                target.revision !==
                  checkpoint.before.revision &&
                target.revision !==
                  checkpoint.afterRevision;
      if (!conflictMatches) {
        context.addIssue({
          code: "custom",
          path: ["conflict"],
          message:
            "Prepared checkpoint abandon conflict classification must match the returned target evidence.",
        });
      }
      if (
        result.garbageCollection.status !==
          "completed" &&
        result.warnings === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["warnings"],
          message:
            "A prepared checkpoint abandon with blocked or failed garbage collection must include at least one warning.",
        });
      }
    });

export const preparedCheckpointDiscardApplyResultOutputSchema =
  z
    .object({
      kind: z.literal(
        "preparedCheckpointDiscard",
      ),
      changeSetId: changeSetIdOutputSchema,
      checkpoint: z
        .object({
          id: checkpointIdOutputSchema,
          createdAt:
            checkpointTimestampOutputSchema,
          label: z
            .string()
            .max(1_024)
            .optional(),
          path: projectPathOutputSchema,
          status: z.literal("prepared"),
          before:
            checkpointPruneBeforeOutputSchema,
          afterRevision:
            revisionOutputSchema,
        })
        .strict(),
      target:
        preparedCheckpointTargetOutputSchema,
      manifestDeleted: z.literal(true),
      garbageCollection:
        checkpointGarbageCollectionOutputSchema,
      warnings: z
        .array(z.string().max(4_096))
        .max(32)
        .optional(),
    })
    .strict();

/*
 * Preserve the existing document-commit wire shape exactly. Checkpoint prune
 * and prepared-checkpoint discard/adjudication mutate recovery metadata
 * rather than a project document, so they have explicitly discriminated
 * success branches.
 */
export const fileDeleteApplyResultOutputSchema =
  z
    .object({
      kind: z.literal("fileDelete"),
      changeSetId: changeSetIdOutputSchema,
      path: projectPathOutputSchema,
      beforeRevision: revisionOutputSchema,
      checkpointId: checkpointIdOutputSchema,
      deleted: z.literal(true),
      warnings: z
        .array(z.string().max(4_096))
        .max(32)
        .optional(),
    })
    .strict();

export const applyResultOutputSchema = z.union([
  documentApplyResultOutputSchema,
  fileDeleteApplyResultOutputSchema,
  checkpointPruneApplyResultOutputSchema,
  checkpointPruneBatchApplyResultOutputSchema,
  preparedCheckpointCommitApplyResultOutputSchema,
  preparedCheckpointAbandonApplyResultOutputSchema,
  preparedCheckpointDiscardApplyResultOutputSchema,
]);

export const applicationErrorResultOutputSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum(
          TILED_MCP_APPLICATION_ERROR_CODES,
        ),
        message: z.string().max(4_096),
        details: z.record(
          z.string(),
          z.json(),
        ),
      })
      .strict(),
  })
  .strict();

export function toolOutputSchema<
  Success extends z.ZodType,
>(success: Success) {
  return z
    .object({
      result: z.union([
        success,
        applicationErrorResultOutputSchema,
      ]),
    })
    .strict();
}

/**
 * Builds an exact, closed schema for a JSON capability snapshot. Callers may
 * replace environment-dependent subtrees with stable structural schemas while
 * retaining literal contracts for static capability values.
 */
export function exactJsonValueOutputSchema(
  value: JsonValue,
  override?: (
    jsonPointer: string,
    value: JsonValue,
  ) => z.ZodType | undefined,
  jsonPointer = "",
): z.ZodType {
  const overridden = override?.(
    jsonPointer,
    value,
  );
  if (overridden !== undefined) {
    return overridden;
  }
  if (value === null) {
    return z.null();
  }
  if (typeof value === "string") {
    return z.literal(value);
  }
  if (typeof value === "number") {
    return z.literal(value);
  }
  if (typeof value === "boolean") {
    return z.literal(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return z.tuple([]);
    }
    const items = value.map(
      (item, index) =>
        exactJsonValueOutputSchema(
          item,
          override,
          `${jsonPointer}/${index}`,
        ),
    ) as [
      z.ZodType,
      ...z.ZodType[],
    ];
    return z.tuple(items);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [key, item] of Object.entries(
    value,
  )) {
    shape[key] =
      exactJsonValueOutputSchema(
        item,
        override,
        `${jsonPointer}/${escapeJsonPointerToken(
          key,
        )}`,
      );
  }
  return z.object(shape).strict();
}

function escapeJsonPointerToken(
  value: string,
): string {
  return value
    .replaceAll("~", "~0")
    .replaceAll("/", "~1");
}
