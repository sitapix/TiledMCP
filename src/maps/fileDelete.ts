import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
} from "../formats/json.js";

export const MAX_DELETE_REFERENCE_SCAN_ASSETS = 2_000;
export const MAX_DELETE_REFERENCE_SCAN_BYTES =
  64 * 1024 * 1024;
export const MAX_DELETE_REFERRER_SAMPLE = 32;

const FILE_DELETE_PLAN_HASH_DOMAIN =
  "tiledmcp/file-delete-plan/v1\0";
export const DELETE_FILE_WARNING =
  "This permanently deletes one project document after committing a checkpoint of its exact current bytes; restoring that checkpoint recreates the file. The bounded reference scan covers TMJ maps, JSON worlds, and JSON templates only, and re-runs on apply.";

export type FileDeleteTargetKind =
  | "map"
  | "tileset";

export interface FileDeleteScanSummary {
  scannedMaps: number;
  scannedWorlds: number;
  scannedTemplates: number;
  scannedBytes: number;
}

export interface FileDeleteSummary {
  targetPath: string;
  targetKind: FileDeleteTargetKind;
  revision: string;
  size: number;
  scan: FileDeleteScanSummary;
  checkpointPolicy: "committed-before-unlink";
  wouldChange: true;
}

export interface FileDeletePlan {
  kind: "fileDelete";
  version: 1;
  id: string;
  targetPath: string;
  targetKind: FileDeleteTargetKind;
  /**
   * Raw SHA-256 of the target's current bytes; the apply CAS re-checks it
   * immediately before the checkpoint commit and unlink.
   */
  baseRevision: string;
  size: number;
  scan: FileDeleteScanSummary;
  summary: FileDeleteSummary;
}

export function fileDeleteSummary(input: {
  targetPath: string;
  targetKind: FileDeleteTargetKind;
  revision: string;
  size: number;
  scan: FileDeleteScanSummary;
}): FileDeleteSummary {
  return {
    targetPath: input.targetPath,
    targetKind: input.targetKind,
    revision: input.revision,
    size: input.size,
    scan: { ...input.scan },
    checkpointPolicy: "committed-before-unlink",
    wouldChange: true,
  };
}

export function fileDeletePlanId(
  value: Omit<FileDeletePlan, "id">,
): string {
  const canonical = stableJson(
    value,
  );
  return `changeset:${createHash("sha256")
    .update(FILE_DELETE_PLAN_HASH_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function assertFileDeletePlan(
  plan: FileDeletePlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    Array.isArray(plan)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The file delete plan is malformed.",
    );
  }
  const keys = Object.keys(plan).sort();
  const expected = [
    "baseRevision",
    "id",
    "kind",
    "scan",
    "size",
    "summary",
    "targetKind",
    "targetPath",
    "version",
  ];
  const scan = plan.scan as unknown;
  const validScan =
    typeof scan === "object" &&
    scan !== null &&
    !Array.isArray(scan) &&
    Object.keys(scan).sort().join("\0") ===
      [
        "scannedBytes",
        "scannedMaps",
        "scannedTemplates",
        "scannedWorlds",
      ].join("\0") &&
    Object.values(scan).every(
      (value) =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0,
    );
  if (
    keys.length !== expected.length ||
    keys.some(
      (key, index) => key !== expected[index],
    ) ||
    plan.kind !== "fileDelete" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.targetPath !== "string" ||
    plan.targetPath.length === 0 ||
    (plan.targetKind !== "map" &&
      plan.targetKind !== "tileset") ||
    !REVISION_PATTERN.test(plan.baseRevision) ||
    !Number.isSafeInteger(plan.size) ||
    plan.size < 0 ||
    !validScan ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The file delete plan is malformed.",
    );
  }
  const expectedSummary = fileDeleteSummary({
    targetPath: plan.targetPath,
    targetKind: plan.targetKind,
    revision: plan.baseRevision,
    size: plan.size,
    scan: plan.scan,
  });
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
      "The file delete summary does not match its plan.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== fileDeletePlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The file delete plan contents do not match its digest. Preview the deletion again.",
    );
  }
}
