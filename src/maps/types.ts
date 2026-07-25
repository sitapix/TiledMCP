import type { TileTransform } from "./gid.js";
import type {
  TextObjectHorizontalAlignment,
  TextObjectVerticalAlignment,
} from "./textObjects.js";

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

export interface StampPatternOperation {
  type: "stampPattern";
  layerId: number;
  /**
   * Absolute tile coordinate of the pattern's top-left cell.
   */
  x: number;
  y: number;
  /**
   * A non-empty, dense rectangular row-major pattern. `null` explicitly
   * clears a target cell; there is no transparent/skip sentinel.
   */
  pattern: Array<Array<TileRef | null>>;
}

export interface FloodFillOperation {
  type: "floodFill";
  layerId: number;
  /**
   * Absolute tile coordinate used as the four-way flood-fill seed.
   */
  x: number;
  y: number;
  /**
   * The replacement tile. `null` explicitly clears the connected region.
   */
  tile: TileRef | null;
}

export interface CopyRegionOperation {
  type: "copyRegion";
  source: {
    layerId: number;
    /**
     * Absolute tile coordinate of the source region's top-left cell.
     */
    x: number;
    y: number;
    width: number;
    height: number;
  };
  destination: {
    layerId: number;
    /**
     * Absolute tile coordinate of the destination region's top-left cell.
     * The destination dimensions are inherited from `source`.
     */
    x: number;
    y: number;
  };
}

export type MapRenderOrder =
  | "right-down"
  | "right-up"
  | "left-down"
  | "left-up";

export interface UpdateMapOperation {
  type: "updateMap";
  patch: {
    renderOrder?: MapRenderOrder;
    /**
     * `null` removes the serialized `backgroundcolor` member.
     */
    backgroundColor?: string | null;
    className?: string;
  };
}

export interface RemoveTilesetFromMapOperation {
  type: "removeTilesetFromMap";
  /**
   * Opaque identifier returned by the map summary. The operation is allowed
   * only when no tile cell or tile object still resolves to this binding.
   */
  tilesetAssetId: string;
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

export interface ObjectPathPoint {
  x: number;
  y: number;
}

export interface ObjectTextFieldsInput {
  text: string;
  fontFamily?: string;
  pixelSize?: number;
  wrap?: boolean;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  kerning?: boolean;
  horizontalAlignment?: TextObjectHorizontalAlignment;
  verticalAlignment?: TextObjectVerticalAlignment;
}

export type ObjectDraft =
  | (ObjectCommonInput & {
      shape: "rectangle";
      width?: number;
      height?: number;
    })
  | (ObjectCommonInput & {
      shape: "point";
    })
  | (ObjectCommonInput & {
      shape: "ellipse" | "capsule";
      /**
       * Like rectangles, omitted dimensions default to zero in Tiled.
       */
      width?: number;
      height?: number;
    })
  | (ObjectCommonInput & {
      shape: "polygon" | "polyline";
      /**
       * Ordered pixel coordinates relative to the object's x/y anchor.
       * Polygons are implicitly closed by Tiled; callers must not repeat the
       * first point unless that duplicate is intentional.
       */
      points: ObjectPathPoint[];
    })
  | (ObjectCommonInput &
      ObjectTextFieldsInput & {
        shape: "text";
        /**
         * Tiled stores a text object's wrapping/clipping box separately from
         * its content. Omitted dimensions use the TMJ zero defaults; the
         * service never derives them from platform-dependent font metrics.
         */
        width?: number;
        height?: number;
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
    /**
     * Whole-array replacement for an existing polygon or polyline. Coordinates
     * remain local to the object's x/y anchor and do not change its shape.
     */
    points?: ObjectPathPoint[];
    name?: string;
    className?: string;
    rotation?: number;
    visible?: boolean;
    opacity?: number;
  } & Partial<ObjectTextFieldsInput>;
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
  | UpdateMapOperation
  | RemoveTilesetFromMapOperation
  | SetTilesOperation
  | FillRegionOperation
  | StampPatternOperation
  | FloodFillOperation
  | CopyRegionOperation
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
    mapUpdates?: Array<{
      operationIndex: number;
      requestedFields: string[];
      changedFields: string[];
      wouldChange: boolean;
      renderingMayChange: boolean;
    }>;
    removedTilesets?: Array<{
      operationIndex: number;
      assetId: string;
      tilesetPath: string;
      source: string;
      tilesetRevision: string;
      name: string;
      nameTruncated: boolean;
      index: number;
      tileCount: number;
      gidSpan: number;
      firstGid: number;
      lastGid: number;
      scannedCellCount: number;
      scannedObjectCount: number;
    }>;
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
    tileStamps?: Array<{
      operationIndex: number;
      layerId: number;
      region: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      cellCount: number;
      nonEmptyCellCount: number;
      clearCellCount: number;
      transformedCellCount: number;
      changedCellCount: number;
      wouldChange: boolean;
    }>;
    tileFloodFills?: Array<{
      operationIndex: number;
      layerId: number;
      seed: {
        x: number;
        y: number;
      };
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
    }>;
    tileCopies?: Array<{
      operationIndex: number;
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
