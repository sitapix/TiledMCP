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
  PreparedCheckpointAdjudicationExpectation,
  PreparedCheckpointAbandonResult,
  PreparedCheckpointCommitResult,
} from "./documentStore.js";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^changeset:[0-9a-f]{64}$/u;
const COMMIT_EVIDENCE_HASH_DOMAIN =
  "tiledmcp/prepared-checkpoint-commit-evidence/v1\0";
const ABANDON_EVIDENCE_HASH_DOMAIN =
  "tiledmcp/prepared-checkpoint-abandon-evidence/v1\0";
const COMMIT_PLAN_HASH_DOMAIN =
  "tiledmcp/prepared-checkpoint-commit-plan/v1\0";
const ABANDON_PLAN_HASH_DOMAIN =
  "tiledmcp/prepared-checkpoint-abandon-plan/v1\0";

export const PREPARED_CHECKPOINT_COMMIT_WARNING =
  "Operator decision required: the create target currently has the checkpoint after revision, but automatic recovery cannot prove which writer created it. Applying this change commits only the internal audit checkpoint record, which still cannot restore target absence. It does not modify the project asset or run garbage collection.";

export const PREPARED_CHECKPOINT_ABANDON_WARNING =
  "Operator decision required: applying this change permanently deletes the ambiguous prepared recovery point while leaving the current project asset unchanged. The deleted recovery point cannot be restored through TiledMCP; fail-closed garbage collection may delete only storage no longer referenced by another valid checkpoint.";

export const PREPARED_CHECKPOINT_COMMIT_GARBAGE_COLLECTION =
  "not-run" as const;

export const PREPARED_CHECKPOINT_ABANDON_GARBAGE_COLLECTION =
  "fail-closed-after-prepared-manifest-abandon" as const;

export type PreparedCheckpointAdjudicationConflict =
  PreparedCheckpointAdjudicationExpectation["conflict"];

export interface PreparedCheckpointCommitSummary {
  operationCount: 1;
  destructive: false;
  checkpointId: string;
  targetPath: string;
  status: "prepared";
  manifestRevision: string;
  manifestBytes: number;
  operatorDecisionRequired: true;
  commitsCheckpointRecord: true;
  projectAssetModified: false;
  garbageCollection:
    typeof PREPARED_CHECKPOINT_COMMIT_GARBAGE_COLLECTION;
  warning: string;
}

export interface PreparedCheckpointAbandonSummary {
  operationCount: 1;
  destructive: true;
  checkpointId: string;
  targetPath: string;
  status: "prepared";
  manifestRevision: string;
  manifestBytes: number;
  operatorDecisionRequired: true;
  removesRecoveryPoint: true;
  projectAssetModified: false;
  garbageCollection:
    typeof PREPARED_CHECKPOINT_ABANDON_GARBAGE_COLLECTION;
  warning: string;
}

export interface PreparedCheckpointCommitPlan {
  kind: "preparedCheckpointCommit";
  version: 1;
  id: string;
  checkpoint: PreparedCheckpointAdjudicationExpectation & {
    before: { existed: false };
    target: {
      existed: true;
      revision: string;
      size: number;
    };
    conflict: "create-target-matches-after";
  };
  baseRevision: string;
  summary: PreparedCheckpointCommitSummary;
}

export interface PreparedCheckpointAbandonPlan {
  kind: "preparedCheckpointAbandon";
  version: 1;
  id: string;
  checkpoint: PreparedCheckpointAdjudicationExpectation;
  baseRevision: string;
  summary: PreparedCheckpointAbandonSummary;
}

export interface PreparedCheckpointCommitOperationPreview {
  type: "commitPreparedCheckpoint";
  destructive: false;
  warning: string;
  checkpointId: string;
  targetPath: string;
  status: "prepared";
  manifestRevision: string;
  manifestBytes: number;
  operatorDecisionRequired: true;
  commitsCheckpointRecord: true;
  projectAssetModified: false;
  garbageCollection:
    typeof PREPARED_CHECKPOINT_COMMIT_GARBAGE_COLLECTION;
}

