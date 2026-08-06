// Shared budgets, patch-field tables and document view types for the map
// modules. Split out of mapService so the pure operation code can be reached
// without importing the I/O shell.

import {
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import {
  type JsonSourcePath,
} from "../formats/jsonSourcePatch.js";
import {
  type NativePreviewHighlightInput,
} from "../images/mapPreview.js";
import {
  type DocumentSnapshot,
  type LoadedDocument,
} from "../storage/documentStore.js";
import {
  type PreviewRegion,
} from "./previewScene.js";
import {
  type ChunkedCellView,
} from "./tileData.js";
import {
  type TileFindQuery,
} from "./tileSearch.js";
import {
  type TilesetCreatePlan,
} from "./tilesetCreate.js";
import {
  type TileMetadataUpdate,
} from "./tilesetEdits.js";
import {
  type CreatableLayerType,
  type TileRef,
} from "./types.js";
import {
  type WangEditOperation,
} from "./wangEdits.js";

export const MAX_PLAN_OPERATIONS = 128;
export const MAX_CELL_WRITES = 100_000;
/** Tiles a merge may shift its source by on either axis. */
export const MAX_MERGE_OFFSET = 1_000_000;
export const MAX_REGION_CELLS = 20_000;
export const MAX_LAYER_COUNT = 10_000;
export const MAX_LAYER_DEPTH = 64;
export const MAX_TILESET_COUNT = 4_096;
export const MAX_TOTAL_DEPENDENCY_BYTES = 64 * 1024 * 1024;
export const MAX_DIAGNOSTICS = 1_000;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_024;
export const MAX_OBJECT_COUNT = 100_000;
export const MAX_OBJECT_MUTATIONS = 10_000;
export const MAX_PATCHED_SUBTREES = 128;
export const MAX_OBJECT_LIST_LIMIT = 10_000;
export const MAX_OBJECT_STRING_LENGTH = 1_024;
export const MAX_OBJECT_DISPLAY_STRING_LENGTH = 128;
export const MAX_LAYER_OPERATION_ID_SAMPLE = 32;
export const MAX_ABSOLUTE_OBJECT_NUMBER = 1_000_000_000;
export const MIN_POLYGON_OBJECT_POINTS = 3;
export const MIN_POLYLINE_OBJECT_POINTS = 2;
export const MAX_OBJECT_SHAPE_POINTS = 256;
export const MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET = 8_192;
export const MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET = 262_144;
export const MAX_TILED_SIGNED_ID = 0x7fffffff;
export const MAX_EDITABLE_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_DUPLICATE_LAYER_BYTES = 16 * 1024 * 1024;
export const MAX_ADD_TILESET_GID_SCANS = 1_000_000;
export const MAX_REMOVE_TILESET_GID_SCANS = 1_000_000;
export const MAX_CREATE_TILE_LAYER_CELLS = MAX_CELL_WRITES;
export const MAX_CREATE_MAP_DIMENSION = 100_000;
export const MAX_CREATE_MAP_TILE_EDGE = 16_384;
export const MAX_LAYER_NAME_LENGTH = MAX_OBJECT_STRING_LENGTH;
export const MAX_MAP_CLASS_NAME_CODE_POINTS = 1_024;
export const MAX_REPLACE_TILE_MAPPINGS = 128;
export const MAX_TILE_OPERATION_SCANS = 1_000_000;
export const MAX_REPLACE_TILE_SCANS =
  MAX_TILE_OPERATION_SCANS;
export const MAX_FLOOD_FILL_SCANS =
  MAX_TILE_OPERATION_SCANS;
export const MAX_STAMP_PATTERN_EDGE = 256;
export const MAX_STAMP_PATTERN_CELLS = 16_384;
export const MAX_RESIZE_MAP_DIMENSION = MAX_CREATE_MAP_DIMENSION;
export const MAX_RESIZE_OFFSET_MAGNITUDE = MAX_CREATE_MAP_DIMENSION;
export const MAX_RESIZE_SOURCE_CELL_SCANS = MAX_TILE_OPERATION_SCANS;
export const MAX_RESIZE_CROPPED_CELL_SAMPLE = 16;
export const DEFAULT_USAGE_TOP_TILE_LIMIT = 64;
export const MAX_USAGE_TOP_TILE_LIMIT = 128;
export const MAX_USAGE_SCAN_VALUES = 1_000_000;
export const MAX_USAGE_DISTINCT_TILES = 100_000;
export const MAX_USAGE_LAYER_SUMMARIES = 64;
export const MAX_USAGE_TILESET_SUMMARIES = 64;
export const MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE = 16;
export const MAX_USAGE_RESULT_BYTES = 256 * 1024;
export const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const ASSET_ID_PATTERN = /^asset_[0-9a-f]{24}$/u;
export const TILED_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
export const MAP_PATCH_FIELDS = [
  "renderOrder",
  "backgroundColor",
  "className",
] as const;
export const LAYER_PATCH_FIELDS = [
  "name",
  "className",
  "visible",
  "opacity",
  "offsetX",
  "offsetY",
  "parallaxX",
  "parallaxY",
  "tintColor",
  "locked",
  "blendMode",
] as const;
export const FOUR_WAY_TILE_NEIGHBOR_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
export type LayerPatchField = (typeof LAYER_PATCH_FIELDS)[number];
export type MapPatchField = (typeof MAP_PATCH_FIELDS)[number];
export const MAP_PATCH_JSON_KEYS: Record<MapPatchField, string> = {
  renderOrder: "renderorder",
  backgroundColor: "backgroundcolor",
  className: "class",
};
export const MAP_RENDER_ORDERS = new Set([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);
export const MAP_RENDER_FIELDS = new Set<MapPatchField>([
  "renderOrder",
  "backgroundColor",
]);
export const LAYER_PATCH_JSON_KEYS: Record<LayerPatchField, string> = {
  name: "name",
  className: "class",
  visible: "visible",
  opacity: "opacity",
  offsetX: "offsetx",
  offsetY: "offsety",
  parallaxX: "parallaxx",
  parallaxY: "parallaxy",
  tintColor: "tintcolor",
  locked: "locked",
  blendMode: "mode",
};
export const LAYER_BLEND_MODES = new Set([
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
]);
export const GROUP_DESCENDANT_RENDER_FIELDS =
  new Set<LayerPatchField>([
    "visible",
    "opacity",
    "offsetX",
    "offsetY",
    "parallaxX",
    "parallaxY",
    "tintColor",
    "blendMode",
  ]);

export interface LayerTraversalBudget {
  count: number;
}

export interface RenderImageBudget {
  revisions: Map<string, string>;
  totalBytes: number;
  totalPixels: number;
  expectedRevisions?: Readonly<Record<string, string>>;
}

export type SelectBaseMatch =
  | { kind: "tiles"; tiles: TileRef[] }
  | { kind: "empty" }
  | { kind: "nonEmpty" }
  | {
      kind: "magicWand";
      seed: { x: number; y: number };
    }
  | {
      kind: "polygon";
      points: Array<{ x: number; y: number }>;
    };

export interface EditableContext {
  loaded: LoadedDocument;
  width: number;
  height: number;
  orientation:
    | "orthogonal"
    | "isometric"
    | "staggered"
    | "hexagonal";
  infinite: boolean;
  bindings: TilesetBinding[];
  /** Non-empty only when the caller opted in via allowEmbeddedTilesets. */
  embeddedBindings: EmbeddedTilesetBinding[];
  dependencyRevisions: Record<string, string>;
}

export interface EditableContextRevisionGuards {
  expectedMapRevision?: string;
  expectedDependencyRevisions?: Record<string, string>;
  selectedTileset?: {
    assetId: string;
    expectedRevision: string;
  };
  /**
   * Only write-path callers persist asset-identity observations; read and
   * preview tool paths default to lock-free, side-effect-free resolution so
   * their readOnlyHint stays strictly true.
   */
  persistIdentity?: boolean;
  /**
   * Read-only tools that understand chunked storage opt in explicitly;
   * every write and preview-edit path keeps the default fail-closed gate,
   * so infinite maps can never reach an edit planner.
   */
  allowInfinite?: boolean;
  /**
   * Read-only tools that tolerate image-collection tilesets opt in
   * explicitly; every edit, render, and tileset-detail path keeps the
   * default fail-closed gate.
   */
  allowCollectionTilesets?: boolean;
  /**
   * Read-only tools that understand embedded (inline) map tilesets opt in
   * explicitly; every other path keeps the default fail-closed gate, so an
   * embedded tileset can never reach an edit planner or renderer.
   */
  allowEmbeddedTilesets?: boolean;
  /**
   * Read-only tools opt in to isometric maps explicitly. Tile data and
   * GID semantics are identical to orthogonal storage; only rendering
   * projects differently, so every edit and render path keeps the
   * default fail-closed gate. Staggered, hexagonal, and oblique maps
   * stay rejected everywhere.
   */
  allowIsometric?: boolean;
  /**
   * Read-only tools that understand staggered and hexagonal storage
   * opt in explicitly; every edit and render path keeps the default
   * fail-closed gate.
   */
  allowStaggeredHexagonal?: boolean;
}

export interface TilesetBinding {
  assetId: string;
  path: string;
  firstGid: number;
  tileCount: number;
  gidSpan: number;
  name: string;
  nameTruncated: boolean;
  revision: string;
  /**
   * Image-collection tilesets (no root atlas image): readable through the
   * semantic core, never editable or renderable in M1. `localIds` is the
   * sparse set of existing tile ids for fail-closed GID validation.
   */
  collection?: true;
  localIds?: ReadonlySet<number>;
}

/**
 * A tileset embedded directly in a map's `tilesets[]` entry (no `source`).
 * Its content lives inside the map bytes, so the map revision is its only
 * pin; it never appears in `dependencyRevisions` and has no asset ID.
 */
export interface EmbeddedTilesetBinding {
  kind: "embedded";
  sourceIndex: number;
  firstGid: number;
  tileCount: number;
  gidSpan: number;
  name: string;
  nameTruncated: boolean;
  document: JsonObject;
}

export interface TilesetBindingCandidate {
  firstGid: number;
  tilesetPath: string;
  snapshot: DocumentSnapshot;
  validation:
    | {
        ok: true;
        tileCount: number;
        gidSpan: number;
        name: string;
        nameTruncated: boolean;
        collectionLocalIds?: ReadonlySet<number>;
      }
    | {
        ok: false;
        error: unknown;
      };
}

export type TilesetUsageReference =
  | {
      kind: "cell";
      layerId: number;
      x: number;
      y: number;
    }
  | {
      kind: "object";
      layerId: number;
      objectId: number;
    };

export interface TilesetUsageInspection {
  scannedCellCount: number;
  scannedObjectCount: number;
}

export interface ProspectiveTilesetBinding {
  assetId: string;
  path: string;
  tileCount: number;
  gidSpan: number;
  revision: string;
}

/**
 * In-memory stand-in for a TSJ that does not exist on disk yet: the exact
 * replayed content of an approved tileset-create plan, keyed by that plan's
 * prospective content revision.
 */
export interface ProspectiveTilesetSource {
  document: JsonObject;
  revision: string;
}

export interface ProspectiveImageBinding {
  assetId: string;
  path: string;
  revision: string;
  width: number;
  height: number;
}

export interface TileLayerView {
  object: JsonObject;
  path: JsonSourcePath;
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: JsonValue[];
  /** Present exactly for infinite chunked layers. */
  chunked?: ChunkedCellView;
}

export interface ObjectLayerView {
  object: JsonObject;
  path: JsonSourcePath;
  id: number;
  name: string;
  objects: JsonValue[];
  ancestors: readonly JsonObject[];
}

export interface ObjectLocation {
  object: JsonObject;
  objectIndex: number;
  layer: ObjectLayerView;
  ancestors: readonly JsonObject[];
}

export interface EditableLayerLocation {
  object: JsonObject;
  path: JsonSourcePath;
  id: number;
  type: CreatableLayerType;
}

export interface DeletableLayerLocation
  extends EditableLayerLocation {
  container: JsonValue[];
  containerPath: JsonSourcePath;
  index: number;
  parentGroupId: number | null;
}

export interface LayerSubtreeInspection {
  layerIds: number[];
  objectIds: number[];
  lockedLayerCount: number;
  effectivelyLockedLayerCount: number;
  maxRelativeDepth: number;
}

export interface ObjectEditIndex {
  byId: Map<number, ObjectLocation>;
  maximumId: number;
}

export type BasicEditableObjectShape =
  | "rectangle"
  | "point"
  | "ellipse"
  | "capsule"
  | "polygon"
  | "polyline"
  | "text"
  | "tile";

export interface CreateMapInput {
  mapPath: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  backgroundColor?: string;
}

export interface CreateTilesetInput {
  tilesetPath: string;
  imagePath: string;
  tileWidth: number;
  tileHeight: number;
  margin?: number;
  spacing?: number;
  name?: string;
  className?: string;
}

export interface GetRegionInput {
  mapPath: string;
  layerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ListObjectsInput {
  mapPath: string;
  layerId?: number;
  limit?: number;
}

export interface GetObjectInput {
  mapPath: string;
  objectId: number;
}

export interface RenderTilesetSheetInput {
  mapPath: string;
  tilesetAssetId: string;
  page?: number;
  pageSize?: number;
  columns?: number;
  scale?: number;
}

export interface RenderTilesInput {
  mapPath: string;
  tilesetAssetId: string;
  localIds: readonly number[];
  columns?: number;
  scale?: number;
  expectedMapRevision?: string;
  expectedTilesetRevision?: string;
}

export interface GetTilesetInput {
  mapPath: string;
  /** Exactly one of tilesetAssetId (external) or embeddedIndex is required. */
  tilesetAssetId?: string;
  /** Original `tilesets[]` array index of an embedded (inline) tileset. */
  embeddedIndex?: number;
  startTileId?: number;
  limit?: number;
}

export type TiledExportRunner = (options: {
  kind: "map" | "tileset";
  format: string;
  sourcePath: string;
  outputPath: string;
  maxOutputBytes: number;
}) => Promise<Buffer>;

export interface UpdateWangsetsInput {
  mapPath: string;
  tilesetAssetId: string;
  expectedMapRevision: string;
  expectedTilesetRevision: string;
  operations: WangEditOperation[];
}

export interface UpdateTileInput {
  mapPath: string;
  tilesetAssetId: string;
  expectedMapRevision: string;
  expectedTilesetRevision: string;
  updates: TileMetadataUpdate[];
}

export interface FindTilesInput {
  mapPath: string;
  tilesetAssetId: string;
  query: TileFindQuery;
  startTileId?: number;
  limit?: number;
  expectedMapRevision?: string;
  expectedTilesetRevision?: string;
}

export interface AnalyzeUsageInput {
  mapPath: string;
  topTileLimit?: number;
  expectedMapRevision?: string;
  expectedDependencyRevisions?: Record<string, string>;
}

export interface PlanMergeMapInput {
  /** The map being merged into. */
  mapPath: string;
  /** The map whose tile layers are copied in. Never modified. */
  sourceMapPath: string;
  expectedMapRevision: string;
  expectedDependencyRevisions: Record<string, string>;
  expectedSourceMapRevision?: string;
  /** Where the source's origin lands in the destination, in tiles. */
  offsetX?: number;
  offsetY?: number;
}

export interface PlanReplaceTilesetInMapInput {
  mapPath: string;
  /** The currently bound tileset to repoint, by its map-summary asset id. */
  tilesetAssetId: string;
  /** The `.tsj` to point that slot at instead. */
  tilesetPath: string;
  expectedMapRevision: string;
  expectedDependencyRevisions: Record<string, string>;
  expectedTilesetRevision?: string;
}

export interface PlanAddTilesetToMapInput {
  mapPath: string;
  tilesetPath: string;
  expectedMapRevision: string;
  expectedDependencyRevisions: Record<string, string>;
  expectedTilesetRevision?: string;
  /**
   * Approved tileset-create plan whose replayed prospective content stands
   * in for a TSJ that does not exist on disk yet. The attachment pins that
   * plan's prospective content revision, so it applies either after the
   * create commits individually or atomically with it in one transaction.
   */
  createPlan?: TilesetCreatePlan;
}

export interface PlanCreateLayerInput {
  mapPath: string;
  layerType: CreatableLayerType;
  name: string;
  parentGroupId?: number;
  index?: number;
  imagePath?: string;
  expectedMapRevision: string;
  expectedDependencyRevisions: Record<string, string>;
  expectedImageRevision?: string;
}

export interface RenderTilesetSheetResult {
  png: Buffer;
  result: Record<string, unknown>;
}

export interface RenderTilesResult {
  png: Buffer;
  result: Record<string, unknown>;
}

export interface RenderPreviewInput {
  mapPath: string;
  region?: PreviewRegion;
  layerIds?: number[];
  scale?: number;
  overlays?: {
    grid?: boolean;
    coordinates?: boolean;
    highlights?: NativePreviewHighlightInput[];
    objectIds?: number[];
    tileObjectCollision?: boolean;
  };
}

export interface RenderPreviewResult {
  png: Buffer;
  result: Record<string, unknown>;
}

export interface RenderSafetySnapshot {
  map: {
    path: string;
    revision: string;
  };
  dependencyRevisions: Record<string, string>;
  /**
   * Internal render guard. The public raster result deliberately does not
   * expose image revisions because TmxRasterizer reads live files.
   */
  inputImageRevisions: Record<string, string>;
}

