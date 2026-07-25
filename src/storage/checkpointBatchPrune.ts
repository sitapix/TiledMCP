import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonValue,
} from "../formats/json.js";
import {
  CHECKPOINT_ID_PATTERN,
  CHECKPOINT_ID_INPUT_PATTERN,
  MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
  MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
} from "./checkpoints.js";
import type {
  CheckpointBatchPruneExpectation,
  DocumentStore,
} from "./documentStore.js";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^changeset:[0-9a-f]{64}$/u;
const BATCH_BASE_REVISION_HASH_DOMAIN =
  "tiledmcp/checkpoint-prune-batch-base/v1\0";
const BATCH_PLAN_HASH_DOMAIN =
  "tiledmcp/checkpoint-prune-batch-plan/v1\0";

export {
  MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
  MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
} from "./checkpoints.js";

export const CHECKPOINT_PRUNE_BATCH_WARNING =
  "This permanently removes the selected committed recovery checkpoint manifests in canonical checkpoint-ID order. The batch is non-atomic, stops on the first failure, and caches any partial result without resuming it. It does not delete project assets. Fail-closed garbage collection runs once only after every selected manifest has been removed.";

export const CHECKPOINT_PRUNE_BATCH_ORDERING =
  "canonical-checkpoint-id" as const;
export const CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT =
  "cached-final-no-resume" as const;
export const CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION =
  "once-after-all-manifests-fail-closed" as const;

export interface CheckpointPruneBatchSummary {
  operationCount: 1;
  checkpointCount: number;
  destructive: true;
  checkpointIds: string[];
  targetCount: number;
  targetPaths: string[];
  status: "committed";
  manifestBytes: number;
  removesRecoveryPointCount: number;
  removesProjectAssets: false;
  ordering: typeof CHECKPOINT_PRUNE_BATCH_ORDERING;
  atomic: false;
  stopOnFirstFailure: true;
  partialResult:
    typeof CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT;
  garbageCollection:
    typeof CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION;
  warning: string;
}

export interface CheckpointPruneBatchPlan {
  kind: "checkpointPruneBatch";
  version: 1;
  id: string;
  checkpoints: CheckpointBatchPruneExpectation[];
  baseRevision: string;
  summary: CheckpointPruneBatchSummary;
}

export interface CheckpointPruneBatchOperationPreview {
  type: "pruneCheckpointBatch";
  destructive: true;
  warning: string;
  checkpointCount: number;
  checkpointIds: string[];
  targetCount: number;
  targetPaths: string[];
  status: "committed";
  manifestBytes: number;
  removesRecoveryPointCount: number;
  removesProjectAssets: false;
  ordering: typeof CHECKPOINT_PRUNE_BATCH_ORDERING;
  atomic: false;
  stopOnFirstFailure: true;
  partialResult:
    typeof CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT;
  garbageCollection:
    typeof CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION;
}

export type CheckpointPruneBatchResult = Awaited<
  ReturnType<
    DocumentStore["pruneCheckpointBatchPlanned"]
  >
>;

export async function planCheckpointPruneBatch(
  store: DocumentStore,
  checkpointIds: readonly string[],
): Promise<CheckpointPruneBatchPlan> {
  const canonicalIds =
    canonicalCheckpointIds(checkpointIds);
  const inspection =
    await store.inspectCheckpointBatchPrune(
      canonicalIds,
    );
  const checkpoints = structuredClone(
    inspection.checkpoints,
  );
  assertInspectionMatchesRequestedIds(
    checkpoints,
    canonicalIds,
  );
  const summary =
    checkpointPruneBatchSummary(checkpoints);
  const unsignedPlan: Omit<
    CheckpointPruneBatchPlan,
    "id"
  > = {
    kind: "checkpointPruneBatch",
    version: 1,
    checkpoints,
    baseRevision:
      checkpointPruneBatchBaseRevision(
        checkpoints,
      ),
    summary,
  };
  const plan: CheckpointPruneBatchPlan = {
    ...unsignedPlan,
    id: checkpointPruneBatchPlanId(
      unsignedPlan,
    ),
  };
  assertCheckpointPruneBatchPlan(plan);
  return plan;
}

