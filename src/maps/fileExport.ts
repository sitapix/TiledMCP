import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonValue,
} from "../formats/json.js";

export const MAX_EXPORT_OUTPUT_BYTES =
  8 * 1024 * 1024;
export const EXPORT_FORMAT_PATTERN =
  /^[a-z0-9]{1,16}$/u;
export const FILE_EXPORT_WARNING =
  "This runs Tiled's own command-line exporter and creates one new project file from its output. The source file is never modified; apply re-runs the export and fails closed unless the output bytes exactly match the approved content hash.";
export const NATIVE_TMX_WARNING =
  "This serializes the source map to TMX natively and creates one new project file. The source file is never modified; apply re-serializes and fails closed unless the output bytes exactly match the approved content hash.";

const FILE_EXPORT_PLAN_HASH_DOMAIN =
  "tiledmcp/file-export-plan/v1\0";

export interface FileExportSummary {
  sourcePath: string;
  targetPath: string;
  exportKind: "map" | "tileset" | "template";
  format: string;
  contentBytes: number;
  wouldChange: true;
}

export interface FileExportPlan {
  kind: "fileExport";
  version: 1;
  id: string;
  /**
   * Which engine reproduces the bytes at apply: the official Tiled CLI
   * exporter, or the native restricted-profile TMX serializer.
   */
  producer: "tiled-cli" | "native";
  sourcePath: string;
  /**
   * Raw SHA-256 revision of the source at preview time. Apply re-reads
   * the source and re-runs the export, so a changed source fails closed
   * before any CLI work happens.
   */
  sourceRevision: string;
  targetPath: string;
  exportKind: "map" | "tileset" | "template";
  format: string;
  /**
   * Present when class-typed properties serialize: the project file
   * whose definitions typed the members, pinned by revision so apply
   * re-resolves against the same definitions.
   */
  projectFilePath?: string;
  projectRevision?: string;
  /**
   * Raw SHA-256 of the exact approved export bytes. There is no existing
   * target file, so the no-replace create pins the approved content
   * itself; a drifting re-export refuses to apply.
   */
  baseRevision: string;
  summary: FileExportSummary;
}

export function fileExportPlanId(
  value: Omit<FileExportPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(FILE_EXPORT_PLAN_HASH_DOMAIN)
    .update(stableJson(value as unknown as JsonValue))
    .digest("hex")}`;
}

export function assertFileExportPlan(
  plan: FileExportPlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    plan.kind !== "fileExport" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    (plan.producer !== "tiled-cli" &&
      plan.producer !== "native") ||
    typeof plan.sourcePath !== "string" ||
    typeof plan.sourceRevision !== "string" ||
    typeof plan.targetPath !== "string" ||
    (plan.exportKind !== "map" &&
      plan.exportKind !== "tileset" &&
      plan.exportKind !== "template") ||
    typeof plan.format !== "string" ||
    !EXPORT_FORMAT_PATTERN.test(plan.format) ||
    (plan.projectFilePath !== undefined &&
      typeof plan.projectFilePath !==
        "string") ||
    (plan.projectRevision !== undefined &&
      typeof plan.projectRevision !==
        "string") ||
    (plan.projectFilePath === undefined) !==
      (plan.projectRevision === undefined) ||
    typeof plan.baseRevision !== "string" ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The file export plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== fileExportPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The file export plan contents do not match its digest. Preview the export again.",
    );
  }
}
