import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
} from "../formats/json.js";
import type {
  TileMetadataUpdate,
  TilesetEditSummary,
} from "./tilesetEdits.js";

const EMBEDDED_TILESET_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/embedded-tileset-edit-plan/v1\0";

/**
 * Per-tile metadata edits for a tileset embedded inline in a map. The
 * edited content lives inside the map bytes, so the plan's CAS target is
 * the map itself: baseRevision is the map revision, apply patches the
 * `tilesets[embeddedIndex]` entry in place, and there is no tileset file
 * or dependency pin. Structural collection updates are impossible here
 * because embedded tilesets are atlas-only.
 */
export interface EmbeddedTilesetEditPlan {
  kind: "embeddedTilesetEdit";
  version: 1;
  id: string;
  mapPath: string;
  /** Raw SHA-256 revision of the map (registry + commit CAS). */
  baseRevision: string;
  embeddedIndex: number;
  updates: TileMetadataUpdate[];
  summary: TilesetEditSummary;
}

export function embeddedTilesetEditPlanId(
  value: Omit<EmbeddedTilesetEditPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(
      EMBEDDED_TILESET_EDIT_PLAN_HASH_DOMAIN,
    )
    .update(stableJson(value))
    .digest("hex")}`;
}

export function assertEmbeddedTilesetEditPlan(
  plan: EmbeddedTilesetEditPlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    plan.kind !== "embeddedTilesetEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.mapPath !== "string" ||
    typeof plan.baseRevision !== "string" ||
    !Number.isSafeInteger(plan.embeddedIndex) ||
    plan.embeddedIndex < 0 ||
    !Array.isArray(plan.updates) ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The embedded tileset edit plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== embeddedTilesetEditPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The embedded tileset edit plan contents do not match its digest. Preview the updates again.",
    );
  }
}