export async function applyCheckpointPruneBatch(
  store: DocumentStore,
  plan: CheckpointPruneBatchPlan,
): Promise<CheckpointPruneBatchResult> {
  assertCheckpointPruneBatchPlan(plan);
  return store.pruneCheckpointBatchPlanned(
    structuredClone(plan.checkpoints),
  );
}

export function checkpointPruneBatchOperationPreview(
  plan: CheckpointPruneBatchPlan,
): CheckpointPruneBatchOperationPreview {
  assertCheckpointPruneBatchPlan(plan);
  return {
    type: "pruneCheckpointBatch",
    destructive: true,
    warning: CHECKPOINT_PRUNE_BATCH_WARNING,
    checkpointCount:
      plan.summary.checkpointCount,
    checkpointIds: structuredClone(
      plan.summary.checkpointIds,
    ),
    targetCount: plan.summary.targetCount,
    targetPaths: structuredClone(
      plan.summary.targetPaths,
    ),
    status: "committed",
    manifestBytes: plan.summary.manifestBytes,
    removesRecoveryPointCount:
      plan.summary.removesRecoveryPointCount,
    removesProjectAssets: false,
    ordering:
      CHECKPOINT_PRUNE_BATCH_ORDERING,
    atomic: false,
    stopOnFirstFailure: true,
    partialResult:
      CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT,
    garbageCollection:
      CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
  };
}

export function checkpointPruneBatchBaseRevision(
  checkpoints: readonly CheckpointBatchPruneExpectation[],
): string {
  const pins = checkpoints.map(
    ({
      id,
      manifestRevision,
      manifestSize,
    }) => ({
      id,
      manifestRevision,
      manifestSize,
    }),
  );
  return `sha256:${createHash("sha256")
    .update(BATCH_BASE_REVISION_HASH_DOMAIN)
    .update(
      stableJson(
        pins as unknown as JsonValue,
      ),
    )
    .digest("hex")}`;
}

function canonicalCheckpointIds(
  checkpointIds: readonly string[],
): string[] {
  if (
    !Array.isArray(checkpointIds) ||
    checkpointIds.length <
      MIN_CHECKPOINT_BATCH_PRUNE_COUNT ||
    checkpointIds.length >
      MAX_CHECKPOINT_BATCH_PRUNE_COUNT ||
    checkpointIds.some(
      (checkpointId) =>
        typeof checkpointId !== "string" ||
        !CHECKPOINT_ID_INPUT_PATTERN.test(
          checkpointId,
        ),
    )
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `checkpointIds must contain ${MIN_CHECKPOINT_BATCH_PRUNE_COUNT} to ${MAX_CHECKPOINT_BATCH_PRUNE_COUNT} UUIDs.`,
      {
        minimum:
          MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
        maximum:
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
      },
    );
  }
  const canonicalIds = checkpointIds.map(
    (checkpointId) =>
      checkpointId.toLowerCase(),
  );
  if (
    new Set(canonicalIds).size !==
    canonicalIds.length
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "checkpointIds contains duplicate UUIDs after lowercase normalization.",
    );
  }
  canonicalIds.sort(compareStrings);
  return canonicalIds;
}

function checkpointPruneBatchSummary(
  checkpoints: readonly CheckpointBatchPruneExpectation[],
): CheckpointPruneBatchSummary {
  const checkpointIds = checkpoints.map(
    (checkpoint) => checkpoint.id,
  );
  const targetPaths = [
    ...new Set(
      checkpoints.map(
        (checkpoint) => checkpoint.path,
      ),
    ),
  ].sort(compareStrings);
  const manifestBytes = checkpoints.reduce(
    (total, checkpoint) => {
      const next =
        total + checkpoint.manifestSize;
      if (!Number.isSafeInteger(next)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The checkpoint batch manifest byte total is not a safe integer.",
        );
      }
      return next;
    },
    0,
  );
  return {
    operationCount: 1,
    checkpointCount: checkpoints.length,
    destructive: true,
    checkpointIds,
    targetCount: targetPaths.length,
    targetPaths,
    status: "committed",
    manifestBytes,
    removesRecoveryPointCount:
      checkpoints.length,
    removesProjectAssets: false,
    ordering:
      CHECKPOINT_PRUNE_BATCH_ORDERING,
    atomic: false,
    stopOnFirstFailure: true,
    partialResult:
      CHECKPOINT_PRUNE_BATCH_PARTIAL_RESULT,
    garbageCollection:
      CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
    warning: CHECKPOINT_PRUNE_BATCH_WARNING,
  };
}