export interface PreparedCheckpointAbandonOperationPreview {
  type: "abandonPreparedCheckpoint";
  destructive: true;
  warning: string;
  checkpointId: string;
  targetPath: string;
  status: "prepared";
  manifestRevision: string;
  manifestBytes: number;
  operatorDecisionRequired: true;
  removesRecoveryPoint: true;
  projectAssetModified: false;
  garbageCollection:
    typeof PREPARED_CHECKPOINT_ABANDON_GARBAGE_COLLECTION;
}

export async function planPreparedCheckpointCommit(
  store: DocumentStore,
  checkpointId: string,
): Promise<PreparedCheckpointCommitPlan> {
  const inspection =
    await store.inspectPreparedCheckpointCommit(
      checkpointId,
    );
  const checkpoint = structuredClone(
    inspection.checkpoint,
  );
  assertCommitEligible(checkpoint);
  const summary =
    preparedCheckpointCommitSummary(checkpoint);
  const unsignedPlan: Omit<
    PreparedCheckpointCommitPlan,
    "id"
  > = {
    kind: "preparedCheckpointCommit",
    version: 1,
    checkpoint,
    baseRevision:
      preparedCheckpointCommitEvidenceRevision(
        checkpoint,
      ),
    summary,
  };
  const plan = {
    ...unsignedPlan,
    id: preparedCheckpointCommitPlanId(
      unsignedPlan,
    ),
  };
  validatePreparedCheckpointCommitPlan(plan);
  return plan;
}

export async function planPreparedCheckpointAbandon(
  store: DocumentStore,
  checkpointId: string,
): Promise<PreparedCheckpointAbandonPlan> {
  const inspection =
    await store.inspectPreparedCheckpointAbandon(
      checkpointId,
    );
  const checkpoint = structuredClone(
    inspection.checkpoint,
  );
  const summary =
    preparedCheckpointAbandonSummary(checkpoint);
  const unsignedPlan: Omit<
    PreparedCheckpointAbandonPlan,
    "id"
  > = {
    kind: "preparedCheckpointAbandon",
    version: 1,
    checkpoint,
    baseRevision:
      preparedCheckpointAbandonEvidenceRevision(
        checkpoint,
      ),
    summary,
  };
  const plan = {
    ...unsignedPlan,
    id: preparedCheckpointAbandonPlanId(
      unsignedPlan,
    ),
  };
  validatePreparedCheckpointAbandonPlan(plan);
  return plan;
}

export async function applyPreparedCheckpointCommit(
  store: DocumentStore,
  plan: PreparedCheckpointCommitPlan,
): Promise<PreparedCheckpointCommitResult> {
  validatePreparedCheckpointCommitPlan(plan);
  return store.commitPreparedCheckpointPlanned(
    structuredClone(plan.checkpoint),
  );
}

export async function applyPreparedCheckpointAbandon(
  store: DocumentStore,
  plan: PreparedCheckpointAbandonPlan,
): Promise<PreparedCheckpointAbandonResult> {
  validatePreparedCheckpointAbandonPlan(plan);
  return store.abandonPreparedCheckpointPlanned(
    structuredClone(plan.checkpoint),
  );
}

export function preparedCheckpointCommitOperationPreview(
  plan: PreparedCheckpointCommitPlan,
): PreparedCheckpointCommitOperationPreview {
  validatePreparedCheckpointCommitPlan(plan);
  return {
    type: "commitPreparedCheckpoint",
    destructive: false,
    warning: PREPARED_CHECKPOINT_COMMIT_WARNING,
    checkpointId: plan.checkpoint.id,
    targetPath: plan.checkpoint.path,
    status: "prepared",
    manifestRevision:
      plan.checkpoint.manifestRevision,
    manifestBytes:
      plan.checkpoint.manifestSize,
    operatorDecisionRequired: true,
    commitsCheckpointRecord: true,
    projectAssetModified: false,
    garbageCollection:
      PREPARED_CHECKPOINT_COMMIT_GARBAGE_COLLECTION,
  };
}

export function preparedCheckpointAbandonOperationPreview(
  plan: PreparedCheckpointAbandonPlan,
): PreparedCheckpointAbandonOperationPreview {
  validatePreparedCheckpointAbandonPlan(plan);
  return {
    type: "abandonPreparedCheckpoint",
    destructive: true,
    warning:
      PREPARED_CHECKPOINT_ABANDON_WARNING,
    checkpointId: plan.checkpoint.id,
    targetPath: plan.checkpoint.path,
    status: "prepared",
    manifestRevision:
      plan.checkpoint.manifestRevision,
    manifestBytes:
      plan.checkpoint.manifestSize,
    operatorDecisionRequired: true,
    removesRecoveryPoint: true,
    projectAssetModified: false,
    garbageCollection:
      PREPARED_CHECKPOINT_ABANDON_GARBAGE_COLLECTION,
  };
}

