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

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
export const DEFAULT_MAX_PENDING_CELL_WRITES = 200_000;

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
    this.entries.set(id, entry);
    return toPreview(entry);
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