function checkpointPruneBatchPlanId(
  value: Omit<
    CheckpointPruneBatchPlan,
    "id"
  >,
): string {
  return `changeset:${createHash("sha256")
    .update(BATCH_PLAN_HASH_DOMAIN)
    .update(
      stableJson(
        value as unknown as JsonValue,
      ),
    )
    .digest("hex")}`;
}

function assertInspectionMatchesRequestedIds(
  checkpoints: readonly CheckpointBatchPruneExpectation[],
  requestedIds: readonly string[],
): void {
  if (
    !Array.isArray(checkpoints) ||
    checkpoints.length !==
      requestedIds.length ||
    checkpoints.some(
      (checkpoint, index) =>
        checkpoint.id !==
        requestedIds[index],
    )
  ) {
    throw new TiledMcpError(
      "INTERNAL_ERROR",
      "Checkpoint batch inspection returned a different checkpoint set or order.",
    );
  }
}

function assertCheckpointPruneBatchPlan(
  plan: CheckpointPruneBatchPlan,
): void {
  try {
    assertExactKeys(plan, [
      "baseRevision",
      "checkpoints",
      "id",
      "kind",
      "summary",
      "version",
    ]);
    if (
      plan.kind !== "checkpointPruneBatch" ||
      plan.version !== 1 ||
      !PLAN_ID_PATTERN.test(plan.id) ||
      !Array.isArray(plan.checkpoints) ||
      plan.checkpoints.length <
        MIN_CHECKPOINT_BATCH_PRUNE_COUNT ||
      plan.checkpoints.length >
        MAX_CHECKPOINT_BATCH_PRUNE_COUNT
    ) {
      throw new Error(
        "invalid checkpoint prune batch plan",
      );
    }
    for (
      let index = 0;
      index < plan.checkpoints.length;
      index += 1
    ) {
      const checkpoint =
        plan.checkpoints[index];
      if (checkpoint === undefined) {
        throw new Error(
          "missing checkpoint expectation",
        );
      }
      assertCheckpointExpectation(checkpoint);
      if (
        index > 0 &&
        !(
          (
            plan.checkpoints[index - 1]
              ?.id ?? ""
          ) < checkpoint.id
        )
      ) {
        throw new Error(
          "checkpoint IDs are not canonical and unique",
        );
      }
    }
    if (
      plan.baseRevision !==
      checkpointPruneBatchBaseRevision(
        plan.checkpoints,
      )
    ) {
      throw new Error(
        "invalid checkpoint batch base revision",
      );
    }
    const expectedSummary =
      checkpointPruneBatchSummary(
        plan.checkpoints,
      );
    assertCheckpointPruneBatchSummary(
      plan.summary,
    );
    if (
      stableJson(
        plan.summary as unknown as JsonValue,
      ) !==
      stableJson(
        expectedSummary as unknown as JsonValue,
      )
    ) {
      throw new Error(
        "checkpoint batch summary mismatch",
      );
    }
    const { id, ...unsignedPlan } = plan;
    if (
      checkpointPruneBatchPlanId(
        unsignedPlan,
      ) !== id
    ) {
      throw new Error(
        "checkpoint batch digest mismatch",
      );
    }
  } catch {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint prune batch change set is malformed or does not match its digest.",
    );
  }
}

