import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
} from "../formats/json.js";
import { CHECKPOINT_ID_PATTERN } from "./checkpoints.js";
import type {
  CheckpointRestoreExpectation,
  CommitResult,
  DocumentStore,
} from "./documentStore.js";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^changeset:[0-9a-f]{64}$/u;
const RESTORE_PLAN_HASH_DOMAIN =
  "tiledmcp/checkpoint-restore-plan/v1\0";

export const CHECKPOINT_RESTORE_WARNING =
  "This replaces the target document with the checkpoint's exact pre-write bytes. Referenced tilesets, images and other files are not restored.";

export interface CheckpointRestoreSummary {
  operationCount: 1;
  destructive: true;
  checkpointId: string;
  targetPath: string;
  /**
   * `null` when the target file is missing and the restore recreates it.
   */
  currentRevision: string | null;
  restoreRevision: string;
  restoreBytes: number;
  wouldChange: boolean;
  warning: string;
}

export interface CheckpointRestorePlan {
  kind: "checkpointRestore";
  version: 1;
  id: string;
  checkpoint: CheckpointRestoreExpectation;
  targetPath: string;
  /**
   * With a missing target there is no current revision to pin, so this is
   * the restored content revision itself and `targetMissing` marks the
   * recreate intent inside the signed plan.
   */
  baseRevision: string;
  restoreRevision: string;
  restoreSize: number;
  wouldChange: boolean;
  targetMissing?: true;
  summary: CheckpointRestoreSummary;
}

export type CheckpointRestoreOperationPreview = {
  type: "restoreCheckpoint";
  destructive: true;
  warning: string;
  checkpointId: string;
  targetPath: string;
  currentRevision: string | null;
  restoreRevision: string;
  restoreBytes: number;
  exactBytes: true;
  wouldChange: boolean;
};

export async function planCheckpointRestore(
  store: DocumentStore,
  checkpointId: string,
  expectedRevision: string,
): Promise<CheckpointRestorePlan> {
  const inspection = await store.inspectRevert(
    checkpointId,
    expectedRevision,
  );
  const summary = checkpointRestoreSummary({
    checkpointId: inspection.checkpoint.id,
    targetPath: inspection.checkpoint.path,
    currentRevision: inspection.currentRevision,
    restoreRevision: inspection.restoreRevision,
    restoreSize: inspection.restoreSize,
    wouldChange: inspection.changed,
  });
  const unsignedPlan: Omit<CheckpointRestorePlan, "id"> = {
    kind: "checkpointRestore",
    version: 1,
    checkpoint: structuredClone(inspection.checkpoint),
    targetPath: inspection.checkpoint.path,
    baseRevision:
      inspection.currentRevision ??
      inspection.restoreRevision,
    restoreRevision: inspection.restoreRevision,
    restoreSize: inspection.restoreSize,
    wouldChange: inspection.changed,
    ...(inspection.currentRevision === null
      ? { targetMissing: true as const }
      : {}),
    summary,
  };
  return {
    ...unsignedPlan,
    id: checkpointRestorePlanId(unsignedPlan),
  };
}

export async function applyCheckpointRestore(
  store: DocumentStore,
  plan: CheckpointRestorePlan,
): Promise<CommitResult & { changeSetId: string }> {
  assertCheckpointRestorePlan(plan);
  const { id, ...unsignedPlan } = plan;
  if (checkpointRestorePlanId(unsignedPlan) !== id) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint restore change set digest is invalid.",
    );
  }
  const expectedSummary = checkpointRestoreSummary({
    checkpointId: plan.checkpoint.id,
    targetPath: plan.targetPath,
    currentRevision:
      plan.targetMissing === true
        ? null
        : plan.baseRevision,
    restoreRevision: plan.restoreRevision,
    restoreSize: plan.restoreSize,
    wouldChange: plan.wouldChange,
  });
  if (
    stableJson(plan.summary) !==
    stableJson(expectedSummary)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint restore summary does not match its approved operation.",
    );
  }
  const result = await store.revertPlanned(
    structuredClone(plan.checkpoint),
    plan.baseRevision,
    plan.targetMissing === true
      ? { expectMissingTarget: true }
      : {},
  );
  return { ...result, changeSetId: plan.id };
}

