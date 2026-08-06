import {
  createHash,
  randomBytes,
} from "node:crypto";

import { TiledMcpError } from "./errors.js";
import type { Revision } from "./storage/revision.js";
import {
  stableJson,
} from "./formats/json.js";
import type {
  CommitResult,
  FileDeleteStoreResult,
  PreparedCheckpointAbandonResult,
  PreparedCheckpointCommitResult,
  PreparedCheckpointDiscardResult,
} from "./storage/documentStore.js";
import {
  checkpointPruneBatchOperationPreview,
  type CheckpointPruneBatchOperationPreview,
  type CheckpointPruneBatchPlan,
  type CheckpointPruneBatchResult,
  type CheckpointPruneBatchSummary,
} from "./storage/checkpointBatchPrune.js";
import {
  checkpointRestoreOperationPreview,
  type CheckpointRestoreOperationPreview,
  type CheckpointRestorePlan,
  type CheckpointRestoreSummary,
} from "./storage/checkpointRestore.js";
import {
  assertTilesetEditPlan,
  updateTileOperationPreview,
  type TilesetEditPlan,
  type UpdateTileOperationPreview,
} from "./maps/tilesetEdits.js";
import {
  assertTilesetPropertyEditPlan,
  updateTilesetOperationPreview,
  type TilesetPropertyEditPlan,
  type UpdateTilesetOperationPreview,
} from "./maps/tilesetProperties.js";
import {
  assertTilesetCreatePlan,
  CREATE_TILESET_WARNING,
  type TilesetCreatePlan,
} from "./maps/tilesetCreate.js";
import {
  assertFileDeletePlan,
  DELETE_FILE_WARNING,
  type FileDeletePlan,
} from "./maps/fileDelete.js";
import type { WorldEditPlan } from "./maps/worldRead.js";
import {
  assertWangEditPlan,
  type WangEditPlan,
} from "./maps/wangEdits.js";
import {
  assertFileExportPlan,
  FILE_EXPORT_WARNING,
  NATIVE_TMX_WARNING,
  type FileExportPlan,
} from "./maps/fileExport.js";
import {
  assertEmbeddedTilesetEditPlan,
  type EmbeddedTilesetEditPlan,
} from "./maps/embeddedTilesetEdit.js";
import {
  assertTileNameEditPlan,
  type TileNameEditApplyResult,
  type TileNameEditPlan,
} from "./maps/tileNames.js";
import {
  assertPropertyTypeEditPlan,
  type PropertyTypeEditPlan,
} from "./maps/propertyTypes.js";
import {
  PREPARED_CHECKPOINT_DISCARD_ELIGIBILITY,
  preparedCheckpointDiscardOperationPreview,
  type PreparedCheckpointDiscardOperationPreview,
  type PreparedCheckpointDiscardPlan,
  type PreparedCheckpointDiscardSummary,
} from "./storage/preparedCheckpointDiscard.js";
import {
  preparedCheckpointAbandonOperationPreview,
  preparedCheckpointCommitOperationPreview,
  type PreparedCheckpointAbandonOperationPreview,
  type PreparedCheckpointAbandonPlan,
  type PreparedCheckpointAbandonSummary,
  type PreparedCheckpointCommitOperationPreview,
  type PreparedCheckpointCommitPlan,
  type PreparedCheckpointCommitSummary,
} from "./storage/preparedCheckpointAdjudication.js";
import type {
  MapEditOperation,
  MapEditPlan,
  PlannedMapEditOperation,
  TileRef,
} from "./maps/types.js";
import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
  GID_HEX_120,
} from "./maps/gid.js";
import {
  DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
  measureTextObjectPayloadBytes,
} from "./maps/textObjects.js";
import {
  MAX_CELL_WRITES,
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_OBJECT_SHAPE_POINTS,
  MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
  MAX_REMOVE_TILESET_GID_SCANS,
  MAX_RESIZE_CROPPED_CELL_SAMPLE,
  MAX_RESIZE_MAP_DIMENSION,
  MAX_RESIZE_OFFSET_MAGNITUDE,
  MAX_RESIZE_SOURCE_CELL_SCANS,
  MAX_TILE_OPERATION_SCANS,
  MIN_POLYGON_OBJECT_POINTS,
  MIN_POLYLINE_OBJECT_POINTS,
} from "./maps/mapService.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
export const DEFAULT_MAX_PENDING_CELL_WRITES = 200_000;
export const DEFAULT_MAX_PENDING_OBJECT_SHAPE_POINTS = 65_536;
export {
  DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
} from "./maps/textObjects.js";
const MAX_ABSOLUTE_OBJECT_SHAPE_COORDINATE =
  1_000_000_000;
const MAP_UPDATE_FIELDS = [
  "renderOrder",
  "backgroundColor",
  "className",
] as const;
const MAP_RENDER_UPDATE_FIELDS = new Set([
  "renderOrder",
  "backgroundColor",
]);
const MAP_RENDER_ORDERS = new Set([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);
const TILED_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const ASSET_ID_PATTERN = /^asset_[0-9a-f]{24}$/u;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type ChangeSetPlan =
  | MapEditPlan
  | TilesetEditPlan
  | TilesetPropertyEditPlan
  | TilesetCreatePlan
  | FileDeletePlan
  | WorldEditPlan
  | WangEditPlan
  | FileExportPlan
  | EmbeddedTilesetEditPlan
  | PropertyTypeEditPlan
  | TileNameEditPlan
  | TransactionPlan
  | CheckpointRestorePlan
  | CheckpointPruneBatchPlan
  | PreparedCheckpointCommitPlan
  | PreparedCheckpointAbandonPlan
  | PreparedCheckpointDiscardPlan;

export type ChangeSetOperationResult =
  | TileNameEditApplyResult
  | (CommitResult & {
      changeSetId: string;
    })
  | (FileDeleteStoreResult & {
      changeSetId: string;
    })
  | TransactionApplyOutcome
  | CheckpointPruneBatchResult
  | PreparedCheckpointCommitResult
  | PreparedCheckpointAbandonResult
  | PreparedCheckpointDiscardResult;

export type ChangeSetApplyResult =
  | TileNameEditApplyResult
  | (CommitResult & {
      changeSetId: string;
    })
  | (FileDeleteStoreResult & {
      changeSetId: string;
    })
  | (TransactionApplyOutcome & {
      changeSetId: string;
    })
  | (CheckpointPruneBatchResult & {
      changeSetId: string;
    })
  | (PreparedCheckpointCommitResult & {
      changeSetId: string;
    })
  | (PreparedCheckpointAbandonResult & {
      changeSetId: string;
    })
  | (PreparedCheckpointDiscardResult & {
      changeSetId: string;
    });

interface ChangeSetEntry {
  id: string;
  plan: ChangeSetPlan;
  pendingTextObjectPayloadBytes: number;
  createdAt: string;
  expiresAt: number;
  result?: ChangeSetApplyResult;
  inFlight?: Promise<ChangeSetApplyResult>;
  /**
   * Transaction change set id that owns this member. Owned members cannot
   * be applied individually; ownership clears when the owner expires.
   */
  ownedBy?: string;
}

interface ChangeSetPreviewCommon {
  changeSetId: string;
  planDigest: string;
  expectedRevision: string;
  operations: OperationPreview[];
  snapshotConsistency:
    | "non-atomic-read-set"
    | "checkpoint-store-locked-manifest-set";
  createdAt: string;
  expiresAt: string;
}

export interface MapEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "mapEdit";
  mapPath: string;
  dependencyRevisions: Record<string, string>;
  prospectiveDependencyRevisions?: Record<string, string>;
  summary: MapEditPlan["summary"];
}

export interface TilesetEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "tilesetEdit";
  mapPath: string;
  tilesetPath: string;
  assetId: string;
  mapRevision: string;
  summary: TilesetEditPlan["summary"];
}

export interface TilesetPropertyEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "tilesetPropertyEdit";
  mapPath: string;
  tilesetPath: string;
  assetId: string;
  mapRevision: string;
  summary: TilesetPropertyEditPlan["summary"];
}

export interface TilesetCreateChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "tilesetCreate";
  tilesetPath: string;
  image: TilesetCreatePlan["image"];
  summary: TilesetCreatePlan["summary"];
}

export interface FileDeleteChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "fileDelete";
  targetPath: string;
  summary: FileDeletePlan["summary"];
}

export interface WorldEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "worldEdit";
  worldPath: string;
  summary: WorldEditPlan["summary"];
}

export interface WangEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "wangEdit";
  mapPath: string;
  tilesetPath: string;
  assetId: string;
  mapRevision: string;
  summary: WangEditPlan["summary"];
}

export interface FileExportChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "fileExport";
  sourcePath: string;
  sourceRevision: string;
  targetPath: string;
  summary: FileExportPlan["summary"];
}

export interface EmbeddedTilesetEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "embeddedTilesetEdit";
  mapPath: string;
  embeddedIndex: number;
  summary: EmbeddedTilesetEditPlan["summary"];
}

export interface PropertyTypeEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "propertyTypeEdit";
  projectFilePath: string;
  summary: PropertyTypeEditPlan["summary"];
}

export interface TileNameEditChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "tileNameEdit";
  registryRevision: Revision | null;
  summary: TileNameEditPlan["summary"];
}

export const MIN_TRANSACTION_MEMBERS = 2;
export const MAX_TRANSACTION_MEMBERS = 16;
export const MAX_PENDING_TRANSACTIONS = 4;
const TRANSACTION_PLAN_HASH_DOMAIN =
  "tiledmcp/transaction-plan/v1\0";
export const TRANSACTION_WARNING =
  "This atomically commits every member change set through a crash-recoverable journal: either all targets land or none do. Members are locked against individual apply while the transaction is pending.";

export type TransactionMemberPlanKind =
  | "mapEdit"
  | "tilesetEdit"
  | "wangEdit"
  | "embeddedTilesetEdit"
  | "tilesetCreate"
  | "fileDelete";

export interface TransactionPlanTarget {
  memberChangeSetId: string;
  memberPlanDigest: string;
  planKind: TransactionMemberPlanKind;
  targetKind: "replace" | "create" | "delete";
  path: string;
  expectedRevision: string | null;
}

export interface TransactionPlan {
  kind: "transaction";
  version: 1;
  id: string;
  /**
   * Aggregate digest over the ordered target pins; with multiple member
   * documents there is no single current revision, so the client echoes
   * this aggregate as `expectedRevision` (the batch-prune precedent).
   */
  baseRevision: string;
  targets: TransactionPlanTarget[];
  summary: {
    memberCount: number;
    targets: TransactionPlanTarget[];
    wouldChange: true;
  };
}

export interface TransactionChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "transaction";
  summary: TransactionPlan["summary"];
}

/**
 * Per-member commit result inside a transaction apply: the exact wire shape
 * the member would have returned had it been applied individually.
 */
export type TransactionMemberApplyResult =
  | (CommitResult & { changeSetId: string })
  | (FileDeleteStoreResult & {
      changeSetId: string;
    });

export interface TransactionApplyOutcome {
  kind: "transaction";
  transactionId: string;
  results: TransactionMemberApplyResult[];
  warnings?: string[];
}

