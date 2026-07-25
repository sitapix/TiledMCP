import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonValue,
} from "../formats/json.js";
import {
  CHECKPOINT_ID_PATTERN,
  MAX_CHECKPOINT_TIMESTAMP_LENGTH,
} from "./checkpoints.js";
import type {
  DocumentStore,
  PreparedCheckpointDiscardExpectation,
  PreparedCheckpointDiscardResult,
} from "./documentStore.js";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^changeset:[0-9a-f]{64}$/u;
const PREPARED_DISCARD_PLAN_HASH_DOMAIN =
  "tiledmcp/prepared-checkpoint-discard-plan/v1\0";

export const PREPARED_CHECKPOINT_DISCARD_WARNING =
  "This prepared checkpoint is eligible for discard only because the target currently matches its pre-write state. Applying this change permanently deletes the prepared manifest without modifying the project asset. Fail-closed garbage collection may then delete an unreferenced pre-write object and private crash temporary files.";

export const PREPARED_CHECKPOINT_DISCARD_ELIGIBILITY =
  "current-target-matches-before-state" as const;

export const PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION =
  "fail-closed-after-prepared-manifest-discard" as const;

export interface PreparedCheckpointDiscardSummary {
  operationCount: 1;
  destructive: true;
  checkpointId: string;
  targetPath: string;
  status: "prepared";
  manifestRevision: string;
  manifestBytes: number;
  removesRecoveryPoint: true;
  removesProjectAsset: false;
  targetBeforeStateVerified: true;
  garbageCollection:
    typeof PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION;
  warning: string;
}

export interface PreparedCheckpointDiscardPlan {
  kind: "preparedCheckpointDiscard";
  version: 1;
  id: string;
  checkpoint: PreparedCheckpointDiscardExpectation;
  baseRevision: string;
  summary: PreparedCheckpointDiscardSummary;
}

export interface PreparedCheckpointDiscardOperationPreview {
  type: "discardPreparedCheckpoint";
  destructive: true;
  warning: string;
  checkpointId: string;
  targetPath: string;
  status: "prepared";
  manifestRevision: string;
  manifestBytes: number;
  removesRecoveryPoint: true;
  removesProjectAsset: false;
  targetBeforeStateVerified: true;
  garbageCollection:
    typeof PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION;
}

export async function planPreparedCheckpointDiscard(
  store: DocumentStore,
  checkpointId: string,
): Promise<PreparedCheckpointDiscardPlan> {
  const inspection =
    await store.inspectPreparedCheckpointDiscard(
      checkpointId,
    );
  const checkpoint = structuredClone(
    inspection.checkpoint,
  );
  const summary =
    preparedCheckpointDiscardSummary(checkpoint);
  const unsignedPlan: Omit<
    PreparedCheckpointDiscardPlan,
    "id"
  > = {
    kind: "preparedCheckpointDiscard",
    version: 1,
    checkpoint,
    baseRevision:
      checkpoint.manifestRevision,
    summary,
  };
  const plan = {
    ...unsignedPlan,
    id: preparedCheckpointDiscardPlanId(
      unsignedPlan,
    ),
  };
  validatePreparedCheckpointDiscardPlan(plan);
  return plan;
}

export async function applyPreparedCheckpointDiscard(
  store: DocumentStore,
  plan: PreparedCheckpointDiscardPlan,
): Promise<PreparedCheckpointDiscardResult> {
  validatePreparedCheckpointDiscardPlan(plan);
  return store.discardPreparedCheckpointPlanned(
    structuredClone(plan.checkpoint),
  );
}

export function preparedCheckpointDiscardOperationPreview(
  plan: PreparedCheckpointDiscardPlan,
): PreparedCheckpointDiscardOperationPreview {
  validatePreparedCheckpointDiscardPlan(plan);
  return {
    type: "discardPreparedCheckpoint",
    destructive: true,
    warning:
      PREPARED_CHECKPOINT_DISCARD_WARNING,
    checkpointId: plan.checkpoint.id,
    targetPath: plan.checkpoint.path,
    status: "prepared",
    manifestRevision:
      plan.checkpoint.manifestRevision,
    manifestBytes:
      plan.checkpoint.manifestSize,
    removesRecoveryPoint: true,
    removesProjectAsset: false,
    targetBeforeStateVerified: true,
    garbageCollection:
      PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION,
  };
}

function preparedCheckpointDiscardSummary(
  checkpoint: PreparedCheckpointDiscardExpectation,
): PreparedCheckpointDiscardSummary {
  return {
    operationCount: 1,
    destructive: true,
    checkpointId: checkpoint.id,
    targetPath: checkpoint.path,
    status: "prepared",
    manifestRevision:
      checkpoint.manifestRevision,
    manifestBytes: checkpoint.manifestSize,
    removesRecoveryPoint: true,
    removesProjectAsset: false,
    targetBeforeStateVerified: true,
    garbageCollection:
      PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION,
    warning:
      PREPARED_CHECKPOINT_DISCARD_WARNING,
  };
}