export function checkpointRestoreOperationPreview(
  plan: CheckpointRestorePlan,
): CheckpointRestoreOperationPreview {
  return {
    type: "restoreCheckpoint",
    destructive: true,
    warning: CHECKPOINT_RESTORE_WARNING,
    checkpointId: plan.checkpoint.id,
    targetPath: plan.targetPath,
    currentRevision:
      plan.targetMissing === true
        ? null
        : plan.baseRevision,
    restoreRevision: plan.restoreRevision,
    restoreBytes: plan.restoreSize,
    exactBytes: true,
    wouldChange: plan.wouldChange,
  };
}

function checkpointRestoreSummary(input: {
  checkpointId: string;
  targetPath: string;
  currentRevision: string | null;
  restoreRevision: string;
  restoreSize: number;
  wouldChange: boolean;
}): CheckpointRestoreSummary {
  return {
    operationCount: 1,
    destructive: true,
    checkpointId: input.checkpointId,
    targetPath: input.targetPath,
    currentRevision: input.currentRevision,
    restoreRevision: input.restoreRevision,
    restoreBytes: input.restoreSize,
    wouldChange: input.wouldChange,
    warning: CHECKPOINT_RESTORE_WARNING,
  };
}

function checkpointRestorePlanId(
  value: Omit<CheckpointRestorePlan, "id">,
): string {
  const canonical = stableJson(value);
  return `changeset:${createHash("sha256")
    .update(RESTORE_PLAN_HASH_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}

function assertCheckpointRestorePlan(
  plan: CheckpointRestorePlan,
): void {
  try {
    assertExactKeys(
      plan,
      plan.targetMissing === undefined
        ? [
            "baseRevision",
            "checkpoint",
            "id",
            "kind",
            "restoreRevision",
            "restoreSize",
            "summary",
            "targetPath",
            "version",
            "wouldChange",
          ]
        : [
            "baseRevision",
            "checkpoint",
            "id",
            "kind",
            "restoreRevision",
            "restoreSize",
            "summary",
            "targetMissing",
            "targetPath",
            "version",
            "wouldChange",
          ],
    );
    assertExactKeys(plan.checkpoint, [
      "afterRevision",
      "before",
      "createdAt",
      "id",
      "label",
      "path",
      "status",
    ]);
    assertExactKeys(plan.checkpoint.before, [
      "objectHash",
      "revision",
      "size",
    ]);
    assertExactKeys(plan.summary, [
      "checkpointId",
      "currentRevision",
      "destructive",
      "operationCount",
      "restoreBytes",
      "restoreRevision",
      "targetPath",
      "warning",
      "wouldChange",
    ]);
    if (
      plan.kind !== "checkpointRestore" ||
      plan.version !== 1 ||
      !PLAN_ID_PATTERN.test(plan.id) ||
      !CHECKPOINT_ID_PATTERN.test(plan.checkpoint.id) ||
      (plan.checkpoint.status !== "prepared" &&
        plan.checkpoint.status !== "committed") ||
      plan.checkpoint.createdAt.length === 0 ||
      plan.checkpoint.label.length > 1_024 ||
      plan.checkpoint.path.length === 0 ||
      !REVISION_PATTERN.test(plan.checkpoint.afterRevision) ||
      !REVISION_PATTERN.test(plan.checkpoint.before.revision) ||
      !OBJECT_HASH_PATTERN.test(
        plan.checkpoint.before.objectHash,
      ) ||
      plan.checkpoint.before.revision !==
        `sha256:${plan.checkpoint.before.objectHash}` ||
      !Number.isSafeInteger(plan.checkpoint.before.size) ||
      plan.checkpoint.before.size < 1 ||
      plan.targetPath !== plan.checkpoint.path ||
      !REVISION_PATTERN.test(plan.baseRevision) ||
      plan.restoreRevision !== plan.checkpoint.before.revision ||
      plan.restoreSize !== plan.checkpoint.before.size ||
      typeof plan.wouldChange !== "boolean" ||
      (plan.targetMissing !== undefined &&
        plan.targetMissing !== true) ||
      (plan.targetMissing === true
        ? plan.baseRevision !==
            plan.restoreRevision ||
          plan.wouldChange !== true ||
          plan.checkpoint.status !== "committed"
        : plan.wouldChange !==
          (plan.baseRevision !==
            plan.restoreRevision))
    ) {
      throw new Error("invalid checkpoint restore plan");
    }
  } catch {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The checkpoint restore change set is malformed.",
    );
  }
}

function assertExactKeys(
  value: object,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(value).sort();
  const canonicalExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalExpected.length ||
    actualKeys.some(
      (key, index) => key !== canonicalExpected[index],
    )
  ) {
    throw new Error("unexpected change set fields");
  }
}
