import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
} from "../formats/json.js";
import { CHECKPOINT_ID_PATTERN } from "./checkpoints.js";
import type {
  CheckpointPruneExpectation,
  CheckpointPruneResult,
  DocumentStore,
} from "./documentStore.js";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^changeset:[0-9a-f]{64}$/u;
const PRUNE_PLAN_HASH_DOMAIN =
  "tiledmcp/checkpoint-prune-plan/v1\0";

export const CHECKPOINT_PRUNE_WARNING =
  "This permanently removes one committed recovery checkpoint manifest. It does not delete project assets. After the manifest is removed, fail-closed garbage collection may delete only unreferenced checkpoint objects and private crash temporary files.";

export const CHECKPOINT_PRUNE_GARBAGE_COLLECTION =
  "fail-closed-after-manifest-prune" as const;

export interface CheckpointPruneSummary {
  operationCount: 1;
  destructive: true;
  checkpointId: string;
  targetPath: string;
  status: "committed";
  manifestRevision: string;
  manifestBytes: number;
  removesRecoveryPoint: true;
  removesProjectAsset: false;
  garbageCollection:
    typeof CHECKPOINT_PRUNE_GARBAGE_COLLECTION;
  warning: string;
}

export interface CheckpointPrunePlan {
  kind: "checkpointPrune";
  version: 1;
  id: string;
  checkpoint: CheckpointPruneExpectation;
  baseRevision: string;
  summary: CheckpointPruneSummary;
}

export interface CheckpointPruneOperationPreview {
  type: "pruneCheckpoint";
  destructive: true;
  warning: string;
  checkpointId: string;
  targetPath: string;
  status: "committed";
  manifestRevision: string;
  manifestBytes: number;
  removesRecoveryPoint: true;
  removesProjectAsset: false;
  garbageCollection:
    typeof CHECKPOINT_PRUNE_GARBAGE_COLLECTION;
}

export async function planCheckpointPrune(
  store: DocumentStore,
  checkpointId: string,
): Promise<CheckpointPrunePlan> {
  const inspection =
    await store.inspectCheckpointPrune(
      checkpointId,
    );
  const checkpoint = structuredClone(
    inspection.checkpoint,
  );
  const summary =
    checkpointPruneSummary(checkpoint);
  const unsignedPlan: Omit<
    CheckpointPrunePlan,
    "id"
  > = {
    kind: "checkpointPrune",
    version: 1,
    checkpoint,
    baseRevision:
      checkpoint.manifestRevision,
    summary,
  };
  const plan = {
    ...unsignedPlan,
    id: checkpointPrunePlanId(
      unsignedPlan,
    ),
  };
  assertCheckpointPrunePlan(plan);
  return plan;
}

export async function applyCheckpointPrune(
  store: DocumentStore,
  plan: CheckpointPrunePlan,
): Promise<CheckpointPruneResult> {
  assertCheckpointPrunePlan(plan);
  const { id, ...unsignedPlan } = plan;
  if (
    checkpointPrunePlanId(unsignedPlan) !== id
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint prune change set digest is invalid.",
    );
  }
  const expectedSummary =
    checkpointPruneSummary(plan.checkpoint);
  if (
    stableJson(
      plan.summary,
    ) !==
    stableJson(
      expectedSummary,
    )
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint prune summary does not match its approved operation.",
    );
  }
  return store.pruneCheckpointPlanned(
    structuredClone(plan.checkpoint),
  );
}

export function checkpointPruneOperationPreview(
  plan: CheckpointPrunePlan,
): CheckpointPruneOperationPreview {
  return {
    type: "pruneCheckpoint",
    destructive: true,
    warning: CHECKPOINT_PRUNE_WARNING,
    checkpointId: plan.checkpoint.id,
    targetPath: plan.checkpoint.path,
    status: "committed",
    manifestRevision:
      plan.checkpoint.manifestRevision,
    manifestBytes:
      plan.checkpoint.manifestSize,
    removesRecoveryPoint: true,
    removesProjectAsset: false,
    garbageCollection:
      CHECKPOINT_PRUNE_GARBAGE_COLLECTION,
  };
}

function checkpointPruneSummary(
  checkpoint: CheckpointPruneExpectation,
): CheckpointPruneSummary {
  return {
    operationCount: 1,
    destructive: true,
    checkpointId: checkpoint.id,
    targetPath: checkpoint.path,
    status: "committed",
    manifestRevision:
      checkpoint.manifestRevision,
    manifestBytes: checkpoint.manifestSize,
    removesRecoveryPoint: true,
    removesProjectAsset: false,
    garbageCollection:
      CHECKPOINT_PRUNE_GARBAGE_COLLECTION,
    warning: CHECKPOINT_PRUNE_WARNING,
  };
}

function checkpointPrunePlanId(
  value: Omit<CheckpointPrunePlan, "id">,
): string {
  const canonical = stableJson(
    value,
  );
  return `changeset:${createHash("sha256")
    .update(PRUNE_PLAN_HASH_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}

function assertCheckpointPrunePlan(
  plan: CheckpointPrunePlan,
): void {
  try {
    assertExactKeys(plan, [
      "baseRevision",
      "checkpoint",
      "id",
      "kind",
      "summary",
      "version",
    ]);
    assertExactKeys(plan.checkpoint, [
      "afterRevision",
      "before",
      "createdAt",
      "id",
      ...(plan.checkpoint.label === undefined
        ? []
        : ["label"]),
      "manifestRevision",
      "manifestSize",
      "path",
      "status",
    ]);
    assertCheckpointBefore(
      plan.checkpoint.before,
    );
    assertExactKeys(plan.summary, [
      "checkpointId",
      "destructive",
      "garbageCollection",
      "manifestBytes",
      "manifestRevision",
      "operationCount",
      "removesProjectAsset",
      "removesRecoveryPoint",
      "status",
      "targetPath",
      "warning",
    ]);
    if (
      plan.kind !== "checkpointPrune" ||
      plan.version !== 1 ||
      !PLAN_ID_PATTERN.test(plan.id) ||
      !CHECKPOINT_ID_PATTERN.test(
        plan.checkpoint.id,
      ) ||
      plan.checkpoint.status !==
        "committed" ||
      typeof plan.checkpoint.createdAt !==
        "string" ||
      plan.checkpoint.createdAt.length ===
        0 ||
      plan.checkpoint.createdAt.length >
        64 ||
      (plan.checkpoint.label !==
        undefined &&
        (typeof plan.checkpoint.label !==
          "string" ||
          plan.checkpoint.label.length >
            1_024)) ||
      typeof plan.checkpoint.path !==
        "string" ||
      plan.checkpoint.path.length === 0 ||
      !REVISION_PATTERN.test(
        plan.checkpoint.afterRevision,
      ) ||
      !REVISION_PATTERN.test(
        plan.checkpoint.manifestRevision,
      ) ||
      !Number.isSafeInteger(
        plan.checkpoint.manifestSize,
      ) ||
      plan.checkpoint.manifestSize < 1 ||
      plan.baseRevision !==
        plan.checkpoint.manifestRevision
    ) {
      throw new Error(
        "invalid checkpoint prune plan",
      );
    }
  } catch {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint prune change set is malformed.",
    );
  }
}

function assertCheckpointBefore(
  before: CheckpointPruneExpectation["before"],
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