function preparedCheckpointDiscardPlanId(
  value: Omit<
    PreparedCheckpointDiscardPlan,
    "id"
  >,
): string {
  const canonical = stableJson(
    value as unknown as JsonValue,
  );
  return `changeset:${createHash("sha256")
    .update(
      PREPARED_DISCARD_PLAN_HASH_DOMAIN,
    )
    .update(canonical)
    .digest("hex")}`;
}

function validatePreparedCheckpointDiscardPlan(
  plan: PreparedCheckpointDiscardPlan,
): void {
  assertPreparedCheckpointDiscardPlan(plan);
  const { id, ...unsignedPlan } = plan;
  if (
    preparedCheckpointDiscardPlanId(
      unsignedPlan,
    ) !== id
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The prepared checkpoint discard change set digest is invalid.",
    );
  }
  const expectedSummary =
    preparedCheckpointDiscardSummary(
      plan.checkpoint,
    );
  if (
    stableJson(
      plan.summary as unknown as JsonValue,
    ) !==
    stableJson(
      expectedSummary as unknown as JsonValue,
    )
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The prepared checkpoint discard summary does not match its approved operation.",
    );
  }
}

function assertPreparedCheckpointDiscardPlan(
  plan: PreparedCheckpointDiscardPlan,
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
      "target",
    ]);
    assertCheckpointBefore(
      plan.checkpoint.before,
    );
    assertTargetState(plan.checkpoint.target);
    assertTargetMatchesBeforeState(
      plan.checkpoint.before,
      plan.checkpoint.target,
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
      "targetBeforeStateVerified",
      "targetPath",
      "warning",
    ]);
    if (
      plan.kind !==
        "preparedCheckpointDiscard" ||
      plan.version !== 1 ||
      !PLAN_ID_PATTERN.test(plan.id) ||
      !CHECKPOINT_ID_PATTERN.test(
        plan.checkpoint.id,
      ) ||
      plan.checkpoint.status !==
        "prepared" ||
      typeof plan.checkpoint.createdAt !==
        "string" ||
      plan.checkpoint.createdAt.length ===
        0 ||
      plan.checkpoint.createdAt.length >
        MAX_CHECKPOINT_TIMESTAMP_LENGTH ||
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
      (plan.checkpoint.before.existed ===
        true &&
        plan.checkpoint.before.revision ===
          plan.checkpoint.afterRevision) ||
      !REVISION_PATTERN.test(
        plan.checkpoint.manifestRevision,
      ) ||
      !Number.isSafeInteger(
        plan.checkpoint.manifestSize,
      ) ||
      plan.checkpoint.manifestSize < 1 ||
      plan.baseRevision !==
        plan.checkpoint.manifestRevision ||
      !Number.isSafeInteger(
        plan.summary.operationCount,
      ) ||
      typeof plan.summary.destructive !==
        "boolean" ||
      typeof plan.summary.checkpointId !==
        "string" ||
      !CHECKPOINT_ID_PATTERN.test(
        plan.summary.checkpointId,
      ) ||
      typeof plan.summary.targetPath !==
        "string" ||
      plan.summary.targetPath.length === 0 ||
      typeof plan.summary.status !==
        "string" ||
      typeof plan.summary.manifestRevision !==
        "string" ||
      !REVISION_PATTERN.test(
        plan.summary.manifestRevision,
      ) ||
      !Number.isSafeInteger(
        plan.summary.manifestBytes,
      ) ||
      plan.summary.manifestBytes < 1 ||
      typeof plan.summary.removesRecoveryPoint !==
        "boolean" ||
      typeof plan.summary.removesProjectAsset !==
        "boolean" ||
      typeof plan.summary.targetBeforeStateVerified !==
        "boolean" ||
      typeof plan.summary.garbageCollection !==
        "string" ||
      typeof plan.summary.warning !== "string"
    ) {
      throw new Error(
        "invalid prepared checkpoint discard plan",
      );
    }
  } catch {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The prepared checkpoint discard change set is malformed.",
    );
  }
}

function assertCheckpointBefore(
  before: PreparedCheckpointDiscardExpectation["before"],
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

function assertTargetState(
  target: PreparedCheckpointDiscardExpectation["target"],
): void {
  if (target.existed === false) {
    assertExactKeys(target, ["existed"]);
    return;
  }
  if (target.existed !== true) {
    throw new Error(
      "invalid prepared checkpoint target state",
    );
  }
  assertExactKeys(target, [
    "existed",
    "revision",
    "size",
  ]);
  if (
    !REVISION_PATTERN.test(target.revision) ||
    !Number.isSafeInteger(target.size) ||
    target.size < 0
  ) {
    throw new Error(
      "invalid prepared checkpoint target state",
    );
  }
}

function assertTargetMatchesBeforeState(
  before: PreparedCheckpointDiscardExpectation["before"],
  target: PreparedCheckpointDiscardExpectation["target"],
): void {
  if (before.existed === false) {
    if (target.existed !== false) {
      throw new Error(
        "prepared checkpoint target does not match absent before state",
      );
    }
    return;
  }
  if (
    target.existed !== true ||
    target.revision !== before.revision ||
    target.size !== before.size
  ) {
    throw new Error(
      "prepared checkpoint target does not match before state",
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