export function preparedCheckpointCommitEvidenceRevision(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): string {
  return evidenceRevision(
    COMMIT_EVIDENCE_HASH_DOMAIN,
    checkpoint,
  );
}

export function preparedCheckpointAbandonEvidenceRevision(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): string {
  return evidenceRevision(
    ABANDON_EVIDENCE_HASH_DOMAIN,
    checkpoint,
  );
}

function preparedCheckpointCommitSummary(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): PreparedCheckpointCommitSummary {
  return {
    operationCount: 1,
    destructive: false,
    checkpointId: checkpoint.id,
    targetPath: checkpoint.path,
    status: "prepared",
    manifestRevision:
      checkpoint.manifestRevision,
    manifestBytes: checkpoint.manifestSize,
    operatorDecisionRequired: true,
    commitsCheckpointRecord: true,
    projectAssetModified: false,
    garbageCollection:
      PREPARED_CHECKPOINT_COMMIT_GARBAGE_COLLECTION,
    warning: PREPARED_CHECKPOINT_COMMIT_WARNING,
  };
}

function preparedCheckpointAbandonSummary(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): PreparedCheckpointAbandonSummary {
  return {
    operationCount: 1,
    destructive: true,
    checkpointId: checkpoint.id,
    targetPath: checkpoint.path,
    status: "prepared",
    manifestRevision:
      checkpoint.manifestRevision,
    manifestBytes: checkpoint.manifestSize,
    operatorDecisionRequired: true,
    removesRecoveryPoint: true,
    projectAssetModified: false,
    garbageCollection:
      PREPARED_CHECKPOINT_ABANDON_GARBAGE_COLLECTION,
    warning:
      PREPARED_CHECKPOINT_ABANDON_WARNING,
  };
}

function preparedCheckpointCommitPlanId(
  value: Omit<
    PreparedCheckpointCommitPlan,
    "id"
  >,
): string {
  return changeSetDigest(
    COMMIT_PLAN_HASH_DOMAIN,
    value,
  );
}

function preparedCheckpointAbandonPlanId(
  value: Omit<
    PreparedCheckpointAbandonPlan,
    "id"
  >,
): string {
  return changeSetDigest(
    ABANDON_PLAN_HASH_DOMAIN,
    value,
  );
}

function evidenceRevision(
  domain: string,
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): string {
  const canonical = stableJson(
    checkpoint as unknown as JsonValue,
  );
  return `sha256:${createHash("sha256")
    .update(domain)
    .update(canonical)
    .digest("hex")}`;
}

function changeSetDigest(
  domain: string,
  value:
    | Omit<
        PreparedCheckpointCommitPlan,
        "id"
      >
    | Omit<
        PreparedCheckpointAbandonPlan,
        "id"
      >,
): string {
  const canonical = stableJson(
    value as unknown as JsonValue,
  );
  return `changeset:${createHash("sha256")
    .update(domain)
    .update(canonical)
    .digest("hex")}`;
}

function validatePreparedCheckpointCommitPlan(
  plan: PreparedCheckpointCommitPlan,
): void {
  assertPreparedCheckpointPlan(
    plan,
    "preparedCheckpointCommit",
  );
  assertCommitEligible(plan.checkpoint);
  const { id, ...unsignedPlan } = plan;
  if (
    preparedCheckpointCommitPlanId(
      unsignedPlan,
    ) !== id
  ) {
    invalidPlan(
      "The prepared checkpoint commit change set digest is invalid.",
    );
  }
  if (
    plan.baseRevision !==
    preparedCheckpointCommitEvidenceRevision(
      plan.checkpoint,
    )
  ) {
    invalidPlan(
      "The prepared checkpoint commit evidence digest is invalid.",
    );
  }
  assertMatchingSummary(
    plan.summary,
    preparedCheckpointCommitSummary(
      plan.checkpoint,
    ),
    "commit",
  );
}

