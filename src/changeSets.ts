import { randomBytes } from "node:crypto";

import { TiledMcpError } from "./errors.js";
import type { CommitResult } from "./storage/documentStore.js";
import {
  checkpointRestoreOperationPreview,
  type CheckpointRestoreOperationPreview,
  type CheckpointRestorePlan,
  type CheckpointRestoreSummary,
} from "./storage/checkpointRestore.js";
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
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_TILE_OPERATION_SCANS,
} from "./maps/mapService.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
export const DEFAULT_MAX_PENDING_CELL_WRITES = 200_000;
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

export type ChangeSetPlan =
  | MapEditPlan
  | CheckpointRestorePlan;

interface ChangeSetEntry {
  id: string;
  plan: ChangeSetPlan;
  createdAt: string;
  expiresAt: number;
  result?: CommitResult & { changeSetId: string };
  inFlight?: Promise<CommitResult & { changeSetId: string }>;
}

interface ChangeSetPreviewCommon {
  changeSetId: string;
  planDigest: string;
  expectedRevision: string;
  operations: OperationPreview[];
  snapshotConsistency: "non-atomic-read-set";
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

export type ChangeSetPreview =
  | MapEditChangeSetPreview
  | CheckpointRestoreChangeSetPreview;

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
  | CheckpointRestoreOperationPreview;

export class ChangeSetRegistry {
  private readonly entries = new Map<string, ChangeSetEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxPendingCellWrites = DEFAULT_MAX_PENDING_CELL_WRITES,
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
    const now = Date.now();
    const id = this.nextId();
    const entry: ChangeSetEntry = {
      id,
      plan: structuredClone(plan),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
    };
    const preview = toPreview(entry);
    this.entries.set(id, entry);
    return preview;
  }

  async apply(
    changeSetId: string,
    expectedRevision: string,
    operation: (
      plan: ChangeSetPlan,
    ) => Promise<CommitResult & { changeSetId: string }>,
  ): Promise<CommitResult & { changeSetId: string }> {
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
  }

  private nextId(): string {
    let id: string;
    do {
      id = `changeset:${randomBytes(32).toString("hex")}`;
    } while (this.entries.has(id));
    return id;
  }
}

function toPreview(entry: ChangeSetEntry): ChangeSetPreview {
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
    operations: plan.operations.map((operation, operationIndex) =>
      summarizeOperation(
        operation,
        operationIndex,
        plan.summary,
      ),
    ),
    summary: structuredClone(plan.summary),
    snapshotConsistency: "non-atomic-read-set",
    createdAt: entry.createdAt,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
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

function scrubAppliedPlan(plan: ChangeSetPlan): ChangeSetPlan {
  if (plan.kind === "mapEdit") {
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
        updateSummary as unknown as Record<
          string,
          unknown
        >,
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
      tile: operation.tile,
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
      object: operation.object,
    };
  }

  if (operation.type === "updateObject") {
    return {
      type: operation.type,
      objectId: operation.objectId,
      changedFields: Object.keys(operation.patch).sort(),
      patch: operation.patch,
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
    sample: operation.cells.slice(0, 8),
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
    left.tileset.assetId === right.tileset.assetId &&
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

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
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