export function transactionPlanId(
  value: Omit<TransactionPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(TRANSACTION_PLAN_HASH_DOMAIN)
    .update(
      stableJson(value),
    )
    .digest("hex")}`;
}

function transactionTargetForPlan(
  memberChangeSetId: string,
  plan: ChangeSetPlan,
): TransactionPlanTarget {
  if (plan.kind === "mapEdit") {
    return {
      memberChangeSetId,
      memberPlanDigest: plan.id,
      planKind: "mapEdit",
      targetKind: "replace",
      path: plan.mapPath,
      expectedRevision: plan.baseRevision,
    };
  }
  if (plan.kind === "tilesetEdit") {
    return {
      memberChangeSetId,
      memberPlanDigest: plan.id,
      planKind: "tilesetEdit",
      targetKind: "replace",
      path: plan.tilesetPath,
      expectedRevision: plan.baseRevision,
    };
  }
  if (plan.kind === "wangEdit") {
    return {
      memberChangeSetId,
      memberPlanDigest: plan.id,
      planKind: "wangEdit",
      targetKind: "replace",
      path: plan.tilesetPath,
      expectedRevision: plan.baseRevision,
    };
  }
  if (plan.kind === "embeddedTilesetEdit") {
    return {
      memberChangeSetId,
      memberPlanDigest: plan.id,
      planKind: "embeddedTilesetEdit",
      targetKind: "replace",
      path: plan.mapPath,
      expectedRevision: plan.baseRevision,
    };
  }
  if (plan.kind === "tilesetCreate") {
    return {
      memberChangeSetId,
      memberPlanDigest: plan.id,
      planKind: "tilesetCreate",
      targetKind: "create",
      path: plan.tilesetPath,
      expectedRevision: null,
    };
  }
  if (plan.kind === "fileDelete") {
    return {
      memberChangeSetId,
      memberPlanDigest: plan.id,
      planKind: "fileDelete",
      targetKind: "delete",
      path: plan.targetPath,
      expectedRevision: plan.baseRevision,
    };
  }
  throw new TiledMcpError(
    "INVALID_ARGUMENT",
    `Change set kind ${plan.kind} cannot join a transaction; only document-commit change sets can.`,
    { kind: plan.kind },
  );
}

/**
 * Rejects member combinations whose pins disagree about the shared
 * pre-state. Every member both validates and commits against the same
 * pre-transaction snapshot, so a pin onto another member's target is
 * sound exactly when it equals that member's own pinned base revision —
 * any serial order of the members applied to the pre-state yields the
 * committed result. Mismatched pins mean the members were previewed
 * against different states and could never commit together. Attaching a
 * tileset another member creates additionally requires the exact
 * prospective content pin (create+attach).
 */
function assertTransactionMemberCoupling(
  plans: readonly ChangeSetPlan[],
  targets: readonly TransactionPlanTarget[],
): void {
  const targetByPath = new Map(
    targets.map((target) => [
      target.path,
      target,
    ]),
  );
  for (const [index, plan] of plans.entries()) {
    const memberChangeSetId =
      targets[index]?.memberChangeSetId ?? null;
    if (
      plan.kind === "tilesetEdit" ||
      plan.kind === "wangEdit"
    ) {
      const pinned = targetByPath.get(
        plan.mapPath,
      );
      if (
        pinned !== undefined &&
        plan.mapRevision !==
          pinned.expectedRevision
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "A tileset-edit member pins a map at a different revision than the member that rewrites or deletes it; preview both against the same state.",
          {
            changeSetId: memberChangeSetId,
            mapPath: plan.mapPath,
            pinnedRevision: plan.mapRevision,
            memberBaseRevision:
              pinned.expectedRevision,
          },
        );
      }
    }
    if (plan.kind !== "mapEdit") {
      continue;
    }
    for (const [
      otherIndex,
      otherPlan,
    ] of plans.entries()) {
      if (
        otherIndex === index ||
        otherPlan.kind !== "tilesetEdit"
      ) {
        continue;
      }
      const pinnedRevision =
        plan.dependencyRevisions[
          otherPlan.assetId
        ];
      if (
        pinnedRevision !== undefined &&
        pinnedRevision !== otherPlan.baseRevision
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "A map-edit member pins a tileset at a different revision than the member that edits it; preview both against the same state.",
          {
            changeSetId: memberChangeSetId,
            tilesetPath: otherPlan.tilesetPath,
            assetId: otherPlan.assetId,
            pinnedRevision,
            memberBaseRevision:
              otherPlan.baseRevision,
          },
        );
      }
    }
    for (const operation of plan.operations) {
      if (operation.type !== "addTilesetToMap") {
        continue;
      }
      const otherIndex = targets.findIndex(
        (target) =>
          target.path === operation.tilesetPath,
      );
      if (
        otherIndex === -1 ||
        otherIndex === index
      ) {
        continue;
      }
      const otherPlan = plans[otherIndex];
      if (
        otherPlan?.kind === "tilesetCreate" &&
        operation.tilesetRevision ===
          otherPlan.baseRevision
      ) {
        continue;
      }
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "A map-edit member attaches a tileset another member targets; only a create+attach coupling pinned on the exact prospective content is allowed.",
        {
          changeSetId: memberChangeSetId,
          tilesetPath: operation.tilesetPath,
        },
      );
    }
  }
}

export interface CheckpointRestoreChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "checkpointRestore";
  targetPath: string;
  checkpoint: {
    id: string;
    status: "prepared" | "committed";
    label: string;
    createdAt: string;
    afterRevision: string;
  };
  restore: {
    revision: string;
    size: number;
    exactBytes: true;
    wouldChange: boolean;
  };
  summary: CheckpointRestoreSummary;
}

export interface CheckpointPruneBatchChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "checkpointPruneBatch";
  targetPaths: string[];
  checkpoints: Array<{
    id: string;
    version: 1 | 2;
    status: "committed";
    label?: string;
    createdAt: string;
    path: string;
    before:
      | { existed: false }
      | {
          existed: true;
          revision: string;
          objectHash: string;
          size: number;
    };
    afterRevision: string;
    retention?:
      | {
          class: "protected";
        }
      | {
          class: "rolling";
          ordinal: number;
        };
    manifest: {
      revision: string;
      size: number;
    };
  }>;
  summary: CheckpointPruneBatchSummary;
}

export interface PreparedCheckpointDiscardChangeSetPreview
  extends ChangeSetPreviewCommon {
  kind: "preparedCheckpointDiscard";
  targetPath: string;
  checkpoint: {
    id: string;
    status: "prepared";
    label?: string;
    createdAt: string;
    path: string;
    before:
      | { existed: false }
      | {
          existed: true;
          revision: string;
          objectHash: string;
          size: number;
        };
    afterRevision: string;
  };
  manifest: {
    revision: string;
    size: number;
  };
  target:
    | { existed: false }
    | {
        existed: true;
        revision: string;
        size: number;
      };
  eligibility:
    typeof PREPARED_CHECKPOINT_DISCARD_ELIGIBILITY;
  summary: PreparedCheckpointDiscardSummary;
}

interface PreparedCheckpointAdjudicationPreviewCheckpoint {
  id: string;
  version: 1 | 2;
  status: "prepared";
  label?: string;
  createdAt: string;
  path: string;
  before:
    | { existed: false }
    | {
        existed: true;
        revision: string;
        objectHash: string;
        size: number;
      };
  afterRevision: string;
  retention?:
    | {
        class: "protected";
      }
    | {
        class: "rolling";
        ordinal: number;
      };
}

interface PreparedCheckpointAdjudicationPreviewEvidence {
  targetPath: string;
  checkpoint: PreparedCheckpointAdjudicationPreviewCheckpoint;
  manifest: {
    revision: string;
    size: number;
  };
  target:
    | { existed: false }
    | {
        existed: true;
        revision: string;
        size: number;
      };
  conflict:
    | "create-target-matches-after"
    | "create-target-unrelated"
    | "existing-target-missing"
    | "existing-target-unrelated";
}

export interface PreparedCheckpointCommitChangeSetPreview
  extends ChangeSetPreviewCommon,
    PreparedCheckpointAdjudicationPreviewEvidence {
  kind: "preparedCheckpointCommit";
  operations: [
    PreparedCheckpointCommitOperationPreview,
  ];
  summary: PreparedCheckpointCommitSummary;
}

export interface PreparedCheckpointAbandonChangeSetPreview
  extends ChangeSetPreviewCommon,
    PreparedCheckpointAdjudicationPreviewEvidence {
  kind: "preparedCheckpointAbandon";
  operations: [
    PreparedCheckpointAbandonOperationPreview,
  ];
  summary: PreparedCheckpointAbandonSummary;
}

export type ChangeSetPreview =
  | MapEditChangeSetPreview
  | TilesetEditChangeSetPreview
  | TilesetPropertyEditChangeSetPreview
  | TilesetCreateChangeSetPreview
  | FileDeleteChangeSetPreview
  | WorldEditChangeSetPreview
  | WangEditChangeSetPreview
  | FileExportChangeSetPreview
  | EmbeddedTilesetEditChangeSetPreview
  | PropertyTypeEditChangeSetPreview
  | TileNameEditChangeSetPreview
  | TransactionChangeSetPreview
  | CheckpointRestoreChangeSetPreview
  | CheckpointPruneBatchChangeSetPreview
  | PreparedCheckpointCommitChangeSetPreview
  | PreparedCheckpointAbandonChangeSetPreview
  | PreparedCheckpointDiscardChangeSetPreview;

type OperationPreview =
  | {
      type: "updateMap";
      destructive: false;
      warning: string;
      patch: Extract<
        MapEditOperation,
        { type: "updateMap" }
      >["patch"];
      requestedFields: string[];
      changedFields: string[];
      wouldChange: boolean;
      renderingMayChange: boolean;
    }
  | {
      type: "transcodeTileLayer";
      destructive: false;
      warning: string;
      layerId: number;
      from: {
        encoding: "csv" | "base64";
        compression: string;
      };
      to: {
        encoding: "csv" | "base64";
        compression: string;
      };
      cellCount: number;
      wouldChange: boolean;
    }
  | {
      type: "resizeMap";
      destructive: true;
      warning: string;
      oldBounds: { width: number; height: number };
      newBounds: { width: number; height: number };
      offset: { x: number; y: number };
      pixelOffset: { x: number; y: number };
      wouldChange: boolean;
      mapDimensionsChanged: boolean;
      tileLayerCount: number;
      resizedTileLayerIds: number[];
      scannedCellCount: number;
      rewrittenCellCount: number;
      preservedNonEmptyCellCount: number;
      croppedNonEmptyCellCount: number;
      croppedCellSample: Array<{
        layerId: number;
        x: number;
        y: number;
        gid: number;
      }>;
      omittedCroppedCellCount: number;
      objectLayerCount: number;
      movedObjectCount: number;
      objectsOutsideNewBounds: number;
      imageLayerCount: number;
      shiftedImageLayerIds: number[];
      groupLayerCount: number;
      lockedLayerCount: number;
    }
  | {
      type: "setTiles";
      layerId: number;
      cellCount: number;
      bounds: { x: number; y: number; width: number; height: number };
      sample: Array<{ x: number; y: number; tile: TileRef | null }>;
      omittedCellCount: number;
    }
  | {
      type: "fillRegion";
      layerId: number;
      region: { x: number; y: number; width: number; height: number };
      tile: Extract<MapEditOperation, { type: "fillRegion" }>["tile"];
    }
  | {
      type: "stampPattern";
      layerId: number;
      destructive: true;
      warning: string;
      region: { x: number; y: number; width: number; height: number };
      cellCount: number;
      nonEmptyCellCount: number;
      clearCellCount: number;
      transformedCellCount: number;
      changedCellCount: number;
      wouldChange: boolean;
      sample: Array<{
        x: number;
        y: number;
        tile: TileRef | null;
      }>;
      omittedCellCount: number;
    }
  | {
      type: "floodFill";
      layerId: number;
      destructive: true;
      warning: string;
      seed: { x: number; y: number };
      connectivity: "four-way";
      sourceTile: TileRef | null;
      targetTile: TileRef | null;
      scannedCellCount: number;
      changedCellCount: number;
      affectedBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
      wouldChange: boolean;
    }
  | {
      type: "copyRegion";
      destructive: true;
      warning: string;
      source: {
        layerId: number;
        x: number;
        y: number;
        width: number;
        height: number;
      };
      destination: {
        layerId: number;
        x: number;
        y: number;
        width: number;
        height: number;
      };
      scannedCellCount: number;
      cellCount: number;
      sourceNonEmptyCellCount: number;
      changedCellCount: number;
      overwrittenNonEmptyCellCount: number;
      clearedCellCount: number;
      overlapsSource: boolean;
      wouldChange: boolean;
    }
  | {
      type: "replaceTiles";
      layerId: number;
      destructive: true;
      warning: string;
      region: { x: number; y: number; width: number; height: number };
      scannedCellCount: number;
      replacedCellCount: number;
      mappingCount: number;
      mappingSample: Array<{
        from: TileRef;
        to: TileRef | null;
      }>;
      omittedMappingCount: number;
    }
  | {
      type: "createObject";
      layerId: number;
      shape: Extract<MapEditOperation, { type: "createObject" }>["object"]["shape"];
      object: Extract<MapEditOperation, { type: "createObject" }>["object"];
    }
  | {
      type: "updateObject";
      objectId: number;
      changedFields: string[];
      patch: Extract<MapEditOperation, { type: "updateObject" }>["patch"];
    }
  | {
      type: "updateLayer";
      layerId: number;
      layerType:
        | "tilelayer"
        | "objectgroup"
        | "imagelayer"
        | "group";
      destructive: false;
      warning: string;
      patch: Extract<
        MapEditOperation,
        { type: "updateLayer" }
      >["patch"];
      requestedFields: string[];
      changedFields: string[];
      wouldChange: boolean;
      affectsDescendants: boolean;
    }
  | {
      type: "deleteLayer";
      layerId: number;
      deleteDescendants: boolean;
      destructive: true;
      warning: string;
      layer: {
        id: number;
        type:
          | "tilelayer"
          | "objectgroup"
          | "imagelayer"
          | "group";
        name: string;
        nameTruncated: boolean;
      };
      parentGroupId: number | null;
      index: number;
      deletedLayerCount: number;
      descendantLayerCount: number;
      layerIdSample: number[];
      omittedLayerCount: number;
      objectCount: number;
      objectIdSample: number[];
      omittedObjectCount: number;
      lockedLayerCount: number;
    }
  | {
      type: "moveLayer";
      layerId: number;
      destructive: false;
      warning: string;
      layer: {
        id: number;
        type:
          | "tilelayer"
          | "objectgroup"
          | "imagelayer"
          | "group";
        name: string;
        nameTruncated: boolean;
      };
      sourceParentGroupId: number | null;
      sourceIndex: number;
      targetParentGroupId: number | null;
      targetIndex: number;
      subtreeLayerCount: number;
      descendantLayerCount: number;
      layerIdSample: number[];
      omittedLayerCount: number;
      objectCount: number;
      lockedLayerCount: number;
      sourceParentLocked: boolean;
      targetParentLocked: boolean;
      effectivelyLockedLayerCountBefore: number;
      effectivelyLockedLayerCountAfter: number;
      wouldChange: boolean;
      renderOrderMayChange: boolean;
      renderContextMayChange: boolean;
      affectsDescendants: boolean;
    }
  | {
      type: "duplicateLayer";
      destructive: false;
      warning: string;
      sourceLayerId: number;
      createdRootLayerId: number;
      layerType:
        | "tilelayer"
        | "objectgroup"
        | "imagelayer"
        | "group";
      name: string;
      nameTruncated: boolean;
      sourceParentGroupId: number | null;
      targetParentGroupId: number | null;
      sourceIndex: number;
      targetIndex: number;
      copiedLayerCount: number;
      descendantLayerCount: number;
      copiedObjectCount: number;
      allocatedCellCount: number;
      serializedDuplicateBytes: number;
      layerIdMappingSample: Array<{
        from: number;
        to: number;
      }>;
      omittedLayerMappingCount: number;
      objectIdMappingSample: Array<{
        from: number;
        to: number;
      }>;
      omittedObjectMappingCount: number;
      remappedInternalObjectReferenceCount: number;
      retainedExternalObjectReferenceCount: number;
      fileReferenceCount: number;
      tileObjectCount: number;
      lockedLayerCount: number;
      effectivelyLockedLayerCount: number;
      renderOrderMayChange: boolean;
      renderContextMayChange: boolean;
      affectsDescendants: boolean;
    }
  | {
      type: "deleteObjects";
      destructive: true;
      warning: string;
      objectCount: number;
      objectIdSample: number[];
      omittedObjectCount: number;
    }
  | {
      type: "addTilesetToMap";
      destructive: false;
      warning: string;
      tileset: {
        kind: "external";
        assetId: string;
        path: string;
        revision: string;
        tileCount: number;
        gidSpan: number;
      };
      source: string;
      assignedFirstGid: number;
      gidRange: { first: number; last: number };
    }
  | {
      type: "replaceTilesetInMap";
      destructive: false;
      warning: string;
      firstGid: number;
      from: {
        tilesetPath: string;
        assetId: string;
        tileCount: number;
        gidSpan: number;
      };
      to: {
        tilesetPath: string;
        source: string;
        assetId: string;
        tilesetRevision: string;
        tileCount: number;
        gidSpan: number;
      };
      /**
       * Highest local id any surviving reference still uses, or `null` when
       * nothing refers to the tileset. This is the number that decides whether
       * a smaller replacement is safe.
       */
      highestReferencedLocalId: number | null;
      referencedCellCount: number;
      referencedObjectCount: number;
    }
  | {
      type: "removeTilesetFromMap";
      destructive: true;
      warning: string;
      tileset: {
        kind: "external";
        assetId: string;
        path: string;
        revision: string;
        name: string;
        nameTruncated?: true;
        tileCount: number;
        gidSpan: number;
      };
      source: string;
      index: number;
      gidRange: { first: number; last: number };
      scanned: {
        tileCells: number;
        objects: number;
      };
    }
  | {
      type: "createLayer";
      destructive: false;
      warning: string;
      layer: {
        id: number;
        type: "tilelayer" | "objectgroup" | "imagelayer" | "group";
        name: string;
      };
      parentGroupId: number | null;
      index: number;
      allocatedCellCount: number;
      image?: {
        assetId: string;
        path: string;
        source: string;
        revision: string;
        width: number;
        height: number;
      };
    }
  | UpdateTileOperationPreview
  | UpdateTilesetOperationPreview
  | {
      type: "createTileset";
      destructive: false;
      warning: string;
      tilesetPath: string;
      name: string;
      className: string | null;
      tileWidth: number;
      tileHeight: number;
      margin: number;
      spacing: number;
      columns: number;
      rows: number;
      tileCount: number;
      contentRevision: string;
      image: TilesetCreatePlan["image"];
    }
  | {
      type: "deleteFile";
      destructive: true;
      warning: string;
      targetPath: string;
      targetKind: "map" | "tileset";
      revision: string;
      size: number;
      scan: FileDeletePlan["scan"];
    }
  | {
      type: "addWorldMap";
      destructive: false;
      warning: string;
      fileName: string;
      x: number;
      y: number;
    }
  | {
      type: "moveWorldMap";
      destructive: false;
      warning: string;
      index: number;
      fileName: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | {
      type: "removeWorldMap";
      destructive: true;
      warning: string;
      index: number;
      fileName: string;
    }
  | {
      type: "addWangSet";
      destructive: false;
      warning: string;
      index: number;
      name: string;
      wangSetType: "corner" | "edge" | "mixed";
      colorCount: number;
    }
  | {
      type: "addWangColor";
      destructive: false;
      warning: string;
      wangSetIndex: number;
      colorIndex: number;
      name: string;
      color: string;
    }
  | {
      type: "setWangTiles";
      destructive: boolean;
      warning: string;
      wangSetIndex: number;
      assignmentCount: number;
      upserts: number;
      removals: number;
      noOps: number;
    }
  | {
      type: "instantiateTemplate";
      destructive: false;
      warning: string;
      layerId: number;
      templatePath: string;
      source: string;
      x: number;
      y: number;
      expectedTemplateRevision: string;
    }
  | {
      type: "upsertPropertyType";
      destructive: false;
      warning: string;
      name: string;
      typeKind: "class" | "enum";
      typeId: number;
      created: boolean;
    }
  | {
      type: "deletePropertyType";
      destructive: true;
      warning: string;
      name: string;
      typeId: number;
    }
  | {
      type: "upsertTileName";
      destructive: false;
      warning: string;
      name: string;
      tileset: string;
      localId: number;
    }
  | {
      type: "deleteTileName";
      destructive: true;
      warning: string;
      name: string;
    }
  | {
      type: "exportFile";
      destructive: false;
      warning: string;
      producer: "tiled-cli" | "native";
      sourcePath: string;
      targetPath: string;
      exportKind: "map" | "tileset" | "template";
      format: string;
      contentBytes: number;
    }
  | {
      type: "transactionMember";
      destructive: boolean;
      warning: string;
      memberChangeSetId: string;
      planKind: TransactionMemberPlanKind;
      targetKind: "replace" | "create" | "delete";
      path: string;
      expectedRevision: string | null;
    }
  | CheckpointRestoreOperationPreview
  | CheckpointPruneBatchOperationPreview
  | PreparedCheckpointCommitOperationPreview
  | PreparedCheckpointAbandonOperationPreview
  | PreparedCheckpointDiscardOperationPreview;

export class ChangeSetRegistry {
  private readonly entries = new Map<string, ChangeSetEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxPendingCellWrites = DEFAULT_MAX_PENDING_CELL_WRITES,
    private readonly maxPendingObjectShapePoints =
      DEFAULT_MAX_PENDING_OBJECT_SHAPE_POINTS,
    private readonly maxPendingTextObjectPayloadBytes =
      DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
  ) {}

  put(plan: ChangeSetPlan): ChangeSetPreview {
    this.prune();
    if (this.entries.size >= this.maxEntries) {
      throw new TiledMcpError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        "Too many pending change sets. Apply one or wait for an older preview to expire.",
        { limit: this.maxEntries },
      );
    }
    const pendingCellWrites = [...this.entries.values()].reduce(
      (total, entry) =>
        total +
        (entry.result || entry.plan.kind !== "mapEdit"
          ? 0
          : entry.plan.summary.cellWrites),
      0,
    );
    const requestedCellWrites =
      plan.kind === "mapEdit" ? plan.summary.cellWrites : 0;
    if (
      pendingCellWrites + requestedCellWrites >
      this.maxPendingCellWrites
    ) {
      throw new TiledMcpError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        "Pending change sets exceed the in-memory cell budget. Apply one or wait for expiry.",
        { limit: this.maxPendingCellWrites },
      );
    }
    const pendingObjectShapePoints = [...this.entries.values()].reduce(
      (total, entry) =>
        total +
        (entry.result
          ? 0
          : pendingObjectShapePointCount(entry.plan)),
      0,
    );
    const requestedObjectShapePoints =
      pendingObjectShapePointCount(plan);
    if (
      pendingObjectShapePoints +
        requestedObjectShapePoints >
      this.maxPendingObjectShapePoints
    ) {
      throw new TiledMcpError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        "Pending change sets exceed the in-memory object shape-point budget. Apply one or wait for expiry.",
        {
          limit: this.maxPendingObjectShapePoints,
          pendingObjectShapePoints,
          requestedObjectShapePoints,
        },
      );
    }
    const pendingTextObjectPayloadBytes =
      pendingTextObjectPayloadBytesForEntries(
        this.entries.values(),
      );
    const requestedTextObjectPayloadBytes =
      textObjectPayloadBytesForPlan(plan);
    const totalTextObjectPayloadBytes =
      addTextObjectPayloadBytes(
        pendingTextObjectPayloadBytes,
        requestedTextObjectPayloadBytes,
      );
    if (
      totalTextObjectPayloadBytes >
      this.maxPendingTextObjectPayloadBytes
    ) {
      throw new TiledMcpError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        "Pending change sets exceed the in-memory text-object payload budget. Apply one or wait for expiry.",
        {
          limit:
            this.maxPendingTextObjectPayloadBytes,
          pendingTextObjectPayloadBytes,
          requestedTextObjectPayloadBytes,
        },
      );
    }
    if (plan.kind === "transaction") {
      const pendingTransactions = [
        ...this.entries.values(),
      ].filter(
        (entry) =>
          entry.plan.kind === "transaction" &&
          entry.result === undefined,
      ).length;
      if (
        pendingTransactions >=
        MAX_PENDING_TRANSACTIONS
      ) {
        throw new TiledMcpError(
          "CHANGE_SET_LIMIT_EXCEEDED",
          `At most ${MAX_PENDING_TRANSACTIONS} transactions may be pending. Apply one or wait for expiry.`,
          { limit: MAX_PENDING_TRANSACTIONS },
        );
      }
    }
    const now = Date.now();
    const id = this.nextId();
    const entry: ChangeSetEntry = {
      id,
      plan: structuredClone(plan),
      pendingTextObjectPayloadBytes:
        requestedTextObjectPayloadBytes,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
    };
    const preview = toPreview(entry);
    this.entries.set(id, entry);
    return preview;
  }

  /**
   * Returns a clone of a pending tileset-create plan for composition:
   * `tiled_add_tileset_to_map` uses it to pre-pin an attachment on the
   * prospective TSJ content before the file exists.
   */
  getTilesetCreatePlan(
    changeSetId: string,
  ): TilesetCreatePlan {
    this.prune();
    const entry = this.entries.get(changeSetId);
    if (entry === undefined) {
      throw new TiledMcpError(
        "CHANGE_SET_NOT_FOUND",
        "The tileset-create change set is missing or expired. Preview it again.",
        { changeSetId },
      );
    }
    if (entry.plan.kind !== "tilesetCreate") {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "createChangeSetId must reference a tileset-create change set.",
        { changeSetId, kind: entry.plan.kind },
      );
    }
    return structuredClone(entry.plan);
  }

  /**
   * Builds and registers a transaction change set from already-previewed,
   * unapplied, unowned member change sets with pairwise-distinct target
   * paths, then locks each member against individual apply.
   */
  previewTransaction(
    changeSetIds: readonly string[],
  ): ChangeSetPreview {
    this.prune();
    if (
      !Array.isArray(changeSetIds) ||
      changeSetIds.length <
        MIN_TRANSACTION_MEMBERS ||
      changeSetIds.length >
        MAX_TRANSACTION_MEMBERS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `A transaction must reference between ${MIN_TRANSACTION_MEMBERS} and ${MAX_TRANSACTION_MEMBERS} member change sets.`,
        {
          min: MIN_TRANSACTION_MEMBERS,
          max: MAX_TRANSACTION_MEMBERS,
        },
      );
    }
    if (
      new Set(changeSetIds).size !==
      changeSetIds.length
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Transaction members must be distinct change sets.",
        {},
      );
    }
    const targets: TransactionPlanTarget[] = [];
    const seenPaths = new Set<string>();
    const members: ChangeSetEntry[] = [];
    for (const memberId of changeSetIds) {
      const entry = this.entries.get(memberId);
      if (entry === undefined) {
        throw new TiledMcpError(
          "CHANGE_SET_NOT_FOUND",
          "A transaction member is missing or expired. Preview it again.",
          { changeSetId: memberId },
        );
      }
      if (entry.result !== undefined) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "A transaction member has already been applied.",
          { changeSetId: memberId },
        );
      }
      if (entry.ownedBy !== undefined) {
        throw new TiledMcpError(
          "CHANGE_SET_OWNED",
          "A transaction member already belongs to another pending transaction.",
          {
            changeSetId: memberId,
            ownedBy: entry.ownedBy,
          },
        );
      }
      const target = transactionTargetForPlan(
        memberId,
        entry.plan,
      );
      if (seenPaths.has(target.path)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `Transaction members must target pairwise-distinct paths; ${target.path} appears twice.`,
          { path: target.path },
        );
      }
      seenPaths.add(target.path);
      targets.push(target);
      members.push(entry);
    }
    assertTransactionMemberCoupling(
      members.map((entry) => entry.plan),
      targets,
    );
    const baseRevision = `sha256:${createHash(
      "sha256",
    )
      .update(
        stableJson(
          targets,
        ),
      )
      .digest("hex")}`;
    const unsigned: Omit<TransactionPlan, "id"> =
      {
        kind: "transaction",
        version: 1,
        baseRevision,
        targets,
        summary: {
          memberCount: targets.length,
          targets: structuredClone(targets),
          wouldChange: true,
        },
      };
    const plan: TransactionPlan = {
      ...unsigned,
      id: transactionPlanId(unsigned),
    };
    const preview = this.put(plan);
    for (const member of members) {
      member.ownedBy = preview.changeSetId;
    }
    return preview;
  }

  /**
   * Returns the member plans of a transaction, re-verifying that each
   * member entry still exists, is unapplied, and still carries the exact
   * plan digest the transaction was signed over.
   */
  resolveTransactionMembers(
    plan: TransactionPlan,
  ): ChangeSetPlan[] {
    const members: ChangeSetPlan[] = [];
    for (const target of plan.targets) {
      const entry = this.entries.get(
        target.memberChangeSetId,
      );
      if (
        entry === undefined ||
        entry.result !== undefined
      ) {
        throw new TiledMcpError(
          "CHANGE_SET_NOT_FOUND",
          "A transaction member is missing, expired, or already applied. Preview the transaction again.",
          {
            changeSetId:
              target.memberChangeSetId,
          },
        );
      }
      if (
        entry.plan.id !== target.memberPlanDigest
      ) {
        throw new TiledMcpError(
          "CHANGE_SET_TAMPERED",
          "A transaction member no longer matches the digest the transaction was approved over.",
          {
            changeSetId:
              target.memberChangeSetId,
          },
        );
      }
      members.push(structuredClone(entry.plan));
    }
    return members;
  }

  /**
   * Marks every member of a committed transaction as applied with its
   * faithful per-target result, so member replays return the transaction's
   * outcome instead of double-committing.
   */
  completeTransactionMembers(
    plan: TransactionPlan,
    memberResults: ReadonlyMap<
      string,
      ChangeSetApplyResult
    >,
  ): void {
    for (const target of plan.targets) {
      const entry = this.entries.get(
        target.memberChangeSetId,
      );
      if (entry === undefined) {
        continue;
      }
      const result = memberResults.get(
        target.memberChangeSetId,
      );
      if (result !== undefined) {
        entry.result = result;
      }
      entry.plan = scrubAppliedPlan(entry.plan);
      entry.pendingTextObjectPayloadBytes = 0;
      delete entry.ownedBy;
    }
  }

  async apply(
    changeSetId: string,
    expectedRevision: string,
    operation: (
      plan: ChangeSetPlan,
    ) => Promise<ChangeSetOperationResult>,
  ): Promise<ChangeSetApplyResult> {
    this.prune();
    const entry = this.entries.get(changeSetId);
    if (!entry) {
      throw new TiledMcpError(
        "CHANGE_SET_NOT_FOUND",
        "The change set is missing or expired. Preview the edits again.",
        { changeSetId },
      );
    }
    if (entry.plan.baseRevision !== expectedRevision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        "expectedRevision does not match the approved change set.",
        {
          changeSetId,
          expectedRevision,
          changeSetRevision: entry.plan.baseRevision,
        },
      );
    }
    if (
      entry.ownedBy !== undefined &&
      entry.result === undefined
    ) {
      const owner = this.entries.get(
        entry.ownedBy,
      );
      if (
        owner !== undefined &&
        owner.result === undefined
      ) {
        throw new TiledMcpError(
          "CHANGE_SET_OWNED",
          "This change set belongs to a pending transaction; apply the transaction instead.",
          {
            changeSetId,
            ownedBy: entry.ownedBy,
          },
        );
      }
      delete entry.ownedBy;
    }
    if (entry.result) {
      return entry.result;
    }
    if (entry.inFlight) {
      return entry.inFlight;
    }

    const inFlight = operation(structuredClone(entry.plan))
      .then((result) => {
        const issuedResult = { ...result, changeSetId };
        entry.result = issuedResult;
        entry.plan = scrubAppliedPlan(entry.plan);
        entry.pendingTextObjectPayloadBytes = 0;
        delete entry.inFlight;
        return issuedResult;
      })
      .catch((error: unknown) => {
        delete entry.inFlight;
        throw error;
      });
    entry.inFlight = inFlight;
    return inFlight;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now && !entry.inFlight) {
        this.entries.delete(id);
      }
    }
    for (const entry of this.entries.values()) {
      if (
        entry.ownedBy !== undefined &&
        !this.entries.has(entry.ownedBy)
      ) {
        delete entry.ownedBy;
      }
    }
  }

  private nextId(): string {
    let id: string;
    do {
      id = `changeset:${randomBytes(32).toString("hex")}`;
    } while (this.entries.has(id));
    return id;
  }
}

function pendingTextObjectPayloadBytesForEntries(
  entries: Iterable<ChangeSetEntry>,
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.result) {
      continue;
    }
    total = addTextObjectPayloadBytes(
      total,
      entry.pendingTextObjectPayloadBytes,
    );
  }
  return total;
}

function textObjectPayloadBytesForPlan(
  plan: ChangeSetPlan,
): number {
  if (plan.kind !== "mapEdit") {
    return 0;
  }
  if (!Array.isArray(plan.operations)) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A map edit plan contains malformed operations while measuring text-object payloads.",
    );
  }
  let total = 0;
  for (
    let operationIndex = 0;
    operationIndex < plan.operations.length;
    operationIndex += 1
  ) {
    const operation = plan.operations[
      operationIndex
    ] as unknown;
    if (!isChangeSetRecord(operation)) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A map edit plan contains a malformed operation while measuring text-object payloads.",
        { operationIndex },
      );
    }
    let payload: Record<string, unknown> | undefined;
    if (operation.type === "createObject") {
      if (!isChangeSetRecord(operation.object)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "A createObject operation contains a malformed object draft.",
          { operationIndex },
        );
      }
      if (operation.object.shape === "text") {
        payload = operation.object;
      }
    } else if (operation.type === "updateObject") {
      if (!isChangeSetRecord(operation.patch)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "An updateObject operation contains a malformed patch.",
          { operationIndex },
        );
      }
      payload = operation.patch;
    }
    if (payload === undefined) {
      continue;
    }
    let measuredBytes: number;
    try {
      measuredBytes =
        measureTextObjectPayloadBytes(payload);
    } catch {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A map edit operation contains a malformed text-object payload.",
        {
          operationIndex,
          operationType: operation.type,
        },
      );
    }
    total = addTextObjectPayloadBytes(
      total,
      measuredBytes,
    );
  }
  return total;
}

function addTextObjectPayloadBytes(
  total: number,
  next: number,
): number {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(next) ||
    next < 0 ||
    !Number.isSafeInteger(total + next)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A map edit plan contains too many text-object payload bytes to count safely.",
    );
  }
  return total + next;
}

function pendingObjectShapePointCount(
  plan: ChangeSetPlan,
): number {
  if (plan.kind !== "mapEdit") {
    return 0;
  }
  if (!Array.isArray(plan.operations)) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A map edit plan contains malformed operations while measuring object shape points.",
    );
  }
  let total = 0;
  for (
    let operationIndex = 0;
    operationIndex < plan.operations.length;
    operationIndex += 1
  ) {
    const operation = plan.operations[
      operationIndex
    ] as unknown;
    if (!isChangeSetRecord(operation)) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A map edit plan contains a malformed operation while measuring object shape points.",
        { operationIndex },
      );
    }
    let pointPayload:
      | {
          points: unknown;
          minimumPointCount: number;
        }
      | undefined;
    if (operation.type === "createObject") {
      const object = operation.object;
      if (!isChangeSetRecord(object)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "A createObject operation contains a malformed object draft.",
          { operationIndex },
        );
      }
      const hasPoints = hasOwnChangeSetProperty(
        object,
        "points",
      );
      if (
        object.shape === "polygon" ||
        object.shape === "polyline"
      ) {
        if (!hasPoints) {
          throw invalidObjectShapePoints(
            operationIndex,
            operation.type,
          );
        }
        pointPayload = {
          points: object.points,
          minimumPointCount:
            object.shape === "polygon"
              ? MIN_POLYGON_OBJECT_POINTS
              : MIN_POLYLINE_OBJECT_POINTS,
        };
      } else if (hasPoints) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "Only polygon and polyline createObject drafts may contain shape points.",
          {
            operationIndex,
            operationType: operation.type,
            shape: object.shape,
          },
        );
      }
    } else if (
      operation.type === "updateObject"
    ) {
      const patch = operation.patch;
      if (!isChangeSetRecord(patch)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "An updateObject operation contains a malformed patch.",
          { operationIndex },
        );
      }
      if (
        hasOwnChangeSetProperty(patch, "points")
      ) {
        pointPayload = {
          points: patch.points,
          minimumPointCount:
            MIN_POLYLINE_OBJECT_POINTS,
        };
      }
    }
    if (pointPayload === undefined) {
      continue;
    }
    const pointCount = validatedObjectShapePointCount(
      pointPayload.points,
      pointPayload.minimumPointCount,
      operationIndex,
      operation.type,
    );
    const nextTotal = total + pointCount;
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Number.isSafeInteger(nextTotal)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A map edit plan contains too many object shape points to count safely.",
      );
    }
    if (
      nextTotal >
      MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        `A map edit plan may contain at most ${MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET} polygon/polyline points across create and update operations.`,
        {
          actual: nextTotal,
          limit:
            MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
        },
      );
    }
    total = nextTotal;
  }
  return total;
}

function validatedObjectShapePointCount(
  points: unknown,
  minimumPointCount: number,
  operationIndex: number,
  operationType: unknown,
): number {
  if (
    !Array.isArray(points) ||
    points.length < minimumPointCount ||
    points.length > MAX_OBJECT_SHAPE_POINTS
  ) {
    throw invalidObjectShapePoints(
      operationIndex,
      operationType,
    );
  }
  for (
    let pointIndex = 0;
    pointIndex < points.length;
    pointIndex += 1
  ) {
    const point = points[pointIndex] as unknown;
    if (
      !isChangeSetRecord(point) ||
      !hasExactKeys(point, ["x", "y"]) ||
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      Math.abs(point.x) >
        MAX_ABSOLUTE_OBJECT_SHAPE_COORDINATE ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.y) ||
      Math.abs(point.y) >
        MAX_ABSOLUTE_OBJECT_SHAPE_COORDINATE
    ) {
      throw invalidObjectShapePoints(
        operationIndex,
        operationType,
        pointIndex,
      );
    }
  }
  return points.length;
}

function invalidObjectShapePoints(
  operationIndex: number,
  operationType: unknown,
  pointIndex?: number,
): TiledMcpError {
  return new TiledMcpError(
    "INVALID_CHANGE_SET",
    "A map edit operation contains malformed shape points.",
    {
      operationIndex,
      operationType,
      ...(pointIndex === undefined
        ? {}
        : { pointIndex }),
    },
  );
}

function hasOwnChangeSetProperty(
  value: Record<string, unknown>,
  property: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    value,
    property,
  );
}

function isChangeSetRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function toPreview(entry: ChangeSetEntry): ChangeSetPreview {
  if (
    entry.plan.kind ===
      "preparedCheckpointCommit" ||
    entry.plan.kind ===
      "preparedCheckpointAbandon"
  ) {
    const plan = entry.plan;
    const common = {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      targetPath: plan.checkpoint.path,
      expectedRevision: plan.baseRevision,
      checkpoint: {
        id: plan.checkpoint.id,
        version: plan.checkpoint.version,
        status: plan.checkpoint.status,
        ...(plan.checkpoint.label === undefined
          ? {}
          : {
              label: plan.checkpoint.label,
            }),
        createdAt: plan.checkpoint.createdAt,
        path: plan.checkpoint.path,
        before: structuredClone(
          plan.checkpoint.before,
        ),
        afterRevision:
          plan.checkpoint.afterRevision,
        ...(plan.checkpoint.retention ===
        undefined
          ? {}
          : {
              retention: structuredClone(
                plan.checkpoint.retention,
              ),
            }),
      },
      manifest: {
        revision:
          plan.checkpoint.manifestRevision,
        size: plan.checkpoint.manifestSize,
      },
      target: structuredClone(
        plan.checkpoint.target,
      ),
      conflict: plan.checkpoint.conflict,
      snapshotConsistency:
        "non-atomic-read-set" as const,
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
    if (
      plan.kind ===
      "preparedCheckpointCommit"
    ) {
      return {
        ...common,
        kind: plan.kind,
        operations: [
          preparedCheckpointCommitOperationPreview(
            plan,
          ),
        ],
        summary: structuredClone(
          plan.summary,
        ),
      };
    }
    return {
      ...common,
      kind: plan.kind,
      operations: [
        preparedCheckpointAbandonOperationPreview(
          plan,
        ),
      ],
      summary: structuredClone(plan.summary),
    };
  }
  if (
    entry.plan.kind ===
    "checkpointPruneBatch"
  ) {
    const plan = entry.plan;
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      targetPaths: structuredClone(
        plan.summary.targetPaths,
      ),
      expectedRevision: plan.baseRevision,
      checkpoints: plan.checkpoints.map(
        (checkpoint) => ({
          id: checkpoint.id,
          version: checkpoint.version,
          status: checkpoint.status,
          ...(checkpoint.label === undefined
            ? {}
            : {
                label: checkpoint.label,
              }),
          createdAt: checkpoint.createdAt,
          path: checkpoint.path,
          before: structuredClone(
            checkpoint.before,
          ),
          afterRevision:
            checkpoint.afterRevision,
          ...(checkpoint.retention ===
          undefined
            ? {}
            : {
                retention: structuredClone(
                  checkpoint.retention,
                ),
              }),
          manifest: {
            revision:
              checkpoint.manifestRevision,
            size: checkpoint.manifestSize,
          },
        }),
      ),
      operations: [
        checkpointPruneBatchOperationPreview(
          plan,
        ),
      ],
      summary: structuredClone(plan.summary),
      snapshotConsistency:
        "checkpoint-store-locked-manifest-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (
    entry.plan.kind ===
    "preparedCheckpointDiscard"
  ) {
    const plan = entry.plan;
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      targetPath: plan.checkpoint.path,
      expectedRevision: plan.baseRevision,
      checkpoint: {
        id: plan.checkpoint.id,
        status: plan.checkpoint.status,
        ...(plan.checkpoint.label === undefined
          ? {}
          : {
              label: plan.checkpoint.label,
            }),
        createdAt: plan.checkpoint.createdAt,
        path: plan.checkpoint.path,
        before: structuredClone(
          plan.checkpoint.before,
        ),
        afterRevision:
          plan.checkpoint.afterRevision,
      },
      manifest: {
        revision:
          plan.checkpoint.manifestRevision,
        size: plan.checkpoint.manifestSize,
      },
      target: structuredClone(
        plan.checkpoint.target,
      ),
      eligibility:
        PREPARED_CHECKPOINT_DISCARD_ELIGIBILITY,
      operations: [
        preparedCheckpointDiscardOperationPreview(
          plan,
        ),
      ],
      summary: structuredClone(plan.summary),
      snapshotConsistency:
        "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "tilesetEdit") {
    const plan = entry.plan;
    assertTilesetEditPlan(plan);
    if (
      plan.summary.updateCount !==
        plan.updates.length ||
      plan.summary.tileUpdates.length !==
        plan.updates.length ||
      plan.summary.tileUpdates.some(
        (tileUpdate, index) =>
          tileUpdate.updateIndex !== index ||
          tileUpdate.tileId !==
            plan.updates[index]?.tileId,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The tileset edit summary does not match its updates.",
      );
    }
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      mapPath: plan.mapPath,
      tilesetPath: plan.tilesetPath,
      assetId: plan.assetId,
      expectedRevision: plan.baseRevision,
      mapRevision: plan.mapRevision,
      operations: plan.summary.tileUpdates.map(
        (tileUpdate) =>
          updateTileOperationPreview(tileUpdate),
      ),
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (
    entry.plan.kind === "tilesetPropertyEdit"
  ) {
    const plan = entry.plan;
    assertTilesetPropertyEditPlan(plan);
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      mapPath: plan.mapPath,
      tilesetPath: plan.tilesetPath,
      assetId: plan.assetId,
      expectedRevision: plan.baseRevision,
      mapRevision: plan.mapRevision,
      operations: [
        updateTilesetOperationPreview(
          plan.summary,
        ),
      ],
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "worldEdit") {
    const plan = entry.plan;
    const operations: OperationPreview[] = [];
    for (const operation of plan.operations) {
      if (operation.type === "addMap") {
        operations.push({
          type: "addWorldMap",
          destructive: false,
          warning:
            "This appends a map member to the world file; the referenced map itself is never modified.",
          fileName: operation.fileName,
          x: operation.x,
          y: operation.y,
        });
      } else if (operation.type === "moveMap") {
        const moved = plan.summary.moved.find(
          (candidate) =>
            candidate.index === operation.index,
        );
        operations.push({
          type: "moveWorldMap",
          destructive: false,
          warning:
            "This repositions one world member; the referenced map itself is never modified.",
          index: operation.index,
          fileName: moved?.fileName ?? "",
          from: moved?.from ?? {
            x: 0,
            y: 0,
          },
          to: { x: operation.x, y: operation.y },
        });
      } else {
        const removed =
          plan.summary.removed.find(
            (candidate) =>
              candidate.index === operation.index,
          );
        operations.push({
          type: "removeWorldMap",
          destructive: true,
          warning:
            "This permanently removes one member entry from the world file; the referenced map file itself is never deleted.",
          index: operation.index,
          fileName: removed?.fileName ?? "",
        });
      }
    }
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      worldPath: plan.worldPath,
      expectedRevision: plan.baseRevision,
      operations,
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "wangEdit") {
    const plan = entry.plan;
    assertWangEditPlan(plan);
    const operations: OperationPreview[] = [];
    for (const operation of plan.operations) {
      if (operation.type === "addWangSet") {
        const added =
          plan.summary.addedWangSets.find(
            (candidate) =>
              candidate.name === operation.name,
          );
        operations.push({
          type: "addWangSet",
          destructive: false,
          warning:
            "This appends a new Wang set to the tileset; existing sets, tiles, and referencing maps are never modified.",
          index: added?.index ?? -1,
          name: operation.name,
          wangSetType: operation.wangSetType,
          colorCount:
            operation.colors?.length ?? 0,
        });
      } else if (
        operation.type === "addWangColor"
      ) {
        operations.push({
          type: "addWangColor",
          destructive: false,
          warning:
            "This appends one color to an existing Wang set; wangId slots referencing lower indexes keep their meaning.",
          wangSetIndex: operation.wangSetIndex,
          colorIndex:
            plan.summary.addedColors.find(
              (candidate) =>
                candidate.wangSetIndex ===
                operation.wangSetIndex,
            )?.colorIndex ?? -1,
          name: operation.color.name,
          color: operation.color.color,
        });
      } else {
        const change =
          plan.summary.assignmentChanges.find(
            (candidate) =>
              candidate.wangSetIndex ===
              operation.wangSetIndex,
          );
        operations.push({
          type: "setWangTiles",
          destructive:
            (change?.removals ?? 0) > 0,
          warning:
            "This rewrites the Wang set's wangtiles member in Tiled's ascending-tileId save order; an all-zero wangId removes that tile's assignment.",
          wangSetIndex: operation.wangSetIndex,
          assignmentCount:
            operation.assignments.length,
          upserts: change?.upserts ?? 0,
          removals: change?.removals ?? 0,
          noOps: change?.noOps ?? 0,
        });
      }
    }
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      mapPath: plan.mapPath,
      tilesetPath: plan.tilesetPath,
      assetId: plan.assetId,
      expectedRevision: plan.baseRevision,
      mapRevision: plan.mapRevision,
      operations,
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "embeddedTilesetEdit") {
    const plan = entry.plan;
    assertEmbeddedTilesetEditPlan(plan);
    if (
      plan.summary.updateCount !==
        plan.updates.length ||
      plan.summary.tileUpdates.length !==
        plan.updates.length ||
      plan.summary.tileUpdates.some(
        (tileUpdate, index) =>
          tileUpdate.updateIndex !== index ||
          tileUpdate.tileId !==
            plan.updates[index]?.tileId,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The embedded tileset edit summary does not match its updates.",
      );
    }
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      mapPath: plan.mapPath,
      embeddedIndex: plan.embeddedIndex,
      expectedRevision: plan.baseRevision,
      operations: plan.summary.tileUpdates.map(
        (tileUpdate) =>
          updateTileOperationPreview(tileUpdate),
      ),
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "propertyTypeEdit") {
    const plan = entry.plan;
    assertPropertyTypeEditPlan(plan);
    const operations: OperationPreview[] = [];
    for (const upsert of plan.summary.upserted) {
      operations.push({
        type: "upsertPropertyType",
        destructive: false,
        warning:
          "This rewrites the project file's propertyTypes member; existing maps and tilesets referencing the type keep their serialized values unchanged.",
        name: upsert.name,
        typeKind: upsert.kind,
        typeId: upsert.id,
        created: upsert.created,
      });
    }
    for (const removal of plan.summary.deleted) {
      operations.push({
        type: "deletePropertyType",
        destructive: true,
        warning:
          "This permanently removes one project type definition; serialized values referencing it in maps and tilesets are not scanned and will lose their annotations.",
        name: removal.name,
        typeId: removal.id,
      });
    }
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      projectFilePath: plan.projectFilePath,
      expectedRevision: plan.baseRevision,
      operations,
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "tileNameEdit") {
    const plan = entry.plan;
    assertTileNameEditPlan(plan);
    const operations: OperationPreview[] =
      plan.operations.map((operation) =>
        operation.type === "upsertName"
          ? {
              type: "upsertTileName" as const,
              destructive: false,
              warning:
                "This rewrites the server-owned .tiledmcp/tile-names.json registry; no Tiled asset is touched.",
              name: operation.name,
              tileset: operation.tileset,
              localId: operation.localId,
            }
          : {
              type: "deleteTileName" as const,
              destructive: true,
              warning:
                "This removes one semantic name from the server-owned registry; the mapping is not recoverable from Tiled assets.",
              name: operation.name,
            },
      );
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      registryRevision: plan.registryRevision,
      expectedRevision: plan.baseRevision,
      operations,
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "fileExport") {
    const plan = entry.plan;
    assertFileExportPlan(plan);
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      sourcePath: plan.sourcePath,
      sourceRevision: plan.sourceRevision,
      targetPath: plan.targetPath,
      expectedRevision: plan.baseRevision,
      operations: [
        {
          type: "exportFile",
          destructive: false,
          warning:
            plan.producer === "native"
              ? NATIVE_TMX_WARNING
              : FILE_EXPORT_WARNING,
          producer: plan.producer,
          sourcePath: plan.sourcePath,
          targetPath: plan.targetPath,
          exportKind: plan.exportKind,
          format: plan.format,
          contentBytes:
            plan.summary.contentBytes,
        },
      ],
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "transaction") {
    const plan = entry.plan;
    const { id: planDigestId, ...unsigned } =
      plan;
    if (
      planDigestId !== transactionPlanId(unsigned)
    ) {
      throw new TiledMcpError(
        "CHANGE_SET_TAMPERED",
        "The transaction plan contents do not match its digest. Preview the transaction again.",
      );
    }
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      expectedRevision: plan.baseRevision,
      operations: plan.targets.map((target) => ({
        type: "transactionMember" as const,
        destructive:
          target.targetKind === "delete",
        warning: TRANSACTION_WARNING,
        memberChangeSetId:
          target.memberChangeSetId,
        planKind: target.planKind,
        targetKind: target.targetKind,
        path: target.path,
        expectedRevision:
          target.expectedRevision,
      })),
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "fileDelete") {
    const plan = entry.plan;
    assertFileDeletePlan(plan);
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      targetPath: plan.targetPath,
      expectedRevision: plan.baseRevision,
      operations: [
        {
          type: "deleteFile",
          destructive: true,
          warning: DELETE_FILE_WARNING,
          targetPath: plan.targetPath,
          targetKind: plan.targetKind,
          revision: plan.baseRevision,
          size: plan.size,
          scan: structuredClone(plan.scan),
        },
      ],
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }
  if (entry.plan.kind === "tilesetCreate") {
    const plan = entry.plan;
    assertTilesetCreatePlan(plan);
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      tilesetPath: plan.tilesetPath,
      expectedRevision: plan.baseRevision,
      image: structuredClone(plan.image),
      operations: [
        {
          type: "createTileset",
          destructive: false,
          warning: CREATE_TILESET_WARNING,
          tilesetPath: plan.tilesetPath,
          name: plan.name,
          className: plan.className,
          tileWidth: plan.tileWidth,
          tileHeight: plan.tileHeight,
          margin: plan.margin,
          spacing: plan.spacing,
          columns: plan.summary.columns,
          rows: plan.summary.rows,
          tileCount: plan.summary.tileCount,
          contentRevision: plan.baseRevision,
          image: structuredClone(plan.image),
        },
      ],
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(
        entry.expiresAt,
      ).toISOString(),
    };
  }

  if (entry.plan.kind === "checkpointRestore") {
    const plan = entry.plan;
    return {
      kind: plan.kind,
      changeSetId: entry.id,
      planDigest: plan.id,
      targetPath: plan.targetPath,
      expectedRevision: plan.baseRevision,
      checkpoint: {
        id: plan.checkpoint.id,
        status: plan.checkpoint.status,
        label: plan.checkpoint.label,
        createdAt: plan.checkpoint.createdAt,
        afterRevision: plan.checkpoint.afterRevision,
      },
      restore: {
        revision: plan.restoreRevision,
        size: plan.restoreSize,
        exactBytes: true,
        wouldChange: plan.wouldChange,
      },
      operations: [checkpointRestoreOperationPreview(plan)],
      summary: structuredClone(plan.summary),
      snapshotConsistency: "non-atomic-read-set",
      createdAt: entry.createdAt,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }
  const plan = entry.plan;
  assertMapUpdateSummaryCoverage(plan);
  assertMapResizeSummaryCoverage(plan);
  assertRemoveTilesetSummaryCoverage(plan);
  assertCopyRegionSummaryCoverage(plan);
  const operations = plan.operations.map(
    (operation, operationIndex) =>
      summarizeOperation(
        operation,
        operationIndex,
        plan.summary,
      ),
  );
  assertMapEditPlanDigest(plan);
  return {
    kind: plan.kind,
    changeSetId: entry.id,
    planDigest: plan.id,
    mapPath: plan.mapPath,
    expectedRevision: plan.baseRevision,
    dependencyRevisions: structuredClone(
      plan.dependencyRevisions,
    ),
    ...(plan.prospectiveDependencyRevisions === undefined
      ? {}
      : {
          prospectiveDependencyRevisions:
            structuredClone(
              plan.prospectiveDependencyRevisions,
            ),
        }),
    operations,
    summary: structuredClone(plan.summary),
    snapshotConsistency: "non-atomic-read-set",
    createdAt: entry.createdAt,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

function assertMapEditPlanDigest(
  plan: MapEditPlan,
): void {
  const { id, ...unsignedPlan } = plan;
  const expectedId =
    `changeset:${createHash("sha256")
      .update(
        stableJson(
          unsignedPlan,
        ),
      )
      .digest("hex")}`;
  if (id !== expectedId) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The map edit plan contents do not match its digest.",
      { suppliedId: id, expectedId },
    );
  }
}

function assertMapUpdateSummaryCoverage(
  plan: MapEditPlan,
): void {
  const operationIndexes = plan.operations.flatMap(
    (operation, operationIndex) =>
      operation.type === "updateMap"
        ? [operationIndex]
        : [],
  );
  const summaries = plan.summary.mapUpdates;
  if (operationIndexes.length === 0) {
    if (summaries === undefined) {
      return;
    }
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "updateMap summaries do not match the updateMap operations.",
    );
  }
  if (
    !Array.isArray(summaries) ||
    summaries.length !== operationIndexes.length ||
    summaries.some(
      (summary, index) =>
        !isMapUpdateSummaryShape(
          summary,
          operationIndexes[index],
        ),
    )
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "updateMap summaries do not match the updateMap operations.",
    );
  }
}

function assertMapResizeSummaryCoverage(
  plan: MapEditPlan,
): void {
  const operationIndexes = plan.operations.flatMap(
    (operation, operationIndex) =>
      operation.type === "resizeMap"
        ? [operationIndex]
        : [],
  );
  const summaries = plan.summary.mapResizes;
  if (operationIndexes.length === 0) {
    if (summaries === undefined) {
      return;
    }
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "resizeMap summaries do not match the resizeMap operations.",
    );
  }
  if (
    operationIndexes.length !== 1 ||
    plan.operations.length !== 1 ||
    !Array.isArray(summaries) ||
    summaries.length !== operationIndexes.length ||
    summaries.some(
      (summary, index) =>
        !isMapResizeSummaryShape(
          summary,
          operationIndexes[index],
        ),
    ) ||
    plan.summary.cellWrites !==
      summaries.reduce(
        (total, summary) =>
          total + summary.rewrittenCellCount,
        0,
      )
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "resizeMap summaries do not match the resizeMap operations.",
    );
  }
}

function assertRemoveTilesetSummaryCoverage(
  plan: MapEditPlan,
): void {
  const operationIndexes = plan.operations.flatMap(
    (operation, operationIndex) =>
      operation.type === "removeTilesetFromMap"
        ? [operationIndex]
        : [],
  );
  const summaries =
    plan.summary.removedTilesets;
  if (operationIndexes.length === 0) {
    if (summaries === undefined) {
      return;
    }
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "removeTilesetFromMap summaries do not match the operations.",
    );
  }
  if (
    operationIndexes.length !== 1 ||
    plan.operations.length !== 1 ||
    !Array.isArray(summaries) ||
    summaries.length !==
      operationIndexes.length ||
    summaries.some(
      (summary, index) =>
        !isRemovedTilesetSummaryShape(
          summary,
          operationIndexes[index],
        ) ||
        plan.dependencyRevisions[
          summary.assetId
        ] !== summary.tilesetRevision,
    )
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "removeTilesetFromMap summaries do not match the operations.",
    );
  }
}

function assertCopyRegionSummaryCoverage(
  plan: MapEditPlan,
): void {
  const operationIndexes = plan.operations.flatMap(
    (operation, operationIndex) =>
      operation.type === "copyRegion"
        ? [operationIndex]
        : [],
  );
  const summaries = plan.summary.tileCopies;
  if (operationIndexes.length === 0) {
    if (summaries === undefined) {
      return;
    }
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "copyRegion summaries do not match the copyRegion operations.",
    );
  }
  if (
    !Array.isArray(summaries) ||
    summaries.length !== operationIndexes.length ||
    summaries.some(
      (summary, index) =>
        !isCopyRegionSummaryShape(
          summary,
          operationIndexes[index],
        ),
    )
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "copyRegion summaries do not match the copyRegion operations.",
    );
  }
  const copyCellWrites = summaries.reduce(
    (total, summary) =>
      total + summary.cellCount,
    0,
  );
  const copyScans = summaries.reduce(
    (total, summary) =>
      total + summary.scannedCellCount,
    0,
  );
  const replacementScans =
    sumSummaryScanCounts(
      plan.summary.tileReplacements,
    );
  const floodFillScans = sumSummaryScanCounts(
    plan.summary.tileFloodFills,
  );
  if (
    !Number.isSafeInteger(
      plan.summary.cellWrites,
    ) ||
    plan.summary.cellWrites < copyCellWrites ||
    plan.summary.cellWrites > MAX_CELL_WRITES ||
    !Number.isSafeInteger(copyScans) ||
    replacementScans === undefined ||
    floodFillScans === undefined ||
    !Number.isSafeInteger(
      copyScans +
        replacementScans +
        floodFillScans,
    ) ||
    copyScans +
        replacementScans +
        floodFillScans >
      MAX_TILE_OPERATION_SCANS
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "copyRegion summaries do not match the shared tile-operation accounting.",
    );
  }
}

function sumSummaryScanCounts(
  summaries:
    | ReadonlyArray<{ scannedCellCount: number }>
    | undefined,
): number | undefined {
  if (summaries === undefined) {
    return 0;
  }
  if (!Array.isArray(summaries)) {
    return undefined;
  }
  let total = 0;
  for (const summary of summaries) {
    if (
      typeof summary !== "object" ||
      summary === null ||
      !Number.isSafeInteger(
        summary.scannedCellCount,
      ) ||
      summary.scannedCellCount < 0 ||
      !Number.isSafeInteger(
        total + summary.scannedCellCount,
      )
    ) {
      return undefined;
    }
    total += summary.scannedCellCount;
  }
  return total;
}

function scrubAppliedPlan(plan: ChangeSetPlan): ChangeSetPlan {
  if (plan.kind === "mapEdit") {
    return { ...plan, operations: [] };
  }
  if (plan.kind === "tilesetEdit") {
    return { ...plan, updates: [] };
  }
  if (plan.kind === "worldEdit") {
    return { ...plan, operations: [] };
  }
  if (plan.kind === "wangEdit") {
    return { ...plan, operations: [] };
  }
  if (plan.kind === "embeddedTilesetEdit") {
    return { ...plan, updates: [] };
  }
  if (plan.kind === "propertyTypeEdit") {
    return { ...plan, operations: [] };
  }
  if (plan.kind === "tileNameEdit") {
    return { ...plan, operations: [] };
  }
  return plan;
}

function summarizeOperation(
  operation: PlannedMapEditOperation,
  operationIndex: number,
  summary: MapEditPlan["summary"],
): OperationPreview {
  if (operation.type === "addTilesetToMap") {
    return {
      type: operation.type,
      destructive: false,
      warning:
        "This adds a new external tileset dependency without rewriting existing firstgid values or tile data.",
      tileset: {
        kind: "external",
        assetId: operation.assetId,
        path: operation.tilesetPath,
        revision: operation.tilesetRevision,
        tileCount: operation.tileCount,
        gidSpan: operation.gidSpan,
      },
      source: operation.source,
      assignedFirstGid: operation.firstGid,
      gidRange: {
        first: operation.firstGid,
        last: operation.firstGid + operation.gidSpan - 1,
      },
    };
  }

  if (
    operation.type ===
    "removeTilesetFromMap"
  ) {
    if (
      !hasExactKeys(
        operation,
        ["tilesetAssetId", "type"],
      ) ||
      typeof operation.tilesetAssetId !==
        "string" ||
      !ASSET_ID_PATTERN.test(
        operation.tilesetAssetId,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "removeTilesetFromMap preview contains an invalid operation.",
        { operationIndex },
      );
    }
    const removalSummaries =
      summary.removedTilesets?.filter(
        (entry) =>
          entry.operationIndex ===
          operationIndex,
      ) ?? [];
    const removal = removalSummaries[0];
    if (
      removalSummaries.length !== 1 ||
      !isRemovedTilesetSummaryShape(
        removal,
        operationIndex,
      ) ||
      removal.assetId !==
        operation.tilesetAssetId
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "removeTilesetFromMap preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      destructive: true,
      warning:
        "This removes one unused external tileset reference from the map. It does not delete or modify the TSJ or image, does not renumber remaining firstgid values, and is allowed only after a full zero-reference scan.",
      tileset: {
        kind: "external",
        assetId: removal.assetId,
        path: removal.tilesetPath,
        revision:
          removal.tilesetRevision,
        name: removal.name,
        ...(removal.nameTruncated
          ? { nameTruncated: true as const }
          : {}),
        tileCount: removal.tileCount,
        gidSpan: removal.gidSpan,
      },
      source: removal.source,
      index: removal.index,
      gidRange: {
        first: removal.firstGid,
        last: removal.lastGid,
      },
      scanned: {
        tileCells:
          removal.scannedCellCount,
        objects:
          removal.scannedObjectCount,
      },
    };
  }

  if (operation.type === "createLayer") {
    return {
      type: operation.type,
      destructive: false,
      warning:
        "This inserts one empty layer and advances nextlayerid without modifying existing layer contents.",
      layer: {
        id: operation.layerId,
        type: operation.layerType,
        name: operation.name,
      },
      parentGroupId: operation.parentGroupId,
      index: operation.index,
      allocatedCellCount: operation.allocatedCellCount,
      ...(operation.image === undefined
        ? {}
        : { image: structuredClone(operation.image) }),
    };
  }

  if (operation.type === "updateMap") {
    if (!isValidMapUpdatePatch(operation.patch)) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "updateMap preview contains an invalid patch.",
        { operationIndex },
      );
    }
    const patch = operation.patch;
    const requestedFields = MAP_UPDATE_FIELDS.filter(
      (field) =>
        Object.prototype.hasOwnProperty.call(
          patch,
          field,
        ),
    );
    const updateSummaries =
      summary.mapUpdates?.filter(
        (entry) =>
          entry.operationIndex === operationIndex,
      ) ?? [];
    const updateSummary = updateSummaries[0];
    const expectedChangedFields =
      MAP_UPDATE_FIELDS.filter((field) =>
        updateSummary?.changedFields.includes(field),
      );
    if (
      updateSummaries.length !== 1 ||
      updateSummary === undefined ||
      !hasExactKeys(
        updateSummary,
        [
          "operationIndex",
          "requestedFields",
          "changedFields",
          "wouldChange",
          "renderingMayChange",
        ],
      ) ||
      !arraysEqual(
        updateSummary.requestedFields,
        requestedFields,
      ) ||
      !arraysEqual(
        updateSummary.changedFields,
        expectedChangedFields,
      ) ||
      updateSummary.changedFields.some(
        (field) => !requestedFields.includes(
          field as (typeof MAP_UPDATE_FIELDS)[number],
        ),
      ) ||
      updateSummary.wouldChange !==
        (updateSummary.changedFields.length > 0) ||
      updateSummary.renderingMayChange !==
        updateSummary.changedFields.some((field) =>
          MAP_RENDER_UPDATE_FIELDS.has(field),
        )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "updateMap preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      destructive: false,
      warning: updateSummary.renderingMayChange
        ? "This updates root map properties and may change tile render order or the rendered background; unrelated root members and layer contents are preserved."
        : updateSummary.wouldChange
          ? "This updates only root map metadata and preserves unrelated root members and layer contents."
          : "The requested root map properties already have the exact serialized values.",
      patch: structuredClone(patch),
      requestedFields: structuredClone(
        updateSummary.requestedFields,
      ),
      changedFields: structuredClone(
        updateSummary.changedFields,
      ),
      wouldChange: updateSummary.wouldChange,
      renderingMayChange:
        updateSummary.renderingMayChange,
    };
  }

  if (operation.type === "resizeMap") {
    const operationRecord =
      operation;
    const allowedKeys = new Set([
      "height",
      "offsetX",
      "offsetY",
      "type",
      "width",
    ]);
    if (
      Object.keys(operationRecord).some(
        (key) => !allowedKeys.has(key),
      ) ||
      !Number.isSafeInteger(operation.width) ||
      operation.width < 1 ||
      operation.width > MAX_RESIZE_MAP_DIMENSION ||
      !Number.isSafeInteger(operation.height) ||
      operation.height < 1 ||
      operation.height > MAX_RESIZE_MAP_DIMENSION ||
      (operation.offsetX !== undefined &&
        (!Number.isSafeInteger(operation.offsetX) ||
          Math.abs(operation.offsetX) >
            MAX_RESIZE_OFFSET_MAGNITUDE)) ||
      (operation.offsetY !== undefined &&
        (!Number.isSafeInteger(operation.offsetY) ||
          Math.abs(operation.offsetY) >
            MAX_RESIZE_OFFSET_MAGNITUDE))
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "resizeMap preview contains an invalid operation.",
        { operationIndex },
      );
    }
    const resizeSummaries =
      summary.mapResizes?.filter(
        (entry) =>
          entry.operationIndex === operationIndex,
      ) ?? [];
    const resize = resizeSummaries[0];
    if (
      resizeSummaries.length !== 1 ||
      !isMapResizeSummaryShape(
        resize,
        operationIndex,
      ) ||
      resize.newWidth !== operation.width ||
      resize.newHeight !== operation.height ||
      resize.offsetX !== (operation.offsetX ?? 0) ||
      resize.offsetY !== (operation.offsetY ?? 0)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "resizeMap preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      destructive: true,
      warning:
        resize.croppedNonEmptyCellCount > 0
          ? `This rewrites every tile layer to the new map bounds and permanently drops ${resize.croppedNonEmptyCellCount} non-empty tile cell(s) outside the new bounds. Objects are shifted but never deleted; out-of-bounds objects are preserved.`
          : "This rewrites every tile layer to the new map bounds without dropping any non-empty tile cells. Objects are shifted but never deleted; out-of-bounds objects are preserved.",
      oldBounds: {
        width: resize.oldWidth,
        height: resize.oldHeight,
      },
      newBounds: {
        width: resize.newWidth,
        height: resize.newHeight,
      },
      offset: {
        x: resize.offsetX,
        y: resize.offsetY,
      },
      pixelOffset: {
        x: resize.pixelOffsetX,
        y: resize.pixelOffsetY,
      },
      wouldChange: resize.wouldChange,
      mapDimensionsChanged:
        resize.mapDimensionsChanged,
      tileLayerCount: resize.tileLayerCount,
      resizedTileLayerIds: structuredClone(
        resize.resizedTileLayerIds,
      ),
      scannedCellCount: resize.scannedCellCount,
      rewrittenCellCount: resize.rewrittenCellCount,
      preservedNonEmptyCellCount:
        resize.preservedNonEmptyCellCount,
      croppedNonEmptyCellCount:
        resize.croppedNonEmptyCellCount,
      croppedCellSample: structuredClone(
        resize.croppedCellSample,
      ),
      omittedCroppedCellCount:
        resize.omittedCroppedCellCount,
      objectLayerCount: resize.objectLayerCount,
      movedObjectCount: resize.movedObjectCount,
      objectsOutsideNewBounds:
        resize.objectsOutsideNewBounds,
      imageLayerCount: resize.imageLayerCount,
      shiftedImageLayerIds: structuredClone(
        resize.shiftedImageLayerIds,
      ),
      groupLayerCount: resize.groupLayerCount,
      lockedLayerCount: resize.lockedLayerCount,
    };
  }

  if (operation.type === "fillRegion") {
    return {
      type: operation.type,
      layerId: operation.layerId,
      region: {
        x: operation.x,
        y: operation.y,
        width: operation.width,
        height: operation.height,
      },
      tile: structuredClone(operation.tile),
    };
  }

  if (operation.type === "stampPattern") {
    const height = operation.pattern.length;
    const width = operation.pattern[0]?.length ?? 0;
    if (
      height === 0 ||
      width === 0 ||
      operation.pattern.some(
        (row) => row.length !== width,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "stampPattern preview requires a non-empty rectangular pattern.",
        { operationIndex },
      );
    }
    const cellCount = width * height;
    let nonEmptyCellCount = 0;
    let transformedCellCount = 0;
    const sample: Array<{
      x: number;
      y: number;
      tile: TileRef | null;
    }> = [];
    for (
      let rowIndex = 0;
      rowIndex < height;
      rowIndex += 1
    ) {
      const row = operation.pattern[rowIndex];
      if (row === undefined) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "stampPattern preview encountered a missing row.",
          { operationIndex, rowIndex },
        );
      }
      for (
        let columnIndex = 0;
        columnIndex < width;
        columnIndex += 1
      ) {
        const tile = row[columnIndex];
        if (tile === undefined) {
          throw new TiledMcpError(
            "INVALID_CHANGE_SET",
            "stampPattern preview encountered a missing cell.",
            {
              operationIndex,
              rowIndex,
              columnIndex,
            },
          );
        }
        if (tile !== null) {
          nonEmptyCellCount += 1;
          const transform = tile.transform;
          if (
            transform !== undefined &&
            (transform.flipH === true ||
              transform.flipV === true ||
              ("flipD" in transform &&
                transform.flipD === true) ||
              (transform.rawFlags ?? 0) !== 0)
          ) {
            transformedCellCount += 1;
          }
        }
        if (sample.length < 8) {
          sample.push({
            x: operation.x + columnIndex,
            y: operation.y + rowIndex,
            tile: structuredClone(tile),
          });
        }
      }
    }
    const stampSummary = summary.tileStamps?.find(
      (entry) => entry.operationIndex === operationIndex,
    );
    const clearCellCount =
      cellCount - nonEmptyCellCount;
    if (
      stampSummary === undefined ||
      stampSummary.layerId !== operation.layerId ||
      stampSummary.region.x !== operation.x ||
      stampSummary.region.y !== operation.y ||
      stampSummary.region.width !== width ||
      stampSummary.region.height !== height ||
      stampSummary.cellCount !== cellCount ||
      stampSummary.nonEmptyCellCount !==
        nonEmptyCellCount ||
      stampSummary.clearCellCount !== clearCellCount ||
      stampSummary.transformedCellCount !==
        transformedCellCount ||
      !Number.isSafeInteger(
        stampSummary.changedCellCount,
      ) ||
      stampSummary.changedCellCount < 0 ||
      stampSummary.changedCellCount > cellCount ||
      stampSummary.wouldChange !==
        (stampSummary.changedCellCount > 0)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "stampPattern preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      layerId: operation.layerId,
      destructive: true,
      warning:
        "This overwrites every target cell in row-major order; null explicitly clears a cell, clipping is not performed, and later operations in the change set win on overlap.",
      region: structuredClone(stampSummary.region),
      cellCount: stampSummary.cellCount,
      nonEmptyCellCount:
        stampSummary.nonEmptyCellCount,
      clearCellCount: stampSummary.clearCellCount,
      transformedCellCount:
        stampSummary.transformedCellCount,
      changedCellCount:
        stampSummary.changedCellCount,
      wouldChange: stampSummary.wouldChange,
      sample,
      omittedCellCount: cellCount - sample.length,
    };
  }

  if (operation.type === "floodFill") {
    const floodSummaries =
      summary.tileFloodFills?.filter(
        (entry) =>
          entry.operationIndex === operationIndex,
      ) ?? [];
    const floodSummary = floodSummaries[0];
    const seed = floodSummary?.seed;
    const bounds = floodSummary?.affectedBounds;
    const boundsArea =
      bounds === null || bounds === undefined
        ? null
        : bounds.width * bounds.height;
    const validBounds =
      bounds === null ||
      (bounds !== undefined &&
        Number.isSafeInteger(bounds.x) &&
        Number.isSafeInteger(bounds.y) &&
        Number.isSafeInteger(bounds.width) &&
        Number.isSafeInteger(bounds.height) &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        Number.isSafeInteger(boundsArea) &&
        Number.isSafeInteger(
          bounds.x + bounds.width - 1,
        ) &&
        Number.isSafeInteger(
          bounds.y + bounds.height - 1,
        ));
    const boundsContainSeed =
      bounds === null ||
      (bounds !== undefined &&
        operation.x >= bounds.x &&
        operation.x < bounds.x + bounds.width &&
        operation.y >= bounds.y &&
        operation.y < bounds.y + bounds.height);
    if (
      floodSummaries.length !== 1 ||
      floodSummary === undefined ||
      seed === undefined ||
      !Number.isSafeInteger(seed.x) ||
      !Number.isSafeInteger(seed.y) ||
      !Number.isSafeInteger(
        floodSummary.layerId,
      ) ||
      floodSummary.layerId <= 0 ||
      floodSummary.layerId !== operation.layerId ||
      seed.x !== operation.x ||
      seed.y !== operation.y ||
      floodSummary.connectivity !== "four-way" ||
      !isCanonicalPreviewTileRef(
        floodSummary.sourceTile,
      ) ||
      !isCanonicalPreviewTileRef(
        floodSummary.targetTile,
      ) ||
      !previewTileRefsEqual(
        floodSummary.targetTile,
        operation.tile,
      ) ||
      floodSummary.wouldChange !==
        !previewTileRefsEqual(
          floodSummary.sourceTile,
          floodSummary.targetTile,
        ) ||
      !Number.isSafeInteger(
        floodSummary.scannedCellCount,
      ) ||
      floodSummary.scannedCellCount < 1 ||
      floodSummary.scannedCellCount >
        MAX_TILE_OPERATION_SCANS ||
      !Number.isSafeInteger(
        floodSummary.changedCellCount,
      ) ||
      floodSummary.changedCellCount < 0 ||
      floodSummary.changedCellCount >
        floodSummary.scannedCellCount ||
      !validBounds ||
      !boundsContainSeed ||
      (boundsArea !== null &&
        boundsArea <
          floodSummary.changedCellCount) ||
      floodSummary.wouldChange !==
        (floodSummary.changedCellCount > 0) ||
      (!floodSummary.wouldChange &&
        floodSummary.scannedCellCount !== 1) ||
      (floodSummary.wouldChange
        ? floodSummary.affectedBounds === null
        : floodSummary.affectedBounds !== null)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "floodFill preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      layerId: operation.layerId,
      destructive: true,
      warning:
        "This scans from the seed with fixed four-way connectivity and exact encoded GID equality, including transform flags; null clears the connected region, and later operations in the change set observe this result.",
      seed: structuredClone(floodSummary.seed),
      connectivity: floodSummary.connectivity,
      sourceTile: structuredClone(
        floodSummary.sourceTile,
      ),
      targetTile: structuredClone(
        floodSummary.targetTile,
      ),
      scannedCellCount:
        floodSummary.scannedCellCount,
      changedCellCount:
        floodSummary.changedCellCount,
      affectedBounds: structuredClone(
        floodSummary.affectedBounds,
      ),
      wouldChange: floodSummary.wouldChange,
    };
  }

  if (operation.type === "copyRegion") {
    const source = operation.source;
    const destination = operation.destination;
    const validOperation =
      hasExactKeys(
        operation,
        ["type", "source", "destination"],
      ) &&
      typeof source === "object" &&
      source !== null &&
      !Array.isArray(source) &&
      hasExactKeys(
        source,
        [
          "layerId",
          "x",
          "y",
          "width",
          "height",
        ],
      ) &&
      typeof destination === "object" &&
      destination !== null &&
      !Array.isArray(destination) &&
      hasExactKeys(
        destination,
        ["layerId", "x", "y"],
      ) &&
      Number.isSafeInteger(source.layerId) &&
      source.layerId > 0 &&
      Number.isSafeInteger(source.x) &&
      Number.isSafeInteger(source.y) &&
      Number.isSafeInteger(source.width) &&
      source.width > 0 &&
      Number.isSafeInteger(source.height) &&
      source.height > 0 &&
      Number.isSafeInteger(destination.layerId) &&
      destination.layerId > 0 &&
      Number.isSafeInteger(destination.x) &&
      Number.isSafeInteger(destination.y) &&
      Number.isSafeInteger(
        source.x + source.width,
      ) &&
      Number.isSafeInteger(
        source.y + source.height,
      ) &&
      Number.isSafeInteger(
        destination.x + source.width,
      ) &&
      Number.isSafeInteger(
        destination.y + source.height,
      );
    const copySummaries =
      summary.tileCopies?.filter(
        (entry) =>
          entry.operationIndex === operationIndex,
      ) ?? [];
    const copySummary = copySummaries[0];
    const expectedOverlap =
      validOperation &&
      source.layerId === destination.layerId &&
      source.x <
        destination.x + source.width &&
      destination.x <
        source.x + source.width &&
      source.y <
        destination.y + source.height &&
      destination.y <
        source.y + source.height;
    if (
      !validOperation ||
      copySummaries.length !== 1 ||
      !isCopyRegionSummaryShape(
        copySummary,
        operationIndex,
      ) ||
      copySummary.source.layerId !==
        source.layerId ||
      copySummary.source.x !== source.x ||
      copySummary.source.y !== source.y ||
      copySummary.source.width !== source.width ||
      copySummary.source.height !==
        source.height ||
      copySummary.destination.layerId !==
        destination.layerId ||
      copySummary.destination.x !==
        destination.x ||
      copySummary.destination.y !==
        destination.y ||
      copySummary.destination.width !==
        source.width ||
      copySummary.destination.height !==
        source.height ||
      copySummary.overlapsSource !==
        expectedOverlap
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "copyRegion preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      destructive: true,
      warning:
        "This snapshots the complete source and destination regions before writing, then overwrites every destination cell with the exact encoded source GID; zero clears a destination cell, clipping is not performed, and later operations observe this result.",
      source: structuredClone(copySummary.source),
      destination: structuredClone(
        copySummary.destination,
      ),
      scannedCellCount:
        copySummary.scannedCellCount,
      cellCount: copySummary.cellCount,
      sourceNonEmptyCellCount:
        copySummary.sourceNonEmptyCellCount,
      changedCellCount:
        copySummary.changedCellCount,
      overwrittenNonEmptyCellCount:
        copySummary.overwrittenNonEmptyCellCount,
      clearedCellCount:
        copySummary.clearedCellCount,
      overlapsSource: copySummary.overlapsSource,
      wouldChange: copySummary.wouldChange,
    };
  }

  if (operation.type === "replaceTiles") {
    const replacementSummary = summary.tileReplacements?.find(
      (entry) => entry.operationIndex === operationIndex,
    );
    if (
      replacementSummary === undefined ||
      replacementSummary.layerId !== operation.layerId ||
      replacementSummary.mappingCount !== operation.mappings.length
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "replaceTiles preview summary does not match its operation.",
        { operationIndex },
      );
    }
    const mappingSample = operation.mappings.slice(0, 8);
    return {
      type: operation.type,
      layerId: operation.layerId,
      destructive: true,
      warning:
        "This replaces exact encoded tile values, including transform flags; mappings are evaluated simultaneously.",
      region: structuredClone(replacementSummary.region),
      scannedCellCount: replacementSummary.scannedCellCount,
      replacedCellCount: replacementSummary.replacedCellCount,
      mappingCount: replacementSummary.mappingCount,
      mappingSample: structuredClone(mappingSample),
      omittedMappingCount:
        operation.mappings.length - mappingSample.length,
    };
  }

  if (operation.type === "createObject") {
    return {
      type: operation.type,
      layerId: operation.layerId,
      shape: operation.object.shape,
      object: structuredClone(operation.object),
    };
  }

  if (operation.type === "updateObject") {
    return {
      type: operation.type,
      objectId: operation.objectId,
      changedFields: Object.keys(operation.patch).sort(),
      patch: structuredClone(operation.patch),
    };
  }

  if (operation.type === "updateLayer") {
    const updateSummary = summary.layerUpdates?.find(
      (entry) => entry.operationIndex === operationIndex,
    );
    const requestedFields = Object.keys(
      operation.patch,
    ).sort();
    if (
      updateSummary === undefined ||
      updateSummary.layerId !== operation.layerId ||
      [...updateSummary.requestedFields].sort().join("\0") !==
        requestedFields.join("\0")
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "updateLayer preview summary does not match its operation.",
        { operationIndex },
      );
    }
    return {
      type: operation.type,
      layerId: operation.layerId,
      layerType: updateSummary.layerType,
      destructive: false,
      warning:
        updateSummary.affectsDescendants
          ? "Group layer properties may affect descendant rendering; locked is advisory metadata and does not block MCP edits."
          : "This updates only common layer properties; locked is advisory metadata and does not block MCP edits.",
      patch: structuredClone(operation.patch),
      requestedFields: structuredClone(
        updateSummary.requestedFields,
      ),
      changedFields: structuredClone(
        updateSummary.changedFields,
      ),
      wouldChange: updateSummary.wouldChange,
      affectsDescendants:
        updateSummary.affectsDescendants,
    };
  }

  if (operation.type === "deleteLayer") {
    const deletionSummary = summary.deletedLayers?.find(
      (entry) => entry.operationIndex === operationIndex,
    );
    if (
      deletionSummary === undefined ||
      deletionSummary.layerId !== operation.layerId
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "deleteLayer preview summary does not match its operation.",
        { operationIndex },
      );
    }
    const lockedWarning =
      deletionSummary.lockedLayerCount === 0
        ? ""
        : ` ${deletionSummary.lockedLayerCount} deleted layer(s) are marked locked; locked is advisory metadata and does not block MCP edits.`;
    return {
      type: operation.type,
      layerId: operation.layerId,
      deleteDescendants:
        operation.deleteDescendants === true,
      destructive: true,
      warning:
        `This permanently removes the selected layer, all layer-owned content, and ${deletionSummary.descendantLayerCount} descendant layer(s).${lockedWarning}`,
      layer: {
        id: deletionSummary.layerId,
        type: deletionSummary.layerType,
        name: deletionSummary.name,
        nameTruncated: deletionSummary.nameTruncated,
      },
      parentGroupId: deletionSummary.parentGroupId,
      index: deletionSummary.index,
      deletedLayerCount:
        deletionSummary.deletedLayerCount,
      descendantLayerCount:
        deletionSummary.descendantLayerCount,
      layerIdSample: structuredClone(
        deletionSummary.layerIdSample,
      ),
      omittedLayerCount:
        deletionSummary.omittedLayerCount,
      objectCount: deletionSummary.objectCount,
      objectIdSample: structuredClone(
        deletionSummary.objectIdSample,
      ),
      omittedObjectCount:
        deletionSummary.omittedObjectCount,
      lockedLayerCount:
        deletionSummary.lockedLayerCount,
    };
  }

  if (operation.type === "moveLayer") {
    const moveSummary = summary.movedLayers?.find(
      (entry) => entry.operationIndex === operationIndex,
    );
    if (
      moveSummary === undefined ||
      moveSummary.layerId !== operation.layerId ||
      moveSummary.targetParentGroupId !==
        (operation.parentGroupId ?? null) ||
      moveSummary.targetIndex !== operation.index
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "moveLayer preview summary does not match its operation.",
        { operationIndex },
      );
    }
    const warnings: string[] = [];
    if (!moveSummary.wouldChange) {
      warnings.push(
        "The layer is already at the requested final location.",
      );
    } else if (moveSummary.renderContextMayChange) {
      warnings.push(
        "Changing the parent Group may change inherited rendering context for the moved subtree.",
      );
    } else {
      warnings.push(
        "Changing sibling order may change map rendering order.",
      );
    }
    if (
      moveSummary.effectivelyLockedLayerCountBefore >
        0 ||
      moveSummary.effectivelyLockedLayerCountAfter > 0
    ) {
      warnings.push(
        "The moved subtree is effectively locked before or after the move; locked is advisory metadata and does not block MCP edits.",
      );
    }
    return {
      type: operation.type,
      layerId: operation.layerId,
      destructive: false,
      warning: warnings.join(" "),
      layer: {
        id: moveSummary.layerId,
        type: moveSummary.layerType,
        name: moveSummary.name,
        nameTruncated: moveSummary.nameTruncated,
      },
      sourceParentGroupId:
        moveSummary.sourceParentGroupId,
      sourceIndex: moveSummary.sourceIndex,
      targetParentGroupId:
        moveSummary.targetParentGroupId,
      targetIndex: moveSummary.targetIndex,
      subtreeLayerCount: moveSummary.subtreeLayerCount,
      descendantLayerCount:
        moveSummary.descendantLayerCount,
      layerIdSample: structuredClone(
        moveSummary.layerIdSample,
      ),
      omittedLayerCount:
        moveSummary.omittedLayerCount,
      objectCount: moveSummary.objectCount,
      lockedLayerCount: moveSummary.lockedLayerCount,
      sourceParentLocked:
        moveSummary.sourceParentLocked,
      targetParentLocked:
        moveSummary.targetParentLocked,
      effectivelyLockedLayerCountBefore:
        moveSummary.effectivelyLockedLayerCountBefore,
      effectivelyLockedLayerCountAfter:
        moveSummary.effectivelyLockedLayerCountAfter,
      wouldChange: moveSummary.wouldChange,
      renderOrderMayChange:
        moveSummary.renderOrderMayChange,
      renderContextMayChange:
        moveSummary.renderContextMayChange,
      affectsDescendants:
        moveSummary.affectsDescendants,
    };
  }

  if (operation.type === "duplicateLayer") {
    const duplicateSummary =
      summary.duplicatedLayers?.find(
        (entry) =>
          entry.operationIndex === operationIndex,
      );
    if (
      duplicateSummary === undefined ||
      duplicateSummary.sourceLayerId !==
        operation.layerId
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "duplicateLayer preview summary does not match its operation.",
        { operationIndex },
      );
    }
    const lockedWarning =
      duplicateSummary.effectivelyLockedLayerCount === 0
        ? ""
        : " The copied subtree contains effectively locked layers; locked is advisory metadata and does not block MCP edits.";
    return {
      type: operation.type,
      destructive: false,
      warning:
        "This inserts one compact duplicate while preserving existing source bytes and advances layer/object ID high-water marks in preorder. Object references within the copy are rewired, references outside it are retained, and referenced external files remain shared." +
        lockedWarning,
      sourceLayerId: duplicateSummary.sourceLayerId,
      createdRootLayerId:
        duplicateSummary.createdRootLayerId,
      layerType: duplicateSummary.layerType,
      name: duplicateSummary.name,
      nameTruncated: duplicateSummary.nameTruncated,
      sourceParentGroupId:
        duplicateSummary.sourceParentGroupId,
      targetParentGroupId:
        duplicateSummary.targetParentGroupId,
      sourceIndex: duplicateSummary.sourceIndex,
      targetIndex: duplicateSummary.targetIndex,
      copiedLayerCount:
        duplicateSummary.copiedLayerCount,
      descendantLayerCount:
        duplicateSummary.descendantLayerCount,
      copiedObjectCount:
        duplicateSummary.copiedObjectCount,
      allocatedCellCount:
        duplicateSummary.allocatedCellCount,
      serializedDuplicateBytes:
        duplicateSummary.serializedDuplicateBytes,
      layerIdMappingSample: structuredClone(
        duplicateSummary.layerIdMappingSample,
      ),
      omittedLayerMappingCount:
        duplicateSummary.omittedLayerMappingCount,
      objectIdMappingSample: structuredClone(
        duplicateSummary.objectIdMappingSample,
      ),
      omittedObjectMappingCount:
        duplicateSummary.omittedObjectMappingCount,
      remappedInternalObjectReferenceCount:
        duplicateSummary.remappedInternalObjectReferenceCount,
      retainedExternalObjectReferenceCount:
        duplicateSummary.retainedExternalObjectReferenceCount,
      fileReferenceCount:
        duplicateSummary.fileReferenceCount,
      tileObjectCount: duplicateSummary.tileObjectCount,
      lockedLayerCount:
        duplicateSummary.lockedLayerCount,
      effectivelyLockedLayerCount:
        duplicateSummary.effectivelyLockedLayerCount,
      renderOrderMayChange:
        duplicateSummary.renderOrderMayChange,
      renderContextMayChange:
        duplicateSummary.renderContextMayChange,
      affectsDescendants:
        duplicateSummary.affectsDescendants,
    };
  }

  if (operation.type === "deleteObjects") {
    const objectIdSample = operation.objectIds.slice(0, 32);
    return {
      type: operation.type,
      destructive: true,
      warning: "This operation permanently removes the selected map objects.",
      objectCount: operation.objectIds.length,
      objectIdSample,
      omittedObjectCount: operation.objectIds.length - objectIdSample.length,
    };
  }

  if (operation.type === "transcodeTileLayer") {
    const transcode = (
      summary.transcodes ?? []
    ).find(
      (candidate) =>
        candidate.operationIndex ===
        operationIndex,
    );
    if (transcode === undefined) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The transcode summary entry is missing.",
      );
    }
    return {
      type: operation.type,
      destructive: false,
      warning:
        "This rewrites the layer's entire stored byte representation into the requested encoding; every cell keeps its exact GID.",
      layerId: operation.layerId,
      from: {
        encoding: transcode.fromEncoding,
        compression: transcode.fromCompression,
      },
      to: {
        encoding: transcode.toEncoding,
        compression: transcode.toCompression,
      },
      cellCount: transcode.cellCount,
      wouldChange: transcode.wouldChange,
    };
  }

  if (
    operation.type === "instantiateTemplate"
  ) {
    return {
      type: operation.type,
      destructive: false,
      warning:
        "This places one minimal template instance ({id, template, x, y}); every other member is inherited from the pinned template at load time, and the template file itself is never modified.",
      layerId: operation.layerId,
      templatePath: operation.templatePath,
      source: operation.source,
      x: operation.x,
      y: operation.y,
      expectedTemplateRevision:
        operation.expectedTemplateRevision,
    };
  }

  if (
    operation.type === "replaceTilesetInMap"
  ) {
    return {
      type: operation.type,
      // Not destructive: firstgid does not move, so every cell keeps pointing
      // at the same slot. What changes is which art that slot resolves to.
      destructive: false,
      warning:
        "This repoints one tileset reference in place. Every GID keeps its value and its slot, so each cell now shows the tile at the same local id in the replacement -- which is the intent when the art changed, and a silent remap when the two tilesets are not laid out alike. Compare both tilesets before approving.",
      firstGid: operation.firstGid,
      from: {
        tilesetPath: operation.fromTilesetPath,
        assetId: operation.fromAssetId,
        tileCount: operation.fromTileCount,
        gidSpan: operation.fromGidSpan,
      },
      to: {
        tilesetPath: operation.tilesetPath,
        source: operation.source,
        assetId: operation.assetId,
        tilesetRevision: operation.tilesetRevision,
        tileCount: operation.tileCount,
        gidSpan: operation.gidSpan,
      },
      highestReferencedLocalId:
        operation.highestReferencedLocalId,
      referencedCellCount:
        operation.referencedCellCount,
      referencedObjectCount:
        operation.referencedObjectCount,
    };
  }

  const first = operation.cells[0];
  if (!first) {
    throw new TiledMcpError("INVALID_CHANGE_SET", "setTiles preview has no cells.");
  }
  let minX = first.x;
  let maxX = first.x;
  let minY = first.y;
  let maxY = first.y;
  for (let index = 1; index < operation.cells.length; index += 1) {
    const cell = operation.cells[index];
    if (!cell) {
      continue;
    }
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y);
  }
  return {
    type: operation.type,
    layerId: operation.layerId,
    cellCount: operation.cells.length,
    bounds: {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
    sample: structuredClone(
      operation.cells.slice(0, 8),
    ),
    omittedCellCount: Math.max(0, operation.cells.length - 8),
  };
}

function isValidMapUpdatePatch(
  value: unknown,
): value is Extract<
  MapEditOperation,
  { type: "updateMap" }
>["patch"] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        !(
          MAP_UPDATE_FIELDS as readonly string[]
        ).includes(key),
    )
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "renderOrder",
    ) &&
    (typeof patch.renderOrder !== "string" ||
      !MAP_RENDER_ORDERS.has(patch.renderOrder))
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "backgroundColor",
    ) &&
    patch.backgroundColor !== null &&
    (typeof patch.backgroundColor !== "string" ||
      !TILED_COLOR_PATTERN.test(patch.backgroundColor))
  ) {
    return false;
  }
  return !(
    Object.prototype.hasOwnProperty.call(
      patch,
      "className",
    ) &&
    (typeof patch.className !== "string" ||
      !hasAtMostCodePoints(
        patch.className,
        MAX_MAP_CLASS_NAME_CODE_POINTS,
      ))
  );
}

function hasAtMostCodePoints(
  value: string,
  limit: number,
): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > limit) {
      return false;
    }
  }
  return true;
}

function isMapUpdateSummaryShape(
  value: unknown,
  expectedOperationIndex: number | undefined,
): value is NonNullable<
  MapEditPlan["summary"]["mapUpdates"]
>[number] {
  if (
    expectedOperationIndex === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const summary = value as Record<string, unknown>;
  return (
    hasExactKeys(summary, [
      "operationIndex",
      "requestedFields",
      "changedFields",
      "wouldChange",
      "renderingMayChange",
    ]) &&
    Number.isSafeInteger(summary.operationIndex) &&
    summary.operationIndex === expectedOperationIndex &&
    Array.isArray(summary.requestedFields) &&
    summary.requestedFields.every(
      (field) => typeof field === "string",
    ) &&
    Array.isArray(summary.changedFields) &&
    summary.changedFields.every(
      (field) => typeof field === "string",
    ) &&
    typeof summary.wouldChange === "boolean" &&
    typeof summary.renderingMayChange === "boolean"
  );
}

function isMapResizeSummaryShape(
  value: unknown,
  expectedOperationIndex: number | undefined,
): value is NonNullable<
  MapEditPlan["summary"]["mapResizes"]
>[number] {
  if (
    expectedOperationIndex === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const summary = value as Record<string, unknown>;
  const isBoundedCount = (
    candidate: unknown,
    limit: number,
  ): candidate is number =>
    Number.isSafeInteger(candidate) &&
    (candidate as number) >= 0 &&
    (candidate as number) <= limit;
  const isSortedIdArray = (
    candidate: unknown,
  ): candidate is number[] =>
    Array.isArray(candidate) &&
    candidate.every(
      (id, index) =>
        Number.isSafeInteger(id) &&
        (id as number) > 0 &&
        (index === 0 ||
          (candidate[index - 1] as number) <
            (id as number)),
    );
  if (
    !hasExactKeys(summary, [
      "operationIndex",
      "oldWidth",
      "oldHeight",
      "newWidth",
      "newHeight",
      "offsetX",
      "offsetY",
      "pixelOffsetX",
      "pixelOffsetY",
      "wouldChange",
      "mapDimensionsChanged",
      "tileLayerCount",
      "resizedTileLayerIds",
      "scannedCellCount",
      "rewrittenCellCount",
      "preservedNonEmptyCellCount",
      "croppedNonEmptyCellCount",
      "croppedCellSample",
      "omittedCroppedCellCount",
      "objectLayerCount",
      "movedObjectCount",
      "objectsOutsideNewBounds",
      "imageLayerCount",
      "shiftedImageLayerIds",
      "groupLayerCount",
      "lockedLayerCount",
    ]) ||
    !Number.isSafeInteger(summary.operationIndex) ||
    summary.operationIndex !== expectedOperationIndex ||
    !isBoundedCount(
      summary.oldWidth,
      Number.MAX_SAFE_INTEGER,
    ) ||
    (summary.oldWidth as number) < 1 ||
    !isBoundedCount(
      summary.oldHeight,
      Number.MAX_SAFE_INTEGER,
    ) ||
    (summary.oldHeight as number) < 1 ||
    !isBoundedCount(
      summary.newWidth,
      MAX_RESIZE_MAP_DIMENSION,
    ) ||
    (summary.newWidth as number) < 1 ||
    !isBoundedCount(
      summary.newHeight,
      MAX_RESIZE_MAP_DIMENSION,
    ) ||
    (summary.newHeight as number) < 1 ||
    !Number.isSafeInteger(summary.offsetX) ||
    Math.abs(summary.offsetX as number) >
      MAX_RESIZE_OFFSET_MAGNITUDE ||
    !Number.isSafeInteger(summary.offsetY) ||
    Math.abs(summary.offsetY as number) >
      MAX_RESIZE_OFFSET_MAGNITUDE ||
    !Number.isSafeInteger(summary.pixelOffsetX) ||
    !Number.isSafeInteger(summary.pixelOffsetY) ||
    typeof summary.wouldChange !== "boolean" ||
    typeof summary.mapDimensionsChanged !==
      "boolean" ||
    !isBoundedCount(
      summary.tileLayerCount,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isSortedIdArray(summary.resizedTileLayerIds) ||
    summary.resizedTileLayerIds.length !==
      summary.tileLayerCount ||
    !isBoundedCount(
      summary.scannedCellCount,
      MAX_RESIZE_SOURCE_CELL_SCANS,
    ) ||
    !isBoundedCount(
      summary.rewrittenCellCount,
      MAX_CELL_WRITES,
    ) ||
    !isBoundedCount(
      summary.preservedNonEmptyCellCount,
      MAX_RESIZE_SOURCE_CELL_SCANS,
    ) ||
    !isBoundedCount(
      summary.croppedNonEmptyCellCount,
      MAX_RESIZE_SOURCE_CELL_SCANS,
    ) ||
    !Array.isArray(summary.croppedCellSample) ||
    summary.croppedCellSample.length >
      MAX_RESIZE_CROPPED_CELL_SAMPLE ||
    summary.croppedCellSample.length >
      (summary.croppedNonEmptyCellCount as number) ||
    !summary.croppedCellSample.every(
      (cell) =>
        typeof cell === "object" &&
        cell !== null &&
        !Array.isArray(cell) &&
        hasExactKeys(
          cell as Record<string, unknown>,
          ["layerId", "x", "y", "gid"],
        ) &&
        Number.isSafeInteger(
          (cell as Record<string, unknown>).layerId,
        ) &&
        ((cell as Record<string, unknown>)
          .layerId as number) > 0 &&
        Number.isSafeInteger(
          (cell as Record<string, unknown>).x,
        ) &&
        ((cell as Record<string, unknown>)
          .x as number) >= 0 &&
        Number.isSafeInteger(
          (cell as Record<string, unknown>).y,
        ) &&
        ((cell as Record<string, unknown>)
          .y as number) >= 0 &&
        Number.isSafeInteger(
          (cell as Record<string, unknown>).gid,
        ) &&
        ((cell as Record<string, unknown>)
          .gid as number) > 0 &&
        ((cell as Record<string, unknown>)
          .gid as number) <= 0xffffffff,
    ) ||
    summary.omittedCroppedCellCount !==
      (summary.croppedNonEmptyCellCount as number) -
        summary.croppedCellSample.length ||
    !isBoundedCount(
      summary.objectLayerCount,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isBoundedCount(
      summary.movedObjectCount,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isBoundedCount(
      summary.objectsOutsideNewBounds,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isBoundedCount(
      summary.imageLayerCount,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isSortedIdArray(summary.shiftedImageLayerIds) ||
    summary.shiftedImageLayerIds.length >
      (summary.imageLayerCount as number) ||
    !isBoundedCount(
      summary.groupLayerCount,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isBoundedCount(
      summary.lockedLayerCount,
      Number.MAX_SAFE_INTEGER,
    )
  ) {
    return false;
  }
  return true;
}

function isRemovedTilesetSummaryShape(
  value: unknown,
  expectedOperationIndex: number | undefined,
): value is NonNullable<
  MapEditPlan["summary"]["removedTilesets"]
>[number] {
  if (
    expectedOperationIndex === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const summary = value as Record<
    string,
    unknown
  >;
  const firstGid = summary.firstGid;
  const gidSpan = summary.gidSpan;
  const lastGid = summary.lastGid;
  const scannedCellCount =
    summary.scannedCellCount;
  const scannedObjectCount =
    summary.scannedObjectCount;
  return (
    hasExactKeys(summary, [
      "operationIndex",
      "assetId",
      "tilesetPath",
      "source",
      "tilesetRevision",
      "name",
      "nameTruncated",
      "index",
      "tileCount",
      "gidSpan",
      "firstGid",
      "lastGid",
      "scannedCellCount",
      "scannedObjectCount",
    ]) &&
    Number.isSafeInteger(summary.operationIndex) &&
    summary.operationIndex ===
      expectedOperationIndex &&
    typeof summary.assetId === "string" &&
    ASSET_ID_PATTERN.test(summary.assetId) &&
    typeof summary.tilesetPath === "string" &&
    summary.tilesetPath.length > 0 &&
    typeof summary.source === "string" &&
    summary.source.length > 0 &&
    typeof summary.tilesetRevision ===
      "string" &&
    REVISION_PATTERN.test(
      summary.tilesetRevision,
    ) &&
    typeof summary.name === "string" &&
    typeof summary.nameTruncated ===
      "boolean" &&
    Number.isSafeInteger(summary.index) &&
    (summary.index as number) >= 0 &&
    Number.isSafeInteger(summary.tileCount) &&
    (summary.tileCount as number) > 0 &&
    Number.isSafeInteger(gidSpan) &&
    (gidSpan as number) >=
      (summary.tileCount as number) &&
    Number.isSafeInteger(firstGid) &&
    (firstGid as number) > 0 &&
    Number.isSafeInteger(lastGid) &&
    lastGid ===
      (firstGid as number) +
        (gidSpan as number) -
        1 &&
    (lastGid as number) <= 0x0fffffff &&
    Number.isSafeInteger(scannedCellCount) &&
    (scannedCellCount as number) >= 0 &&
    Number.isSafeInteger(
      scannedObjectCount,
    ) &&
    (scannedObjectCount as number) >= 0 &&
    (scannedCellCount as number) +
      (scannedObjectCount as number) <=
      MAX_REMOVE_TILESET_GID_SCANS
  );
}

function isCopyRegionSummaryShape(
  value: unknown,
  expectedOperationIndex: number | undefined,
): value is NonNullable<
  MapEditPlan["summary"]["tileCopies"]
>[number] {
  if (
    expectedOperationIndex === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const summary = value as Record<
    string,
    unknown
  >;
  const source = summary.source;
  const destination = summary.destination;
  if (
    typeof source !== "object" ||
    source === null ||
    Array.isArray(source) ||
    typeof destination !== "object" ||
    destination === null ||
    Array.isArray(destination)
  ) {
    return false;
  }
  const sourceRecord = source as Record<
    string,
    unknown
  >;
  const destinationRecord =
    destination as Record<string, unknown>;
  const width = sourceRecord.width;
  const height = sourceRecord.height;
  const sourceX = sourceRecord.x;
  const sourceY = sourceRecord.y;
  const destinationX = destinationRecord.x;
  const destinationY = destinationRecord.y;
  const cellCount = summary.cellCount;
  const scannedCellCount =
    summary.scannedCellCount;
  const sourceNonEmptyCellCount =
    summary.sourceNonEmptyCellCount;
  const changedCellCount =
    summary.changedCellCount;
  const overwrittenNonEmptyCellCount =
    summary.overwrittenNonEmptyCellCount;
  const clearedCellCount =
    summary.clearedCellCount;
  return (
    hasExactKeys(summary, [
      "operationIndex",
      "source",
      "destination",
      "scannedCellCount",
      "cellCount",
      "sourceNonEmptyCellCount",
      "changedCellCount",
      "overwrittenNonEmptyCellCount",
      "clearedCellCount",
      "overlapsSource",
      "wouldChange",
    ]) &&
    hasExactKeys(sourceRecord, [
      "layerId",
      "x",
      "y",
      "width",
      "height",
    ]) &&
    hasExactKeys(destinationRecord, [
      "layerId",
      "x",
      "y",
      "width",
      "height",
    ]) &&
    Number.isSafeInteger(summary.operationIndex) &&
    summary.operationIndex ===
      expectedOperationIndex &&
    Number.isSafeInteger(sourceRecord.layerId) &&
    (sourceRecord.layerId as number) > 0 &&
    Number.isSafeInteger(sourceX) &&
    Number.isSafeInteger(sourceY) &&
    Number.isSafeInteger(width) &&
    (width as number) > 0 &&
    Number.isSafeInteger(height) &&
    (height as number) > 0 &&
    Number.isSafeInteger(
      (sourceX as number) + (width as number),
    ) &&
    Number.isSafeInteger(
      (sourceY as number) + (height as number),
    ) &&
    Number.isSafeInteger(
      destinationRecord.layerId,
    ) &&
    (destinationRecord.layerId as number) > 0 &&
    Number.isSafeInteger(destinationX) &&
    Number.isSafeInteger(destinationY) &&
    destinationRecord.width === width &&
    destinationRecord.height === height &&
    Number.isSafeInteger(
      (destinationX as number) +
        (width as number),
    ) &&
    Number.isSafeInteger(
      (destinationY as number) +
        (height as number),
    ) &&
    Number.isSafeInteger(cellCount) &&
    cellCount ===
      (width as number) * (height as number) &&
    (cellCount as number) > 0 &&
    (cellCount as number) <= MAX_CELL_WRITES &&
    Number.isSafeInteger(scannedCellCount) &&
    scannedCellCount ===
      (cellCount as number) * 2 &&
    (scannedCellCount as number) <=
      MAX_TILE_OPERATION_SCANS &&
    Number.isSafeInteger(
      sourceNonEmptyCellCount,
    ) &&
    (sourceNonEmptyCellCount as number) >= 0 &&
    (sourceNonEmptyCellCount as number) <=
      (cellCount as number) &&
    Number.isSafeInteger(changedCellCount) &&
    (changedCellCount as number) >= 0 &&
    (changedCellCount as number) <=
      (cellCount as number) &&
    Number.isSafeInteger(
      overwrittenNonEmptyCellCount,
    ) &&
    (overwrittenNonEmptyCellCount as number) >=
      0 &&
    (overwrittenNonEmptyCellCount as number) <=
      (cellCount as number) &&
    Number.isSafeInteger(clearedCellCount) &&
    (clearedCellCount as number) >= 0 &&
    (clearedCellCount as number) <=
      (changedCellCount as number) &&
    (clearedCellCount as number) <=
      (overwrittenNonEmptyCellCount as number) &&
    (clearedCellCount as number) <=
      (cellCount as number) -
        (sourceNonEmptyCellCount as number) &&
    // These three inequalities keep the implied nonnegative counts for
    // source-only, equal-nonempty and different-nonempty cell pairs.
    (sourceNonEmptyCellCount as number) +
        (clearedCellCount as number) >=
      (overwrittenNonEmptyCellCount as number) &&
    (sourceNonEmptyCellCount as number) +
        (clearedCellCount as number) >=
      (changedCellCount as number) &&
    (overwrittenNonEmptyCellCount as number) +
        (changedCellCount as number) >=
      (sourceNonEmptyCellCount as number) +
        2 * (clearedCellCount as number) &&
    typeof summary.overlapsSource === "boolean" &&
    typeof summary.wouldChange === "boolean" &&
    summary.wouldChange ===
      ((changedCellCount as number) > 0)
  );
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value === right[index],
    )
  );
}

function isCanonicalPreviewTileRef(
  value: unknown,
): value is TileRef | null {
  if (value === null) {
    return true;
  }
  if (
    typeof value !== "object" ||
    value === undefined ||
    Array.isArray(value)
  ) {
    return false;
  }
  const tile = value as Record<string, unknown>;
  if (
    !hasExactKeys(tile, [
      "tileset",
      "localId",
      "transform",
    ]) ||
    !Number.isSafeInteger(tile.localId) ||
    (tile.localId as number) < 0 ||
    (tile.localId as number) > 0x0fffffff
  ) {
    return false;
  }
  const tileset = tile.tileset;
  if (
    typeof tileset !== "object" ||
    tileset === null ||
    Array.isArray(tileset)
  ) {
    return false;
  }
  const tilesetRecord = tileset as Record<
    string,
    unknown
  >;
  if (
    !hasExactKeys(tilesetRecord, [
      "kind",
      "assetId",
    ]) ||
    tilesetRecord.kind !== "external" ||
    typeof tilesetRecord.assetId !== "string" ||
    tilesetRecord.assetId.length === 0 ||
    tilesetRecord.assetId.length > 128
  ) {
    return false;
  }
  const transform = tile.transform;
  if (transform === undefined) {
    return true;
  }
  if (
    typeof transform !== "object" ||
    transform === null ||
    Array.isArray(transform)
  ) {
    return false;
  }
  const transformRecord = transform as Record<
    string,
    unknown
  >;
  if (
    !hasExactKeys(transformRecord, [
      "kind",
      "flipH",
      "flipV",
      "flipD",
      "rawFlags",
    ]) ||
    transformRecord.kind !== "orthogonal" ||
    typeof transformRecord.flipH !== "boolean" ||
    typeof transformRecord.flipV !== "boolean" ||
    typeof transformRecord.flipD !== "boolean" ||
    !Number.isSafeInteger(
      transformRecord.rawFlags,
    ) ||
    (transformRecord.rawFlags as number) < 0 ||
    (transformRecord.rawFlags as number) >
      0xffffffff
  ) {
    return false;
  }
  return (
    (transformRecord.rawFlags as number) >>> 0
  ) === previewOrthogonalFlags(
    value as TileRef,
  );
}

function previewTileRefsEqual(
  left: TileRef | null,
  right: TileRef | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.tileset.kind === right.tileset.kind &&
    (left.tileset.kind === "external"
      ? right.tileset.kind === "external" &&
        left.tileset.assetId === right.tileset.assetId
      : right.tileset.kind === "embedded" &&
        left.tileset.sourceIndex ===
          right.tileset.sourceIndex) &&
    left.localId === right.localId &&
    (left.transform?.kind ?? "orthogonal") ===
      (right.transform?.kind ?? "orthogonal") &&
    (left.transform?.flipH ?? false) ===
      (right.transform?.flipH ?? false) &&
    (left.transform?.flipV ?? false) ===
      (right.transform?.flipV ?? false) &&
    previewFlipD(left) === previewFlipD(right) &&
    previewOrthogonalFlags(left) ===
      previewOrthogonalFlags(right)
  );
}

function previewOrthogonalFlags(tile: TileRef): number {
  const transform = tile.transform;
  let flags =
    (transform?.rawFlags ?? 0) &
    GID_HEX_120;
  if (transform?.flipH === true) {
    flags |= GID_FLIP_HORIZONTAL;
  }
  if (transform?.flipV === true) {
    flags |= GID_FLIP_VERTICAL;
  }
  if (previewFlipD(tile)) {
    flags |= GID_DIAGONAL_OR_HEX_60;
  }
  return flags >>> 0;
}

function previewFlipD(tile: TileRef): boolean {
  const transform = tile.transform;
  return transform !== undefined &&
    "flipD" in transform
    ? (transform.flipD ?? false)
    : false;
}

/**
 * Generic over `T` so narrowed operation types are accepted without laundering
 * them through `as unknown as Record<string, unknown>`; binding `expectedKeys`
 * to `keyof T` makes a stale key list a compile error. See `assertExactKeys`.
 */
function hasExactKeys<T extends object>(
  value: T,
  expectedKeys: readonly (keyof T & string)[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) => key === expected[index],
    )
  );
}