function validatePreparedCheckpointAbandonPlan(
  plan: PreparedCheckpointAbandonPlan,
): void {
  assertPreparedCheckpointPlan(
    plan,
    "preparedCheckpointAbandon",
  );
  const { id, ...unsignedPlan } = plan;
  if (
    preparedCheckpointAbandonPlanId(
      unsignedPlan,
    ) !== id
  ) {
    invalidPlan(
      "The prepared checkpoint abandon change set digest is invalid.",
    );
  }
  if (
    plan.baseRevision !==
    preparedCheckpointAbandonEvidenceRevision(
      plan.checkpoint,
    )
  ) {
    invalidPlan(
      "The prepared checkpoint abandon evidence digest is invalid.",
    );
  }
  assertMatchingSummary(
    plan.summary,
    preparedCheckpointAbandonSummary(
      plan.checkpoint,
    ),
    "abandon",
  );
}

function assertPreparedCheckpointPlan(
  plan:
    | PreparedCheckpointCommitPlan
    | PreparedCheckpointAbandonPlan,
  kind:
    | "preparedCheckpointCommit"
    | "preparedCheckpointAbandon",
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
    assertCheckpoint(plan.checkpoint);
    assertSummary(
      plan.summary,
      kind,
    );
    if (
      plan.kind !== kind ||
      plan.version !== 1 ||
      !PLAN_ID_PATTERN.test(plan.id) ||
      !REVISION_PATTERN.test(
        plan.baseRevision,
      )
    ) {
      throw new Error(
        "invalid prepared checkpoint adjudication plan",
      );
    }
  } catch {
    invalidPlan(
      `The ${kind === "preparedCheckpointCommit" ? "prepared checkpoint commit" : "prepared checkpoint abandon"} change set is malformed.`,
    );
  }
}

