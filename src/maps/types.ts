import type { TileTransform } from "./gid.js";

export interface TileRef {
  tileset: {
    kind: "external";
    assetId: string;
  };
  localId: number;
  transform?: Partial<TileTransform>;
}

export interface SetTilesOperation {
  type: "setTiles";
  layerId: number;
  cells: Array<{ x: number; y: number; tile: TileRef | null }>;
}

export interface FillRegionOperation {
  type: "fillRegion";
  layerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  tile: TileRef | null;
}

export interface ReplaceTilesOperation {
  type: "replaceTiles";
  layerId: number;
  mappings: Array<{
    from: TileRef;
    to: TileRef | null;
  }>;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface ObjectCommonInput {
  x: number;
  y: number;
  name?: string;
  className?: string;
  rotation?: number;
  visible?: boolean;
  opacity?: number;
}

export type ObjectDraft =
  | (ObjectCommonInput & {
      shape: "rectangle";
      width?: number;
      height?: number;
    })
  | (ObjectCommonInput & {
      shape: "point";
    });

export interface CreateObjectOperation {
  type: "createObject";
  layerId: number;
  object: ObjectDraft;
}

export interface UpdateObjectOperation {
  type: "updateObject";
  objectId: number;
  patch: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    name?: string;
    className?: string;
    rotation?: number;
    visible?: boolean;
    opacity?: number;
  };
}

export interface DeleteObjectsOperation {
  type: "deleteObjects";
  objectIds: number[];
}

export type LayerBlendMode =
  | "normal"
  | "add"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion";

export interface UpdateLayerOperation {
  type: "updateLayer";
  layerId: number;
  patch: {
    name?: string;
    className?: string;
    visible?: boolean;
    opacity?: number;
    offsetX?: number;
    offsetY?: number;
    parallaxX?: number;
    parallaxY?: number;
    tintColor?: string | null;
    locked?: boolean;
    blendMode?: LayerBlendMode;
  };
}

export interface DeleteLayerOperation {
  type: "deleteLayer";
  layerId: number;
  /**
   * Required when the target is a non-empty group. Layer-owned content such
   * as tile cells, images and objects is always deleted with its layer.
   */
  deleteDescendants?: boolean;
}

export interface MoveLayerOperation {
  type: "moveLayer";
  layerId: number;
  /**
   * Omit to move to the root layers array. The target must not be the moved
   * Group itself or one of its descendants.
   */
  parentGroupId?: number;
  /**
   * Zero-based final index after the move has completed.
   */
  index: number;
}

export type DuplicateLayerDestination =
  | {
      kind: "sameParent";
      /**
       * Zero-based final insertion index. Omit to insert immediately above
       * the source layer in its current parent.
       */
      index?: number;
    }
  | {
      kind: "root";
      /**
       * Zero-based final insertion index. Omit to append at the root.
       */
      index?: number;
    }
  | {
      kind: "group";
      parentGroupId: number;
      /**
       * Zero-based final insertion index. Omit to append to the Group.
       */
      index?: number;
    };

export interface DuplicateLayerOperation {
  type: "duplicateLayer";
  layerId: number;
  destination?: DuplicateLayerDestination;
  name?: string;
}

export type MapEditOperation =
  | SetTilesOperation
  | FillRegionOperation
  | ReplaceTilesOperation
  | CreateObjectOperation
  | UpdateObjectOperation
  | DeleteObjectsOperation
  | UpdateLayerOperation
  | DeleteLayerOperation
  | MoveLayerOperation
  | DuplicateLayerOperation;

/**
 * A fully resolved operation emitted only by the dedicated
 * `planAddTilesetToMap` use case. It is intentionally excluded from
 * `MapEditOperation`, so callers of the generic map-edit planner cannot forge
 * path, revision or firstgid decisions.
 */
export interface ResolvedAddTilesetToMapOperation {
  type: "addTilesetToMap";
  tilesetPath: string;
  source: string;
  assetId: string;
  tilesetRevision: string;
  tileCount: number;
  gidSpan: number;
  firstGid: number;
}

export type CreatableLayerType =
  | "tilelayer"
  | "objectgroup"
  | "imagelayer"
  | "group";

export interface ResolvedCreateLayerOperation {
  type: "createLayer";
  layerType: CreatableLayerType;
  layerId: number;
  name: string;
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

export type PlannedMapEditOperation =
  | MapEditOperation
  | ResolvedAddTilesetToMapOperation
  | ResolvedCreateLayerOperation;

export interface MapEditPlan {
  kind: "mapEdit";
  version: 1;
  id: string;
  mapPath: string;
  baseRevision: string;
  dependencyRevisions: Record<string, string>;
  /**
   * Read dependencies that are not referenced by the current map yet. Keeping
   * these separate is important: current dependency CAS remains an exact-set
   * comparison, while prospective dependencies are pinned independently.
   */
  prospectiveDependencyRevisions?: Record<string, string>;
  operations: PlannedMapEditOperation[];
  summary: {
    operationCount: number;
    cellWrites: number;
    affectedLayerIds: number[];
    affectedTileLayerIds: number[];
    affectedObjectLayerIds: number[];
    createdObjectIds: number[];
    updatedObjectIds: number[];
    deletedObjectIds: number[];
    updatedLayerIds?: number[];
    layerUpdates?: Array<{
      operationIndex: number;
      layerId: number;
      layerType: CreatableLayerType;
      requestedFields: string[];
      changedFields: string[];
      wouldChange: boolean;
      affectsDescendants: boolean;
    }>;
    deletedLayers?: Array<{
      operationIndex: number;
      layerId: number;
      layerType: CreatableLayerType;
      name: string;
      nameTruncated: boolean;
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
    }>;
    movedLayers?: Array<{
      operationIndex: number;
      layerId: number;
      layerType: CreatableLayerType;
      name: string;
      nameTruncated: boolean;
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
    }>;
    duplicatedLayers?: Array<{
      operationIndex: number;
      sourceLayerId: number;
      createdRootLayerId: number;
      layerType: CreatableLayerType;
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
    }>;
    tileReplacements?: Array<{
      operationIndex: number;
      layerId: number;
      region: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      scannedCellCount: number;
      replacedCellCount: number;
      mappingCount: number;
    }>;
    addedTilesets?: Array<{
      tilesetPath: string;
      source: string;
      assetId: string;
      tilesetRevision: string;
      tileCount: number;
      gidSpan: number;
      firstGid: number;
    }>;
    createdLayers?: Array<{
      layerId: number;
      layerType: CreatableLayerType;
      name: string;
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
    }>;
  };
}

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  jsonPointer?: string;
}
