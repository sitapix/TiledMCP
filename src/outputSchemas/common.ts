import { z } from "zod";

import { TILED_MCP_APPLICATION_ERROR_CODES } from "../errorRegistry.js";
import type { JsonValue } from "../formats/json.js";
import {
  CHECKPOINT_ID_PATTERN,
  MAX_CHECKPOINT_TIMESTAMP_LENGTH,
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

export const commitResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    beforeRevision:
      revisionOutputSchema.nullable(),
    revision: revisionOutputSchema,
    checkpointId:
      checkpointIdOutputSchema.nullable(),
    changed: z.boolean(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export const documentApplyResultOutputSchema =
  commitResultOutputSchema.extend({
    changeSetId: changeSetIdOutputSchema,
  });

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
    .strict(),
]);

export const checkpointGarbageCollectionOutputSchema =
  z.union([
    checkpointGarbageCollectionCompletedOutputSchema,
    checkpointGarbageCollectionBlockedOutputSchema,
    checkpointGarbageCollectionFailedOutputSchema,
  ]);

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
 * and prepared-checkpoint discard mutate recovery metadata rather than a
 * project document, so they have explicitly discriminated success branches.
 */
export const applyResultOutputSchema = z.union([
  documentApplyResultOutputSchema,
  checkpointPruneApplyResultOutputSchema,
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