function assertCheckpoint(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): void {
  assertExactKeys(checkpoint, [
    "afterRevision",
    "before",
    "conflict",
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
    "target",
    "version",
  ]);
  assertBefore(checkpoint.before);
  assertTarget(checkpoint.target);
  assertVersionAndRetention(checkpoint);
  assertConflict(checkpoint);
  if (
    !CHECKPOINT_ID_PATTERN.test(
      checkpoint.id,
    ) ||
    checkpoint.status !== "prepared" ||
    typeof checkpoint.createdAt !==
      "string" ||
    checkpoint.createdAt.length === 0 ||
    checkpoint.createdAt.length >
      MAX_CHECKPOINT_TIMESTAMP_LENGTH ||
    (checkpoint.label !== undefined &&
      (typeof checkpoint.label !==
        "string" ||
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
      "invalid prepared checkpoint evidence",
    );
  }
}

function assertVersionAndRetention(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): void {
  if (checkpoint.version === 1) {
    if (checkpoint.retention !== undefined) {
      throw new Error(
        "legacy checkpoint cannot have retention metadata",
      );
    }
    return;
  }
  if (
    checkpoint.version !== 2 ||
    checkpoint.retention === undefined
  ) {
    throw new Error(
      "invalid checkpoint version or retention metadata",
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
  if (
    checkpoint.retention.class !==
      "rolling" ||
    !Number.isSafeInteger(
      checkpoint.retention.ordinal,
    ) ||
    checkpoint.retention.ordinal < 1
  ) {
    throw new Error(
      "invalid rolling checkpoint retention metadata",
    );
  }
  assertExactKeys(checkpoint.retention, [
    "class",
    "ordinal",
  ]);
}

function assertBefore(
  before: PreparedCheckpointAdjudicationExpectation["before"],
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

function assertTarget(
  target: PreparedCheckpointAdjudicationExpectation["target"],
): void {
  if (target.existed === false) {
    assertExactKeys(target, ["existed"]);
    return;
  }
  if (target.existed !== true) {
    throw new Error(
      "invalid checkpoint target state",
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
      "invalid checkpoint target state",
    );
  }
}

function assertConflict(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): void {
  const { before, target, afterRevision } =
    checkpoint;
  switch (checkpoint.conflict) {
    case "create-target-matches-after":
      if (
        before.existed !== false ||
        target.existed !== true ||
        target.revision !== afterRevision
      ) {
        throw new Error(
          "conflict classification does not match evidence",
        );
      }
      return;
    case "create-target-unrelated":
      if (
        before.existed !== false ||
        target.existed !== true ||
        target.revision === afterRevision
      ) {
        throw new Error(
          "conflict classification does not match evidence",
        );
      }
      return;
    case "existing-target-missing":
      if (
        before.existed !== true ||
        target.existed !== false
      ) {
        throw new Error(
          "conflict classification does not match evidence",
        );
      }
      return;
    case "existing-target-unrelated":
      if (
        before.existed !== true ||
        target.existed !== true ||
        target.revision === before.revision ||
        target.revision === afterRevision
      ) {
        throw new Error(
          "conflict classification does not match evidence",
        );
      }
      return;
    default: {
      const exhaustive: never =
        checkpoint.conflict;
      throw new Error(
        `unknown conflict ${String(exhaustive)}`,
      );
    }
  }
}

function assertCommitEligible(
  checkpoint: PreparedCheckpointAdjudicationExpectation,
): asserts checkpoint is PreparedCheckpointCommitPlan["checkpoint"] {
  if (
    checkpoint.conflict !==
      "create-target-matches-after" ||
    checkpoint.before.existed !== false ||
    checkpoint.target.existed !== true ||
    checkpoint.target.revision !==
      checkpoint.afterRevision
  ) {
    throw new TiledMcpError(
      "CHECKPOINT_STATE_CONFLICT",
      "Only an ambiguous create checkpoint whose current target exactly matches the after revision can be committed by operator adjudication.",
      {
        checkpointId: checkpoint.id,
        conflict: checkpoint.conflict,
      },
    );
  }
}

function assertSummary(
  summary:
    | PreparedCheckpointCommitSummary
    | PreparedCheckpointAbandonSummary,
  kind:
    | "preparedCheckpointCommit"
    | "preparedCheckpointAbandon",
): void {
  const commit =
    kind === "preparedCheckpointCommit";
  assertExactKeys(summary, [
    "checkpointId",
    ...(commit
      ? ["commitsCheckpointRecord"]
      : ["removesRecoveryPoint"]),
    "destructive",
    "garbageCollection",
    "manifestBytes",
    "manifestRevision",
    "operationCount",
    "operatorDecisionRequired",
    "projectAssetModified",
    "status",
    "targetPath",
    "warning",
  ]);
  if (
    summary.operationCount !== 1 ||
    summary.destructive !== !commit ||
    !CHECKPOINT_ID_PATTERN.test(
      summary.checkpointId,
    ) ||
    typeof summary.targetPath !==
      "string" ||
    summary.targetPath.length === 0 ||
    summary.status !== "prepared" ||
    !REVISION_PATTERN.test(
      summary.manifestRevision,
    ) ||
    !Number.isSafeInteger(
      summary.manifestBytes,
    ) ||
    summary.manifestBytes < 1 ||
    summary.operatorDecisionRequired !==
      true ||
    summary.projectAssetModified !==
      false ||
    typeof summary.warning !== "string" ||
    summary.warning.length === 0 ||
    (commit
      ? !(
          "commitsCheckpointRecord" in
            summary &&
          summary.commitsCheckpointRecord ===
            true &&
          summary.garbageCollection ===
            PREPARED_CHECKPOINT_COMMIT_GARBAGE_COLLECTION
        )
      : !(
          "removesRecoveryPoint" in
            summary &&
          summary.removesRecoveryPoint ===
            true &&
          summary.garbageCollection ===
            PREPARED_CHECKPOINT_ABANDON_GARBAGE_COLLECTION
        ))
  ) {
    throw new Error(
      "invalid prepared checkpoint adjudication summary",
    );
  }
}

function assertMatchingSummary(
  actual:
    | PreparedCheckpointCommitSummary
    | PreparedCheckpointAbandonSummary,
  expected:
    | PreparedCheckpointCommitSummary
    | PreparedCheckpointAbandonSummary,
  action: "commit" | "abandon",
): void {
  if (
    stableJson(
      actual as unknown as JsonValue,
    ) !==
    stableJson(
      expected as unknown as JsonValue,
    )
  ) {
    invalidPlan(
      `The prepared checkpoint ${action} summary does not match its approved operation.`,
    );
  }
}

function invalidPlan(message: string): never {
  throw new TiledMcpError(
    "INVALID_CHANGE_SET",
    message,
  );
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
