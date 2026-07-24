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

export type MapEditOperation =
  | SetTilesOperation
  | FillRegionOperation
  | ReplaceTilesOperation
  | CreateObjectOperation
  | UpdateObjectOperation
  | DeleteObjectsOperation;

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