function assertCheckpointExpectation(
  checkpoint: CheckpointBatchPruneExpectation,
): void {
  assertExactKeys(checkpoint, [
    "afterRevision",
    "before",
    "createdAt",
    "id",
    ...(checkpoint.label === undefined
      ? []
      : ["label"]),
    "manifestRevision",
    "manifestSize",
    "path",
    ...(checkpoint.retention === undefined
      ? []
      : ["retention"]),
    "status",
    "version",
  ]);
  assertCheckpointBefore(checkpoint.before);
  assertCheckpointRetention(checkpoint);
  if (
    !CHECKPOINT_ID_PATTERN.test(
      checkpoint.id,
    ) ||
    checkpoint.status !== "committed" ||
    typeof checkpoint.createdAt !==
      "string" ||
    checkpoint.createdAt.length === 0 ||
    checkpoint.createdAt.length > 64 ||
    (checkpoint.label !== undefined &&
      (typeof checkpoint.label !== "string" ||
        checkpoint.label.length > 1_024)) ||
    typeof checkpoint.path !== "string" ||
    checkpoint.path.length === 0 ||
    !REVISION_PATTERN.test(
      checkpoint.afterRevision,
    ) ||
    !REVISION_PATTERN.test(
      checkpoint.manifestRevision,
    ) ||
    !Number.isSafeInteger(
      checkpoint.manifestSize,
    ) ||
    checkpoint.manifestSize < 1
  ) {
    throw new Error(
      "invalid checkpoint expectation",
    );
  }
}

function assertCheckpointPruneBatchSummary(
  summary: CheckpointPruneBatchSummary,
): void {
  assertExactKeys(summary, [
    "atomic",
    "checkpointCount",
    "checkpointIds",
    "destructive",
    "garbageCollection",
    "manifestBytes",
    "operationCount",
    "ordering",
    "partialResult",
    "removesProjectAssets",
    "removesRecoveryPointCount",
    "status",
    "stopOnFirstFailure",
    "targetCount",
    "targetPaths",
    "warning",
  ]);
}

function assertCheckpointBefore(
  before: CheckpointBatchPruneExpectation["before"],
): void {
  if (before.existed === false) {
    assertExactKeys(before, ["existed"]);
    return;
  }
  if (before.existed !== true) {
    throw new Error(
      "invalid checkpoint before state",
    );
  }
  assertExactKeys(before, [
    "existed",
    "objectHash",
    "revision",
    "size",
  ]);
  if (
    !REVISION_PATTERN.test(before.revision) ||
    !OBJECT_HASH_PATTERN.test(
      before.objectHash,
    ) ||
    before.revision !==
      `sha256:${before.objectHash}` ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0
  ) {
    throw new Error(
      "invalid checkpoint before state",
    );
  }
}

function assertCheckpointRetention(
  checkpoint: CheckpointBatchPruneExpectation,
): void {
  if (checkpoint.version === 1) {
    if (checkpoint.retention !== undefined) {
      throw new Error(
        "legacy checkpoint has retention metadata",
      );
    }
    return;
  }
  if (
    checkpoint.version !== 2 ||
    checkpoint.retention === undefined
  ) {
    throw new Error(
      "invalid checkpoint version",
    );
  }
  if (
    checkpoint.retention.class ===
    "protected"
  ) {
    assertExactKeys(
      checkpoint.retention,
      ["class"],
    );
    return;
  }
  assertExactKeys(checkpoint.retention, [
    "class",
    "ordinal",
  ]);
  if (
    checkpoint.retention.class !==
      "rolling" ||
    !Number.isSafeInteger(
      checkpoint.retention.ordinal,
    ) ||
    checkpoint.retention.ordinal < 1
  ) {
    throw new Error(
      "invalid checkpoint retention metadata",
    );
  }
}

function assertExactKeys(
  value: object,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(value).sort();
  const canonicalExpected = [
    ...expectedKeys,
  ].sort();
  if (
    actualKeys.length !==
      canonicalExpected.length ||
    actualKeys.some(
      (key, index) =>
        key !== canonicalExpected[index],
    )
  ) {
    throw new Error(
      "unexpected change set fields",
    );
  }
}

function compareStrings(
  left: string,
  right: string,
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}
