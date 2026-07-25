import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { posix } from "node:path";

import { TiledMcpError, asTiledMcpError } from "../errors.js";
import {
  cloneJson,
  expectArray,
  expectInteger,
  expectObject,
  expectString,
  isJsonObject,
  serializeJsonDocument,
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import { revisionOf } from "../storage/revision.js";
import {
  assertTilesetCreatePlan,
  buildTilesetDocument,
  computeAtlasGrid,
  tilesetCreatePlanId,
  validateCreateTilesetScalars,
  type TilesetCreatePlan,
} from "./tilesetCreate.js";
import {
  assertFileDeletePlan,
  fileDeletePlanId,
  fileDeleteSummary,
  MAX_DELETE_REFERENCE_SCAN_ASSETS,
  MAX_DELETE_REFERENCE_SCAN_BYTES,
  MAX_DELETE_REFERRER_SAMPLE,
  type FileDeletePlan,
  type FileDeleteScanSummary,
} from "./fileDelete.js";
import {
  decodeChunkCells,
  decodeEncodedTileLayerData,
  encodeTileLayerCells,
  readChunkedRegionGids,
  readChunkedTileLayerStructure,
  resolveTileLayerCells,
} from "./tileData.js";
import {
  patchJsonDocumentSource,
  type JsonArrayDeletion,
  type JsonArrayInsertion,
  type JsonArrayMove,
  type JsonObjectMemberPatch,
  type JsonSourcePath,
} from "../formats/jsonSourcePatch.js";
import {
  readImageFileSnapshot,
  type ImageFileSnapshot,
} from "../images/imageFile.js";
import {
  DEFAULT_TILESET_SHEET_PAGE_SIZE,
  DEFAULT_TILESET_SHEET_SCALE,
  MAX_TILE_RENDER_LOCAL_IDS,
  MAX_TILESET_IMAGE_BYTES,
  MAX_TILESET_INPUT_EDGE,
  MAX_TILESET_INPUT_PIXELS,
  renderTilesetTiles,
  renderTilesetSheet,
} from "../images/tilesetSheet.js";
import {
  MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
  MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
  MAX_NATIVE_PREVIEW_OBJECT_POINTS,
  MAX_NATIVE_PREVIEW_OBJECTS,
  MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
  DEFAULT_NATIVE_PREVIEW_SCALE,
  prepareNativePreviewHighlightOverlay,
  renderNativePreview,
  type NativePreviewAtlas,
  type NativePreviewCollisionShapeInput,
  type NativePreviewCollisionShapeKind,
  type NativePreviewHighlightInput,
  type NativePreviewObjectInput,
} from "../images/mapPreview.js";
import {
  parseTransparentColor,
  validateAtlasGeometry,
  type AtlasGeometry,
} from "../images/atlas.js";
import {
  decodeSafeImage,
  inspectSafeImage,
} from "../images/safeImage.js";
import type { ProjectPathResolver } from "../project/pathResolver.js";
import {
  MAX_RASTER_INPUT_AGGREGATE_BYTES,
  MAX_RASTER_INPUT_AGGREGATE_PIXELS,
  MAX_RASTER_INPUT_EDGE,
  MAX_RASTER_INPUT_IMAGES,
} from "../rasterContract.js";
import { AssetRegistry } from "../project/assetRegistry.js";
import type {
  CommitResult,
  DocumentSnapshot,
  DocumentStore,
  FileDeleteStoreResult,
  LoadedDocument,
} from "../storage/documentStore.js";
import { decodeGid, encodeGid, type MapOrientation, type OrthogonalTransform } from "./gid.js";
import {
  buildPreviewScene,
  type PreviewRegion,
  type PreviewScene,
} from "./previewScene.js";
import {
  assertAtlasTileDefinition,
  assertTilesetDetailResultSize,
  DEFAULT_TILESET_METADATA_LIMIT,
  MAX_TILESET_METADATA_ENTRIES,
  summarizeTilesetDocument,
} from "./tilesetDetails.js";
import {
  applyTileMetadataUpdates,
  assertTilesetEditPlan,
  tilesetEditPlanId,
  type TileMetadataUpdate,
  type TilesetEditPlan,
} from "./tilesetEdits.js";
import {
  assertTileFindResultSize,
  DEFAULT_TILE_FIND_LIMIT,
  searchTilesetDocument,
  type TileFindQuery,
} from "./tileSearch.js";
import {
  applyTextObjectFieldsPatch,
  hasTextObjectFields,
  MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
  measureTextObjectPayloadBytes,
  parseTiledTextObjectData,
  serializeTiledTextObjectData,
  TEXT_OBJECT_FIELDS,
  TextObjectValidationError,
  textObjectFieldsFromFlatInput,
  type EffectiveTextObjectFields,
} from "./textObjects.js";
import {
  applyPropertiesPatch,
  measurePropertiesPatchBytes,
  projectScalarProperties,
  validatePropertiesPatch,
} from "./propertyEdits.js";
import type {
  CreatableLayerType,
  Diagnostic,
  MapEditOperation,
  MapEditPlan,
  ObjectDraft,
  ObjectPathPoint,
  PlannedMapEditOperation,
  ResolvedAddTilesetToMapOperation,
  ResolvedCreateLayerOperation,
  TileRef,
} from "./types.js";

const MAX_PLAN_OPERATIONS = 128;
export const MAX_CELL_WRITES = 100_000;
const MAX_REGION_CELLS = 20_000;
const MAX_LAYER_COUNT = 10_000;
const MAX_LAYER_DEPTH = 64;
const MAX_TILESET_COUNT = 4_096;
const MAX_TOTAL_DEPENDENCY_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTICS = 1_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_024;
const MAX_OBJECT_COUNT = 100_000;
const MAX_OBJECT_MUTATIONS = 10_000;
const MAX_PATCHED_SUBTREES = 128;
const MAX_OBJECT_LIST_LIMIT = 10_000;
const MAX_OBJECT_STRING_LENGTH = 1_024;
export const MAX_OBJECT_DISPLAY_STRING_LENGTH = 128;
const MAX_LAYER_OPERATION_ID_SAMPLE = 32;
const MAX_ABSOLUTE_OBJECT_NUMBER = 1_000_000_000;
export const MIN_POLYGON_OBJECT_POINTS = 3;
export const MIN_POLYLINE_OBJECT_POINTS = 2;
export const MAX_OBJECT_SHAPE_POINTS = 256;
export const MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET = 8_192;
export const MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET = 262_144;
const MAX_TILED_SIGNED_ID = 0x7fffffff;
const MAX_EDITABLE_DOCUMENT_BYTES = 64 * 1024 * 1024;
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
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ASSET_ID_PATTERN = /^asset_[0-9a-f]{24}$/u;
const TILED_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const MAP_PATCH_FIELDS = [
  "renderOrder",
  "backgroundColor",
  "className",
] as const;
const LAYER_PATCH_FIELDS = [
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
const FOUR_WAY_TILE_NEIGHBOR_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
type LayerPatchField = (typeof LAYER_PATCH_FIELDS)[number];
type MapPatchField = (typeof MAP_PATCH_FIELDS)[number];
const MAP_PATCH_JSON_KEYS: Record<MapPatchField, string> = {
  renderOrder: "renderorder",
  backgroundColor: "backgroundcolor",
  className: "class",
};
const MAP_RENDER_ORDERS = new Set([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);
const MAP_RENDER_FIELDS = new Set<MapPatchField>([
  "renderOrder",
  "backgroundColor",
]);
const LAYER_PATCH_JSON_KEYS: Record<LayerPatchField, string> = {
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
const LAYER_BLEND_MODES = new Set([
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
const GROUP_DESCENDANT_RENDER_FIELDS =
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

interface LayerTraversalBudget {
  count: number;
}

interface RenderImageBudget {
  revisions: Map<string, string>;
  totalBytes: number;
  totalPixels: number;
  expectedRevisions?: Readonly<Record<string, string>>;
}

interface EditableContext {
  loaded: LoadedDocument;
  width: number;
  height: number;
  orientation: "orthogonal";
  infinite: boolean;
  bindings: TilesetBinding[];
  dependencyRevisions: Record<string, string>;
}

interface EditableContextRevisionGuards {
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
}

interface TilesetBinding {
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

interface TilesetBindingCandidate {
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

type TilesetUsageReference =
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

interface TilesetUsageInspection {
  scannedCellCount: number;
  scannedObjectCount: number;
}

interface ProspectiveTilesetBinding {
  assetId: string;
  path: string;
  tileCount: number;
  gidSpan: number;
  revision: string;
}

interface ProspectiveImageBinding {
  assetId: string;
  path: string;
  revision: string;
  width: number;
  height: number;
}

interface TileLayerView {
  object: JsonObject;
  path: JsonSourcePath;
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: JsonValue[];
}

interface ObjectLayerView {
  object: JsonObject;
  path: JsonSourcePath;
  id: number;
  name: string;
  objects: JsonValue[];
  ancestors: readonly JsonObject[];
}

interface ObjectLocation {
  object: JsonObject;
  objectIndex: number;
  layer: ObjectLayerView;
  ancestors: readonly JsonObject[];
}

interface EditableLayerLocation {
  object: JsonObject;
  path: JsonSourcePath;
  id: number;
  type: CreatableLayerType;
}

interface DeletableLayerLocation
  extends EditableLayerLocation {
  container: JsonValue[];
  containerPath: JsonSourcePath;
  index: number;
  parentGroupId: number | null;
}

interface LayerSubtreeInspection {
  layerIds: number[];
  objectIds: number[];
  lockedLayerCount: number;
  effectivelyLockedLayerCount: number;
  maxRelativeDepth: number;
}

interface ObjectEditIndex {
  byId: Map<number, ObjectLocation>;
  maximumId: number;
}

type BasicEditableObjectShape =
  | "rectangle"
  | "point"
  | "ellipse"
  | "capsule"
  | "polygon"
  | "polyline"
  | "text";

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
  tilesetAssetId: string;
  startTileId?: number;
  limit?: number;
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

export interface PlanAddTilesetToMapInput {
  mapPath: string;
  tilesetPath: string;
  expectedMapRevision: string;
  expectedDependencyRevisions: Record<string, string>;
  expectedTilesetRevision?: string;
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

export class MapService {
  private readonly assetRegistry: AssetRegistry;

  constructor(
    private readonly resolver: ProjectPathResolver,
    private readonly store: DocumentStore,
    assetRegistry?: AssetRegistry,
  ) {
    this.assetRegistry =
      assetRegistry ?? new AssetRegistry(resolver);
  }

  async initializeAssetRegistry(): Promise<void> {
    await this.assetRegistry.initialize();
  }

  async createMap(input: CreateMapInput): Promise<CommitResult> {
    const mapPath = this.resolver.normalize(input.mapPath);
    if (posix.extname(mapPath).toLowerCase() !== ".tmj") {
      throw new TiledMcpError("UNSUPPORTED_FORMAT", "MVP map creation requires a .tmj path.");
    }
    assertPositiveIntegerAtMost(
      input.width,
      "width",
      MAX_CREATE_MAP_DIMENSION,
    );
    assertPositiveIntegerAtMost(
      input.height,
      "height",
      MAX_CREATE_MAP_DIMENSION,
    );
    assertPositiveIntegerAtMost(
      input.tileWidth,
      "tileWidth",
      MAX_CREATE_MAP_TILE_EDGE,
    );
    assertPositiveIntegerAtMost(
      input.tileHeight,
      "tileHeight",
      MAX_CREATE_MAP_TILE_EDGE,
    );
    if (
      input.backgroundColor !== undefined &&
      !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(input.backgroundColor)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "backgroundColor must be #RRGGBB or #AARRGGBB.",
      );
    }

    const map: JsonObject = {
      compressionlevel: -1,
      height: input.height,
      infinite: false,
      layers: [],
      nextlayerid: 1,
      nextobjectid: 1,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: input.tileHeight,
      tilesets: [],
      tilewidth: input.tileWidth,
      type: "map",
      version: "1.10",
      width: input.width,
    };
    if (input.backgroundColor !== undefined) {
      map.backgroundcolor = input.backgroundColor;
    }
    return this.store.create(mapPath, map, "create finite orthogonal TMJ map");
  }

  async getSummary(mapPath: string): Promise<Record<string, unknown>> {
    const context = await this.loadEditableContext(mapPath, {
      allowInfinite: true,
      allowCollectionTilesets: true,
    });
    const rootProperties = summarizeMapRootProperties(
      context.loaded.document,
      context.loaded.path,
    );
    const layers = collectLayerSummaries(
      expectArray(context.loaded.document.layers, `${mapPath}.layers`),
      `${mapPath}.layers`,
      context.infinite,
    );
    return {
      path: context.loaded.path,
      revision: context.loaded.revision,
      format: "tmj",
      orientation: context.orientation,
      infinite: context.infinite,
      ...rootProperties,
      width: context.width,
      height: context.height,
      tileWidth: expectInteger(context.loaded.document.tilewidth, `${mapPath}.tilewidth`),
      tileHeight: expectInteger(context.loaded.document.tileheight, `${mapPath}.tileheight`),
      layers,
      tilesets: context.bindings.map((binding) => ({
        assetId: binding.assetId,
        path: binding.path,
        name: binding.name,
        ...(binding.nameTruncated ? { nameTruncated: true } : {}),
        firstGid: binding.firstGid,
        tileCount: binding.tileCount,
        gidSpan: binding.gidSpan,
        lastPotentialGid:
          binding.firstGid + binding.gidSpan - 1,
        revision: binding.revision,
        ...(binding.collection === true
          ? { collection: true }
          : {}),
      })),
      dependencyRevisions: context.dependencyRevisions,
      editableProfile: context.infinite
        ? "infinite-orthogonal-tmj-read-only-chunked"
        : "finite-orthogonal-tmj-external-atlas-tsj",
    };
  }

  async analyzeUsage(
    input: AnalyzeUsageInput,
  ): Promise<Record<string, unknown>> {
    const hasExpectedMapRevision =
      input.expectedMapRevision !== undefined;
    const hasExpectedDependencyRevisions =
      input.expectedDependencyRevisions !== undefined;
    if (
      hasExpectedMapRevision !==
      hasExpectedDependencyRevisions
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "expectedMapRevision and expectedDependencyRevisions must be provided together.",
      );
    }
    if (input.expectedMapRevision !== undefined) {
      assertRequiredRevision(
        input.expectedMapRevision,
        "expectedMapRevision",
      );
    }
    const topTileLimit = readUsageLimit(
      input.topTileLimit,
      DEFAULT_USAGE_TOP_TILE_LIMIT,
      MAX_USAGE_TOP_TILE_LIMIT,
      "topTileLimit",
    );
    const context = await this.loadEditableContext(input.mapPath, {
      allowInfinite: true,
      ...(input.expectedMapRevision === undefined
        ? {}
        : {
            expectedMapRevision:
              input.expectedMapRevision,
            expectedDependencyRevisions:
              input.expectedDependencyRevisions,
          }),
    });
    const projection = analyzeUsageDocument({
      map: context.loaded.document,
      mapPath: context.loaded.path,
      bindings: context.bindings,
      topTileLimit,
      infinite: context.infinite,
    });

    await this.assertDependenciesUnchanged(context.bindings);
    const currentMapRevision = await this.store.readRevision(
      context.loaded.path,
    );
    if (currentMapRevision !== context.loaded.revision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while tile usage was analyzed.`,
        {
          path: context.loaded.path,
          expectedRevision: context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }

    const result = {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      dependencyRevisions: context.dependencyRevisions,
      profile:
        "finite-orthogonal-tmj-external-atlas-tsj",
      ...projection,
      snapshotConsistency: "non-atomic-read-set",
    };
    assertUsageAnalysisResultSize(result);
    return result;
  }

  async getTileset(input: GetTilesetInput): Promise<Record<string, unknown>> {
    const context = await this.loadEditableContext(input.mapPath);
    const binding = this.requireTilesetBinding(
      context,
      input.tilesetAssetId,
    );
    const tileset = await this.store.read(binding.path);
    if (tileset.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while its details were being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: tileset.revision,
        },
      );
    }
    const imageReference = expectString(
      tileset.document.image,
      `${binding.path}.image`,
    );
    const imagePath = await this.resolver.resolveReference(
      binding.path,
      imageReference,
    );
    const projection = summarizeTilesetDocument({
      document: tileset.document,
      path: binding.path,
      imagePath,
      name: binding.name,
      nameTruncated: binding.nameTruncated,
      tileCount: binding.tileCount,
      startTileId: input.startTileId ?? 0,
      limit: input.limit ?? DEFAULT_TILESET_METADATA_LIMIT,
    });

    await this.assertDependenciesUnchanged(context.bindings);
    const currentMapRevision = await this.store.readRevision(
      context.loaded.path,
    );
    if (currentMapRevision !== context.loaded.revision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while the tileset details were prepared.`,
        {
          path: context.loaded.path,
          expectedRevision: context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }

    const result = {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      source: {
        assetId: binding.assetId,
        revision: binding.revision,
      },
      binding: {
        firstGid: binding.firstGid,
        lastGid: binding.firstGid + binding.gidSpan - 1,
        gidSpan: binding.gidSpan,
      },
      ...projection,
      snapshotConsistency: "non-atomic-read-set",
    };
    assertTilesetDetailResultSize(result);
    return result;
  }

  async findTiles(input: FindTilesInput): Promise<Record<string, unknown>> {
    assertOptionalRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    assertOptionalRevision(
      input.expectedTilesetRevision,
      "expectedTilesetRevision",
    );
    const context = await this.loadEditableContext(input.mapPath, {
      ...(input.expectedMapRevision === undefined
        ? {}
        : { expectedMapRevision: input.expectedMapRevision }),
      ...(input.expectedTilesetRevision === undefined
        ? {}
        : {
            selectedTileset: {
              assetId: input.tilesetAssetId,
              expectedRevision: input.expectedTilesetRevision,
            },
          }),
    });
    if (
      input.expectedMapRevision !== undefined &&
      input.expectedMapRevision !== context.loaded.revision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed since the requested tile-search page.`,
        {
          path: context.loaded.path,
          expectedRevision: input.expectedMapRevision,
          actualRevision: context.loaded.revision,
        },
      );
    }
    const binding = this.requireTilesetBinding(
      context,
      input.tilesetAssetId,
    );
    if (
      input.expectedTilesetRevision !== undefined &&
      input.expectedTilesetRevision !== binding.revision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed since the requested tile-search page.`,
        {
          assetId: binding.assetId,
          expectedRevision: input.expectedTilesetRevision,
          actualRevision: binding.revision,
        },
      );
    }

    const tilesetSnapshot = await this.store.readSnapshot(binding.path);
    if (tilesetSnapshot.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while its tiles were being searched.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: tilesetSnapshot.revision,
        },
      );
    }
    const tileset = this.store.parseSnapshot(tilesetSnapshot);
    const projection = searchTilesetDocument({
      document: tileset.document,
      path: binding.path,
      assetId: binding.assetId,
      tileCount: binding.tileCount,
      query: input.query,
      startTileId: input.startTileId ?? 0,
      limit: input.limit ?? DEFAULT_TILE_FIND_LIMIT,
    });

    await this.assertDependenciesUnchanged(context.bindings);
    const currentMapRevision = await this.store.readRevision(
      context.loaded.path,
    );
    if (currentMapRevision !== context.loaded.revision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while tiles were being searched.`,
        {
          path: context.loaded.path,
          expectedRevision: context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }

    const page = projection.page as {
      hasMore: boolean;
      nextStartTileId?: number;
    };
    const result = {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      source: {
        assetId: binding.assetId,
        revision: binding.revision,
      },
      ...projection,
      ...(page.hasMore && page.nextStartTileId !== undefined
        ? {
            nextPage: {
              startTileId: page.nextStartTileId,
              expectedMapRevision: context.loaded.revision,
              expectedTilesetRevision: binding.revision,
            },
          }
        : {}),
      snapshotConsistency: "non-atomic-read-set",
    };
    assertTileFindResultSize(result);
    return result;
  }

  async renderTilesetSheet(
    input: RenderTilesetSheetInput,
  ): Promise<RenderTilesetSheetResult> {
    const context = await this.loadEditableContext(input.mapPath);
    const binding = this.requireTilesetBinding(
      context,
      input.tilesetAssetId,
    );

    const tilesetSnapshot =
      await this.store.readSnapshot(binding.path);
    if (tilesetSnapshot.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the tileset sheet was being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: tilesetSnapshot.revision,
        },
      );
    }
    const tileset =
      this.store.parseSnapshot(tilesetSnapshot);
    const document = tileset.document;
    if (typeof document.image !== "string") {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        "Tileset sheets require a root atlas image.",
        { path: binding.path },
      );
    }
    assertRootAtlasTileDefinitions(
      document,
      binding.path,
      binding.tileCount,
    );

    const imagePath = await this.resolver.resolveReference(
      binding.path,
      document.image,
    );
    const image = await readImageFileSnapshot(
      this.resolver,
      imagePath,
      MAX_TILESET_IMAGE_BYTES,
    );
    const tileWidth = expectInteger(
      document.tilewidth,
      `${binding.path}.tilewidth`,
    );
    const tileHeight = expectInteger(
      document.tileheight,
      `${binding.path}.tileheight`,
    );
    const tileCount = expectInteger(
      document.tilecount,
      `${binding.path}.tilecount`,
    );
    const atlasColumns = expectInteger(
      document.columns,
      `${binding.path}.columns`,
    );
    const margin = expectInteger(
      document.margin ?? 0,
      `${binding.path}.margin`,
    );
    const spacing = expectInteger(
      document.spacing ?? 0,
      `${binding.path}.spacing`,
    );
    const declaredImageWidth = expectInteger(
      document.imagewidth,
      `${binding.path}.imagewidth`,
    );
    const declaredImageHeight = expectInteger(
      document.imageheight,
      `${binding.path}.imageheight`,
    );
    const transparentColor =
      document.transparentcolor === undefined
        ? undefined
        : expectString(
            document.transparentcolor,
            `${binding.path}.transparentcolor`,
          );

    const rendered = await renderTilesetSheet({
      imageBytes: image.bytes,
      imagePath: image.path,
      imageWidth: declaredImageWidth,
      imageHeight: declaredImageHeight,
      tileWidth,
      tileHeight,
      tileCount,
      atlasColumns,
      margin,
      spacing,
      page: input.page ?? 0,
      pageSize: input.pageSize ?? DEFAULT_TILESET_SHEET_PAGE_SIZE,
      scale: input.scale ?? DEFAULT_TILESET_SHEET_SCALE,
      ...(input.columns === undefined
        ? {}
        : { sheetColumns: input.columns }),
      ...(transparentColor === undefined ? {} : { transparentColor }),
    });

    await this.assertDependenciesUnchanged([binding]);
    const currentMapRevision = await this.store.readRevision(
      context.loaded.path,
    );
    if (currentMapRevision !== context.loaded.revision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while the tileset sheet was rendered.`,
        {
          path: context.loaded.path,
          expectedRevision: context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }

    return {
      png: rendered.png,
      result: {
        mimeType: rendered.mimeType,
        pixelSize: rendered.pixelSize,
        byteLength: rendered.byteLength,
        sha256: rendered.sha256,
        source: {
          assetId: binding.assetId,
          revision: binding.revision,
        },
        map: {
          path: context.loaded.path,
          revision: context.loaded.revision,
        },
        image: {
          path: image.path,
          revision: image.revision,
          format: rendered.image.format,
          pixelSize: rendered.image.pixelSize,
        },
        tileset: {
          path: binding.path,
          name: binding.name,
          ...(binding.nameTruncated ? { nameTruncated: true } : {}),
          tileCount,
          tileSize: { width: tileWidth, height: tileHeight },
          atlas: {
            columns: atlasColumns,
            margin,
            spacing,
          },
        },
        page: rendered.page,
        scale: rendered.scale,
        truncated: false,
      },
    };
  }

  async renderTiles(
    input: RenderTilesInput,
  ): Promise<RenderTilesResult> {
    assertOptionalRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    assertOptionalRevision(
      input.expectedTilesetRevision,
      "expectedTilesetRevision",
    );
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        ...(input.expectedMapRevision === undefined
          ? {}
          : {
              expectedMapRevision:
                input.expectedMapRevision,
            }),
        ...(input.expectedTilesetRevision ===
        undefined
          ? {}
          : {
              selectedTileset: {
                assetId: input.tilesetAssetId,
                expectedRevision:
                  input.expectedTilesetRevision,
              },
            }),
      },
    );
    const binding = this.requireTilesetBinding(
      context,
      input.tilesetAssetId,
    );

    const tilesetSnapshot =
      await this.store.readSnapshot(binding.path);
    if (
      tilesetSnapshot.revision !==
      binding.revision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the explicit tile selection was being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision:
            tilesetSnapshot.revision,
        },
      );
    }
    const tileset =
      this.store.parseSnapshot(tilesetSnapshot);
    const document = tileset.document;
    if (typeof document.image !== "string") {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        "Explicit tile rendering requires a root atlas image.",
        {
          path: binding.path,
          assetId: binding.assetId,
        },
      );
    }

    const tileCount = expectInteger(
      document.tilecount,
      `${binding.path}.tilecount`,
    );
    assertRootAtlasTileDefinitions(
      document,
      binding.path,
      tileCount,
    );
    assertSelectedLocalIds(
      input.localIds,
      tileCount,
      binding.path,
    );

    const imagePath =
      await this.resolver.resolveReference(
        binding.path,
        document.image,
      );
    const image = await readImageFileSnapshot(
      this.resolver,
      imagePath,
      MAX_TILESET_IMAGE_BYTES,
    );
    const tileWidth = expectInteger(
      document.tilewidth,
      `${binding.path}.tilewidth`,
    );
    const tileHeight = expectInteger(
      document.tileheight,
      `${binding.path}.tileheight`,
    );
    const atlasColumns = expectInteger(
      document.columns,
      `${binding.path}.columns`,
    );
    const margin = expectInteger(
      document.margin ?? 0,
      `${binding.path}.margin`,
    );
    const spacing = expectInteger(
      document.spacing ?? 0,
      `${binding.path}.spacing`,
    );
    const declaredImageWidth = expectInteger(
      document.imagewidth,
      `${binding.path}.imagewidth`,
    );
    const declaredImageHeight = expectInteger(
      document.imageheight,
      `${binding.path}.imageheight`,
    );
    const transparentColor =
      document.transparentcolor === undefined
        ? undefined
        : expectString(
            document.transparentcolor,
            `${binding.path}.transparentcolor`,
          );

    const rendered = await renderTilesetTiles({
      imageBytes: image.bytes,
      imagePath: image.path,
      imageWidth: declaredImageWidth,
      imageHeight: declaredImageHeight,
      tileWidth,
      tileHeight,
      tileCount,
      atlasColumns,
      margin,
      spacing,
      localIds: input.localIds,
      ...(input.columns === undefined
        ? {}
        : { columns: input.columns }),
      ...(input.scale === undefined
        ? {}
        : { scale: input.scale }),
      ...(transparentColor === undefined
        ? {}
        : { transparentColor }),
    });

    await this.assertDependenciesUnchanged([
      binding,
    ]);
    const currentMapRevision =
      await this.store.readRevision(
        context.loaded.path,
      );
    if (
      currentMapRevision !==
      context.loaded.revision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while the explicit tile selection was rendered.`,
        {
          path: context.loaded.path,
          expectedRevision:
            context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }

    return {
      png: rendered.png,
      result: {
        mimeType: rendered.mimeType,
        pixelSize: rendered.pixelSize,
        byteLength: rendered.byteLength,
        sha256: rendered.sha256,
        map: {
          path: context.loaded.path,
          revision: context.loaded.revision,
        },
        source: {
          assetId: binding.assetId,
          revision: binding.revision,
        },
        image: {
          path: image.path,
          revision: image.revision,
          format: rendered.image.format,
          pixelSize:
            rendered.image.pixelSize,
        },
        tileset: {
          path: binding.path,
          name: binding.name,
          ...(binding.nameTruncated
            ? { nameTruncated: true }
            : {}),
          tileCount,
          tileSize: {
            width: tileWidth,
            height: tileHeight,
          },
          atlas: {
            columns: atlasColumns,
            margin,
            spacing,
          },
        },
        renderProfile:
          "explicit-local-id-atlas-selection-v1",
        selection: rendered.selection,
        scale: rendered.scale,
        snapshotConsistency:
          "non-atomic-read-set",
        truncated: false,
      },
    };
  }

  async renderPreview(
    input: RenderPreviewInput,
  ): Promise<RenderPreviewResult> {
    const context = await this.loadEditableContext(input.mapPath, {
      allowInfinite: true,
    });
    const map = context.loaded.document;
    const tileWidth = expectInteger(
      map.tilewidth,
      `${context.loaded.path}.tilewidth`,
    );
    const tileHeight = expectInteger(
      map.tileheight,
      `${context.loaded.path}.tileheight`,
    );
    const scene = buildPreviewScene(
      map,
      context.loaded.path,
      context.width,
      context.height,
      context.bindings.map((binding) => ({
        assetId: binding.assetId,
        firstGid: binding.firstGid,
        tileCount: binding.tileCount,
        name: binding.name,
      })),
      {
        ...(input.region === undefined ? {} : { region: input.region }),
        ...(input.layerIds === undefined ? {} : { layerIds: input.layerIds }),
      },
    );
    await this.resolveBaseTileObjects(
      scene,
      context.bindings,
      context.loaded.path,
    );
    prepareNativePreviewHighlightOverlay(
      input.overlays?.highlights,
      scene.region,
    );
    const preparedObjectDebug =
      prepareNativePreviewObjectDebug(
        map,
        context.loaded.path,
        input.overlays?.objectIds,
        context.bindings,
        input.overlays?.tileObjectCollision === true,
      );
    if (
      preparedObjectDebug !== undefined &&
      preparedObjectDebug.pendingTileFrames.length > 0
    ) {
      await this.resolveTileObjectFrames(
        context.bindings,
        preparedObjectDebug,
      );
    }
    const objectDebug = preparedObjectDebug?.objects;

    const atlases: NativePreviewAtlas[] = [];
    const sources: Array<Record<string, unknown>> = [];
    let aggregateImageBytes = 0;
    let aggregateDecodedPixels = 0;
    for (const assetId of scene.usedAssetIds) {
      const binding = context.bindings.find(
        (candidate) => candidate.assetId === assetId,
      );
      if (binding === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          `Preview source ${assetId} disappeared from the map context.`,
          { assetId },
        );
      }
      const loaded = await this.loadPreviewAtlas(
        binding,
        tileWidth,
        tileHeight,
        MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES -
          aggregateImageBytes,
        MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS -
          aggregateDecodedPixels,
      );
      aggregateImageBytes += loaded.image.bytes.byteLength;
      aggregateDecodedPixels +=
        loaded.geometry.imageWidth * loaded.geometry.imageHeight;
      if (aggregateImageBytes > MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Preview atlas inputs exceed the ${MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES} byte aggregate limit.`,
          {
            actual: aggregateImageBytes,
            limit: MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
          },
        );
      }
      if (
        !Number.isSafeInteger(aggregateDecodedPixels) ||
        aggregateDecodedPixels >
          MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Preview atlases exceed the ${MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS} decoded-pixel aggregate limit.`,
          {
            actual: aggregateDecodedPixels,
            limit: MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
          },
        );
      }
      atlases.push({
        assetId: binding.assetId,
        firstGid: binding.firstGid,
        tileCount: binding.tileCount,
        rgba: loaded.decoded.rgba,
        format: loaded.decoded.format,
        geometry: loaded.geometry,
        ...(loaded.transparentColor === undefined
          ? {}
          : { transparentColor: loaded.transparentColor }),
      });
      sources.push({
        assetId: binding.assetId,
        tileset: {
          path: binding.path,
          revision: binding.revision,
        },
        image: {
          path: loaded.image.path,
          revision: loaded.image.revision,
          format: loaded.decoded.format,
          pixelSize: loaded.decoded.pixelSize,
        },
      });
    }
    atlases.sort((left, right) => left.firstGid - right.firstGid);

    const scale = input.scale ?? DEFAULT_NATIVE_PREVIEW_SCALE;
    const overlays = {
      grid: input.overlays?.grid ?? false,
      coordinates: input.overlays?.coordinates ?? false,
      ...(input.overlays?.highlights === undefined
        ? {}
        : { highlights: input.overlays.highlights }),
      ...(objectDebug === undefined
        ? {}
        : { objectDebug }),
    };
    let rendered;
    try {
      rendered = await renderNativePreview({
        tileWidth,
        tileHeight,
        region: scene.region,
        layers: scene.layers,
        objectLayers: scene.objectLayers,
        drawList: scene.drawList,
        atlases,
        scale,
        overlays,
        ...(map.backgroundcolor === undefined
          ? {}
          : {
              backgroundColor: expectString(
                map.backgroundcolor,
                `${context.loaded.path}.backgroundcolor`,
              ),
            }),
      });
    } catch (error) {
      if (
        input.region === undefined &&
        error instanceof TiledMcpError &&
        error.code === "PREVIEW_DIMENSIONS_EXCEEDED"
      ) {
        throw new TiledMcpError(
          "PREVIEW_REGION_REQUIRED",
          "The full map exceeds the native preview output budget; provide a smaller region or scale.",
          {
            ...error.details,
            mapBounds: {
              x: 0,
              y: 0,
              width: context.width,
              height: context.height,
            },
          },
        );
      }
      throw error;
    }

    await this.assertDependenciesUnchanged(context.bindings);
    const currentMapRevision = await this.store.readRevision(
      context.loaded.path,
    );
    if (currentMapRevision !== context.loaded.revision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while the native preview was rendered.`,
        {
          path: context.loaded.path,
          expectedRevision: context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }

    return {
      png: rendered.png,
      result: {
        mimeType: rendered.mimeType,
        pixelSize: rendered.pixelSize,
        byteLength: rendered.byteLength,
        sha256: rendered.sha256,
        map: {
          path: context.loaded.path,
          revision: context.loaded.revision,
        },
        dependencyRevisions: context.dependencyRevisions,
        sources,
        tileRegion: scene.region,
        coordinateTransform: rendered.coordinateTransform,
        contentPixelRect: rendered.contentPixelRect,
        layerIds: scene.layers.map((layer) => layer.id),
        layerSelection: scene.layerSelection,
        omittedLayers: scene.omittedLayers,
        omittedLayerCount: scene.omittedLayerCount,
        omittedLayersTruncated: scene.omittedLayersTruncated,
        partial: scene.omittedLayerCount > 0,
        snapshotConsistency: "non-atomic-read-set",
        scale,
        overlays: {
          grid: overlays.grid,
          coordinates: overlays.coordinates,
          highlights: rendered.highlightOverlay,
          objectDebug:
            rendered.objectDebugOverlay,
        },
        objectLayers: rendered.objectLayers,
        objectLayerRendering: {
          profile: "base-object-layers-v1",
          colors:
            "group-color-else-gray-class-colors-unsupported",
          fillAlpha: 50,
          shadow: "one-pixel-black-offset",
          stroke: "one-pixel-cosmetic",
          text: "layout-box-only",
          tileObjects:
            "affine-nearest-neighbor-images",
          templates: "omitted-counted",
          pointMarker:
            "tiled-pin-cosmetic-radius-10",
          drawOrder:
            "tiled-topdown-stable-or-index",
          opacity:
            "layer-times-object-source-over",
        },
        renderProfile: context.infinite
          ? "infinite-orthogonal-static-atlas-chunked-tilelayers-v1"
          : "finite-orthogonal-static-atlas-tilelayers-v1",
        truncated: false,
      },
    };
  }

  /**
   * Resolves base-preview tile objects: decodes each encoded GID, loads the
   * owning tileset's frame metadata, and attaches the tile-image-to-anchor
   * affine (the same fragment math as the collision overlay, without a
   * per-shape rotation). Newly referenced atlases join the scene's atlas
   * set.
   */
  private async resolveBaseTileObjects(
    scene: PreviewScene,
    bindings: readonly TilesetBinding[],
    mapPath: string,
  ): Promise<void> {
    const frames = new Map<
      string,
      TileObjectFrameTileset
    >();
    for (const layer of scene.objectLayers) {
      for (const object of layer.objects) {
        if (
          object.shape !== "tile" ||
          object.gid === undefined
        ) {
          continue;
        }
        const decoded = decodeGid(
          object.gid,
          "orthogonal",
        );
        if (decoded.baseGid === 0) {
          throw new TiledMcpError(
            "INVALID_GID",
            `Object ${object.id} carries a flip-only GID without a tile.`,
            {
              path: mapPath,
              layerId: layer.id,
              objectId: object.id,
              gid: object.gid,
            },
          );
        }
        const binding = bindings.find(
          (candidate) =>
            decoded.baseGid >=
              candidate.firstGid &&
            decoded.baseGid <
              candidate.firstGid +
                candidate.gidSpan,
        );
        if (binding === undefined) {
          throw new TiledMcpError(
            "GID_OUT_OF_RANGE",
            `Object ${object.id} GID ${decoded.baseGid} is outside every tileset range.`,
            {
              path: mapPath,
              layerId: layer.id,
              objectId: object.id,
              gid: decoded.baseGid,
            },
          );
        }
        const localId =
          decoded.baseGid - binding.firstGid;
        if (localId >= binding.tileCount) {
          throw new TiledMcpError(
            "INVALID_GID",
            `Object ${object.id} GID ${decoded.baseGid} points into the reserved gap of ${binding.path}.`,
            {
              path: mapPath,
              layerId: layer.id,
              objectId: object.id,
              gid: decoded.baseGid,
            },
          );
        }
        let frame = frames.get(binding.assetId);
        if (frame === undefined) {
          frame =
            await this.loadTileObjectFrameTileset(
              binding,
            );
          frames.set(binding.assetId, frame);
        }
        const transform =
          decoded.transform as OrthogonalTransform;
        const width =
          object.width === 0
            ? frame.tileWidth
            : object.width;
        const height =
          object.height === 0
            ? frame.tileHeight
            : object.height;
        const alignmentOffset =
          tileObjectAlignmentOffset(
            frame.objectAlignment,
            width,
            height,
          );
        const scaleX =
          width / frame.tileWidth;
        const scaleY =
          height / frame.tileHeight;
        let rotated = false;
        let flipH = transform.flipH;
        let flipV = transform.flipV;
        let fragmentX =
          width / 2 +
          frame.tileOffsetX * scaleX;
        let fragmentY =
          height / 2 +
          frame.tileOffsetY * scaleY;
        if (transform.flipD) {
          rotated = true;
          const wasFlippedH = flipH;
          flipH = flipV;
          flipV = !wasFlippedH;
          const halfDiff =
            height / 2 - width / 2;
          fragmentX += halfDiff;
          fragmentY += halfDiff;
        }
        const signedScaleX =
          (flipH ? -1 : 1) * scaleX;
        const signedScaleY =
          (flipV ? -1 : 1) * scaleY;
        const linearA = rotated
          ? 0
          : signedScaleX;
        const linearB = rotated
          ? signedScaleX
          : 0;
        const linearC = rotated
          ? -signedScaleY
          : 0;
        const linearD = rotated
          ? 0
          : signedScaleY;
        const centerX = frame.tileWidth / 2;
        const centerY = frame.tileHeight / 2;
        object.width = width;
        object.height = height;
        object.tileRender = {
          assetId: binding.assetId,
          localId,
          transform: [
            linearA,
            linearB,
            linearC,
            linearD,
            fragmentX -
              alignmentOffset.x -
              (linearA * centerX +
                linearC * centerY),
            fragmentY -
              alignmentOffset.y -
              (linearB * centerX +
                linearD * centerY),
          ],
        };
        if (
          !scene.usedAssetIds.includes(
            binding.assetId,
          )
        ) {
          scene.usedAssetIds.push(
            binding.assetId,
          );
        }
      }
    }
  }

  private async resolveTileObjectFrames(
    bindings: readonly TilesetBinding[],
    prepared: PreparedNativePreviewObjectDebug,
  ): Promise<void> {
    const frames = new Map<
      string,
      TileObjectFrameTileset
    >();
    const collisionLocalIds = new Map<
      string,
      Set<number>
    >();
    if (prepared.tileObjectCollision) {
      for (const pending of prepared.pendingTileFrames) {
        let ids = collisionLocalIds.get(
          pending.assetId,
        );
        if (ids === undefined) {
          ids = new Set<number>();
          collisionLocalIds.set(
            pending.assetId,
            ids,
          );
        }
        ids.add(pending.localId);
      }
    }
    for (const pending of prepared.pendingTileFrames) {
      let frame = frames.get(pending.assetId);
      if (frame === undefined) {
        const binding = bindings.find(
          (candidate) =>
            candidate.assetId === pending.assetId,
        );
        if (binding === undefined) {
          throw new TiledMcpError(
            "INTERNAL_ERROR",
            `Tile object frame tileset ${pending.assetId} disappeared from the map context.`,
            { assetId: pending.assetId },
          );
        }
        frame =
          await this.loadTileObjectFrameTileset(
            binding,
            collisionLocalIds.get(pending.assetId),
          );
        frames.set(pending.assetId, frame);
      }
      const entry =
        prepared.objects[pending.entryIndex];
      if (
        entry === undefined ||
        entry.shape !== "tile"
      ) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          "Tile object frame lost its prepared debug entry.",
          { objectId: pending.objectId },
        );
      }
      const width =
        pending.rawWidth === 0
          ? frame.tileWidth
          : pending.rawWidth;
      const height =
        pending.rawHeight === 0
          ? frame.tileHeight
          : pending.rawHeight;
      const alignmentOffset =
        tileObjectAlignmentOffset(
          frame.objectAlignment,
          width,
          height,
        );
      const boxOffsetX =
        -alignmentOffset.x +
        (frame.tileOffsetX * width) /
          frame.tileWidth;
      const boxOffsetY =
        -alignmentOffset.y +
        (frame.tileOffsetY * height) /
          frame.tileHeight;
      for (const [field, value] of [
        ["width", width],
        ["height", height],
        ["boxOffsetX", boxOffsetX],
        ["boxOffsetY", boxOffsetY],
      ] as const) {
        if (
          !Number.isFinite(value) ||
          Math.abs(value) >
            MAX_ABSOLUTE_OBJECT_NUMBER
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            `Object ${pending.objectId} tile frame ${field} is outside the supported numeric range.`,
            {
              objectId: pending.objectId,
              field,
              value,
            },
          );
        }
      }
      entry.width = width;
      entry.height = height;
      entry.boxOffsetX = boxOffsetX;
      entry.boxOffsetY = boxOffsetY;
      if (prepared.tileObjectCollision) {
        entry.representation =
          "tile-frame-and-collision";
        entry.collisionShapes =
          buildTileCollisionShapeInputs(
            pending,
            frame,
            {
              width,
              height,
              alignmentOffsetX: alignmentOffset.x,
              alignmentOffsetY: alignmentOffset.y,
            },
          );
      }
    }
  }

  private async loadTileObjectFrameTileset(
    binding: TilesetBinding,
    collisionLocalIds?: ReadonlySet<number>,
  ): Promise<TileObjectFrameTileset> {
    const snapshot = await this.store.readSnapshot(
      binding.path,
    );
    if (snapshot.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the tile object frames were being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: snapshot.revision,
        },
      );
    }
    const document =
      this.store.parseSnapshot(snapshot).document;
    const tileWidth = expectInteger(
      document.tilewidth,
      `${binding.path}.tilewidth`,
    );
    const tileHeight = expectInteger(
      document.tileheight,
      `${binding.path}.tileheight`,
    );
    assertPositiveInteger(
      tileWidth,
      `${binding.path}.tilewidth`,
    );
    assertPositiveInteger(
      tileHeight,
      `${binding.path}.tileheight`,
    );
    const tileOffset = readTilesetTileOffset(
      document,
      binding.path,
    );
    return {
      tileWidth,
      tileHeight,
      objectAlignment: readTilesetObjectAlignment(
        document,
        binding.path,
      ),
      tileOffsetX: tileOffset.x,
      tileOffsetY: tileOffset.y,
      collision:
        collisionLocalIds === undefined
          ? new Map()
          : readTilesetCollisionSources(
              document,
              binding.path,
              collisionLocalIds,
            ),
    };
  }

  async getRegion(input: GetRegionInput): Promise<Record<string, unknown>> {
    assertSafeInteger(input.layerId, "layerId");
    assertSafeInteger(input.x, "x");
    assertSafeInteger(input.y, "y");
    assertPositiveInteger(input.width, "width");
    assertPositiveInteger(input.height, "height");
    if (input.width * input.height > MAX_REGION_CELLS) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A region may contain at most ${MAX_REGION_CELLS} cells.`,
        { limit: MAX_REGION_CELLS },
      );
    }

    const context = await this.loadEditableContext(input.mapPath, {
      allowInfinite: true,
      allowCollectionTilesets: true,
    });
    const rows: Array<Array<TileRef | null>> = [];
    let layerDescriptor: { id: number; name: string };
    if (context.infinite) {
      const located = findChunkedTileLayer(
        context.loaded.document,
        input.layerId,
        input.mapPath,
      );
      layerDescriptor = {
        id: located.id,
        name: located.name,
      };
      const gids = readChunkedRegionGids(
        located.object,
        located.id,
        input.mapPath,
        {
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
        },
      );
      for (let y = 0; y < input.height; y += 1) {
        const row: Array<TileRef | null> = [];
        for (let x = 0; x < input.width; x += 1) {
          const gid = gids[y * input.width + x];
          if (
            typeof gid !== "number" ||
            !Number.isSafeInteger(gid)
          ) {
            throw new TiledMcpError(
              "INVALID_TILE_DATA",
              `Layer ${located.id} has a non-integer GID.`,
              {
                layerId: located.id,
                x: input.x + x,
                y: input.y + y,
              },
            );
          }
          row.push(
            gidToTileRef(
              gid,
              context.orientation,
              context.bindings,
            ),
          );
        }
        rows.push(row);
      }
    } else {
      const layer = findTileLayer(
        context.loaded.document,
        input.layerId,
        input.mapPath,
        "read",
      );
      layerDescriptor = {
        id: layer.id,
        name: layer.name,
      };
      assertRegionInsideLayer(layer, input.x, input.y, input.width, input.height);
      for (let y = input.y; y < input.y + input.height; y += 1) {
        const row: Array<TileRef | null> = [];
        for (let x = input.x; x < input.x + input.width; x += 1) {
          const gid = readLayerGid(layer, x, y);
          row.push(gidToTileRef(gid, context.orientation, context.bindings));
        }
        rows.push(row);
      }
    }

    return {
      mapPath: context.loaded.path,
      revision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      layer: layerDescriptor,
      region: {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      },
      rows,
    };
  }

  async listObjects(input: ListObjectsInput): Promise<Record<string, unknown>> {
    if (input.layerId !== undefined) {
      assertSafeInteger(input.layerId, "layerId");
    }
    const limit = input.limit ?? 1_000;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > MAX_OBJECT_LIST_LIMIT
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `limit must be between 1 and ${MAX_OBJECT_LIST_LIMIT}.`,
      );
    }

    const context = await this.loadEditableContext(input.mapPath, {
      allowCollectionTilesets: true,
    });
    const locations =
      input.layerId === undefined
        ? collectObjectLocations(context.loaded.document, context.loaded.path)
        : collectObjectLocationsFromLayer(
            findObjectLayer(
              context.loaded.document,
              input.layerId,
              context.loaded.path,
            ),
            context.loaded.path,
          );
    return {
      mapPath: context.loaded.path,
      revision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      total: locations.length,
      truncated: locations.length > limit,
      objects: locations.slice(0, limit).map(summarizeObjectLocation),
    };
  }

  async getObject(input: GetObjectInput): Promise<Record<string, unknown>> {
    assertPositiveInteger(input.objectId, "objectId");
    const context = await this.loadEditableContext(input.mapPath, {
      allowCollectionTilesets: true,
    });
    const location = findObjectLocation(
      buildObjectEditIndex(
        context.loaded.document,
        context.loaded.path,
      ),
      input.objectId,
      context.loaded.path,
    );
    const shape = assertBasicEditableObject(
      location.object,
      input.objectId,
      context.loaded.path,
    );
    return {
      mapPath: context.loaded.path,
      revision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      object: describeEditableObject(
        location,
        shape,
        context.loaded.path,
      ),
    };
  }

  async planAddTilesetToMap(
    input: PlanAddTilesetToMapInput,
  ): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    assertOptionalRevision(
      input.expectedTilesetRevision,
      "expectedTilesetRevision",
    );
    const mapPath = this.resolver.normalize(input.mapPath);
    const tilesetPath = this.resolver.normalize(input.tilesetPath);
    if (posix.extname(tilesetPath).toLowerCase() !== ".tsj") {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Adding a tileset to an MVP map requires an existing .tsj file.",
        { path: tilesetPath },
      );
    }

    const context = await this.loadEditableContext(mapPath, {
      expectedMapRevision: input.expectedMapRevision,
      expectedDependencyRevisions:
        input.expectedDependencyRevisions,
    });
    assertDependencyRevisions(
      input.expectedDependencyRevisions,
      context.dependencyRevisions,
    );
    const prospective = await this.loadProspectiveTilesetBinding(
      tilesetPath,
      input.expectedTilesetRevision,
    );
    const operation = resolveAddTilesetToMapOperation(
      context,
      prospective,
    );
    const edited = cloneJson(context.loaded.document);
    const operations: PlannedMapEditOperation[] = [operation];
    const summary = validateAndSummarizeOperations(
      edited,
      context.orientation,
      context.bindings,
      operations,
      context.loaded.path,
      {
        allowResolvedAddTileset: true,
        sourceBytes: context.loaded.size,
      },
    );
    const unsignedPlan: Omit<MapEditPlan, "id"> = {
      kind: "mapEdit",
      version: 1,
      mapPath: context.loaded.path,
      baseRevision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      prospectiveDependencyRevisions: {
        [prospective.assetId]: prospective.revision,
      },
      operations,
      summary,
    };

    await this.assertDependenciesUnchanged(context.bindings);
    await assertRevisionUnchanged(
      this.store,
      prospective.path,
      prospective.revision,
      "DEPENDENCY_REVISION_CONFLICT",
      {
        assetId: prospective.assetId,
      },
    );
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
    );
    return { ...unsignedPlan, id: planId(unsignedPlan) };
  }

  async planUpdateTile(
    input: UpdateTileInput,
  ): Promise<TilesetEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    assertRequiredRevision(
      input.expectedTilesetRevision,
      "expectedTilesetRevision",
    );
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        expectedMapRevision:
          input.expectedMapRevision,
      },
    );
    const binding = this.requireTilesetBinding(
      context,
      input.tilesetAssetId,
    );
    if (
      binding.revision !==
      input.expectedTilesetRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} does not match the expected tileset revision.`,
        {
          assetId: binding.assetId,
          expectedRevision:
            input.expectedTilesetRevision,
          actualRevision: binding.revision,
        },
      );
    }
    const loaded =
      await this.loadBoundTilesetForEdit(
        binding,
      );
    const edited = cloneJson(loaded.document);
    const planned = applyTileMetadataUpdates(
      edited,
      binding.tileCount,
      structuredClone(
        input.updates,
      ) as TileMetadataUpdate[],
      binding.path,
    );
    const unsignedPlan: Omit<TilesetEditPlan, "id"> = {
      kind: "tilesetEdit",
      version: 1,
      mapPath: context.loaded.path,
      tilesetPath: binding.path,
      assetId: binding.assetId,
      baseRevision: binding.revision,
      mapRevision: context.loaded.revision,
      updates: structuredClone(
        input.updates,
      ) as TileMetadataUpdate[],
      summary: planned.summary,
    };
    await assertRevisionUnchanged(
      this.store,
      binding.path,
      binding.revision,
      "DEPENDENCY_REVISION_CONFLICT",
      { assetId: binding.assetId },
    );
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
    );
    return {
      ...unsignedPlan,
      id: tilesetEditPlanId(unsignedPlan),
    };
  }

  async applyTilesetEdit(
    plan: TilesetEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    assertTilesetEditPlan(plan);
    const context = await this.loadEditableContext(
      plan.mapPath,
      {
        expectedMapRevision: plan.mapRevision,
        persistIdentity: true,
      },
    );
    const binding = this.requireTilesetBinding(
      context,
      plan.assetId,
    );
    if (
      binding.path !== plan.tilesetPath ||
      binding.revision !== plan.baseRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${plan.tilesetPath} no longer matches the pinned tileset binding.`,
        {
          assetId: plan.assetId,
          expectedRevision: plan.baseRevision,
          actualRevision: binding.revision,
        },
      );
    }
    const loaded =
      await this.loadBoundTilesetForEdit(
        binding,
      );
    const edited = cloneJson(loaded.document);
    const applied = applyTileMetadataUpdates(
      edited,
      binding.tileCount,
      structuredClone(
        plan.updates,
      ) as TileMetadataUpdate[],
      binding.path,
    );
    if (
      stableJson(
        applied.summary as unknown as JsonValue,
      ) !==
      stableJson(plan.summary as unknown as JsonValue)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The tileset edit summary does not match its updates.",
      );
    }
    const patchedSource = patchJsonDocumentSource(
      loaded.source,
      edited,
      [],
      plan.tilesetPath,
      applied.patches.insertions,
      applied.patches.memberPatches,
      applied.patches.deletions,
      [],
    );
    const result = await this.store.commitBytes(
      plan.tilesetPath,
      plan.baseRevision,
      patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  async planCreateTileset(
    input: CreateTilesetInput,
  ): Promise<TilesetCreatePlan> {
    const tilesetPath = this.resolver.normalize(
      input.tilesetPath,
    );
    if (
      posix.extname(tilesetPath).toLowerCase() !==
      ".tsj"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Tileset creation requires a .tsj path.",
      );
    }
    const scalars = {
      name:
        input.name ??
        posix.basename(tilesetPath, ".tsj"),
      className: input.className ?? null,
      tileWidth: input.tileWidth,
      tileHeight: input.tileHeight,
      margin: input.margin ?? 0,
      spacing: input.spacing ?? 0,
    };
    validateCreateTilesetScalars(scalars);
    await this.assertCreateTargetAbsent(
      tilesetPath,
    );

    const imagePath = this.resolver.normalize(
      input.imagePath,
    );
    const snapshot = await readImageFileSnapshot(
      this.resolver,
      imagePath,
      MAX_TILESET_IMAGE_BYTES,
    );
    const metadata = await inspectSafeImage({
      bytes: snapshot.bytes,
      path: snapshot.path,
      limits: {
        maxInputBytes: MAX_TILESET_IMAGE_BYTES,
        maxInputPixels: MAX_TILESET_INPUT_PIXELS,
        maxInputEdge: MAX_TILESET_INPUT_EDGE,
      },
    });
    const source = relativeProjectReference(
      tilesetPath,
      snapshot.path,
      "atlas image",
    );
    const grid = computeAtlasGrid({
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      tileWidth: scalars.tileWidth,
      tileHeight: scalars.tileHeight,
      margin: scalars.margin,
      spacing: scalars.spacing,
    });
    const document = buildTilesetDocument({
      ...scalars,
      imageSource: source,
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      columns: grid.columns,
      tileCount: grid.tileCount,
    });
    const content =
      serializeJsonDocument(document);
    const unsigned: Omit<TilesetCreatePlan, "id"> =
      {
        kind: "tilesetCreate",
        version: 1,
        tilesetPath,
        baseRevision: revisionOf(content),
        ...scalars,
        image: {
          path: snapshot.path,
          source,
          revision: snapshot.revision,
          width: metadata.width,
          height: metadata.height,
        },
        summary: {
          tilesetPath,
          ...scalars,
          columns: grid.columns,
          rows: grid.rows,
          tileCount: grid.tileCount,
          imageWidth: metadata.width,
          imageHeight: metadata.height,
          unusedRightPixels:
            grid.unusedRightPixels,
          unusedBottomPixels:
            grid.unusedBottomPixels,
          contentBytes: content.byteLength,
          wouldChange: true,
        },
      };
    return {
      ...unsigned,
      id: tilesetCreatePlanId(unsigned),
    };
  }

  async applyTilesetCreate(
    plan: TilesetCreatePlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    assertTilesetCreatePlan(plan);
    const image = await readImageFileSnapshot(
      this.resolver,
      plan.image.path,
      MAX_TILESET_IMAGE_BYTES,
    );
    if (image.revision !== plan.image.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${plan.image.path} changed while the tileset creation was being prepared.`,
        {
          path: plan.image.path,
          expectedRevision: plan.image.revision,
          actualRevision: image.revision,
        },
      );
    }
    const grid = computeAtlasGrid({
      imageWidth: plan.image.width,
      imageHeight: plan.image.height,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
      margin: plan.margin,
      spacing: plan.spacing,
    });
    const document = buildTilesetDocument({
      name: plan.name,
      className: plan.className,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
      margin: plan.margin,
      spacing: plan.spacing,
      imageSource: plan.image.source,
      imageWidth: plan.image.width,
      imageHeight: plan.image.height,
      columns: grid.columns,
      tileCount: grid.tileCount,
    });
    const content =
      serializeJsonDocument(document);
    const replayedSummary = {
      tilesetPath: plan.tilesetPath,
      name: plan.name,
      className: plan.className,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
      margin: plan.margin,
      spacing: plan.spacing,
      columns: grid.columns,
      rows: grid.rows,
      tileCount: grid.tileCount,
      imageWidth: plan.image.width,
      imageHeight: plan.image.height,
      unusedRightPixels: grid.unusedRightPixels,
      unusedBottomPixels:
        grid.unusedBottomPixels,
      contentBytes: content.byteLength,
      wouldChange: true,
    };
    if (
      revisionOf(content) !== plan.baseRevision ||
      stableJson(
        replayedSummary as unknown as JsonValue,
      ) !==
        stableJson(
          plan.summary as unknown as JsonValue,
        )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The tileset create summary does not match its replayed content.",
      );
    }
    const result = await this.store.create(
      plan.tilesetPath,
      document,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  async planDeleteFile(input: {
    path: string;
  }): Promise<FileDeletePlan> {
    const targetPath = this.resolver.normalize(
      input.path,
    );
    const extension = posix
      .extname(targetPath)
      .toLowerCase();
    const targetKind =
      extension === ".tmj"
        ? ("map" as const)
        : extension === ".tsj"
          ? ("tileset" as const)
          : undefined;
    if (targetKind === undefined) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "File deletion covers .tmj maps and .tsj tilesets only.",
        { path: targetPath },
      );
    }
    const snapshot =
      await this.store.readSnapshot(targetPath);
    const scan = await this.scanDeleteReferences(
      targetPath,
      targetKind,
    );
    const unsigned: Omit<FileDeletePlan, "id"> = {
      kind: "fileDelete",
      version: 1,
      targetPath,
      targetKind,
      baseRevision: snapshot.revision,
      size: snapshot.size,
      scan,
      summary: fileDeleteSummary({
        targetPath,
        targetKind,
        revision: snapshot.revision,
        size: snapshot.size,
        scan,
      }),
    };
    return {
      ...unsigned,
      id: fileDeletePlanId(unsigned),
    };
  }

  async applyDeleteFile(
    plan: FileDeletePlan,
  ): Promise<
    FileDeleteStoreResult & { changeSetId: string }
  > {
    assertFileDeletePlan(plan);
    // References may have appeared since the preview; the scan is fail-closed
    // evidence, so it re-runs against the current project state.
    await this.scanDeleteReferences(
      plan.targetPath,
      plan.targetKind,
    );
    const result =
      await this.store.deleteDocument(
        plan.targetPath,
        plan.baseRevision,
        `apply change set ${plan.id}`,
      );
    return { ...result, changeSetId: plan.id };
  }

  private async scanDeleteReferences(
    targetPath: string,
    targetKind: "map" | "tileset",
  ): Promise<FileDeleteScanSummary> {
    const assets =
      await this.resolver.listAssets(10_000);
    const xmlAssets = assets.filter((asset) =>
      /\.(?:tmx|tsx|tx)$/iu.test(asset.path),
    );
    if (xmlAssets.length > 0) {
      throw new TiledMcpError(
        "UNSUPPORTED_REFERENCE_SCAN",
        "The project contains XML Tiled assets that may reference the target but cannot be scanned in the JSON-only profile.",
        {
          path: targetPath,
          reason: "xml-assets-present",
          xmlAssetCount: xmlAssets.length,
          xmlAssetSample: xmlAssets
            .slice(0, MAX_DELETE_REFERRER_SAMPLE)
            .map((asset) => asset.path),
        },
      );
    }
    const referrers = assets.filter((asset) => {
      if (asset.path === targetPath) {
        return false;
      }
      if (targetKind === "tileset") {
        return (
          asset.path.toLowerCase().endsWith(".tmj") ||
          asset.path.toLowerCase().endsWith(".tj")
        );
      }
      return asset.path
        .toLowerCase()
        .endsWith(".world");
    });
    if (
      referrers.length >
      MAX_DELETE_REFERENCE_SCAN_ASSETS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `The reference scan covers at most ${MAX_DELETE_REFERENCE_SCAN_ASSETS} candidate referrers.`,
        {
          path: targetPath,
          limit: MAX_DELETE_REFERENCE_SCAN_ASSETS,
          actual: referrers.length,
        },
      );
    }
    const scan: FileDeleteScanSummary = {
      scannedMaps: 0,
      scannedWorlds: 0,
      scannedTemplates: 0,
      scannedBytes: 0,
    };
    const referencing: string[] = [];
    let referencingCount = 0;
    for (const referrer of referrers) {
      const snapshot =
        await this.store.readSnapshot(
          referrer.path,
        );
      scan.scannedBytes += snapshot.size;
      if (
        scan.scannedBytes >
        MAX_DELETE_REFERENCE_SCAN_BYTES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `The reference scan covers at most ${MAX_DELETE_REFERENCE_SCAN_BYTES} bytes of candidate referrers.`,
          {
            path: targetPath,
            limit:
              MAX_DELETE_REFERENCE_SCAN_BYTES,
          },
        );
      }
      let document: JsonObject;
      try {
        document =
          this.store.parseSnapshot(
            snapshot,
          ).document;
      } catch {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${referrer.path} could not be parsed, so references to ${targetPath} cannot be ruled out.`,
          {
            path: referrer.path,
            target: targetPath,
          },
        );
      }
      const lower = referrer.path.toLowerCase();
      let references = false;
      if (lower.endsWith(".tmj")) {
        scan.scannedMaps += 1;
        references =
          await this.documentReferencesTileset(
            referrer.path,
            document,
            targetPath,
          );
      } else if (lower.endsWith(".tj")) {
        scan.scannedTemplates += 1;
        const source = isJsonObject(
          document.tileset,
        )
          ? document.tileset.source
          : undefined;
        references =
          typeof source === "string" &&
          (await this.referenceResolvesTo(
            referrer.path,
            source,
            targetPath,
          ));
      } else {
        scan.scannedWorlds += 1;
        if (
          Array.isArray(document.patterns) &&
          document.patterns.length > 0
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_REFERENCE_SCAN",
            `${referrer.path} uses pattern-based world membership, which cannot prove the target map is unreferenced.`,
            {
              path: referrer.path,
              target: targetPath,
              reason: "world-patterns",
            },
          );
        }
        const maps = Array.isArray(document.maps)
          ? document.maps
          : [];
        for (const entry of maps) {
          const fileName = isJsonObject(entry)
            ? entry.fileName
            : undefined;
          if (
            typeof fileName === "string" &&
            (await this.referenceResolvesTo(
              referrer.path,
              fileName,
              targetPath,
            ))
          ) {
            references = true;
            break;
          }
        }
      }
      if (references) {
        referencingCount += 1;
        if (
          referencing.length <
          MAX_DELETE_REFERRER_SAMPLE
        ) {
          referencing.push(referrer.path);
        }
      }
    }
    if (referencingCount > 0) {
      throw new TiledMcpError(
        "FILE_IN_USE",
        `${targetPath} is still referenced by ${referencingCount} project asset${referencingCount === 1 ? "" : "s"}.`,
        {
          path: targetPath,
          referencedByCount: referencingCount,
          referencedBy: referencing,
        },
      );
    }
    return scan;
  }

  private async documentReferencesTileset(
    mapPath: string,
    document: JsonObject,
    targetPath: string,
  ): Promise<boolean> {
    const tilesets = Array.isArray(
      document.tilesets,
    )
      ? document.tilesets
      : [];
    for (const entry of tilesets) {
      const source = isJsonObject(entry)
        ? entry.source
        : undefined;
      if (
        typeof source === "string" &&
        (await this.referenceResolvesTo(
          mapPath,
          source,
          targetPath,
        ))
      ) {
        return true;
      }
    }
    return false;
  }

  private async referenceResolvesTo(
    fromPath: string,
    reference: string,
    targetPath: string,
  ): Promise<boolean> {
    try {
      return (
        (await this.resolver.resolveReference(
          fromPath,
          reference,
        )) === targetPath
      );
    } catch {
      // References escaping the project root cannot point at an in-root
      // target.
      return false;
    }
  }

  private async assertCreateTargetAbsent(
    projectPath: string,
  ): Promise<void> {
    const absolutePath =
      await this.resolver.resolveForCreate(
        projectPath,
      );
    try {
      await stat(absolutePath);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    throw new TiledMcpError(
      "FILE_ALREADY_EXISTS",
      `Refusing to overwrite existing file ${projectPath}.`,
      { path: projectPath },
    );
  }

  private async loadBoundTilesetForEdit(
    binding: TilesetBinding,
  ): Promise<{
    document: JsonObject;
    source: Buffer;
  }> {
    const tileset = await this.store.read(
      binding.path,
    );
    if (tileset.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the tile update was being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: tileset.revision,
        },
      );
    }
    const imageReference = expectString(
      tileset.document.image,
      `${binding.path}.image`,
    );
    const imagePath =
      await this.resolver.resolveReference(
        binding.path,
        imageReference,
      );
    // Reuse the bounded semantic scanner as the tileset write-profile gate;
    // it rejects non-atlas tiles, duplicate or out-of-range ids, and
    // malformed probability/animation metadata before any mutation.
    summarizeTilesetDocument({
      document: tileset.document,
      path: binding.path,
      imagePath,
      name: binding.name,
      nameTruncated: binding.nameTruncated,
      tileCount: binding.tileCount,
      startTileId: 0,
      limit: 1,
    });
    return {
      document: tileset.document,
      source: tileset.source,
    };
  }

  async planCreateLayer(
    input: PlanCreateLayerInput,
  ): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    assertOptionalRevision(
      input.expectedImageRevision,
      "expectedImageRevision",
    );
    const context = await this.loadEditableContext(input.mapPath, {
      expectedMapRevision: input.expectedMapRevision,
      expectedDependencyRevisions:
        input.expectedDependencyRevisions,
    });
    assertDependencyRevisions(
      input.expectedDependencyRevisions,
      context.dependencyRevisions,
    );

    let prospectiveImage: ProspectiveImageBinding | undefined;
    if (input.layerType === "imagelayer") {
      if (input.imagePath === undefined) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "imagePath is required when creating an image layer.",
        );
      }
      prospectiveImage = await this.loadProspectiveImageBinding(
        input.imagePath,
        input.expectedImageRevision,
      );
    } else if (
      input.imagePath !== undefined ||
      input.expectedImageRevision !== undefined
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "imagePath and expectedImageRevision are available only for image layers.",
      );
    }

    const operation = resolveCreateLayerOperation(
      context,
      input,
      prospectiveImage,
    );
    const edited = cloneJson(context.loaded.document);
    const operations: PlannedMapEditOperation[] = [operation];
    const summary = validateAndSummarizeOperations(
      edited,
      context.orientation,
      context.bindings,
      operations,
      context.loaded.path,
      {
        allowResolvedCreateLayer: true,
        sourceBytes: context.loaded.size,
      },
    );
    const unsignedPlan: Omit<MapEditPlan, "id"> = {
      kind: "mapEdit",
      version: 1,
      mapPath: context.loaded.path,
      baseRevision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      ...(prospectiveImage === undefined
        ? {}
        : {
            prospectiveDependencyRevisions: {
              [prospectiveImage.assetId]:
                prospectiveImage.revision,
            },
          }),
      operations,
      summary,
    };

    await this.assertDependenciesUnchanged(context.bindings);
    if (prospectiveImage !== undefined) {
      await this.assertProspectiveImageUnchanged(
        prospectiveImage,
      );
    }
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
    );
    return { ...unsignedPlan, id: planId(unsignedPlan) };
  }

  async planEdits(
    mapPath: string,
    expectedRevision: string,
    expectedDependencyRevisions: Record<string, string>,
    operations: readonly MapEditOperation[],
  ): Promise<MapEditPlan> {
    const context = await this.loadEditableContext(mapPath, {
      expectedMapRevision: expectedRevision,
      expectedDependencyRevisions,
    });
    if (context.loaded.revision !== expectedRevision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed after it was read. Read the region again before previewing edits.`,
        {
          path: context.loaded.path,
          expectedRevision,
          actualRevision: context.loaded.revision,
        },
      );
    }
    assertDependencyRevisions(
      expectedDependencyRevisions,
      context.dependencyRevisions,
    );
    const copiedOperations = structuredClone(operations) as MapEditOperation[];
    const previewDocument = cloneJson(context.loaded.document);
    const summary = validateAndSummarizeOperations(
      previewDocument,
      context.orientation,
      context.bindings,
      copiedOperations,
      mapPath,
      { sourceBytes: context.loaded.size },
    );
    const unsignedPlan = {
      kind: "mapEdit" as const,
      version: 1 as const,
      mapPath: context.loaded.path,
      baseRevision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      operations: copiedOperations,
      summary,
    };
    return { ...unsignedPlan, id: planId(unsignedPlan) };
  }

  async applyEdits(plan: MapEditPlan): Promise<CommitResult & { changeSetId: string }> {
    assertPlanShape(plan);
    const { id: suppliedId, ...unsignedPlan } = plan;
    const expectedId = planId(unsignedPlan);
    if (suppliedId !== expectedId) {
      throw new TiledMcpError(
        "CHANGE_SET_TAMPERED",
        "The change set contents do not match its id. Plan the edits again.",
        { suppliedId, expectedId },
      );
    }

    const context = await this.loadEditableContext(plan.mapPath, {
      expectedMapRevision: plan.baseRevision,
      expectedDependencyRevisions: plan.dependencyRevisions,
      persistIdentity: true,
    });
    assertDependencyRevisions(plan.dependencyRevisions, context.dependencyRevisions);

    const addTilesetOperations = plan.operations.filter(
      (
        operation,
      ): operation is ResolvedAddTilesetToMapOperation =>
        operation.type === "addTilesetToMap",
    );
    const createLayerOperations = plan.operations.filter(
      (
        operation,
      ): operation is ResolvedCreateLayerOperation =>
        operation.type === "createLayer",
    );
    if (
      addTilesetOperations.length > 1 ||
      createLayerOperations.length > 1 ||
      addTilesetOperations.length + createLayerOperations.length > 1
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A change set may contain at most one dedicated resolved map operation.",
      );
    }
    if (
      addTilesetOperations.length + createLayerOperations.length === 1 &&
      plan.operations.length !== 1
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A dedicated resolved map operation cannot be batched with generic edits.",
      );
    }
    let prospectiveTileset: ProspectiveTilesetBinding | undefined;
    let prospectiveImage: ProspectiveImageBinding | undefined;
    if (addTilesetOperations.length === 1) {
      const plannedOperation = addTilesetOperations[0];
      if (plannedOperation === undefined) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The add-tileset operation is missing.",
        );
      }
      prospectiveTileset = await this.loadProspectiveTilesetBinding(
        plannedOperation.tilesetPath,
        plannedOperation.tilesetRevision,
        plannedOperation.assetId,
        true,
      );
      assertDependencyRevisions(
        plan.prospectiveDependencyRevisions ?? {},
        {
          [prospectiveTileset.assetId]:
            prospectiveTileset.revision,
        },
      );
      const resolvedOperation = resolveAddTilesetToMapOperation(
        context,
        prospectiveTileset,
      );
      if (
        stableJson(resolvedOperation as unknown as JsonValue) !==
        stableJson(plannedOperation as unknown as JsonValue)
      ) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The planned tileset reference no longer matches its canonical path, revision, tile count or assigned firstgid.",
          {
            path: plannedOperation.tilesetPath,
            assetId: plannedOperation.assetId,
          },
        );
      }
    } else if (createLayerOperations.length === 1) {
      const plannedOperation = createLayerOperations[0];
      if (plannedOperation === undefined) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The create-layer operation is missing.",
        );
      }
      assertResolvedCreateLayerOperation(plannedOperation);
      if (plannedOperation.image !== undefined) {
        prospectiveImage = await this.loadProspectiveImageBinding(
          plannedOperation.image.path,
          plannedOperation.image.revision,
          plannedOperation.image.assetId,
          true,
        );
        assertDependencyRevisions(
          plan.prospectiveDependencyRevisions ?? {},
          {
            [prospectiveImage.assetId]:
              prospectiveImage.revision,
          },
        );
      } else if (
        plan.prospectiveDependencyRevisions !== undefined
      ) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "A non-image layer change set cannot contain prospective dependency revisions.",
        );
      }
      const resolvedOperation = resolveCreateLayerOperation(
        context,
        {
          layerType: plannedOperation.layerType,
          name: plannedOperation.name,
          index: plannedOperation.index,
          ...(plannedOperation.parentGroupId === null
            ? {}
            : {
                parentGroupId:
                  plannedOperation.parentGroupId,
              }),
          ...(plannedOperation.image === undefined
            ? {}
            : { imagePath: plannedOperation.image.path }),
        },
        prospectiveImage,
      );
      if (
        stableJson(resolvedOperation as unknown as JsonValue) !==
        stableJson(plannedOperation as unknown as JsonValue)
      ) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The planned layer no longer matches its canonical id, placement, image source or dimensions.",
          {
            path: plan.mapPath,
            layerId: plannedOperation.layerId,
          },
        );
      }
    } else if (
      plan.prospectiveDependencyRevisions !== undefined &&
      Object.keys(plan.prospectiveDependencyRevisions).length > 0
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "A map-only change set cannot contain prospective dependency revisions.",
      );
    }

    const edited = cloneJson(context.loaded.document);
    const appliedSummary = validateAndSummarizeOperations(
      edited,
      context.orientation,
      context.bindings,
      plan.operations,
      plan.mapPath,
      {
        allowResolvedAddTileset: addTilesetOperations.length === 1,
        allowResolvedCreateLayer:
          createLayerOperations.length === 1,
        sourceBytes: context.loaded.size,
      },
    );
    if (
      stableJson(appliedSummary as unknown as JsonValue) !==
      stableJson(plan.summary as unknown as JsonValue)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The change set summary does not match its operations.",
      );
    }
    await this.assertDependenciesUnchanged(context.bindings);
    if (prospectiveTileset !== undefined) {
      await assertRevisionUnchanged(
        this.store,
        prospectiveTileset.path,
        prospectiveTileset.revision,
        "DEPENDENCY_REVISION_CONFLICT",
        { assetId: prospectiveTileset.assetId },
      );
    }
    if (prospectiveImage !== undefined) {
      await this.assertProspectiveImageUnchanged(
        prospectiveImage,
      );
    }
    reencodeWrittenTileLayers(
      edited,
      context.loaded.document,
      appliedSummary.affectedTileLayerIds,
      plan.mapPath,
    );
    const patchedSource = patchJsonDocumentSource(
      context.loaded.source,
      edited,
      sourcePatchPathsForSummary(edited, appliedSummary, plan.mapPath),
      plan.mapPath,
      sourceArrayInsertionsForSummary(
        edited,
        appliedSummary,
        plan.mapPath,
      ),
      sourceObjectMemberPatchesForSummary(
        edited,
        appliedSummary,
        plan.mapPath,
      ),
      sourceArrayDeletionsForSummary(
        edited,
        appliedSummary,
        plan.mapPath,
      ),
      sourceArrayMovesForSummary(
        context.loaded.document,
        appliedSummary,
        plan.mapPath,
      ),
    );
    const result = await this.store.commitBytes(
      plan.mapPath,
      plan.baseRevision,
      patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  async assertRenderSafe(
    mapPath: string,
    expectedSnapshot?: RenderSafetySnapshot,
  ): Promise<RenderSafetySnapshot> {
    const context = await this.loadEditableContext(
      mapPath,
      expectedSnapshot === undefined
        ? {}
        : {
            expectedMapRevision:
              expectedSnapshot.map.revision,
            expectedDependencyRevisions:
              expectedSnapshot.dependencyRevisions,
          },
    );
    const imageBudget: RenderImageBudget = {
      revisions: new Map<string, string>(),
      totalBytes: 0,
      totalPixels: 0,
      ...(expectedSnapshot === undefined
        ? {}
        : {
            expectedRevisions:
              expectedSnapshot.inputImageRevisions,
          }),
    };
    await this.assertRenderLayerReferences(
      context.loaded.path,
      expectArray(context.loaded.document.layers, `${mapPath}.layers`),
      0,
      { count: 0 },
      imageBudget,
    );
    for (const binding of context.bindings) {
      const tileset = await this.store.read(binding.path);
      assertNoTemplateReferences(tileset.document, binding.path);
      if (typeof tileset.document.image === "string") {
        const imagePath =
          await this.resolver.resolveReference(
            binding.path,
            tileset.document.image,
          );
        await this.assertRenderImageSafe(
          imagePath,
          imageBudget,
        );
      }
      if (Array.isArray(tileset.document.tiles)) {
        for (const value of tileset.document.tiles) {
          if (!isJsonObject(value) || typeof value.image !== "string") {
            continue;
          }
          const imagePath = await this.resolver.resolveReference(
            binding.path,
            value.image,
          );
          await this.assertRenderImageSafe(
            imagePath,
            imageBudget,
          );
        }
      }
    }
    const inputImageRevisions =
      Object.fromEntries(
        [...imageBudget.revisions.entries()].sort(
          ([left], [right]) =>
            left < right
              ? -1
              : left > right
                ? 1
                : 0,
        ),
      );
    if (expectedSnapshot !== undefined) {
      const expectedPaths = Object.keys(
        expectedSnapshot.inputImageRevisions,
      ).sort();
      const actualPaths = Object.keys(
        inputImageRevisions,
      ).sort();
      if (
        expectedPaths.length !== actualPaths.length ||
        expectedPaths.some(
          (path, index) =>
            path !== actualPaths[index],
        )
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          "The raster input image set changed while the map was rendered.",
          {
            expectedCount: expectedPaths.length,
            actualCount: actualPaths.length,
            expectedPaths,
            actualPaths,
          },
        );
      }
    }
    await this.assertDependenciesUnchanged(context.bindings);
    const currentMapRevision = await this.store.readRevision(
      context.loaded.path,
    );
    if (currentMapRevision !== context.loaded.revision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${context.loaded.path} changed while its render dependencies were validated.`,
        {
          path: context.loaded.path,
          expectedRevision: context.loaded.revision,
          actualRevision: currentMapRevision,
        },
      );
    }
    return {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      dependencyRevisions:
        context.dependencyRevisions,
      inputImageRevisions,
    };
  }

  async validate(mapPath: string): Promise<{
    path: string;
    revision: string;
    valid: boolean;
    diagnostics: Diagnostic[];
  }> {
    const loaded = await this.store.read(mapPath);
    const diagnostics: Diagnostic[] = [];
    const map = loaded.document;

    if (map.type !== "map") {
      diagnostics.push(errorDiagnostic("MAP_TYPE_INVALID", "Root type must be \"map\".", "/type"));
    }
    if (map.orientation !== "orthogonal") {
      diagnostics.push(
        errorDiagnostic(
          "ORIENTATION_UNSUPPORTED",
          "MVP semantic editing supports only orthogonal maps.",
          "/orientation",
        ),
      );
    }
    if (typeof map.infinite !== "boolean") {
      diagnostics.push(
        errorDiagnostic(
          "INFINITE_FLAG_INVALID",
          "infinite must be a boolean.",
          "/infinite",
        ),
      );
    } else if (map.infinite) {
      diagnostics.push(
        errorDiagnostic(
          "INFINITE_MAP_UNSUPPORTED",
          "MVP semantic editing supports only finite maps.",
          "/infinite",
        ),
      );
    }

    const mapWidth = validatePositiveIntegerField(map, "width", diagnostics);
    const mapHeight = validatePositiveIntegerField(map, "height", diagnostics);
    validatePositiveIntegerField(map, "tilewidth", diagnostics);
    validatePositiveIntegerField(map, "tileheight", diagnostics);
    const nextLayerId = validatePositiveIntegerField(map, "nextlayerid", diagnostics);
    const nextObjectId = validatePositiveIntegerField(
      map,
      "nextobjectid",
      diagnostics,
    );

    const seenLayerIds = new Set<number>();
    const seenObjectIds = new Set<number>();
    if (!Array.isArray(map.layers)) {
      diagnostics.push(errorDiagnostic("LAYERS_INVALID", "layers must be an array.", "/layers"));
    } else {
      validateLayers(
        map.layers,
        diagnostics,
        seenLayerIds,
        seenObjectIds,
        "/layers",
        mapWidth,
        mapHeight,
      );
      if (
        nextLayerId > 0 &&
        seenLayerIds.size > 0 &&
        nextLayerId <= maximumSetValue(seenLayerIds)
      ) {
        diagnostics.push(
          errorDiagnostic(
            "NEXT_LAYER_ID_INVALID",
            "nextlayerid must be greater than every existing layer id.",
            "/nextlayerid",
          ),
        );
      }
      if (
        nextObjectId > 0 &&
        seenObjectIds.size > 0 &&
        nextObjectId <= maximumSetValue(seenObjectIds)
      ) {
        diagnostics.push(
          errorDiagnostic(
            "NEXT_OBJECT_ID_INVALID",
            "nextobjectid must be greater than every existing object id.",
            "/nextobjectid",
          ),
        );
      }
    }

    if (!Array.isArray(map.tilesets)) {
      diagnostics.push(
        errorDiagnostic("TILESETS_INVALID", "tilesets must be an array.", "/tilesets"),
      );
    } else {
      await this.validateTilesets(loaded.path, map.tilesets, diagnostics);
      const tilesetShapeValid = !diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.jsonPointer?.startsWith("/tilesets") === true,
      );
      if (tilesetShapeValid && map.orientation === "orthogonal" && Array.isArray(map.layers)) {
        try {
          const bindings = await this.loadTilesetBindings(loaded.path, map.tilesets);
          validateReferencedGids(map.layers, bindings, diagnostics, "/layers");
        } catch (error) {
          diagnostics.push(fromCaughtDiagnostic(error, "/tilesets"));
        }
      }
    }

    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      diagnostics.splice(MAX_DIAGNOSTICS - 1);
      diagnostics.push({
        code: "DIAGNOSTIC_LIMIT_REACHED",
        severity: "warning",
        message: `Validation stopped after ${MAX_DIAGNOSTICS - 1} diagnostics.`,
      });
    }

    return {
      path: loaded.path,
      revision: loaded.revision,
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
    };
  }

  private async loadEditableContext(
    mapPath: string,
    revisionGuards: EditableContextRevisionGuards = {},
  ): Promise<EditableContext> {
    if (revisionGuards.expectedDependencyRevisions !== undefined) {
      assertDependencyRevisionRecord(
        revisionGuards.expectedDependencyRevisions,
      );
    }
    const normalizedMapPath = this.resolver.normalize(mapPath);
    const loaded =
      revisionGuards.expectedMapRevision === undefined
        ? await this.store.read(normalizedMapPath)
        : await (async () => {
            const snapshot =
              await this.store.readSnapshot(normalizedMapPath);
            if (
              snapshot.revision !== revisionGuards.expectedMapRevision
            ) {
              throw new TiledMcpError(
                "REVISION_CONFLICT",
                `${normalizedMapPath} changed since the requested tile-search page.`,
                {
                  path: normalizedMapPath,
                  expectedRevision:
                    revisionGuards.expectedMapRevision,
                  actualRevision: snapshot.revision,
                },
              );
            }
            return this.store.parseSnapshot(snapshot);
          })();
    if (posix.extname(loaded.path).toLowerCase() !== ".tmj") {
      throw new TiledMcpError("UNSUPPORTED_FORMAT", "MVP semantic tools require TMJ maps.", {
        path: loaded.path,
      });
    }
    const map = loaded.document;
    if (map.type !== "map") {
      throw new TiledMcpError("INVALID_DOCUMENT", `${loaded.path} is not a Tiled map.`);
    }
    const orientation = expectString(map.orientation, `${loaded.path}.orientation`);
    if (orientation !== "orthogonal") {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        "MVP semantic tools support only orthogonal maps.",
        { path: loaded.path, orientation },
      );
    }
    if (typeof map.infinite !== "boolean") {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${loaded.path}.infinite must be a boolean.`,
        { path: loaded.path },
      );
    }
    const infinite = map.infinite === true;
    if (
      infinite &&
      revisionGuards.allowInfinite !== true
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        "This tool supports only finite maps; infinite maps are readable through the summary, region, and usage tools.",
        { path: loaded.path },
      );
    }
    const width = expectInteger(map.width, `${loaded.path}.width`);
    const height = expectInteger(map.height, `${loaded.path}.height`);
    assertPositiveInteger(width, "map.width");
    assertPositiveInteger(height, "map.height");
    assertPositiveInteger(
      expectInteger(map.tilewidth, `${loaded.path}.tilewidth`),
      "map.tilewidth",
    );
    assertPositiveInteger(
      expectInteger(map.tileheight, `${loaded.path}.tileheight`),
      "map.tileheight",
    );
    const layers = expectArray(map.layers, `${loaded.path}.layers`);
    assertEditableLayerIdentities(layers, loaded.path);

    const bindings = await this.loadTilesetBindings(
      loaded.path,
      expectArray(map.tilesets, `${loaded.path}.tilesets`),
      revisionGuards.selectedTileset,
      revisionGuards.expectedDependencyRevisions,
      revisionGuards.persistIdentity === true,
      revisionGuards.allowCollectionTilesets ===
        true,
    );
    const dependencyRevisions = Object.fromEntries(
      bindings.map((binding) => [binding.assetId, binding.revision]),
    );
    if (revisionGuards.expectedDependencyRevisions !== undefined) {
      assertDependencyRevisions(
        revisionGuards.expectedDependencyRevisions,
        dependencyRevisions,
      );
    }
    return {
      loaded,
      width,
      height,
      orientation,
      infinite,
      bindings,
      dependencyRevisions,
    };
  }

  private async loadTilesetBindings(
    mapPath: string,
    entries: JsonValue[],
    selectedRevisionGuard?: {
      assetId: string;
      expectedRevision: string;
    },
    expectedDependencyRevisions?: Record<string, string>,
    persistIdentity = false,
    allowCollectionTilesets = false,
  ): Promise<TilesetBinding[]> {
    if (entries.length > MAX_TILESET_COUNT) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A map may reference at most ${MAX_TILESET_COUNT} tilesets in the MVP.`,
        { path: mapPath, limit: MAX_TILESET_COUNT, actual: entries.length },
      );
    }
    const bindings: TilesetBinding[] = [];
    let totalDependencyBytes = 0;
    const firstGids = new Set<number>();
    const tilesetPaths = new Set<string>();
    const candidates:
      TilesetBindingCandidate[] = [];
    let aggregateLimitError:
      TiledMcpError | undefined;
    for (const [index, entryValue] of entries.entries()) {
      const entry = expectObject(entryValue, `${mapPath}.tilesets[${index}]`);
      const firstGid = expectInteger(entry.firstgid, `${mapPath}.tilesets[${index}].firstgid`);
      if (firstGid <= 0 || firstGid > 0x0fffffff) {
        throw new TiledMcpError("INVALID_DOCUMENT", "firstgid is outside the valid range.", {
          path: mapPath,
          firstGid,
        });
      }
      if (firstGids.has(firstGid)) {
        throw new TiledMcpError("INVALID_DOCUMENT", `Duplicate firstgid ${firstGid}.`, {
          path: mapPath,
        });
      }
      firstGids.add(firstGid);
      if (typeof entry.source !== "string") {
        throw new TiledMcpError(
          "UNSUPPORTED_TILESET",
          "MVP editing requires every map tileset to be an external TSJ atlas.",
          { path: mapPath, index },
        );
      }
      const tilesetPath = await this.resolver.resolveReference(mapPath, entry.source);
      if (posix.extname(tilesetPath).toLowerCase() !== ".tsj") {
        throw new TiledMcpError(
          "UNSUPPORTED_TILESET",
          "MVP editing requires external JSON tilesets (.tsj).",
          { path: tilesetPath },
        );
      }
      if (tilesetPaths.has(tilesetPath)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath} references the same tileset more than once.`,
          { path: tilesetPath },
        );
      }
      tilesetPaths.add(tilesetPath);
      const snapshot =
        await this.store.readSnapshot(tilesetPath);
      totalDependencyBytes += snapshot.size;
      if (totalDependencyBytes > MAX_TOTAL_DEPENDENCY_BYTES) {
        aggregateLimitError =
          new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `Referenced tilesets exceed the ${MAX_TOTAL_DEPENDENCY_BYTES} byte aggregate limit.`,
            {
              path: mapPath,
              limit:
                MAX_TOTAL_DEPENDENCY_BYTES,
              actual: totalDependencyBytes,
            },
          );
        if (
          selectedRevisionGuard === undefined &&
          expectedDependencyRevisions ===
            undefined
        ) {
          throw aggregateLimitError;
        }
        candidates.push({
          firstGid,
          tilesetPath,
          snapshot,
          validation: {
            ok: false,
            error: aggregateLimitError,
          },
        });
        break;
      }
      let validation:
        TilesetBindingCandidate["validation"];
      try {
        const tileset =
          this.store.parseSnapshot(snapshot);
        if (tileset.document.type !== "tileset") {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            `${tilesetPath} is not a Tiled tileset.`,
          );
        }
        let collectionLocalIds:
          | Set<number>
          | undefined;
        if (
          typeof tileset.document.image !==
          "string"
        ) {
          if (!allowCollectionTilesets) {
            throw new TiledMcpError(
              "UNSUPPORTED_TILESET",
              "This tool requires atlas tilesets with a root image field; maps referencing image-collection tilesets are readable through the summary, region, and object tools.",
              { path: tilesetPath },
            );
          }
          collectionLocalIds =
            readCollectionTileIds(
              tileset.document,
              tilesetPath,
            );
        } else {
          const imagePath =
            await this.resolver.resolveReference(
              tilesetPath,
              tileset.document.image,
            );
          const imageStat = await stat(
            await this.resolver.resolveExisting(
              imagePath,
            ),
          );
          if (!imageStat.isFile()) {
            throw new TiledMcpError(
              "INVALID_TILESET_IMAGE",
              `${imagePath} is not a regular image file.`,
              { path: imagePath },
            );
          }
        }
        const tileCount = expectInteger(
          tileset.document.tilecount,
          `${tilesetPath}.tilecount`,
        );
        const gidSpan = tilesetGidSpan(
          tileset.document,
          tilesetPath,
          tileCount,
        );
        if (
          tileCount <= 0 ||
          firstGid + gidSpan - 1 > 0x0fffffff
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            `${tilesetPath} has an invalid tilecount.`,
            {
              path: tilesetPath,
              tileCount,
              gidSpan,
            },
          );
        }
        const displayName =
          boundedDisplayString(
            expectString(
              tileset.document.name,
              `${tilesetPath}.name`,
            ),
          );
        if (
          collectionLocalIds !== undefined &&
          collectionLocalIds.size !== tileCount
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            `${tilesetPath}.tilecount does not match its image-collection tile entries.`,
            {
              path: tilesetPath,
              tileCount,
              actual: collectionLocalIds.size,
            },
          );
        }
        validation = {
          ok: true,
          tileCount,
          gidSpan,
          name: displayName.value,
          nameTruncated:
            displayName.truncated,
          ...(collectionLocalIds === undefined
            ? {}
            : { collectionLocalIds }),
        };
      } catch (error) {
        if (
          selectedRevisionGuard === undefined &&
          expectedDependencyRevisions ===
            undefined
        ) {
          throw error;
        }
        validation = {
          ok: false,
          error,
        };
      }
      candidates.push({
        firstGid,
        tilesetPath,
        snapshot,
        validation,
      });
    }

    const resolvedAssetIds =
      await this.assetRegistry.resolveManyChecked(
        candidates.map(
          ({ tilesetPath, snapshot }) => ({
            kind:
              "external-tileset" as const,
            path: tilesetPath,
            identity: snapshot.identity,
          }),
        ),
        (candidateAssetIds) => {
          const uniqueAssetIds =
            new Set<string>();
          for (
            let index = 0;
            index < candidates.length;
            index += 1
          ) {
            const candidate = candidates[index];
            const assetId =
              candidateAssetIds[index];
            if (
              candidate === undefined ||
              assetId === undefined
            ) {
              throw new TiledMcpError(
                "INTERNAL_ERROR",
                "Asset registry returned an incomplete batch result.",
              );
            }
            if (
              uniqueAssetIds.has(assetId)
            ) {
              throw new TiledMcpError(
                "INVALID_DOCUMENT",
                `${mapPath} references the same tileset more than once.`,
                {
                  path:
                    candidate.tilesetPath,
                },
              );
            }
            uniqueAssetIds.add(assetId);
          }

          // Check every captured raw-byte candidate (the complete set unless
          // the aggregate cap stopped scanning) before surfacing any
          // parse/profile/image error. This preserves revision-conflict
          // precedence even when a stale replacement is malformed.
          for (
            let index = 0;
            index < candidates.length;
            index += 1
          ) {
            const candidate = candidates[index];
            const assetId =
              candidateAssetIds[index];
            if (
              candidate === undefined ||
              assetId === undefined
            ) {
              throw new TiledMcpError(
                "INTERNAL_ERROR",
                "Asset registry returned an incomplete batch result.",
              );
            }
            const guardedSelectedTileset =
              selectedRevisionGuard !==
                undefined &&
              selectedRevisionGuard.assetId ===
                assetId;
            const expectedDependencyRevision =
              expectedDependencyRevisions?.[
                assetId
              ];
            if (
              expectedDependencyRevisions !==
                undefined &&
              expectedDependencyRevision ===
                undefined
            ) {
              throw new TiledMcpError(
                "DEPENDENCY_REVISION_CONFLICT",
                "The expected dependency set does not contain every tileset referenced by the pinned map.",
                {
                  path: mapPath,
                  assetId,
                  tilesetPath:
                    candidate.tilesetPath,
                  expectedCount:
                    Object.keys(
                      expectedDependencyRevisions,
                    ).length,
                },
              );
            }
            if (
              guardedSelectedTileset &&
              expectedDependencyRevision !==
                undefined &&
              selectedRevisionGuard
                .expectedRevision !==
                expectedDependencyRevision
            ) {
              throw new TiledMcpError(
                "DEPENDENCY_REVISION_CONFLICT",
                "Conflicting revision guards were supplied for the same tileset.",
                {
                  assetId,
                  selectedRevision:
                    selectedRevisionGuard
                      .expectedRevision,
                  dependencyRevision:
                    expectedDependencyRevision,
                },
              );
            }
            const guardedRevision =
              guardedSelectedTileset
                ? selectedRevisionGuard
                    .expectedRevision
                : expectedDependencyRevision;
            if (
              guardedRevision !== undefined &&
              candidate.snapshot.revision !==
                guardedRevision
            ) {
              throw new TiledMcpError(
                "DEPENDENCY_REVISION_CONFLICT",
                `${candidate.tilesetPath} changed since the requested snapshot.`,
                {
                  assetId,
                  expectedRevision:
                    guardedRevision,
                  actualRevision:
                    candidate.snapshot
                      .revision,
                  ...(expectedDependencyRevisions ===
                  undefined
                    ? {}
                    : {
                        expectedCount:
                          Object.keys(
                            expectedDependencyRevisions,
                          ).length,
                        actualCount:
                          entries.length,
                        differences: [
                          {
                            assetId,
                            expectedRevision:
                              guardedRevision,
                            actualRevision:
                              candidate.snapshot
                                .revision,
                          },
                        ],
                      }),
                },
              );
            }
          }

          // The aggregate cap intentionally stops the scan. Check exact
          // revision guards for the captured prefix first, then report the
          // resource limit before comparing the necessarily incomplete full
          // dependency set. This makes the error independent of where the
          // over-limit entry appears.
          if (aggregateLimitError !== undefined) {
            throw aggregateLimitError;
          }

          if (
            expectedDependencyRevisions !==
            undefined
          ) {
            assertDependencyRevisions(
              expectedDependencyRevisions,
              Object.fromEntries(
                candidates.map(
                  (candidate, index) => [
                    candidateAssetIds[index]!,
                    candidate.snapshot.revision,
                  ],
                ),
              ),
            );
          }

          for (const candidate of candidates) {
            if (!candidate.validation.ok) {
              throw candidate.validation.error;
            }
          }

          const ranges = candidates
            .map((candidate, index) => {
              if (!candidate.validation.ok) {
                throw new TiledMcpError(
                  "INTERNAL_ERROR",
                  "Validated tileset range was unavailable.",
                );
              }
              return {
                assetId:
                  candidateAssetIds[index]!,
                firstGid:
                  candidate.firstGid,
                tileCount:
                  candidate.validation
                    .tileCount,
                gidSpan:
                  candidate.validation.gidSpan,
              };
            })
            .sort(
              (left, right) =>
                left.firstGid -
                right.firstGid,
            );
          for (
            let index = 1;
            index < ranges.length;
            index += 1
          ) {
            const previous =
              ranges[index - 1];
            const current = ranges[index];
            if (
              previous !== undefined &&
              current !== undefined &&
              previous.firstGid +
                previous.gidSpan >
                current.firstGid
            ) {
              throw new TiledMcpError(
                "TILESET_GID_RANGE_OVERLAP",
                `Tileset GID ranges overlap at firstgid ${current.firstGid}.`,
                {
                  previousAssetId:
                    previous.assetId,
                  previousFirstGid:
                    previous.firstGid,
                  previousTileCount:
                    previous.tileCount,
                  previousGidSpan:
                    previous.gidSpan,
                  currentAssetId:
                    current.assetId,
                  currentFirstGid:
                    current.firstGid,
                },
              );
            }
          }
        },
        { persistIdentity },
      );

    for (
      let index = 0;
      index < candidates.length;
      index += 1
    ) {
      const candidate = candidates[index];
      const assetId = resolvedAssetIds[index];
      if (
        candidate === undefined ||
        assetId === undefined ||
        !candidate.validation.ok
      ) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          "Validated asset registry batch was incomplete.",
        );
      }
      bindings.push({
        assetId,
        path: candidate.tilesetPath,
        firstGid: candidate.firstGid,
        tileCount:
          candidate.validation.tileCount,
        gidSpan:
          candidate.validation.gidSpan,
        name: candidate.validation.name,
        nameTruncated:
          candidate.validation.nameTruncated,
        revision:
          candidate.snapshot.revision,
        ...(candidate.validation
          .collectionLocalIds === undefined
          ? {}
          : {
              collection: true as const,
              localIds:
                candidate.validation
                  .collectionLocalIds,
            }),
      });
    }
    bindings.sort((left, right) => left.firstGid - right.firstGid);
    return bindings;
  }

  private async loadProspectiveTilesetBinding(
    tilesetPath: string,
    expectedRevision?: string,
    expectedAssetId?: string,
    persistIdentity = false,
  ): Promise<ProspectiveTilesetBinding> {
    const normalizedPath = this.resolver.normalize(tilesetPath);
    if (posix.extname(normalizedPath).toLowerCase() !== ".tsj") {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Adding a tileset requires an external JSON tileset (.tsj).",
        { path: normalizedPath },
      );
    }
    const snapshot = await this.store.readSnapshot(normalizedPath);
    if (
      expectedRevision !== undefined &&
      snapshot.revision !== expectedRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${normalizedPath} changed after the prospective tileset was selected.`,
        {
          path: normalizedPath,
          ...(expectedAssetId === undefined
            ? {}
            : { assetId: expectedAssetId }),
          expectedRevision,
          actualRevision: snapshot.revision,
        },
      );
    }

    // Parse only after the raw-byte revision comparison above. A stale plan
    // must remain a revision conflict even when the new bytes are malformed.
    const loaded = this.store.parseSnapshot(snapshot);
    if (loaded.document.type !== "tileset") {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${normalizedPath} is not a Tiled tileset.`,
        { path: normalizedPath },
      );
    }
    const imageReference = expectString(
      loaded.document.image,
      `${normalizedPath}.image`,
    );
    const imagePath = await this.resolver.resolveReference(
      normalizedPath,
      imageReference,
    );
    const imageStat = await stat(
      await this.resolver.resolveExisting(imagePath),
    );
    if (!imageStat.isFile()) {
      throw new TiledMcpError(
        "INVALID_TILESET_IMAGE",
        `${imagePath} is not a regular image file.`,
        { path: imagePath },
      );
    }
    const tileCount = expectInteger(
      loaded.document.tilecount,
      `${normalizedPath}.tilecount`,
    );
    if (tileCount <= 0 || tileCount > 0x0fffffff) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${normalizedPath} has an invalid atlas tilecount.`,
        { path: normalizedPath, tileCount },
      );
    }
    const gidSpan = tilesetGidSpan(
      loaded.document,
      normalizedPath,
      tileCount,
    );
    const displayName = boundedDisplayString(
      expectString(loaded.document.name, `${normalizedPath}.name`),
    );
    // Reuse the bounded semantic scanner as the write-profile gate. In
    // addition to atlas geometry, this rejects duplicate/out-of-range tile
    // definitions and per-tile image/subrect overrides.
    summarizeTilesetDocument({
      document: loaded.document,
      path: normalizedPath,
      imagePath,
      name: displayName.value,
      nameTruncated: displayName.truncated,
      tileCount,
      startTileId: 0,
      limit: 1,
    });
    const assetId = await this.assetRegistry.resolve(
      {
        kind: "external-tileset",
        path: normalizedPath,
        identity: snapshot.identity,
      },
      { persistIdentity },
    );
    return {
      assetId,
      path: normalizedPath,
      tileCount,
      gidSpan,
      revision: loaded.revision,
    };
  }

  private async loadProspectiveImageBinding(
    imagePath: string,
    expectedRevision?: string,
    expectedAssetId?: string,
    persistIdentity = false,
  ): Promise<ProspectiveImageBinding> {
    const normalizedPath = this.resolver.normalize(imagePath);
    const snapshot = await readImageFileSnapshot(
      this.resolver,
      normalizedPath,
      MAX_TILESET_IMAGE_BYTES,
    );
    if (
      expectedRevision !== undefined &&
      snapshot.revision !== expectedRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${normalizedPath} changed after the image layer source was selected.`,
        {
          path: normalizedPath,
          ...(expectedAssetId === undefined
            ? {}
            : { assetId: expectedAssetId }),
          expectedRevision,
          actualRevision: snapshot.revision,
        },
      );
    }

    // Inspect only after the raw revision comparison. A stale replacement must
    // remain a revision conflict even when its bytes are no longer an image.
    const metadata = await inspectSafeImage({
      bytes: snapshot.bytes,
      path: snapshot.path,
      limits: {
        maxInputBytes: MAX_TILESET_IMAGE_BYTES,
        maxInputPixels: MAX_TILESET_INPUT_PIXELS,
        maxInputEdge: MAX_TILESET_INPUT_EDGE,
      },
    });
    const assetId = await this.assetRegistry.resolve(
      {
        kind: "image-layer",
        path: normalizedPath,
        identity: snapshot.identity,
      },
      { persistIdentity },
    );
    return {
      assetId,
      path: snapshot.path,
      revision: snapshot.revision,
      width: metadata.width,
      height: metadata.height,
    };
  }

  private async assertProspectiveImageUnchanged(
    image: ProspectiveImageBinding,
  ): Promise<void> {
    const current = await readImageFileSnapshot(
      this.resolver,
      image.path,
      MAX_TILESET_IMAGE_BYTES,
    );
    if (current.revision !== image.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${image.path} changed while the image-layer change set was being prepared.`,
        {
          path: image.path,
          assetId: image.assetId,
          expectedRevision: image.revision,
          actualRevision: current.revision,
        },
      );
    }
  }

  private requireTilesetBinding(
    context: EditableContext,
    tilesetAssetId: string,
  ): TilesetBinding {
    const binding = context.bindings.find(
      (candidate) => candidate.assetId === tilesetAssetId,
    );
    if (binding === undefined) {
      throw new TiledMcpError(
        "TILESET_NOT_FOUND",
        `The requested tileset asset is not referenced by ${context.loaded.path}.`,
        {
          mapPath: context.loaded.path,
          tilesetAssetId,
        },
      );
    }
    return binding;
  }

  private async loadPreviewAtlas(
    binding: TilesetBinding,
    mapTileWidth: number,
    mapTileHeight: number,
    remainingImageBytes: number,
    remainingDecodedPixels: number,
  ) {
    if (remainingImageBytes <= 0 || remainingDecodedPixels <= 0) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "The native preview has exhausted its aggregate atlas resource budget.",
        {
          assetId: binding.assetId,
          remainingImageBytes: Math.max(0, remainingImageBytes),
          remainingDecodedPixels: Math.max(0, remainingDecodedPixels),
        },
      );
    }
    const tileset = await this.store.read(binding.path);
    if (tileset.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the native preview was being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: tileset.revision,
        },
      );
    }
    const document = tileset.document;
    if (typeof document.image !== "string") {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        "Native preview v1 requires a root atlas image.",
        { path: binding.path, assetId: binding.assetId },
      );
    }

    const tileWidth = expectInteger(
      document.tilewidth,
      `${binding.path}.tilewidth`,
    );
    const tileHeight = expectInteger(
      document.tileheight,
      `${binding.path}.tileheight`,
    );
    if (tileWidth !== mapTileWidth || tileHeight !== mapTileHeight) {
      throw new TiledMcpError(
        "UNSUPPORTED_RENDER_FEATURE",
        "Native preview v1 requires every atlas tile size to match the map grid size.",
        {
          feature: "tileset-tile-size",
          assetId: binding.assetId,
          path: binding.path,
          mapTileSize: { width: mapTileWidth, height: mapTileHeight },
          tilesetTileSize: { width: tileWidth, height: tileHeight },
        },
      );
    }
    const tileRenderSize = document.tilerendersize ?? "tile";
    if (tileRenderSize !== "tile") {
      throw unsupportedRenderFeature(
        "tileset-tile-render-size",
        "Native preview v1 supports only tileset tilerendersize \"tile\".",
        {
          assetId: binding.assetId,
          path: binding.path,
          tileRenderSize,
        },
      );
    }
    const fillMode = document.fillmode ?? "stretch";
    if (fillMode !== "stretch") {
      throw unsupportedRenderFeature(
        "tileset-fill-mode",
        "Native preview v1 supports only tileset fillmode \"stretch\".",
        {
          assetId: binding.assetId,
          path: binding.path,
          fillMode,
        },
      );
    }
    if (document.tileoffset !== undefined) {
      const tileOffset = expectObject(
        document.tileoffset,
        `${binding.path}.tileoffset`,
      );
      const offsetX = expectInteger(
        tileOffset.x ?? 0,
        `${binding.path}.tileoffset.x`,
      );
      const offsetY = expectInteger(
        tileOffset.y ?? 0,
        `${binding.path}.tileoffset.y`,
      );
      if (offsetX !== 0 || offsetY !== 0) {
        throw unsupportedRenderFeature(
          "tileset-tile-offset",
          "Native preview v1 does not support a non-zero tileset tileoffset.",
          {
            assetId: binding.assetId,
            path: binding.path,
            tileOffset: { x: offsetX, y: offsetY },
          },
        );
      }
    }
    if (document.tiles !== undefined) {
      const tileEntries = expectArray(
        document.tiles,
        `${binding.path}.tiles`,
      );
      for (const [index, value] of tileEntries.entries()) {
        const tile = expectObject(value, `${binding.path}.tiles[${index}]`);
        if (tile.image !== undefined) {
          throw new TiledMcpError(
            "UNSUPPORTED_TILESET",
            "Native preview v1 does not support hybrid or image-collection tilesets.",
            {
              assetId: binding.assetId,
              path: binding.path,
              tileIndex: index,
            },
          );
        }
        if (
          tile.x !== undefined ||
          tile.y !== undefined ||
          tile.width !== undefined ||
          tile.height !== undefined ||
          tile.imagewidth !== undefined ||
          tile.imageheight !== undefined
        ) {
          throw unsupportedRenderFeature(
            "tile-image-subrect",
            "Native preview v1 does not support per-tile image subrect overrides.",
            {
              assetId: binding.assetId,
              path: binding.path,
              tileIndex: index,
            },
          );
        }
        if (tile.animation !== undefined) {
          throw unsupportedRenderFeature(
            "animated-tile",
            "Native preview v1 renders only static tiles.",
            {
              assetId: binding.assetId,
              path: binding.path,
              tileIndex: index,
            },
          );
        }
      }
    }

    const imagePath = await this.resolver.resolveReference(
      binding.path,
      document.image,
    );
    const geometry: AtlasGeometry = {
      imagePath,
      imageWidth: expectInteger(
        document.imagewidth,
        `${binding.path}.imagewidth`,
      ),
      imageHeight: expectInteger(
        document.imageheight,
        `${binding.path}.imageheight`,
      ),
      tileWidth,
      tileHeight,
      tileCount: expectInteger(
        document.tilecount,
        `${binding.path}.tilecount`,
      ),
      columns: expectInteger(
        document.columns,
        `${binding.path}.columns`,
      ),
      margin: expectInteger(
        document.margin ?? 0,
        `${binding.path}.margin`,
      ),
      spacing: expectInteger(
        document.spacing ?? 0,
        `${binding.path}.spacing`,
      ),
    };
    validateAtlasGeometry(geometry);
    const decodedPixels = geometry.imageWidth * geometry.imageHeight;
    if (
      !Number.isSafeInteger(decodedPixels) ||
      decodedPixels > remainingDecodedPixels
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Preview atlases exceed the ${MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS} decoded-pixel aggregate limit.`,
        {
          assetId: binding.assetId,
          path: binding.path,
          nextImagePixels: decodedPixels,
          remainingPixels: Math.max(0, remainingDecodedPixels),
          limit: MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
        },
      );
    }
    const image = await readImageFileSnapshot(
      this.resolver,
      imagePath,
      Math.min(MAX_TILESET_IMAGE_BYTES, remainingImageBytes),
    );
    const decoded = await decodeSafeImage({
      bytes: image.bytes,
      path: image.path,
      declaredWidth: geometry.imageWidth,
      declaredHeight: geometry.imageHeight,
      limits: {
        maxInputBytes: Math.min(
          MAX_TILESET_IMAGE_BYTES,
          remainingImageBytes,
        ),
        maxInputPixels: Math.min(
          MAX_TILESET_INPUT_PIXELS,
          remainingDecodedPixels,
        ),
        maxInputEdge: MAX_TILESET_INPUT_EDGE,
      },
    });
    const transparentColor =
      document.transparentcolor === undefined
        ? undefined
        : parseTransparentColor(
            expectString(
              document.transparentcolor,
              `${binding.path}.transparentcolor`,
            ),
          );
    return {
      image,
      geometry,
      decoded,
      ...(transparentColor === undefined ? {} : { transparentColor }),
    };
  }

  private async assertDependenciesUnchanged(bindings: readonly TilesetBinding[]): Promise<void> {
    for (const binding of bindings) {
      const currentRevision = await this.store.readRevision(binding.path);
      if (currentRevision !== binding.revision) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          `${binding.path} changed while the operation was being prepared.`,
          {
            assetId: binding.assetId,
            expectedRevision: binding.revision,
            actualRevision: currentRevision,
          },
        );
      }
    }
  }

  private async validateTilesets(
    mapPath: string,
    entries: JsonValue[],
    diagnostics: Diagnostic[],
  ): Promise<void> {
    if (entries.length > MAX_TILESET_COUNT) {
      diagnostics.push(
        errorDiagnostic(
          "TILESET_LIMIT_EXCEEDED",
          `Map references more than ${MAX_TILESET_COUNT} tilesets.`,
          "/tilesets",
        ),
      );
    }
    const firstGids = new Set<number>();
    let totalDependencyBytes = 0;
    for (const [index, value] of entries.slice(0, MAX_TILESET_COUNT).entries()) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return;
      }
      const pointer = `/tilesets/${index}`;
      if (!isJsonObject(value)) {
        diagnostics.push(errorDiagnostic("TILESET_ENTRY_INVALID", "Entry must be an object.", pointer));
        continue;
      }
      if (
        typeof value.firstgid !== "number" ||
        !Number.isSafeInteger(value.firstgid) ||
        value.firstgid <= 0
      ) {
        diagnostics.push(
          errorDiagnostic("FIRSTGID_INVALID", "firstgid must be a positive integer.", `${pointer}/firstgid`),
        );
      } else if (firstGids.has(value.firstgid)) {
        diagnostics.push(
          errorDiagnostic("FIRSTGID_DUPLICATE", `Duplicate firstgid ${value.firstgid}.`, `${pointer}/firstgid`),
        );
      } else {
        firstGids.add(value.firstgid);
      }
      if (typeof value.source !== "string") {
        diagnostics.push(
          errorDiagnostic(
            "TILESET_PROFILE_UNSUPPORTED",
            "MVP editing requires an external TSJ atlas.",
            pointer,
          ),
        );
        continue;
      }
      try {
        const tilesetPath = await this.resolver.resolveReference(mapPath, value.source);
        const tileset = await this.store.read(tilesetPath);
        totalDependencyBytes += tileset.size;
        if (totalDependencyBytes > MAX_TOTAL_DEPENDENCY_BYTES) {
          diagnostics.push(
            errorDiagnostic(
              "DEPENDENCY_BYTES_LIMIT_EXCEEDED",
              `Referenced tilesets exceed the ${MAX_TOTAL_DEPENDENCY_BYTES} byte aggregate limit.`,
              "/tilesets",
            ),
          );
          return;
        }
        if (typeof tileset.document.image !== "string") {
          diagnostics.push(
            errorDiagnostic(
              "TILESET_PROFILE_UNSUPPORTED",
              "External tileset is not an atlas tileset.",
              pointer,
            ),
          );
        } else {
          const imagePath = await this.resolver.resolveReference(
            tilesetPath,
            tileset.document.image,
          );
          const imageStat = await stat(await this.resolver.resolveExisting(imagePath));
          if (!imageStat.isFile()) {
            throw new TiledMcpError(
              "INVALID_TILESET_IMAGE",
              `${imagePath} is not a regular image file.`,
              { path: imagePath },
            );
          }
        }
      } catch (error) {
        diagnostics.push(fromCaughtDiagnostic(error, `${pointer}/source`));
      }
    }
  }

  private async assertRenderLayerReferences(
    mapPath: string,
    layers: JsonValue[],
    depth: number,
    budget: LayerTraversalBudget,
    imageBudget: RenderImageBudget,
  ): Promise<void> {
    assertLayerTraversalBudget(layers.length, depth, budget);
    for (const [index, value] of layers.entries()) {
      const layer = expectObject(value, `${mapPath}.layers[${index}]`);
      const type = expectString(layer.type, `${mapPath}.layers[${index}].type`);
      if (type === "group") {
        await this.assertRenderLayerReferences(
          mapPath,
          expectArray(layer.layers, `${mapPath}.layers[${index}].layers`),
          depth + 1,
          budget,
          imageBudget,
        );
        continue;
      }
      if (type === "tilelayer") {
        findTileLayer(
          { layers },
          expectInteger(layer.id, `${mapPath}.layers[${index}].id`),
          mapPath,
          "read",
        );
        continue;
      }
      if (type === "imagelayer") {
        if (typeof layer.image !== "string") {
          throw new TiledMcpError(
            "UNSAFE_RENDER_REFERENCE",
            "Image layers must use a project-local image path.",
            { path: mapPath, layerIndex: index },
          );
        }
        const imagePath = await this.resolver.resolveReference(mapPath, layer.image);
        await this.assertRenderImageSafe(
          imagePath,
          imageBudget,
        );
        continue;
      }
      if (type === "objectgroup") {
        assertNoTemplateReferences(layer, mapPath);
        continue;
      }
      throw new TiledMcpError(
        "UNSUPPORTED_RENDER_LAYER",
        `Layer type ${type} is not supported by the sandboxed MVP renderer.`,
        { path: mapPath, layerIndex: index, type },
      );
    }
  }

  private async assertRenderImageSafe(
    imagePath: string,
    budget: RenderImageBudget,
  ): Promise<void> {
    const normalizedPath =
      this.resolver.normalize(imagePath);
    if (budget.revisions.has(normalizedPath)) {
      return;
    }
    if (
      budget.revisions.size >=
      MAX_RASTER_INPUT_IMAGES
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Raster input references more than ${MAX_RASTER_INPUT_IMAGES} unique images.`,
        {
          path: normalizedPath,
          limit: MAX_RASTER_INPUT_IMAGES,
        },
      );
    }

    const remainingBytes =
      MAX_RASTER_INPUT_AGGREGATE_BYTES -
      budget.totalBytes;
    if (remainingBytes <= 0) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Raster input images exceed the ${MAX_RASTER_INPUT_AGGREGATE_BYTES} byte aggregate limit.`,
        {
          path: normalizedPath,
          limit:
            MAX_RASTER_INPUT_AGGREGATE_BYTES,
          actual: budget.totalBytes,
        },
      );
    }
    const expectedRevision =
      budget.expectedRevisions?.[
        normalizedPath
      ];
    if (
      budget.expectedRevisions !== undefined &&
      expectedRevision === undefined
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${normalizedPath} was not part of the pre-render image set.`,
        {
          path: normalizedPath,
        },
      );
    }
    let image: ImageFileSnapshot;
    try {
      image = await readImageFileSnapshot(
        this.resolver,
        normalizedPath,
        remainingBytes,
      );
    } catch (error) {
      if (expectedRevision === undefined) {
        throw error;
      }
      const cause =
        asTiledMcpError(error);
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${normalizedPath} could not be re-read after the map was rendered.`,
        {
          path: normalizedPath,
          causeCode: cause.code,
        },
      );
    }
    if (
      expectedRevision !== undefined &&
      image.revision !== expectedRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${normalizedPath} changed while the map was rendered.`,
        {
          path: normalizedPath,
        },
      );
    }

    const remainingPixels =
      MAX_RASTER_INPUT_AGGREGATE_PIXELS -
      budget.totalPixels;
    if (remainingPixels <= 0) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Raster input images exceed the ${MAX_RASTER_INPUT_AGGREGATE_PIXELS} decoded-pixel aggregate limit.`,
        {
          path: normalizedPath,
          limit:
            MAX_RASTER_INPUT_AGGREGATE_PIXELS,
          actual: budget.totalPixels,
        },
      );
    }
    const metadata = await inspectSafeImage({
      bytes: image.bytes,
      path: image.path,
      limits: {
        maxInputBytes: remainingBytes,
        maxInputPixels: remainingPixels,
        maxInputEdge:
          MAX_RASTER_INPUT_EDGE,
      },
    });
    budget.totalBytes +=
      image.bytes.byteLength;
    budget.totalPixels +=
      metadata.width * metadata.height;
    budget.revisions.set(
      normalizedPath,
      image.revision,
    );
  }

}

function validateAndSummarizeOperations(
  map: JsonObject,
  orientation: "orthogonal",
  bindings: readonly TilesetBinding[],
  operations: readonly PlannedMapEditOperation[],
  mapPath: string,
  options: {
    allowResolvedAddTileset?: boolean;
    allowResolvedCreateLayer?: boolean;
    sourceBytes?: number;
  } = {},
): MapEditPlan["summary"] {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TiledMcpError("INVALID_ARGUMENT", "At least one edit operation is required.");
  }
  if (operations.length > MAX_PLAN_OPERATIONS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_PLAN_OPERATIONS} operations.`,
      { limit: MAX_PLAN_OPERATIONS },
    );
  }
  const removeTilesetOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "removeTilesetFromMap",
  ).length;
  if (
    removeTilesetOperationCount > 1 ||
    (removeTilesetOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "removeTilesetFromMap must be the only operation in its change set.",
    );
  }
  const deleteLayerOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "deleteLayer",
  ).length;
  if (
    deleteLayerOperationCount > 1 ||
    (deleteLayerOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "deleteLayer must be the only operation in its change set.",
    );
  }
  const moveLayerOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "moveLayer",
  ).length;
  if (
    moveLayerOperationCount > 1 ||
    (moveLayerOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "moveLayer must be the only operation in its change set.",
    );
  }
  const duplicateLayerOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "duplicateLayer",
  ).length;
  if (
    duplicateLayerOperationCount > 1 ||
    (duplicateLayerOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "duplicateLayer must be the only operation in its change set.",
    );
  }
  const resizeMapOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "resizeMap",
  ).length;
  if (
    resizeMapOperationCount > 1 ||
    (resizeMapOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "resizeMap must be the only operation in its change set.",
    );
  }

  let cellWrites = 0;
  let tileOperationScans = 0;
  let objectMutations = 0;
  let objectShapePoints = 0;
  let textObjectPayloadBytes = 0;
  let objectPropertyPatchBytes = 0;
  const affectedLayerIds = new Set<number>();
  const affectedTileLayerIds = new Set<number>();
  const affectedObjectLayerIds = new Set<number>();
  const createdObjectIds = new Set<number>();
  const updatedObjectIds = new Set<number>();
  const deletedObjectIds = new Set<number>();
  const updatedLayerIds = new Set<number>();
  const changedMapMembers = new Set<string>();
  const changedLayerMembers = new Set<string>();
  const addedTilesets: NonNullable<
    MapEditPlan["summary"]["addedTilesets"]
  > = [];
  const removedTilesets: NonNullable<
    MapEditPlan["summary"]["removedTilesets"]
  > = [];
  const createdLayers: NonNullable<
    MapEditPlan["summary"]["createdLayers"]
  > = [];
  const tileReplacements: NonNullable<
    MapEditPlan["summary"]["tileReplacements"]
  > = [];
  const tileStamps: NonNullable<
    MapEditPlan["summary"]["tileStamps"]
  > = [];
  const tileFloodFills: NonNullable<
    MapEditPlan["summary"]["tileFloodFills"]
  > = [];
  const tileCopies: NonNullable<
    MapEditPlan["summary"]["tileCopies"]
  > = [];
  const mapUpdates: NonNullable<
    MapEditPlan["summary"]["mapUpdates"]
  > = [];
  const mapResizes: NonNullable<
    MapEditPlan["summary"]["mapResizes"]
  > = [];
  const layerUpdates: NonNullable<
    MapEditPlan["summary"]["layerUpdates"]
  > = [];
  const deletedLayers: NonNullable<
    MapEditPlan["summary"]["deletedLayers"]
  > = [];
  const movedLayers: NonNullable<
    MapEditPlan["summary"]["movedLayers"]
  > = [];
  const duplicatedLayers: NonNullable<
    MapEditPlan["summary"]["duplicatedLayers"]
  > = [];
  let objectIndex: ObjectEditIndex | undefined;
  const getObjectIndex = (): ObjectEditIndex => {
    objectIndex ??= buildObjectEditIndex(map, mapPath);
    return objectIndex;
  };
  for (const [operationIndex, operation] of operations.entries()) {
    if (!isRecordValue(operation)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Operation ${operationIndex} must be an object.`,
      );
    }
    if (operation.type === "createLayer") {
      if (
        options.allowResolvedCreateLayer !== true ||
        operations.length !== 1
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "createLayer is available only through its dedicated preview tool and cannot be batched with generic map edits.",
        );
      }
      assertResolvedCreateLayerOperation(operation);
      const created = applyResolvedCreateLayer(
        map,
        operation,
        mapPath,
      );
      if (cellWrites + created.allocatedCellCount > MAX_CELL_WRITES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          { limit: MAX_CELL_WRITES },
        );
      }
      cellWrites += created.allocatedCellCount;
      affectedLayerIds.add(operation.layerId);
      createdLayers.push({
        layerId: operation.layerId,
        layerType: operation.layerType,
        name: operation.name,
        parentGroupId: operation.parentGroupId,
        index: operation.index,
        allocatedCellCount: created.allocatedCellCount,
        ...(operation.image === undefined
          ? {}
          : { image: structuredClone(operation.image) }),
      });
    } else if (operation.type === "addTilesetToMap") {
      if (
        options.allowResolvedAddTileset !== true ||
        operations.length !== 1
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "addTilesetToMap is available only through its dedicated preview tool and cannot be batched with generic map edits.",
        );
      }
      assertResolvedAddTilesetOperation(operation);
      const entries = expectArray(map.tilesets, `${mapPath}.tilesets`);
      entries.push({
        firstgid: operation.firstGid,
        source: operation.source,
      });
      map.tilesets = entries;
      addedTilesets.push({
        tilesetPath: operation.tilesetPath,
        source: operation.source,
        assetId: operation.assetId,
        tilesetRevision: operation.tilesetRevision,
        tileCount: operation.tileCount,
        gidSpan: operation.gidSpan,
        firstGid: operation.firstGid,
      });
    } else if (
      operation.type === "removeTilesetFromMap"
    ) {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["tilesetAssetId", "type"]),
        `operations[${operationIndex}]`,
      );
      if (
        typeof operation.tilesetAssetId !== "string" ||
        !ASSET_ID_PATTERN.test(
          operation.tilesetAssetId,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].tilesetAssetId must be an opaque asset id returned by the map summary.`,
        );
      }
      removedTilesets.push({
        operationIndex,
        ...removeUnusedTilesetReference(
          map,
          bindings,
          operation.tilesetAssetId,
          mapPath,
        ),
      });
    } else if (operation.type === "updateMap") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["patch", "type"]),
        `operations[${operationIndex}]`,
      );
      const update = updateCommonMap(
        map,
        operation.patch,
        `operations[${operationIndex}].patch`,
      );
      for (const field of update.changedFields) {
        changedMapMembers.add(mapPatchJsonKey(field));
      }
      mapUpdates.push({
        operationIndex,
        requestedFields: update.requestedFields,
        changedFields: update.changedFields,
        wouldChange: update.changedFields.length > 0,
        renderingMayChange: update.changedFields.some(
          (field) => MAP_RENDER_FIELDS.has(field),
        ),
      });
    } else if (operation.type === "resizeMap") {
      const operationContext = `operations[${operationIndex}]`;
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["height", "offsetX", "offsetY", "type", "width"]),
        operationContext,
      );
      const input = readResizeMapInput(
        operation as unknown as Record<string, unknown>,
        operationContext,
      );
      const oldWidth = expectInteger(map.width, `${mapPath}.width`);
      const oldHeight = expectInteger(map.height, `${mapPath}.height`);
      assertPositiveInteger(oldWidth, `${mapPath}.width`);
      assertPositiveInteger(oldHeight, `${mapPath}.height`);
      const tileWidth = expectInteger(map.tilewidth, `${mapPath}.tilewidth`);
      const tileHeight = expectInteger(map.tileheight, `${mapPath}.tileheight`);
      assertPositiveInteger(tileWidth, `${mapPath}.tilewidth`);
      assertPositiveInteger(tileHeight, `${mapPath}.tileheight`);
      const pixelOffsetX = input.offsetX * tileWidth;
      const pixelOffsetY = input.offsetY * tileHeight;
      if (
        !Number.isSafeInteger(pixelOffsetX) ||
        !Number.isSafeInteger(pixelOffsetY) ||
        !Number.isSafeInteger(input.width * tileWidth) ||
        !Number.isSafeInteger(input.height * tileHeight)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext} pixel arithmetic must stay within safe integers.`,
        );
      }
      const views = collectResizeLayerViews(
        map,
        oldWidth,
        oldHeight,
        mapPath,
        operationContext,
      );
      const scannedCellCount =
        views.tileLayers.length * oldWidth * oldHeight;
      const rewrittenCellCount =
        views.tileLayers.length * input.width * input.height;
      if (
        !Number.isSafeInteger(rewrittenCellCount) ||
        cellWrites + rewrittenCellCount > MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          {
            limit: MAX_CELL_WRITES,
            actual: cellWrites + rewrittenCellCount,
            operationIndex,
          },
        );
      }
      if (
        !Number.isSafeInteger(scannedCellCount) ||
        tileOperationScans + scannedCellCount >
          MAX_RESIZE_SOURCE_CELL_SCANS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A resizeMap operation may scan at most ${MAX_RESIZE_SOURCE_CELL_SCANS} source tile cells.`,
          {
            limit: MAX_RESIZE_SOURCE_CELL_SCANS,
            actual: tileOperationScans + scannedCellCount,
            operationIndex,
          },
        );
      }
      const resized = performMapResize(
        map,
        orientation,
        bindings,
        views,
        {
          operationContext,
          mapPath,
          oldWidth,
          oldHeight,
          newWidth: input.width,
          newHeight: input.height,
          offsetX: input.offsetX,
          offsetY: input.offsetY,
          pixelOffsetX,
          pixelOffsetY,
          tileWidth,
          tileHeight,
          objectMutationsUsed: objectMutations,
        },
      );
      cellWrites += rewrittenCellCount;
      tileOperationScans += scannedCellCount;
      objectMutations += resized.movedObjectCount;
      for (const layerId of resized.dataChangedTileLayerIds) {
        affectedLayerIds.add(layerId);
        affectedTileLayerIds.add(layerId);
      }
      for (const layerId of resized.objectShiftedLayerIds) {
        affectedLayerIds.add(layerId);
        affectedObjectLayerIds.add(layerId);
      }
      for (const layerId of resized.shiftedImageLayerIds) {
        affectedLayerIds.add(layerId);
      }
      mapResizes.push({
        operationIndex,
        oldWidth,
        oldHeight,
        newWidth: input.width,
        newHeight: input.height,
        offsetX: input.offsetX,
        offsetY: input.offsetY,
        pixelOffsetX,
        pixelOffsetY,
        wouldChange: resized.wouldChange,
        mapDimensionsChanged: resized.mapDimensionsChanged,
        tileLayerCount: views.tileLayers.length,
        resizedTileLayerIds: views.tileLayers
          .map((layer) => layer.id)
          .sort((left, right) => left - right),
        scannedCellCount,
        rewrittenCellCount,
        preservedNonEmptyCellCount:
          resized.preservedNonEmptyCellCount,
        croppedNonEmptyCellCount:
          resized.croppedNonEmptyCellCount,
        croppedCellSample: resized.croppedCellSample,
        omittedCroppedCellCount:
          resized.croppedNonEmptyCellCount -
          resized.croppedCellSample.length,
        objectLayerCount: views.objectLayers.length,
        movedObjectCount: resized.movedObjectCount,
        objectsOutsideNewBounds:
          resized.objectsOutsideNewBounds,
        imageLayerCount: views.imageLayers.length,
        shiftedImageLayerIds: [
          ...resized.shiftedImageLayerIds,
        ].sort((left, right) => left - right),
        groupLayerCount: views.groupLayerCount,
        lockedLayerCount: views.lockedLayerCount,
      });
    } else if (operation.type === "setTiles") {
      assertSafeInteger(operation.layerId, `operations[${operationIndex}].layerId`);
      if (!Array.isArray(operation.cells) || operation.cells.length === 0) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].cells must not be empty.`,
        );
      }
      if (cellWrites + operation.cells.length > MAX_CELL_WRITES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          { limit: MAX_CELL_WRITES },
        );
      }
      const layer = findTileLayer(map, operation.layerId, mapPath);
      affectedLayerIds.add(layer.id);
      affectedTileLayerIds.add(layer.id);
      cellWrites += operation.cells.length;
      for (const [cellIndex, cell] of operation.cells.entries()) {
        assertSafeInteger(cell.x, `operations[${operationIndex}].cells[${cellIndex}].x`);
        assertSafeInteger(cell.y, `operations[${operationIndex}].cells[${cellIndex}].y`);
        assertRegionInsideLayer(layer, cell.x, cell.y, 1, 1);
        const gid = tileRefToGid(cell.tile, orientation, bindings);
        writeLayerGid(layer, cell.x, cell.y, gid);
      }
    } else if (operation.type === "fillRegion") {
      assertSafeInteger(operation.layerId, `operations[${operationIndex}].layerId`);
      assertSafeInteger(operation.x, `operations[${operationIndex}].x`);
      assertSafeInteger(operation.y, `operations[${operationIndex}].y`);
      assertPositiveInteger(operation.width, `operations[${operationIndex}].width`);
      assertPositiveInteger(operation.height, `operations[${operationIndex}].height`);
      const regionCells = operation.width * operation.height;
      if (
        !Number.isSafeInteger(regionCells) ||
        cellWrites + regionCells > MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          { limit: MAX_CELL_WRITES },
        );
      }
      const layer = findTileLayer(map, operation.layerId, mapPath);
      assertRegionInsideLayer(
        layer,
        operation.x,
        operation.y,
        operation.width,
        operation.height,
      );
      affectedLayerIds.add(layer.id);
      affectedTileLayerIds.add(layer.id);
      cellWrites += regionCells;
      const gid = tileRefToGid(operation.tile, orientation, bindings);
      for (let y = operation.y; y < operation.y + operation.height; y += 1) {
        for (let x = operation.x; x < operation.x + operation.width; x += 1) {
          writeLayerGid(layer, x, y, gid);
        }
      }
    } else if (operation.type === "floodFill") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set([
          "layerId",
          "tile",
          "type",
          "x",
          "y",
        ]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      assertSafeInteger(
        operation.x,
        `operations[${operationIndex}].x`,
      );
      assertSafeInteger(
        operation.y,
        `operations[${operationIndex}].y`,
      );
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
      );
      assertRegionInsideLayer(
        layer,
        operation.x,
        operation.y,
        1,
        1,
      );
      const targetGid = tileRefToGid(
        operation.tile,
        orientation,
        bindings,
      );
      const targetTile = gidToTileRef(
        targetGid,
        orientation,
        bindings,
      );
      let scannedCellCount = 0;
      const readObservedGid = (
        x: number,
        y: number,
      ): {
        gid: number;
        tile: TileRef | null;
      } => {
        const nextScanCount =
          tileOperationScans +
          scannedCellCount +
          1;
        if (
          !Number.isSafeInteger(nextScanCount) ||
          nextScanCount >
            MAX_TILE_OPERATION_SCANS
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
            {
              limit: MAX_TILE_OPERATION_SCANS,
              actual: nextScanCount,
              operationIndex,
            },
          );
        }
        scannedCellCount += 1;
        const gid = readLayerGid(layer, x, y);
        return {
          gid,
          tile: gidToTileRef(
            gid,
            orientation,
            bindings,
          ),
        };
      };
      const source = readObservedGid(
        operation.x,
        operation.y,
      );
      let changedCellCount = 0;
      let affectedBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null = null;

      if (source.gid !== targetGid) {
        if (cellWrites + 1 > MAX_CELL_WRITES) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may write at most ${MAX_CELL_WRITES} cells.`,
            {
              limit: MAX_CELL_WRITES,
              actual: cellWrites + 1,
              operationIndex,
            },
          );
        }
        const seedLocalX =
          operation.x - layer.x;
        const seedLocalY =
          operation.y - layer.y;
        const queue = [
          seedLocalY * layer.width + seedLocalX,
        ];
        writeLayerGid(
          layer,
          operation.x,
          operation.y,
          targetGid,
        );
        changedCellCount = 1;
        let minimumX = operation.x;
        let minimumY = operation.y;
        let maximumX = operation.x;
        let maximumY = operation.y;

        for (
          let queueIndex = 0;
          queueIndex < queue.length;
          queueIndex += 1
        ) {
          const index = queue[queueIndex] as number;
          const localX = index % layer.width;
          const localY = Math.floor(
            index / layer.width,
          );
          for (const [
            deltaX,
            deltaY,
          ] of FOUR_WAY_TILE_NEIGHBOR_OFFSETS) {
            const neighborLocalX =
              localX + deltaX;
            const neighborLocalY =
              localY + deltaY;
            if (
              neighborLocalX < 0 ||
              neighborLocalY < 0 ||
              neighborLocalX >= layer.width ||
              neighborLocalY >= layer.height
            ) {
              continue;
            }
            const neighborX =
              layer.x + neighborLocalX;
            const neighborY =
              layer.y + neighborLocalY;
            const candidate = readObservedGid(
              neighborX,
              neighborY,
            );
            if (candidate.gid !== source.gid) {
              continue;
            }
            const nextChangedCellCount =
              changedCellCount + 1;
            if (
              cellWrites +
                nextChangedCellCount >
              MAX_CELL_WRITES
            ) {
              throw new TiledMcpError(
                "RESULT_LIMIT_EXCEEDED",
                `A change set may write at most ${MAX_CELL_WRITES} cells.`,
                {
                  limit: MAX_CELL_WRITES,
                  actual:
                    cellWrites +
                    nextChangedCellCount,
                  operationIndex,
                },
              );
            }
            writeLayerGid(
              layer,
              neighborX,
              neighborY,
              targetGid,
            );
            changedCellCount =
              nextChangedCellCount;
            minimumX = Math.min(
              minimumX,
              neighborX,
            );
            minimumY = Math.min(
              minimumY,
              neighborY,
            );
            maximumX = Math.max(
              maximumX,
              neighborX,
            );
            maximumY = Math.max(
              maximumY,
              neighborY,
            );
            queue.push(
              neighborLocalY * layer.width +
                neighborLocalX,
            );
          }
        }
        affectedBounds = {
          x: minimumX,
          y: minimumY,
          width: maximumX - minimumX + 1,
          height: maximumY - minimumY + 1,
        };
      }

      tileOperationScans +=
        scannedCellCount;
      cellWrites += changedCellCount;
      if (changedCellCount > 0) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
      }
      tileFloodFills.push({
        operationIndex,
        layerId: layer.id,
        seed: {
          x: operation.x,
          y: operation.y,
        },
        connectivity: "four-way",
        sourceTile: source.tile,
        targetTile,
        scannedCellCount,
        changedCellCount,
        affectedBounds,
        wouldChange: changedCellCount > 0,
      });
    } else if (operation.type === "copyRegion") {
      const operationContext =
        `operations[${operationIndex}]`;
      assertExactObjectKeys(
        operation as unknown as Record<
          string,
          unknown
        >,
        new Set(["destination", "source", "type"]),
        operationContext,
      );
      if (!isRecordValue(operation.source)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext}.source must be an object.`,
        );
      }
      if (!isRecordValue(operation.destination)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext}.destination must be an object.`,
        );
      }
      assertExactObjectKeys(
        operation.source as unknown as Record<
          string,
          unknown
        >,
        new Set([
          "height",
          "layerId",
          "width",
          "x",
          "y",
        ]),
        `${operationContext}.source`,
      );
      assertExactObjectKeys(
        operation.destination as unknown as Record<
          string,
          unknown
        >,
        new Set(["layerId", "x", "y"]),
        `${operationContext}.destination`,
      );
      assertPositiveInteger(
        operation.source.layerId,
        `${operationContext}.source.layerId`,
      );
      assertSafeInteger(
        operation.source.x,
        `${operationContext}.source.x`,
      );
      assertSafeInteger(
        operation.source.y,
        `${operationContext}.source.y`,
      );
      assertPositiveInteger(
        operation.source.width,
        `${operationContext}.source.width`,
      );
      assertPositiveInteger(
        operation.source.height,
        `${operationContext}.source.height`,
      );
      assertPositiveInteger(
        operation.destination.layerId,
        `${operationContext}.destination.layerId`,
      );
      assertSafeInteger(
        operation.destination.x,
        `${operationContext}.destination.x`,
      );
      assertSafeInteger(
        operation.destination.y,
        `${operationContext}.destination.y`,
      );
      if (
        !Number.isSafeInteger(
          operation.source.x +
            operation.source.width,
        ) ||
        !Number.isSafeInteger(
          operation.source.y +
            operation.source.height,
        ) ||
        !Number.isSafeInteger(
          operation.destination.x +
            operation.source.width,
        ) ||
        !Number.isSafeInteger(
          operation.destination.y +
            operation.source.height,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext} copy endpoints must be safe integers.`,
        );
      }
      const copyCellCount =
        operation.source.width *
        operation.source.height;
      if (
        !Number.isSafeInteger(copyCellCount) ||
        cellWrites + copyCellCount >
          MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          {
            limit: MAX_CELL_WRITES,
            actual: cellWrites + copyCellCount,
            operationIndex,
          },
        );
      }
      const scannedCellCount = copyCellCount * 2;
      if (
        !Number.isSafeInteger(scannedCellCount) ||
        tileOperationScans + scannedCellCount >
          MAX_TILE_OPERATION_SCANS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
          {
            limit: MAX_TILE_OPERATION_SCANS,
            actual:
              tileOperationScans +
              scannedCellCount,
            operationIndex,
          },
        );
      }
      const sourceLayer = findTileLayer(
        map,
        operation.source.layerId,
        mapPath,
      );
      const destinationLayer = findTileLayer(
        map,
        operation.destination.layerId,
        mapPath,
      );
      assertRegionInsideLayer(
        sourceLayer,
        operation.source.x,
        operation.source.y,
        operation.source.width,
        operation.source.height,
      );
      assertRegionInsideLayer(
        destinationLayer,
        operation.destination.x,
        operation.destination.y,
        operation.source.width,
        operation.source.height,
      );

      const sourceGids: number[] = [];
      const destinationGids: number[] = [];
      let sourceNonEmptyCellCount = 0;
      let overwrittenNonEmptyCellCount = 0;
      let changedCellCount = 0;
      let clearedCellCount = 0;
      for (
        let rowIndex = 0;
        rowIndex < operation.source.height;
        rowIndex += 1
      ) {
        for (
          let columnIndex = 0;
          columnIndex < operation.source.width;
          columnIndex += 1
        ) {
          const sourceGid = readLayerGid(
            sourceLayer,
            operation.source.x + columnIndex,
            operation.source.y + rowIndex,
          );
          const destinationGid = readLayerGid(
            destinationLayer,
            operation.destination.x + columnIndex,
            operation.destination.y + rowIndex,
          );
          // A copy observes both rectangles before it mutates either one.
          // Resolve every observed encoded GID so malformed or unbound
          // values fail closed even when the destination would be unchanged.
          gidToTileRef(
            sourceGid,
            orientation,
            bindings,
          );
          gidToTileRef(
            destinationGid,
            orientation,
            bindings,
          );
          sourceGids.push(sourceGid);
          destinationGids.push(destinationGid);
          if (sourceGid !== 0) {
            sourceNonEmptyCellCount += 1;
          }
          if (destinationGid !== 0) {
            overwrittenNonEmptyCellCount += 1;
          }
          if (sourceGid !== destinationGid) {
            changedCellCount += 1;
            if (
              sourceGid === 0 &&
              destinationGid !== 0
            ) {
              clearedCellCount += 1;
            }
          }
        }
      }

      for (
        let rowIndex = 0;
        rowIndex < operation.source.height;
        rowIndex += 1
      ) {
        for (
          let columnIndex = 0;
          columnIndex < operation.source.width;
          columnIndex += 1
        ) {
          const index =
            rowIndex * operation.source.width +
            columnIndex;
          const sourceGid = sourceGids[index] as number;
          if (
            sourceGid === destinationGids[index]
          ) {
            continue;
          }
          writeLayerGid(
            destinationLayer,
            operation.destination.x + columnIndex,
            operation.destination.y + rowIndex,
            sourceGid,
          );
        }
      }
      cellWrites += copyCellCount;
      tileOperationScans += scannedCellCount;
      if (changedCellCount > 0) {
        affectedLayerIds.add(destinationLayer.id);
        affectedTileLayerIds.add(
          destinationLayer.id,
        );
      }
      const overlapsSource =
        sourceLayer.id === destinationLayer.id &&
        operation.source.x <
          operation.destination.x +
            operation.source.width &&
        operation.destination.x <
          operation.source.x +
            operation.source.width &&
        operation.source.y <
          operation.destination.y +
            operation.source.height &&
        operation.destination.y <
          operation.source.y +
            operation.source.height;
      tileCopies.push({
        operationIndex,
        source: {
          layerId: sourceLayer.id,
          x: operation.source.x,
          y: operation.source.y,
          width: operation.source.width,
          height: operation.source.height,
        },
        destination: {
          layerId: destinationLayer.id,
          x: operation.destination.x,
          y: operation.destination.y,
          width: operation.source.width,
          height: operation.source.height,
        },
        scannedCellCount,
        cellCount: copyCellCount,
        sourceNonEmptyCellCount,
        changedCellCount,
        overwrittenNonEmptyCellCount,
        clearedCellCount,
        overlapsSource,
        wouldChange: changedCellCount > 0,
      });
    } else if (operation.type === "stampPattern") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set([
          "layerId",
          "pattern",
          "type",
          "x",
          "y",
        ]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      assertSafeInteger(
        operation.x,
        `operations[${operationIndex}].x`,
      );
      assertSafeInteger(
        operation.y,
        `operations[${operationIndex}].y`,
      );
      const pattern = readStampPattern(
        operation.pattern,
        operationIndex,
      );
      const height = pattern.length;
      const width = pattern[0]?.length ?? 0;
      const patternCellCount = width * height;
      if (
        !Number.isSafeInteger(operation.x + width) ||
        !Number.isSafeInteger(operation.y + height)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}] stamp endpoints must be safe integers.`,
        );
      }
      if (
        cellWrites + patternCellCount >
        MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          {
            limit: MAX_CELL_WRITES,
            actual: cellWrites + patternCellCount,
          },
        );
      }
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
      );
      assertRegionInsideLayer(
        layer,
        operation.x,
        operation.y,
        width,
        height,
      );

      const resolvedRows: number[][] = [];
      let nonEmptyCellCount = 0;
      let clearCellCount = 0;
      let transformedCellCount = 0;
      for (const row of pattern) {
        const resolvedRow: number[] = [];
        for (const tile of row) {
          const gid = tileRefToGid(
            tile,
            orientation,
            bindings,
          );
          resolvedRow.push(gid);
          if (gid === 0) {
            clearCellCount += 1;
          } else {
            nonEmptyCellCount += 1;
            if (
              decodeGid(gid, orientation).transform
                .rawFlags !== 0
            ) {
              transformedCellCount += 1;
            }
          }
        }
        resolvedRows.push(resolvedRow);
      }

      let changedCellCount = 0;
      for (
        let rowIndex = 0;
        rowIndex < resolvedRows.length;
        rowIndex += 1
      ) {
        const row = resolvedRows[rowIndex] as number[];
        for (
          let columnIndex = 0;
          columnIndex < row.length;
          columnIndex += 1
        ) {
          const gid = row[columnIndex] as number;
          const x = operation.x + columnIndex;
          const y = operation.y + rowIndex;
          const currentGid = readLayerGid(layer, x, y);
          gidToTileRef(
            currentGid,
            orientation,
            bindings,
          );
          if (currentGid === gid) {
            continue;
          }
          writeLayerGid(layer, x, y, gid);
          changedCellCount += 1;
        }
      }
      if (changedCellCount > 0) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
      }
      cellWrites += patternCellCount;
      tileStamps.push({
        operationIndex,
        layerId: layer.id,
        region: {
          x: operation.x,
          y: operation.y,
          width,
          height,
        },
        cellCount: patternCellCount,
        nonEmptyCellCount,
        clearCellCount,
        transformedCellCount,
        changedCellCount,
        wouldChange: changedCellCount > 0,
      });
    } else if (operation.type === "replaceTiles") {
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      if (
        !Array.isArray(operation.mappings) ||
        operation.mappings.length === 0
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].mappings must not be empty.`,
        );
      }
      if (
        operation.mappings.length >
        MAX_REPLACE_TILE_MAPPINGS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A replaceTiles operation may contain at most ${MAX_REPLACE_TILE_MAPPINGS} mappings.`,
          { limit: MAX_REPLACE_TILE_MAPPINGS },
        );
      }
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
      );
      const region =
        operation.region === undefined
          ? {
              x: layer.x,
              y: layer.y,
              width: layer.width,
              height: layer.height,
            }
          : readReplaceTilesRegion(
              operation.region,
              operationIndex,
            );
      if (
        !Number.isSafeInteger(region.x + region.width) ||
        !Number.isSafeInteger(region.y + region.height)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].region endpoints must be safe integers.`,
        );
      }
      assertRegionInsideLayer(
        layer,
        region.x,
        region.y,
        region.width,
        region.height,
      );
      const scannedCellCount = region.width * region.height;
      if (
        !Number.isSafeInteger(scannedCellCount) ||
        tileOperationScans + scannedCellCount >
          MAX_TILE_OPERATION_SCANS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
          {
            limit: MAX_TILE_OPERATION_SCANS,
            actual:
              tileOperationScans +
              scannedCellCount,
          },
        );
      }
      tileOperationScans += scannedCellCount;

      const replacements = new Map<number, number>();
      const sourceMappingIndexes = new Map<number, number>();
      for (const [
        mappingIndex,
        mapping,
      ] of operation.mappings.entries()) {
        if (!isRecordValue(mapping) || mapping.from === null) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].mappings[${mappingIndex}].from must be a TileRef.`,
          );
        }
        const fromGid = tileRefToGid(
          mapping.from,
          orientation,
          bindings,
        );
        const toGid = tileRefToGid(
          mapping.to,
          orientation,
          bindings,
        );
        const duplicateIndex =
          sourceMappingIndexes.get(fromGid);
        if (duplicateIndex !== undefined) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].mappings contains duplicate canonical source tiles.`,
            {
              operationIndex,
              mappingIndex,
              duplicateMappingIndex: duplicateIndex,
              fromGid,
            },
          );
        }
        if (fromGid === toGid) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].mappings[${mappingIndex}] does not change the encoded tile value.`,
            { operationIndex, mappingIndex, gid: fromGid },
          );
        }
        sourceMappingIndexes.set(fromGid, mappingIndex);
        replacements.set(fromGid, toGid);
      }

      let replacedCellCount = 0;
      for (
        let y = region.y;
        y < region.y + region.height;
        y += 1
      ) {
        for (
          let x = region.x;
          x < region.x + region.width;
          x += 1
        ) {
          const currentGid = readLayerGid(layer, x, y);
          // Replacement interprets every scanned cell, so malformed or
          // unbound GIDs fail closed even when they are not a mapping source.
          gidToTileRef(currentGid, orientation, bindings);
          const replacement = replacements.get(currentGid);
          if (replacement === undefined) {
            continue;
          }
          if (
            cellWrites + replacedCellCount + 1 >
            MAX_CELL_WRITES
          ) {
            throw new TiledMcpError(
              "RESULT_LIMIT_EXCEEDED",
              `A change set may write at most ${MAX_CELL_WRITES} cells.`,
              { limit: MAX_CELL_WRITES },
            );
          }
          writeLayerGid(layer, x, y, replacement);
          replacedCellCount += 1;
        }
      }
      if (replacedCellCount > 0) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
      }
      cellWrites += replacedCellCount;
      tileReplacements.push({
        operationIndex,
        layerId: layer.id,
        region,
        scannedCellCount,
        replacedCellCount,
        mappingCount: operation.mappings.length,
      });
    } else if (operation.type === "updateLayer") {
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      const update = updateCommonLayer(
        map,
        operation.layerId,
        operation.patch,
        mapPath,
        `operations[${operationIndex}].patch`,
      );
      if (update.changedFields.length > 0) {
        affectedLayerIds.add(update.layer.id);
        updatedLayerIds.add(update.layer.id);
        for (const field of update.changedFields) {
          changedLayerMembers.add(
            `${update.layer.id}:${layerPatchJsonKey(field)}`,
          );
        }
      }
      layerUpdates.push({
        operationIndex,
        layerId: update.layer.id,
        layerType: update.layer.type,
        requestedFields: update.requestedFields,
        changedFields: update.changedFields,
        wouldChange: update.changedFields.length > 0,
        affectsDescendants:
          update.layer.type === "group" &&
          update.changedFields.some((field) =>
            GROUP_DESCENDANT_RENDER_FIELDS.has(field),
          ),
      });
    } else if (operation.type === "deleteLayer") {
      const deleted = deleteExistingLayer(
        map,
        operation,
        mapPath,
        `operations[${operationIndex}]`,
      );
      affectedLayerIds.add(deleted.layerId);
      deletedLayers.push({
        operationIndex,
        ...deleted,
      });
    } else if (operation.type === "moveLayer") {
      const moved = moveExistingLayer(
        map,
        operation,
        mapPath,
        `operations[${operationIndex}]`,
      );
      if (moved.wouldChange) {
        affectedLayerIds.add(moved.layerId);
      }
      movedLayers.push({
        operationIndex,
        ...moved,
      });
    } else if (operation.type === "duplicateLayer") {
      const duplicated = duplicateExistingLayer(
        map,
        operation,
        bindings,
        mapPath,
        `operations[${operationIndex}]`,
        options.sourceBytes,
      );
      affectedLayerIds.add(
        duplicated.createdRootLayerId,
      );
      cellWrites += duplicated.allocatedCellCount;
      objectMutations += duplicated.copiedObjectCount;
      duplicatedLayers.push({
        operationIndex,
        ...duplicated,
      });
    } else if (operation.type === "createObject") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["layerId", "object", "type"]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      const created = createBasicObject(
        map,
        operation.layerId,
        operation.object,
        mapPath,
        `operations[${operationIndex}].object`,
        getObjectIndex(),
      );
      textObjectPayloadBytes +=
        measureTextObjectPayloadBytes(
          operation.object as unknown as Readonly<
            Record<string, unknown>
          >,
        );
      assertTextObjectPayloadBudget(
        textObjectPayloadBytes,
      );
      if (
        operation.object.shape === "polygon" ||
        operation.object.shape === "polyline"
      ) {
        objectShapePoints += operation.object.points.length;
        assertObjectShapePointBudget(objectShapePoints);
      }
      affectedLayerIds.add(created.layer.id);
      affectedObjectLayerIds.add(created.layer.id);
      createdObjectIds.add(expectInteger(created.object.id, "created object id"));
      objectMutations += 1;
    } else if (operation.type === "updateObject") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["objectId", "patch", "type"]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.objectId,
        `operations[${operationIndex}].objectId`,
      );
      const updated = updateBasicObject(
        operation.objectId,
        operation.patch,
        mapPath,
        `operations[${operationIndex}].patch`,
        getObjectIndex(),
      );
      textObjectPayloadBytes +=
        measureTextObjectPayloadBytes(
          operation.patch as Readonly<
            Record<string, unknown>
          >,
        );
      assertTextObjectPayloadBudget(
        textObjectPayloadBytes,
      );
      if (
        Object.prototype.hasOwnProperty.call(
          operation.patch,
          "points",
        )
      ) {
        objectShapePoints += operation.patch.points?.length ?? 0;
        assertObjectShapePointBudget(objectShapePoints);
      }
      if (operation.patch.properties !== undefined) {
        objectPropertyPatchBytes +=
          measurePropertiesPatchBytes(
            operation.patch.properties,
          );
        assertObjectPropertyPatchBudget(
          objectPropertyPatchBytes,
        );
      }
      affectedLayerIds.add(updated.layer.id);
      affectedObjectLayerIds.add(updated.layer.id);
      updatedObjectIds.add(operation.objectId);
      objectMutations += 1;
    } else if (operation.type === "deleteObjects") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["objectIds", "type"]),
        `operations[${operationIndex}]`,
      );
      if (
        !Array.isArray(operation.objectIds) ||
        operation.objectIds.length === 0
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].objectIds must not be empty.`,
        );
      }
      if (operation.objectIds.length > MAX_OBJECT_MUTATIONS) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A deleteObjects operation may contain at most ${MAX_OBJECT_MUTATIONS} ids.`,
          { limit: MAX_OBJECT_MUTATIONS },
        );
      }
      const uniqueIds = new Set<number>();
      for (const [idIndex, objectId] of operation.objectIds.entries()) {
        assertPositiveInteger(
          objectId,
          `operations[${operationIndex}].objectIds[${idIndex}]`,
        );
        if (uniqueIds.has(objectId)) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].objectIds contains duplicate id ${objectId}.`,
          );
        }
        uniqueIds.add(objectId);
      }
      const deletedLocations = deleteBasicObjects(
        map,
        operation.objectIds,
        mapPath,
        getObjectIndex(),
      );
      for (const deleted of deletedLocations) {
        const objectId = expectInteger(deleted.object.id, "deleted object id");
        affectedLayerIds.add(deleted.layer.id);
        affectedObjectLayerIds.add(deleted.layer.id);
        deletedObjectIds.add(objectId);
        objectMutations += 1;
      }
    } else {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Unsupported edit operation type at index ${operationIndex}.`,
      );
    }
    if (cellWrites > MAX_CELL_WRITES) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A change set may write at most ${MAX_CELL_WRITES} cells.`,
        { limit: MAX_CELL_WRITES },
      );
    }
    if (objectMutations > MAX_OBJECT_MUTATIONS) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A change set may mutate at most ${MAX_OBJECT_MUTATIONS} objects.`,
        { limit: MAX_OBJECT_MUTATIONS },
      );
    }
  }

  const patchedSubtreeCount =
    affectedTileLayerIds.size +
    affectedObjectLayerIds.size +
    changedMapMembers.size +
    changedLayerMembers.size +
    (createdObjectIds.size > 0 ? 1 : 0) +
    (addedTilesets.length > 0 ? 1 : 0) +
    (removedTilesets.length > 0 ? 1 : 0) +
    (createdLayers.length > 0 ? 2 : 0) +
    duplicatedLayers.reduce(
      (count, duplicated) =>
        count +
        2 +
        (duplicated.copiedObjectCount > 0 ? 1 : 0),
      0,
    ) +
    (deletedLayers.length > 0 ? 1 : 0) +
    movedLayers.reduce(
      (count, move) =>
        count +
        (move.wouldChange
          ? move.sourceParentGroupId ===
            move.targetParentGroupId
            ? 1
            : 2
          : 0),
      0,
    ) +
    mapResizes.reduce((count, resize) => {
      const changedDimensionMembers =
        (resize.newWidth !== resize.oldWidth ? 1 : 0) +
        (resize.newHeight !== resize.oldHeight ? 1 : 0);
      const changedOffsetMembers =
        (resize.pixelOffsetX !== 0 ? 1 : 0) +
        (resize.pixelOffsetY !== 0 ? 1 : 0);
      return (
        count +
        changedDimensionMembers *
          (1 + resize.resizedTileLayerIds.length) +
        changedOffsetMembers *
          resize.shiftedImageLayerIds.length
      );
    }, 0);
  if (patchedSubtreeCount > MAX_PATCHED_SUBTREES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may rewrite at most ${MAX_PATCHED_SUBTREES} JSON subtrees.`,
      { limit: MAX_PATCHED_SUBTREES, actual: patchedSubtreeCount },
    );
  }

  return {
    operationCount: operations.length,
    cellWrites,
    affectedLayerIds: [...affectedLayerIds].sort((left, right) => left - right),
    affectedTileLayerIds: [...affectedTileLayerIds].sort(
      (left, right) => left - right,
    ),
    affectedObjectLayerIds: [...affectedObjectLayerIds].sort(
      (left, right) => left - right,
    ),
    createdObjectIds: [...createdObjectIds].sort((left, right) => left - right),
    updatedObjectIds: [...updatedObjectIds].sort((left, right) => left - right),
    deletedObjectIds: [...deletedObjectIds].sort((left, right) => left - right),
    ...(mapUpdates.length === 0
      ? {}
      : { mapUpdates }),
    ...(mapResizes.length === 0
      ? {}
      : { mapResizes }),
    ...(layerUpdates.length === 0
      ? {}
      : {
          updatedLayerIds: [...updatedLayerIds].sort(
            (left, right) => left - right,
          ),
          layerUpdates,
        }),
    ...(tileReplacements.length === 0
      ? {}
      : { tileReplacements }),
    ...(tileStamps.length === 0
      ? {}
      : { tileStamps }),
    ...(tileFloodFills.length === 0
      ? {}
      : { tileFloodFills }),
    ...(tileCopies.length === 0
      ? {}
      : { tileCopies }),
    ...(addedTilesets.length === 0 ? {} : { addedTilesets }),
    ...(removedTilesets.length === 0
      ? {}
      : { removedTilesets }),
    ...(createdLayers.length === 0 ? {} : { createdLayers }),
    ...(deletedLayers.length === 0 ? {} : { deletedLayers }),
    ...(movedLayers.length === 0 ? {} : { movedLayers }),
    ...(duplicatedLayers.length === 0
      ? {}
      : { duplicatedLayers }),
  };
}

interface ResizeTileLayerScanView {
  object: JsonObject;
  id: number;
  width: number;
  height: number;
  data: JsonValue[];
}

interface ResizeObjectLayerScanView {
  object: JsonObject;
  id: number;
  objects: JsonValue[];
}

interface ResizeImageLayerScanView {
  object: JsonObject;
  id: number;
}

interface ResizeLayerViews {
  tileLayers: ResizeTileLayerScanView[];
  objectLayers: ResizeObjectLayerScanView[];
  imageLayers: ResizeImageLayerScanView[];
  groupLayerCount: number;
  lockedLayerCount: number;
}

function readResizeMapInput(
  operation: Record<string, unknown>,
  operationContext: string,
): { width: number; height: number; offsetX: number; offsetY: number } {
  const { width, height } = operation;
  if (typeof width !== "number" || typeof height !== "number") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${operationContext} width and height must be numbers.`,
    );
  }
  assertPositiveIntegerAtMost(
    width,
    `${operationContext}.width`,
    MAX_RESIZE_MAP_DIMENSION,
  );
  assertPositiveIntegerAtMost(
    height,
    `${operationContext}.height`,
    MAX_RESIZE_MAP_DIMENSION,
  );
  const readOffset = (key: "offsetX" | "offsetY"): number => {
    const value = operation[key];
    if (value === undefined) {
      return 0;
    }
    if (typeof value !== "number") {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${operationContext}.${key} must be an integer.`,
      );
    }
    assertSafeInteger(value, `${operationContext}.${key}`);
    if (Math.abs(value) > MAX_RESIZE_OFFSET_MAGNITUDE) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${operationContext}.${key} magnitude must be at most ${MAX_RESIZE_OFFSET_MAGNITUDE}.`,
        {
          option: `${operationContext}.${key}`,
          limit: MAX_RESIZE_OFFSET_MAGNITUDE,
          actual: value,
        },
      );
    }
    return value;
  };
  return {
    width,
    height,
    offsetX: readOffset("offsetX"),
    offsetY: readOffset("offsetY"),
  };
}

function collectResizeLayerViews(
  map: JsonObject,
  oldWidth: number,
  oldHeight: number,
  mapPath: string,
  operationContext: string,
): ResizeLayerViews {
  const tileLayers: ResizeTileLayerScanView[] = [];
  const objectLayers: ResizeObjectLayerScanView[] = [];
  const imageLayers: ResizeImageLayerScanView[] = [];
  let groupLayerCount = 0;
  let lockedLayerCount = 0;
  const budget: LayerTraversalBudget = { count: 0 };
  const visit = (
    entries: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    assertLayerTraversalBudget(entries.length, depth, budget);
    for (const [index, value] of entries.entries()) {
      const layer = expectObject(value, `${context}[${index}]`);
      const layerType = expectString(
        layer.type,
        `${context}[${index}].type`,
      );
      const layerId = expectInteger(
        layer.id,
        `${context}[${index}].id`,
      );
      if (layer.locked === true) {
        lockedLayerCount += 1;
      }
      if (layerType === "tilelayer") {
        if ("chunks" in layer || typeof layer.data === "string") {
          throw new TiledMcpError(
            "UNSUPPORTED_TILE_ENCODING",
            "MVP editing supports only finite JSON tile layers with numeric data arrays.",
            { path: mapPath, layerId },
          );
        }
        const width = expectInteger(layer.width, `layer ${layerId}.width`);
        const height = expectInteger(layer.height, `layer ${layerId}.height`);
        assertPositiveInteger(width, `layer ${layerId}.width`);
        assertPositiveInteger(height, `layer ${layerId}.height`);
        const x = readOptionalInteger(layer.x, `layer ${layerId}.x`, 0);
        const y = readOptionalInteger(layer.y, `layer ${layerId}.y`, 0);
        if (
          x !== 0 ||
          y !== 0 ||
          width !== oldWidth ||
          height !== oldHeight
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_RESIZE_LAYER_BOUNDS",
            `${operationContext} cannot resize this map: tile layer ${layerId} bounds do not match the map bounds, and Tiled 1.12 leaves resize semantics for such layers undefined.`,
            {
              path: mapPath,
              layerId,
              layerBounds: { x, y, width, height },
              mapBounds: {
                x: 0,
                y: 0,
                width: oldWidth,
                height: oldHeight,
              },
            },
          );
        }
        const data = expectArray(layer.data, `layer ${layerId}.data`);
        if (data.length !== width * height) {
          throw new TiledMcpError(
            "INVALID_TILE_DATA",
            `Layer ${layerId} data length does not match width × height.`,
            { layerId, expected: width * height, actual: data.length },
          );
        }
        tileLayers.push({
          object: layer,
          id: layerId,
          width,
          height,
          data,
        });
      } else if (layerType === "objectgroup") {
        objectLayers.push({
          object: layer,
          id: layerId,
          objects: expectArray(
            layer.objects,
            `layer ${layerId}.objects`,
          ),
        });
      } else if (layerType === "imagelayer") {
        imageLayers.push({ object: layer, id: layerId });
      } else if (layerType === "group") {
        groupLayerCount += 1;
        visit(
          expectArray(layer.layers, `layer ${layerId}.layers`),
          `${context}[${index}].layers`,
          depth + 1,
        );
      } else {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}[${index}].type is not a supported Tiled layer type.`,
          { layerType },
        );
      }
    }
  };
  visit(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
    0,
  );
  return {
    tileLayers,
    objectLayers,
    imageLayers,
    groupLayerCount,
    lockedLayerCount,
  };
}

function performMapResize(
  map: JsonObject,
  orientation: "orthogonal",
  bindings: readonly TilesetBinding[],
  views: ResizeLayerViews,
  input: {
    operationContext: string;
    mapPath: string;
    oldWidth: number;
    oldHeight: number;
    newWidth: number;
    newHeight: number;
    offsetX: number;
    offsetY: number;
    pixelOffsetX: number;
    pixelOffsetY: number;
    tileWidth: number;
    tileHeight: number;
    objectMutationsUsed: number;
  },
): {
  wouldChange: boolean;
  mapDimensionsChanged: boolean;
  dataChangedTileLayerIds: number[];
  preservedNonEmptyCellCount: number;
  croppedNonEmptyCellCount: number;
  croppedCellSample: Array<{
    layerId: number;
    x: number;
    y: number;
    gid: number;
  }>;
  objectShiftedLayerIds: number[];
  movedObjectCount: number;
  objectsOutsideNewBounds: number;
  shiftedImageLayerIds: number[];
} {
  const {
    operationContext,
    mapPath,
    newWidth,
    newHeight,
    offsetX,
    offsetY,
    pixelOffsetX,
    pixelOffsetY,
  } = input;
  const newArea = newWidth * newHeight;
  const dataChangedTileLayerIds: number[] = [];
  const croppedCellSample: Array<{
    layerId: number;
    x: number;
    y: number;
    gid: number;
  }> = [];
  let preservedNonEmptyCellCount = 0;
  let croppedNonEmptyCellCount = 0;
  for (const layer of views.tileLayers) {
    const newData: number[] = new Array<number>(newArea).fill(0);
    for (let y = 0; y < layer.height; y += 1) {
      for (let x = 0; x < layer.width; x += 1) {
        const raw = layer.data[y * layer.width + x];
        if (
          typeof raw !== "number" ||
          !Number.isSafeInteger(raw)
        ) {
          throw new TiledMcpError(
            "INVALID_TILE_DATA",
            `Layer ${layer.id} has a non-integer GID.`,
            { layerId: layer.id, x, y },
          );
        }
        // Every scanned source cell resolves fail closed, so cropping can
        // never silently discard a malformed or unbound encoded GID.
        gidToTileRef(raw, orientation, bindings);
        const destX = x + offsetX;
        const destY = y + offsetY;
        if (
          destX >= 0 &&
          destX < newWidth &&
          destY >= 0 &&
          destY < newHeight
        ) {
          newData[destY * newWidth + destX] = raw;
          if (raw !== 0) {
            preservedNonEmptyCellCount += 1;
          }
        } else if (raw !== 0) {
          croppedNonEmptyCellCount += 1;
          if (
            croppedCellSample.length <
            MAX_RESIZE_CROPPED_CELL_SAMPLE
          ) {
            croppedCellSample.push({
              layerId: layer.id,
              x,
              y,
              gid: raw,
            });
          }
        }
      }
    }
    let changed =
      layer.width !== newWidth || layer.height !== newHeight;
    if (!changed) {
      for (let index = 0; index < newArea; index += 1) {
        if (newData[index] !== layer.data[index]) {
          changed = true;
          break;
        }
      }
    }
    layer.object.width = newWidth;
    layer.object.height = newHeight;
    layer.object.data = newData;
    if (changed) {
      dataChangedTileLayerIds.push(layer.id);
    }
  }

  const shifting = pixelOffsetX !== 0 || pixelOffsetY !== 0;
  const newPixelWidth = newWidth * input.tileWidth;
  const newPixelHeight = newHeight * input.tileHeight;
  const objectShiftedLayerIds: number[] = [];
  let movedObjectCount = 0;
  let objectsOutsideNewBounds = 0;
  let visitedObjects = 0;
  for (const layer of views.objectLayers) {
    let layerShifted = false;
    for (const [objectIndex, value] of layer.objects.entries()) {
      visitedObjects += 1;
      if (visitedObjects > MAX_OBJECT_COUNT) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A resizeMap operation may scan at most ${MAX_OBJECT_COUNT} objects.`,
          { limit: MAX_OBJECT_COUNT },
        );
      }
      const objectRecord = expectObject(
        value,
        `layer ${layer.id}.objects[${objectIndex}]`,
      );
      if (
        shifting &&
        Object.prototype.hasOwnProperty.call(
          objectRecord,
          "template",
        )
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_RESIZE_TEMPLATE",
          `${operationContext} cannot move template objects: template semantics are outside the supported editing profile.`,
          {
            path: mapPath,
            layerId: layer.id,
          },
        );
      }
      const x = objectRecord.x;
      const y = objectRecord.y;
      if (
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        typeof y !== "number" ||
        !Number.isFinite(y)
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `layer ${layer.id}.objects[${objectIndex}] must have finite numeric x and y coordinates.`,
          { path: mapPath, layerId: layer.id },
        );
      }
      let finalX = x;
      let finalY = y;
      if (shifting) {
        finalX = x + pixelOffsetX;
        finalY = y + pixelOffsetY;
        if (
          !Number.isFinite(finalX) ||
          Math.abs(finalX) > MAX_ABSOLUTE_OBJECT_NUMBER ||
          !Number.isFinite(finalY) ||
          Math.abs(finalY) > MAX_ABSOLUTE_OBJECT_NUMBER
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${operationContext} would move object coordinates beyond ±${MAX_ABSOLUTE_OBJECT_NUMBER} map pixels.`,
            {
              limit: MAX_ABSOLUTE_OBJECT_NUMBER,
              layerId: layer.id,
            },
          );
        }
        objectRecord.x = finalX;
        objectRecord.y = finalY;
        movedObjectCount += 1;
        if (
          input.objectMutationsUsed + movedObjectCount >
          MAX_OBJECT_MUTATIONS
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may mutate at most ${MAX_OBJECT_MUTATIONS} objects.`,
            { limit: MAX_OBJECT_MUTATIONS },
          );
        }
        layerShifted = true;
      }
      if (
        finalX < 0 ||
        finalX > newPixelWidth ||
        finalY < 0 ||
        finalY > newPixelHeight
      ) {
        objectsOutsideNewBounds += 1;
      }
    }
    if (layerShifted) {
      objectShiftedLayerIds.push(layer.id);
    }
  }

  const shiftedImageLayerIds: number[] = [];
  if (shifting) {
    for (const layer of views.imageLayers) {
      const applyOffsetShift = (
        key: "offsetx" | "offsety",
        delta: number,
      ): void => {
        if (delta === 0) {
          return;
        }
        const current = layer.object[key];
        if (
          current !== undefined &&
          (typeof current !== "number" ||
            !Number.isFinite(current))
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            `layer ${layer.id}.${key} must be a finite number.`,
            { path: mapPath, layerId: layer.id },
          );
        }
        const base = typeof current === "number" ? current : 0;
        const next = base + delta;
        if (
          !Number.isFinite(next) ||
          Math.abs(next) > MAX_ABSOLUTE_OBJECT_NUMBER
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${operationContext} would move image layer ${layer.id} offsets beyond ±${MAX_ABSOLUTE_OBJECT_NUMBER} map pixels.`,
            {
              limit: MAX_ABSOLUTE_OBJECT_NUMBER,
              layerId: layer.id,
            },
          );
        }
        layer.object[key] = next;
      };
      applyOffsetShift("offsetx", pixelOffsetX);
      applyOffsetShift("offsety", pixelOffsetY);
      shiftedImageLayerIds.push(layer.id);
    }
  }

  const mapDimensionsChanged =
    newWidth !== input.oldWidth || newHeight !== input.oldHeight;
  if (mapDimensionsChanged) {
    map.width = newWidth;
    map.height = newHeight;
  }
  return {
    wouldChange:
      mapDimensionsChanged ||
      dataChangedTileLayerIds.length > 0 ||
      movedObjectCount > 0 ||
      shiftedImageLayerIds.length > 0,
    mapDimensionsChanged,
    dataChangedTileLayerIds,
    preservedNonEmptyCellCount,
    croppedNonEmptyCellCount,
    croppedCellSample,
    objectShiftedLayerIds,
    movedObjectCount,
    objectsOutsideNewBounds,
    shiftedImageLayerIds,
  };
}

function resolveAddTilesetToMapOperation(
  context: EditableContext,
  prospective: ProspectiveTilesetBinding,
): ResolvedAddTilesetToMapOperation {
  const entries = expectArray(
    context.loaded.document.tilesets,
    `${context.loaded.path}.tilesets`,
  );
  if (entries.length >= MAX_TILESET_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A map may reference at most ${MAX_TILESET_COUNT} tilesets in the MVP.`,
      {
        path: context.loaded.path,
        limit: MAX_TILESET_COUNT,
        actual: entries.length,
      },
    );
  }
  assertSerializedTilesetOrder(entries, context.loaded.path);

  const duplicate = context.bindings.find(
    (binding) =>
      binding.path === prospective.path ||
      binding.assetId === prospective.assetId,
  );
  if (duplicate !== undefined) {
    if (duplicate.path === prospective.path) {
      throw new TiledMcpError(
        "TILESET_ALREADY_REFERENCED",
        `${context.loaded.path} already references ${prospective.path}.`,
        {
          mapPath: context.loaded.path,
          tilesetPath: prospective.path,
          assetId: prospective.assetId,
          firstGid: duplicate.firstGid,
        },
      );
    }
    throw new TiledMcpError(
      "ASSET_ID_COLLISION",
      "Two distinct external tileset paths resolved to the same opaque asset id.",
      {
        assetId: prospective.assetId,
        existingPath: duplicate.path,
        prospectivePath: prospective.path,
      },
    );
  }

  assertCurrentMapGidsResolve(
    expectArray(context.loaded.document.layers, `${context.loaded.path}.layers`),
    context.bindings,
    context.loaded.path,
  );

  let firstGid = 1;
  for (const binding of context.bindings) {
    const afterRange = binding.firstGid + binding.gidSpan;
    if (!Number.isSafeInteger(afterRange)) {
      throw new TiledMcpError(
        "GID_RANGE_EXHAUSTED",
        "An existing tileset GID range exceeds safe integer bounds.",
        {
          path: context.loaded.path,
          assetId: binding.assetId,
          firstGid: binding.firstGid,
          tileCount: binding.tileCount,
          gidSpan: binding.gidSpan,
        },
      );
    }
    firstGid = Math.max(firstGid, afterRange);
  }
  const lastGid = firstGid + prospective.gidSpan - 1;
  if (
    !Number.isSafeInteger(firstGid) ||
    !Number.isSafeInteger(lastGid) ||
    firstGid <= 0 ||
    lastGid > 0x0fffffff
  ) {
    throw new TiledMcpError(
      "GID_RANGE_EXHAUSTED",
      "The prospective tileset does not fit in Tiled's 28-bit base GID range.",
      {
        path: context.loaded.path,
        tilesetPath: prospective.path,
        firstGid,
        tileCount: prospective.tileCount,
        gidSpan: prospective.gidSpan,
        maximumBaseGid: 0x0fffffff,
      },
    );
  }

  const source = posix.relative(
    posix.dirname(context.loaded.path),
    prospective.path,
  );
  if (
    source.length === 0 ||
    source.includes("\\") ||
    posix.isAbsolute(source) ||
    posix.normalize(source) !== source
  ) {
    throw new TiledMcpError(
      "INVALID_PROJECT_PATH",
      "The prospective tileset could not be represented by a canonical map-relative POSIX source.",
      {
        mapPath: context.loaded.path,
        tilesetPath: prospective.path,
        source,
      },
    );
  }
  return {
    type: "addTilesetToMap",
    tilesetPath: prospective.path,
    source,
    assetId: prospective.assetId,
    tilesetRevision: prospective.revision,
    tileCount: prospective.tileCount,
    gidSpan: prospective.gidSpan,
    firstGid,
  };
}

function removeUnusedTilesetReference(
  map: JsonObject,
  bindings: readonly TilesetBinding[],
  tilesetAssetId: string,
  mapPath: string,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["removedTilesets"]
  >[number],
  "operationIndex"
> {
  const binding = bindings.find(
    (candidate) =>
      candidate.assetId === tilesetAssetId,
  );
  if (binding === undefined) {
    throw new TiledMcpError(
      "TILESET_NOT_FOUND",
      `The requested tileset asset is not referenced by ${mapPath}.`,
      { mapPath, tilesetAssetId },
    );
  }

  const entries = expectArray(
    map.tilesets,
    `${mapPath}.tilesets`,
  );
  const index = entries.findIndex((value, entryIndex) => {
    const entry = expectObject(
      value,
      `${mapPath}.tilesets[${entryIndex}]`,
    );
    return (
      expectInteger(
        entry.firstgid,
        `${mapPath}.tilesets[${entryIndex}].firstgid`,
      ) === binding.firstGid
    );
  });
  if (index < 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `The serialized tileset entry for ${tilesetAssetId} is missing.`,
      {
        path: mapPath,
        tilesetAssetId,
        firstGid: binding.firstGid,
      },
    );
  }
  const entry = expectObject(
    entries[index],
    `${mapPath}.tilesets[${index}]`,
  );
  const source = expectString(
    entry.source,
    `${mapPath}.tilesets[${index}].source`,
  );
  const usage = inspectTilesetUsage(
    map,
    bindings,
    tilesetAssetId,
    mapPath,
  );

  entries.splice(index, 1);
  map.tilesets = entries;
  return {
    assetId: binding.assetId,
    tilesetPath: binding.path,
    source,
    tilesetRevision: binding.revision,
    name: binding.name,
    nameTruncated: binding.nameTruncated,
    index,
    tileCount: binding.tileCount,
    gidSpan: binding.gidSpan,
    firstGid: binding.firstGid,
    lastGid:
      binding.firstGid + binding.gidSpan - 1,
    scannedCellCount: usage.scannedCellCount,
    scannedObjectCount: usage.scannedObjectCount,
  };
}

function inspectTilesetUsage(
  map: JsonObject,
  bindings: readonly TilesetBinding[],
  tilesetAssetId: string,
  mapPath: string,
): TilesetUsageInspection {
  const result: TilesetUsageInspection = {
    scannedCellCount: 0,
    scannedObjectCount: 0,
  };
  const targetBinding = bindings.find(
    (binding) =>
      binding.assetId === tilesetAssetId,
  );
  if (targetBinding === undefined) {
    throw new TiledMcpError(
      "TILESET_NOT_FOUND",
      `The requested tileset asset is not referenced by ${mapPath}.`,
      { mapPath, tilesetAssetId },
    );
  }
  const traversalBudget: LayerTraversalBudget = {
    count: 0,
  };

  const record = (
    gid: JsonValue | undefined,
    reference: TilesetUsageReference,
    context: string,
  ): void => {
    if (
      typeof gid !== "number" ||
      !Number.isSafeInteger(gid) ||
      gid < 0 ||
      gid > 0xffffffff
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `${context} must be an unsigned 32-bit GID.`,
        { context },
      );
    }
    const tile = gidToTileRef(
      gid,
      "orthogonal",
      bindings,
    );
    if (
      tile?.tileset.assetId !==
      tilesetAssetId
    ) {
      return;
    }
    throw new TiledMcpError(
      "TILESET_IN_USE",
      `Tileset ${tilesetAssetId} is still referenced by a ${reference.kind === "cell" ? "tile cell" : "tile object"}. Clear or replace every matching reference before removing the binding.`,
      {
        path: mapPath,
        tilesetAssetId,
        tilesetPath: targetBinding.path,
        firstGid: targetBinding.firstGid,
        lastGid:
          targetBinding.firstGid +
          targetBinding.gidSpan -
          1,
        cellReferenceCount:
          reference.kind === "cell" ? 1 : 0,
        objectReferenceCount:
          reference.kind === "object" ? 1 : 0,
        referenceCount: 1,
        referenceCountIsLowerBound: true,
        referenceSample: [reference],
        reference,
        scanStoppedAtFirstReference: true,
        scannedCellCount:
          result.scannedCellCount,
        scannedObjectCount:
          result.scannedObjectCount,
      },
    );
  };

  const visitLayers = (
    layers: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    assertLayerTraversalBudget(
      layers.length,
      depth,
      traversalBudget,
    );
    for (const [layerIndex, layerValue] of layers.entries()) {
      const layerContext = `${context}[${layerIndex}]`;
      const layer = expectObject(
        layerValue,
        layerContext,
      );
      const layerId = expectInteger(
        layer.id,
        `${layerContext}.id`,
      );
      const layerType = expectString(
        layer.type,
        `${layerContext}.type`,
      );
      if (layerType === "group") {
        visitLayers(
          expectArray(
            layer.layers,
            `${layerContext}.layers`,
          ),
          `${layerContext}.layers`,
          depth + 1,
        );
        continue;
      }
      if (layerType === "imagelayer") {
        continue;
      }
      if (layerType === "objectgroup") {
        const objects = expectArray(
          layer.objects,
          `${layerContext}.objects`,
        );
        for (
          const [objectIndex, objectValue]
          of objects.entries()
        ) {
          consumeRemoveTilesetScanBudget(
            0,
            1,
            result,
            mapPath,
          );
          const objectContext =
            `${layerContext}.objects[${objectIndex}]`;
          const object = expectObject(
            objectValue,
            objectContext,
          );
          const objectId = expectInteger(
            object.id,
            `${objectContext}.id`,
          );
          if (
            Object.prototype.hasOwnProperty.call(
              object,
              "template",
            )
          ) {
            throw new TiledMcpError(
              "UNSUPPORTED_TILESET_REMOVAL_TEMPLATE",
              `Object ${objectId} uses a template whose hidden tile reference cannot be revision-pinned for tileset removal. Instantiate or remove the template object first, or keep the tileset binding.`,
              {
                path: mapPath,
                layerId,
                objectId,
              },
            );
          }
          if (object.gid === undefined) {
            continue;
          }
          record(
            object.gid,
            {
              kind: "object",
              layerId,
              objectId,
            },
            `${objectContext}.gid`,
          );
        }
        continue;
      }
      if (layerType !== "tilelayer") {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${layerContext}.type is not a supported Tiled layer type.`,
          { path: mapPath, layerId, layerType },
        );
      }
      const width = expectInteger(
        layer.width,
        `${layerContext}.width`,
      );
      const height = expectInteger(
        layer.height,
        `${layerContext}.height`,
      );
      assertPositiveInteger(
        width,
        `${layerContext}.width`,
      );
      assertPositiveInteger(
        height,
        `${layerContext}.height`,
      );
      const cellCount = width * height;
      // The removal scan only reads cells; encoded layers decode without
      // touching their stored bytes.
      const data = resolveTileLayerCells(
        layer,
        layerId,
        mapPath,
        cellCount,
        "read",
        "Removing a tileset reference supports only finite JSON tile layers with numeric data arrays.",
      );
      if (
        !Number.isSafeInteger(cellCount) ||
        data.length !== cellCount
      ) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} data length does not match width × height.`,
          {
            layerId,
            expected: cellCount,
            actual: data.length,
          },
        );
      }
      const layerX = readOptionalInteger(
        layer.x,
        `${layerContext}.x`,
        0,
      );
      const layerY = readOptionalInteger(
        layer.y,
        `${layerContext}.y`,
        0,
      );
      for (const [gidIndex, gid] of data.entries()) {
        consumeRemoveTilesetScanBudget(
          1,
          0,
          result,
          mapPath,
        );
        record(
          gid,
          {
            kind: "cell",
            layerId,
            x: layerX + (gidIndex % width),
            y:
              layerY +
              Math.floor(gidIndex / width),
          },
          `${layerContext}.data[${gidIndex}]`,
        );
      }
    }
  };

  visitLayers(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
    0,
  );
  return result;
}

function consumeRemoveTilesetScanBudget(
  cellCount: number,
  objectCount: number,
  usage: TilesetUsageInspection,
  mapPath: string,
): void {
  const nextCount = cellCount + objectCount;
  const scanned =
    usage.scannedCellCount +
    usage.scannedObjectCount;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount < 0 ||
    !Number.isSafeInteger(objectCount) ||
    objectCount < 0 ||
    !Number.isSafeInteger(nextCount) ||
    scanned + nextCount >
      MAX_REMOVE_TILESET_GID_SCANS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Removing a tileset may scan at most ${MAX_REMOVE_TILESET_GID_SCANS} existing tile cells and objects.`,
      {
        path: mapPath,
        limit: MAX_REMOVE_TILESET_GID_SCANS,
        scanned,
        nextCount,
      },
    );
  }
  usage.scannedCellCount += cellCount;
  usage.scannedObjectCount += objectCount;
}

function resolveCreateLayerOperation(
  context: EditableContext,
  input: Pick<
    PlanCreateLayerInput,
    "layerType" | "name" | "parentGroupId" | "index" | "imagePath"
  >,
  prospectiveImage?: ProspectiveImageBinding,
): ResolvedCreateLayerOperation {
  if (
    input.layerType !== "tilelayer" &&
    input.layerType !== "objectgroup" &&
    input.layerType !== "imagelayer" &&
    input.layerType !== "group"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "layerType must be tilelayer, objectgroup, imagelayer or group.",
    );
  }
  assertBoundedString(input.name, "name");
  if (input.name.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "name must not be empty.",
    );
  }
  if (input.parentGroupId !== undefined) {
    assertPositiveInteger(input.parentGroupId, "parentGroupId");
  }
  if (
    input.index !== undefined &&
    (!Number.isSafeInteger(input.index) || input.index < 0)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "index must be a non-negative safe integer.",
    );
  }

  const map = context.loaded.document;
  const rootLayers = expectArray(
    map.layers,
    `${context.loaded.path}.layers`,
  );
  const inventory = inspectLayerTree(rootLayers, context.loaded.path);
  if (inventory.count >= MAX_LAYER_COUNT) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `A map may contain at most ${MAX_LAYER_COUNT} layers.`,
      {
        path: context.loaded.path,
        limit: MAX_LAYER_COUNT,
        actual: inventory.count,
      },
    );
  }

  const nextLayerId = expectInteger(
    map.nextlayerid,
    `${context.loaded.path}.nextlayerid`,
  );
  if (
    nextLayerId <= 0 ||
    nextLayerId <= inventory.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_LAYER_ID_INVALID",
      `${context.loaded.path}.nextlayerid must be greater than every existing layer id.`,
      {
        path: context.loaded.path,
        nextLayerId,
        maximumExistingId: inventory.maximumId,
      },
    );
  }
  if (nextLayerId >= MAX_TILED_SIGNED_ID) {
    throw new TiledMcpError(
      "LAYER_ID_EXHAUSTED",
      `${context.loaded.path}.nextlayerid cannot be incremented within Tiled's signed 32-bit id space.`,
      {
        path: context.loaded.path,
        nextLayerId,
        maximumAllocatableLayerId: MAX_TILED_SIGNED_ID - 1,
      },
    );
  }

  const placement = layerContainerForParent(
    map,
    input.parentGroupId,
    context.loaded.path,
  );
  if (placement.childDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `Creating this layer would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: context.loaded.path,
        parentGroupId: input.parentGroupId ?? null,
        childDepth: placement.childDepth,
        limit: MAX_LAYER_DEPTH,
      },
    );
  }
  const index = input.index ?? placement.layers.length;
  if (index < 0 || index > placement.layers.length) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      `index must be between 0 and ${placement.layers.length} for the selected layer container.`,
      {
        path: context.loaded.path,
        parentGroupId: input.parentGroupId ?? null,
        index,
        minimum: 0,
        maximum: placement.layers.length,
      },
    );
  }

  let allocatedCellCount = 0;
  if (input.layerType === "tilelayer") {
    const cellCount = context.width * context.height;
    if (
      !Number.isSafeInteger(cellCount) ||
      cellCount > MAX_CREATE_TILE_LAYER_CELLS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A new tile layer may allocate at most ${MAX_CREATE_TILE_LAYER_CELLS} cells.`,
        {
          path: context.loaded.path,
          width: context.width,
          height: context.height,
          actual: Number.isSafeInteger(cellCount) ? cellCount : null,
          limit: MAX_CREATE_TILE_LAYER_CELLS,
        },
      );
    }
    allocatedCellCount = cellCount;
  }

  if (
    (input.layerType === "imagelayer") !==
    (prospectiveImage !== undefined)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      input.layerType === "imagelayer"
        ? "An image layer requires a validated imagePath."
        : "Only an image layer may carry an image dependency.",
    );
  }
  if (
    prospectiveImage !== undefined &&
    input.imagePath !== prospectiveImage.path
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "The validated image path does not match imagePath.",
      {
        imagePath: input.imagePath,
        validatedPath: prospectiveImage.path,
      },
    );
  }

  return {
    type: "createLayer",
    layerType: input.layerType,
    layerId: nextLayerId,
    name: input.name,
    parentGroupId: input.parentGroupId ?? null,
    index,
    allocatedCellCount,
    ...(prospectiveImage === undefined
      ? {}
      : {
          image: {
            assetId: prospectiveImage.assetId,
            path: prospectiveImage.path,
            source: relativeProjectReference(
              context.loaded.path,
              prospectiveImage.path,
              "image",
            ),
            revision: prospectiveImage.revision,
            width: prospectiveImage.width,
            height: prospectiveImage.height,
          },
        }),
  };
}

function inspectLayerTree(
  layers: JsonValue[],
  mapPath: string,
): { count: number; maximumId: number } {
  let count = 0;
  let maximumId = 0;
  const seen = new Set<number>();
  const visit = (
    entries: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    if (
      depth > MAX_LAYER_DEPTH ||
      count + entries.length > MAX_LAYER_COUNT
    ) {
      throw new TiledMcpError(
        "LAYER_LIMIT_EXCEEDED",
        `Layer tree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
        { path: mapPath },
      );
    }
    count += entries.length;
    for (const [index, value] of entries.entries()) {
      const layer = expectObject(value, `${context}[${index}]`);
      const id = expectInteger(layer.id, `${context}[${index}].id`);
      if (id <= 0 || seen.has(id)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          id <= 0
            ? `${mapPath} contains a non-positive layer id.`
            : `${mapPath} contains duplicate layer id ${id}.`,
          { path: mapPath, layerId: id },
        );
      }
      seen.add(id);
      maximumId = Math.max(maximumId, id);
      if (layer.type === "group") {
        visit(
          expectArray(layer.layers, `${context}[${index}].layers`),
          `${context}[${index}].layers`,
          depth + 1,
        );
      }
    }
  };
  visit(layers, `${mapPath}.layers`, 0);
  return { count, maximumId };
}

function layerContainerForParent(
  map: JsonObject,
  parentGroupId: number | null | undefined,
  mapPath: string,
): {
  layers: JsonValue[];
  path: JsonSourcePath;
  childDepth: number;
  parentLocked: boolean;
  effectiveParentLocked: boolean;
} {
  const rootLayers = expectArray(map.layers, `${mapPath}.layers`);
  if (parentGroupId === undefined || parentGroupId === null) {
    return {
      layers: rootLayers,
      path: ["layers"],
      childDepth: 0,
      parentLocked: false,
      effectiveParentLocked: false,
    };
  }
  const located = findLayerRecursive(
    rootLayers,
    parentGroupId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (located === undefined) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Parent layer ${parentGroupId} does not exist.`,
      {
        path: mapPath,
        layerId: parentGroupId,
        role: "parent",
      },
    );
  }
  if (located.object.type !== "group") {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Parent layer ${parentGroupId} is not a group layer.`,
      {
        path: mapPath,
        layerId: parentGroupId,
        role: "parent",
      },
    );
  }
  const numericSegments = located.path.filter(
    (segment): segment is number => typeof segment === "number",
  ).length;
  return {
    layers: expectArray(
      located.object.layers,
      `group layer ${parentGroupId}.layers`,
    ),
    path: [...located.path, "layers"],
    childDepth: numericSegments,
    parentLocked: located.object.locked === true,
    effectiveParentLocked:
      isLayerPathEffectivelyLocked(map, located.path),
  };
}

function isLayerPathEffectivelyLocked(
  map: JsonObject,
  path: JsonSourcePath,
): boolean {
  let current: JsonValue = map;
  for (const segment of path) {
    if (typeof segment === "number") {
      const array = expectArray(
        current,
        "layer path array",
      );
      current = array[segment] as JsonValue;
    } else {
      const object = expectObject(
        current,
        "layer path object",
      );
      current = object[segment] as JsonValue;
    }
    if (
      isJsonObject(current) &&
      current.locked === true
    ) {
      return true;
    }
  }
  return false;
}

function relativeProjectReference(
  fromPath: string,
  targetPath: string,
  kind: string,
): string {
  const source = posix.relative(posix.dirname(fromPath), targetPath);
  if (
    source.length === 0 ||
    source.includes("\\") ||
    posix.isAbsolute(source) ||
    posix.normalize(source) !== source
  ) {
    throw new TiledMcpError(
      "INVALID_PROJECT_PATH",
      `The prospective ${kind} could not be represented by a canonical map-relative POSIX source.`,
      { fromPath, targetPath, source },
    );
  }
  return source;
}

/**
 * Tiled allocates the next map-level firstgid from Tileset::nextTileId(), not
 * from the serialized tilecount. For an atlas this is normally tilecount, but
 * an explicit high tile definition also raises nextTileId and reserves the
 * intervening local-ID gap. Preserve that high-water mark even though the M1
 * TileRef profile only exposes the contiguous atlas cells.
 */
function tilesetGidSpan(
  document: JsonObject,
  path: string,
  tileCount: number,
): number {
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path}.tilecount must be a positive safe integer.`,
      { path, tileCount },
    );
  }
  let gidSpan = tileCount;
  if (document.nexttileid !== undefined) {
    const nextTileId = expectInteger(
      document.nexttileid,
      `${path}.nexttileid`,
    );
    if (nextTileId <= 0 || nextTileId > 0x0fffffff) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.nexttileid is outside the supported base-GID space.`,
        { path, nextTileId, maximumNextTileId: 0x0fffffff },
      );
    }
    gidSpan = Math.max(gidSpan, nextTileId);
  }
  const tileValues =
    document.tiles === undefined
      ? []
      : expectArray(document.tiles, `${path}.tiles`);
  if (tileValues.length > MAX_TILESET_METADATA_ENTRIES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} has more than ${MAX_TILESET_METADATA_ENTRIES} tile metadata entries.`,
      {
        path,
        actual: tileValues.length,
        limit: MAX_TILESET_METADATA_ENTRIES,
      },
    );
  }

  for (const [index, value] of tileValues.entries()) {
    const tile = expectObject(value, `${path}.tiles[${index}]`);
    const localId = expectInteger(
      tile.id,
      `${path}.tiles[${index}].id`,
    );
    if (localId < 0 || localId >= 0x0fffffff) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.tiles[${index}].id is outside the supported base-GID space.`,
        { path, index, localId, maximumLocalId: 0x0ffffffe },
      );
    }
    gidSpan = Math.max(gidSpan, localId + 1);
  }
  return gidSpan;
}

function assertSerializedTilesetOrder(
  entries: readonly JsonValue[],
  mapPath: string,
): void {
  let previousFirstGid = 0;
  for (const [index, value] of entries.entries()) {
    const entry = expectObject(value, `${mapPath}.tilesets[${index}]`);
    const firstGid = expectInteger(
      entry.firstgid,
      `${mapPath}.tilesets[${index}].firstgid`,
    );
    if (firstGid <= previousFirstGid) {
      throw new TiledMcpError(
        "UNSORTED_TILESET_REFERENCES",
        "Adding a tileset requires existing map references to be stored in strictly increasing firstgid order.",
        {
          path: mapPath,
          index,
          previousFirstGid,
          firstGid,
        },
      );
    }
    previousFirstGid = firstGid;
  }
}

function assertCurrentMapGidsResolve(
  layers: readonly JsonValue[],
  bindings: readonly TilesetBinding[],
  mapPath: string,
  depth = 0,
  budget: { scanned: number } = { scanned: 0 },
): void {
  if (depth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Layer tree exceeds depth ${MAX_LAYER_DEPTH}.`,
      { path: mapPath, maxDepth: MAX_LAYER_DEPTH },
    );
  }
  for (const [layerIndex, layerValue] of layers.entries()) {
    const layer = expectObject(
      layerValue,
      `${mapPath}.layers[${layerIndex}]`,
    );
    const type = expectString(
      layer.type,
      `${mapPath}.layers[${layerIndex}].type`,
    );
    if (type === "group") {
      assertCurrentMapGidsResolve(
        expectArray(
          layer.layers,
          `${mapPath}.layers[${layerIndex}].layers`,
        ),
        bindings,
        mapPath,
        depth + 1,
        budget,
      );
      continue;
    }
    if (type === "tilelayer") {
      const data = expectArray(
        layer.data,
        `${mapPath}.layers[${layerIndex}].data`,
      );
      consumeGidScanBudget(data.length, budget, mapPath);
      for (const [gidIndex, gid] of data.entries()) {
        assertResolvableGid(
          gid,
          bindings,
          `${mapPath}.layers[${layerIndex}].data[${gidIndex}]`,
        );
      }
      continue;
    }
    if (type !== "objectgroup") {
      continue;
    }
    const objects = expectArray(
      layer.objects,
      `${mapPath}.layers[${layerIndex}].objects`,
    );
    consumeGidScanBudget(objects.length, budget, mapPath);
    for (const [objectIndex, objectValue] of objects.entries()) {
      const object = expectObject(
        objectValue,
        `${mapPath}.layers[${layerIndex}].objects[${objectIndex}]`,
      );
      if (object.gid !== undefined) {
        assertResolvableGid(
          object.gid,
          bindings,
          `${mapPath}.layers[${layerIndex}].objects[${objectIndex}].gid`,
        );
      }
    }
  }
}

function consumeGidScanBudget(
  count: number,
  budget: { scanned: number },
  mapPath: string,
): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    budget.scanned + count > MAX_ADD_TILESET_GID_SCANS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Adding a tileset may scan at most ${MAX_ADD_TILESET_GID_SCANS} existing tile cells and objects.`,
      {
        path: mapPath,
        limit: MAX_ADD_TILESET_GID_SCANS,
        scanned: budget.scanned,
        nextCount: count,
      },
    );
  }
  budget.scanned += count;
}

function assertResolvableGid(
  value: JsonValue | undefined,
  bindings: readonly TilesetBinding[],
  context: string,
): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `${context} must be an unsigned 32-bit GID.`,
      { context },
    );
  }
  if (value !== 0) {
    gidToTileRef(value, "orthogonal", bindings);
  }
}

function assertResolvedAddTilesetOperation(
  operation: ResolvedAddTilesetToMapOperation,
): void {
  const expectedKeys = [
    "assetId",
    "firstGid",
    "gidSpan",
    "source",
    "tileCount",
    "tilesetPath",
    "tilesetRevision",
    "type",
  ];
  const actualKeys = Object.keys(operation).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved add-tileset operation has unexpected fields.",
    );
  }
  if (
    operation.type !== "addTilesetToMap" ||
    typeof operation.tilesetPath !== "string" ||
    posix.extname(operation.tilesetPath).toLowerCase() !== ".tsj" ||
    typeof operation.source !== "string" ||
    operation.source.length === 0 ||
    operation.source.includes("\\") ||
    posix.isAbsolute(operation.source) ||
    posix.normalize(operation.source) !== operation.source ||
    typeof operation.assetId !== "string" ||
    !/^asset_[0-9a-f]{24}$/u.test(operation.assetId) ||
    typeof operation.tilesetRevision !== "string" ||
    !REVISION_PATTERN.test(operation.tilesetRevision) ||
    !Number.isSafeInteger(operation.tileCount) ||
    operation.tileCount <= 0 ||
    !Number.isSafeInteger(operation.gidSpan) ||
    operation.gidSpan < operation.tileCount ||
    !Number.isSafeInteger(operation.firstGid) ||
    operation.firstGid <= 0 ||
    operation.firstGid + operation.gidSpan - 1 > 0x0fffffff
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved add-tileset operation is malformed.",
    );
  }
}

function assertResolvedCreateLayerOperation(
  operation: ResolvedCreateLayerOperation,
): void {
  const expectedKeys = [
    "allocatedCellCount",
    "index",
    "layerId",
    "layerType",
    "name",
    "parentGroupId",
    "type",
    ...(operation.image === undefined ? [] : ["image"]),
  ].sort();
  const actualKeys = Object.keys(operation).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved create-layer operation has unexpected fields.",
    );
  }
  if (
    operation.type !== "createLayer" ||
    (operation.layerType !== "tilelayer" &&
      operation.layerType !== "objectgroup" &&
      operation.layerType !== "imagelayer" &&
      operation.layerType !== "group") ||
    !Number.isSafeInteger(operation.layerId) ||
    operation.layerId <= 0 ||
    operation.layerId >= MAX_TILED_SIGNED_ID ||
    typeof operation.name !== "string" ||
    operation.name.length === 0 ||
    operation.name.length > MAX_LAYER_NAME_LENGTH ||
    (operation.parentGroupId !== null &&
      (!Number.isSafeInteger(operation.parentGroupId) ||
        operation.parentGroupId <= 0)) ||
    !Number.isSafeInteger(operation.index) ||
    operation.index < 0 ||
    !Number.isSafeInteger(operation.allocatedCellCount) ||
    operation.allocatedCellCount < 0 ||
    operation.allocatedCellCount > MAX_CREATE_TILE_LAYER_CELLS ||
    (operation.layerType === "tilelayer"
      ? operation.allocatedCellCount <= 0
      : operation.allocatedCellCount !== 0)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved create-layer operation is malformed.",
    );
  }
  if (
    (operation.layerType === "imagelayer") !==
    (operation.image !== undefined)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "Only an image layer may carry one required image dependency.",
    );
  }
  if (operation.image === undefined) {
    return;
  }
  const imageKeys = Object.keys(operation.image).sort();
  const expectedImageKeys = [
    "assetId",
    "height",
    "path",
    "revision",
    "source",
    "width",
  ];
  if (
    imageKeys.length !== expectedImageKeys.length ||
    imageKeys.some((key, index) => key !== expectedImageKeys[index]) ||
    !/^asset_[0-9a-f]{24}$/u.test(operation.image.assetId) ||
    typeof operation.image.path !== "string" ||
    operation.image.path.length === 0 ||
    typeof operation.image.source !== "string" ||
    operation.image.source.length === 0 ||
    operation.image.source.includes("\\") ||
    posix.isAbsolute(operation.image.source) ||
    posix.normalize(operation.image.source) !== operation.image.source ||
    !REVISION_PATTERN.test(operation.image.revision) ||
    !Number.isSafeInteger(operation.image.width) ||
    operation.image.width <= 0 ||
    operation.image.width > MAX_TILESET_INPUT_EDGE ||
    !Number.isSafeInteger(operation.image.height) ||
    operation.image.height <= 0 ||
    operation.image.height > MAX_TILESET_INPUT_EDGE
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved image-layer dependency is malformed.",
    );
  }
}

function applyResolvedCreateLayer(
  map: JsonObject,
  operation: ResolvedCreateLayerOperation,
  mapPath: string,
): { allocatedCellCount: number } {
  const rootLayers = expectArray(map.layers, `${mapPath}.layers`);
  const inventory = inspectLayerTree(rootLayers, mapPath);
  if (inventory.count >= MAX_LAYER_COUNT) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `A map may contain at most ${MAX_LAYER_COUNT} layers.`,
      { path: mapPath, limit: MAX_LAYER_COUNT },
    );
  }
  const nextLayerId = expectInteger(
    map.nextlayerid,
    `${mapPath}.nextlayerid`,
  );
  if (
    nextLayerId !== operation.layerId ||
    nextLayerId <= inventory.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_LAYER_ID_INVALID",
      "The planned layer id no longer matches the map nextlayerid high-water mark.",
      {
        path: mapPath,
        plannedLayerId: operation.layerId,
        nextLayerId,
        maximumExistingId: inventory.maximumId,
      },
    );
  }
  if (nextLayerId >= MAX_TILED_SIGNED_ID) {
    throw new TiledMcpError(
      "LAYER_ID_EXHAUSTED",
      "The map has exhausted Tiled's signed 32-bit layer id space.",
      { path: mapPath, nextLayerId },
    );
  }

  const placement = layerContainerForParent(
    map,
    operation.parentGroupId,
    mapPath,
  );
  if (placement.childDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `Creating this layer would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: mapPath,
        childDepth: placement.childDepth,
        limit: MAX_LAYER_DEPTH,
      },
    );
  }
  if (operation.index > placement.layers.length) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      "The planned insertion index no longer exists in the target layer container.",
      {
        path: mapPath,
        parentGroupId: operation.parentGroupId,
        index: operation.index,
        maximum: placement.layers.length,
      },
    );
  }

  const common = {
    id: operation.layerId,
    name: operation.name,
    opacity: 1,
    type: operation.layerType,
    visible: true,
    x: 0,
    y: 0,
  } satisfies JsonObject;
  let layer: JsonObject;
  let allocatedCellCount = 0;
  if (operation.layerType === "tilelayer") {
    const width = expectInteger(map.width, `${mapPath}.width`);
    const height = expectInteger(map.height, `${mapPath}.height`);
    allocatedCellCount = width * height;
    if (
      width <= 0 ||
      height <= 0 ||
      !Number.isSafeInteger(allocatedCellCount) ||
      allocatedCellCount > MAX_CREATE_TILE_LAYER_CELLS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A new tile layer may allocate at most ${MAX_CREATE_TILE_LAYER_CELLS} cells.`,
        {
          path: mapPath,
          width,
          height,
          actual: Number.isSafeInteger(allocatedCellCount)
            ? allocatedCellCount
            : null,
          limit: MAX_CREATE_TILE_LAYER_CELLS,
        },
      );
    }
    layer = {
      data: Array.from({ length: allocatedCellCount }, () => 0),
      height,
      ...common,
      width,
    };
  } else if (operation.layerType === "objectgroup") {
    layer = {
      draworder: "topdown",
      ...common,
      objects: [],
    };
  } else if (operation.layerType === "group") {
    layer = {
      id: common.id,
      layers: [],
      name: common.name,
      opacity: common.opacity,
      type: common.type,
      visible: common.visible,
      x: common.x,
      y: common.y,
    };
  } else {
    const image = operation.image;
    if (image === undefined) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The image layer is missing its pinned image dependency.",
      );
    }
    layer = {
      id: common.id,
      image: image.source,
      imageheight: image.height,
      imagewidth: image.width,
      name: common.name,
      opacity: common.opacity,
      type: common.type,
      visible: common.visible,
      x: common.x,
      y: common.y,
    };
  }

  if (operation.allocatedCellCount !== allocatedCellCount) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The planned layer cell allocation does not match the current map dimensions.",
      {
        path: mapPath,
        planned: operation.allocatedCellCount,
        actual: allocatedCellCount,
      },
    );
  }
  placement.layers.splice(operation.index, 0, layer);
  map.nextlayerid = operation.layerId + 1;
  return { allocatedCellCount };
}

function tileRefToGid(
  tile: TileRef | null,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
): number {
  if (tile === null) {
    return 0;
  }
  if (!isRecordValue(tile)) {
    throw new TiledMcpError("INVALID_ARGUMENT", "tile must be a TileRef or null.");
  }
  const tileRecord =
    tile as unknown as Record<string, unknown>;
  assertExactObjectKeys(
    tileRecord,
    new Set([
      "localId",
      "tileset",
      ...(Object.prototype.hasOwnProperty.call(
        tileRecord,
        "transform",
      )
        ? ["transform"]
        : []),
    ]),
    "tile",
  );
  if (
    !isRecordValue(tile.tileset) ||
    tile.tileset.kind !== "external" ||
    typeof tile.tileset.assetId !== "string" ||
    tile.tileset.assetId.length === 0 ||
    tile.tileset.assetId.length > 128
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.tileset must identify an external tileset asset.",
    );
  }
  assertExactObjectKeys(
    tile.tileset as unknown as Record<string, unknown>,
    new Set(["assetId", "kind"]),
    "tile.tileset",
  );
  assertSafeInteger(tile.localId, "tile.localId");
  assertTileTransformInput(
    tileRecord.transform,
    orientation,
  );
  const binding = bindings.find((candidate) => candidate.assetId === tile.tileset.assetId);
  if (!binding) {
    throw new TiledMcpError(
      "TILESET_NOT_IN_MAP",
      `Tileset ${tile.tileset.assetId} is not referenced by this map.`,
      { tilesetAssetId: tile.tileset.assetId },
    );
  }
  if (tile.localId < 0 || tile.localId >= binding.tileCount) {
    throw new TiledMcpError(
      "TILE_ID_OUT_OF_RANGE",
      `Tile ${tile.localId} is outside tileset ${binding.name}.`,
      { tilesetAssetId: binding.assetId, localId: tile.localId, tileCount: binding.tileCount },
    );
  }
  return encodeGid(binding.firstGid + tile.localId, orientation, tile.transform);
}

function assertTileTransformInput(
  value: unknown,
  orientation: MapOrientation,
): void {
  if (value === undefined) {
    return;
  }
  if (!isRecordValue(value)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.transform must be an object when present.",
    );
  }
  const transform = value as Record<string, unknown>;
  const hexagonal = orientation === "hexagonal";
  const booleanFields = hexagonal
    ? ["flipH", "flipV", "rotate60", "rotate120"]
    : ["flipD", "flipH", "flipV"];
  const allowedFields = new Set([
    "kind",
    "rawFlags",
    ...booleanFields,
  ]);
  const unexpectedField = Object.keys(transform).find(
    (key) => !allowedFields.has(key),
  );
  if (unexpectedField !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `tile.transform contains unsupported field ${unexpectedField}.`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      transform,
      "kind",
    ) &&
    transform.kind !==
      (hexagonal ? "hexagonal" : "orthogonal")
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `tile.transform.kind must be ${hexagonal ? "hexagonal" : "orthogonal"}.`,
    );
  }
  for (const field of booleanFields) {
    if (
      Object.prototype.hasOwnProperty.call(
        transform,
        field,
      ) &&
      typeof transform[field] !== "boolean"
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `tile.transform.${field} must be a boolean.`,
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(
      transform,
      "rawFlags",
    ) &&
    (typeof transform.rawFlags !== "number" ||
      !Number.isSafeInteger(transform.rawFlags) ||
      transform.rawFlags < 0 ||
      transform.rawFlags > 0xffffffff)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.transform.rawFlags must be an unsigned 32-bit integer.",
    );
  }
}

/**
 * Validates an image-collection tileset's per-tile entries and returns the
 * sparse set of existing local ids. Every tile of a collection carries its
 * own image, so `tiles.length` must equal `tilecount`.
 */
function readCollectionTileIds(
  document: JsonObject,
  tilesetPath: string,
): Set<number> {
  const entries = expectArray(
    document.tiles,
    `${tilesetPath}.tiles`,
  );
  const localIds = new Set<number>();
  for (const [index, value] of entries.entries()) {
    const entry = expectObject(
      value,
      `${tilesetPath}.tiles[${index}]`,
    );
    const id = expectInteger(
      entry.id,
      `${tilesetPath}.tiles[${index}].id`,
    );
    if (id < 0 || localIds.has(id)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tiles[${index}].id must be a unique nonnegative integer.`,
        { path: tilesetPath, index, id },
      );
    }
    if (
      typeof entry.image !== "string" ||
      entry.image.length === 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tiles[${index}] must carry a per-tile image in an image-collection tileset.`,
        { path: tilesetPath, index, id },
      );
    }
    for (const field of [
      "imagewidth",
      "imageheight",
    ] as const) {
      const size = entry[field];
      if (
        size !== undefined &&
        (typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size <= 0)
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${tilesetPath}.tiles[${index}].${field} must be a positive integer.`,
          { path: tilesetPath, index, id },
        );
      }
    }
    localIds.add(id);
  }
  return localIds;
}

function gidToTileRef(
  gid: number,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
): TileRef | null {
  const decoded = decodeGid(gid, orientation);
  if (decoded.baseGid === 0) {
    return null;
  }
  let lower = 0;
  let upper = bindings.length - 1;
  let bindingIndex = -1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const candidate = bindings[middle];
    if (candidate !== undefined && candidate.firstGid <= decoded.baseGid) {
      bindingIndex = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  const binding =
    bindingIndex < 0 ? undefined : bindings[bindingIndex];
  if (!binding) {
    throw new TiledMcpError("GID_OUT_OF_RANGE", `GID ${decoded.baseGid} has no tileset.`);
  }
  const localId = decoded.baseGid - binding.firstGid;
  const insideRange =
    binding.localIds !== undefined
      ? binding.localIds.has(localId)
      : localId >= 0 &&
        localId < binding.tileCount;
  if (!insideRange) {
    throw new TiledMcpError(
      "GID_OUT_OF_RANGE",
      `GID ${decoded.baseGid} falls outside tileset ${binding.name}.`,
      { gid: decoded.baseGid, tilesetAssetId: binding.assetId },
    );
  }
  return {
    tileset: { kind: "external", assetId: binding.assetId },
    localId,
    transform: decoded.transform,
  };
}

/**
 * Re-encodes actually-written encoded tile layers before source patching.
 * A layer's `data` member flips from string to array exactly when the first
 * real cell write lands (writeLayerGid syncs the decoded view back), so
 * untouched encoded layers keep their exact original bytes. A written layer
 * whose decoded cells ended up identical to the original gets its original
 * string restored, preserving the exact-byte net no-op collapse.
 */
function reencodeWrittenTileLayers(
  edited: JsonObject,
  original: JsonObject,
  affectedTileLayerIds: readonly number[],
  mapPath: string,
): void {
  for (const layerId of affectedTileLayerIds) {
    const located = findLayerRecursive(
      expectArray(
        edited.layers,
        `${mapPath}.layers`,
      ),
      layerId,
      `${mapPath}.layers`,
      ["layers"],
    );
    if (located === undefined) {
      continue;
    }
    const layer = located.object;
    const editedCells = layer.data;
    if (
      layer.encoding !== "base64" ||
      !Array.isArray(editedCells)
    ) {
      continue;
    }
    const compression =
      layer.compression === undefined ||
      layer.compression === ""
        ? ""
        : String(layer.compression);
    const originalLocated = findLayerRecursive(
      expectArray(
        original.layers,
        `${mapPath}.layers`,
      ),
      layerId,
      `${mapPath}.layers`,
      ["layers"],
    );
    const originalLayer = originalLocated?.object;
    if (
      originalLayer !== undefined &&
      typeof originalLayer.data === "string" &&
      originalLayer.encoding === "base64"
    ) {
      const originalCells =
        decodeEncodedTileLayerData(
          originalLayer,
          layerId,
          mapPath,
          editedCells.length,
        );
      if (
        originalCells.length ===
          editedCells.length &&
        originalCells.every(
          (cell, index) =>
            cell === editedCells[index],
        )
      ) {
        layer.data = originalLayer.data;
        continue;
      }
    }
    layer.data = encodeTileLayerCells(
      editedCells,
      compression,
      layerId,
      mapPath,
    );
  }
}

function findChunkedTileLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): {
  object: JsonObject;
  id: number;
  name: string;
} {
  const layers = expectArray(
    map.layers,
    `${mapPath}.layers`,
  );
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (!located) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist.`,
      { path: mapPath, layerId },
    );
  }
  const found = located.object;
  if (found.type !== "tilelayer") {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Layer ${layerId} is not a tile layer.`,
      { path: mapPath, layerId },
    );
  }
  if (!("chunks" in found)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${layerId} of an infinite map must use chunked storage.`,
      { path: mapPath, layerId },
    );
  }
  return {
    object: found,
    id: expectInteger(
      found.id,
      `layer ${layerId}.id`,
    ),
    name:
      typeof found.name === "string"
        ? found.name
        : `Layer ${layerId}`,
  };
}

function findTileLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
  mode: "read" | "edit" = "edit",
): TileLayerView {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (!located) {
    throw new TiledMcpError("LAYER_NOT_FOUND", `Layer ${layerId} does not exist.`, {
      path: mapPath,
      layerId,
    });
  }
  const found = located.object;
  if (found.type !== "tilelayer") {
    throw new TiledMcpError("LAYER_TYPE_MISMATCH", `Layer ${layerId} is not a tile layer.`, {
      path: mapPath,
      layerId,
    });
  }
  const width = expectInteger(found.width, `layer ${layerId}.width`);
  const height = expectInteger(found.height, `layer ${layerId}.height`);
  assertPositiveInteger(width, `layer ${layerId}.width`);
  assertPositiveInteger(height, `layer ${layerId}.height`);
  const data = resolveTileLayerCells(
    found,
    layerId,
    mapPath,
    width * height,
    mode,
    "MVP editing supports only finite JSON tile layers with numeric data arrays.",
  );
  if (data.length !== width * height) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${layerId} data length does not match width × height.`,
      { layerId, expected: width * height, actual: data.length },
    );
  }
  return {
    object: found,
    path: located.path,
    id: expectInteger(found.id, `layer ${layerId}.id`),
    name: typeof found.name === "string" ? found.name : `Layer ${layerId}`,
    x: readOptionalInteger(found.x, `layer ${layerId}.x`, 0),
    y: readOptionalInteger(found.y, `layer ${layerId}.y`, 0),
    width,
    height,
    data,
  };
}

function assertEditableLayerIdentities(
  layers: JsonValue[],
  mapPath: string,
): void {
  const ids = new Set<number>();
  const visit = (
    entries: JsonValue[],
    context: string,
    depth: number,
    budget: LayerTraversalBudget,
  ): void => {
    assertLayerTraversalBudget(entries.length, depth, budget);
    for (const [index, value] of entries.entries()) {
      const layer = expectObject(value, `${context}[${index}]`);
      const id = expectInteger(layer.id, `${context}[${index}].id`);
      if (id <= 0) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath} contains a non-positive layer id.`,
          { path: mapPath, layerId: id },
        );
      }
      if (ids.has(id)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath} contains duplicate layer id ${id}.`,
          { path: mapPath, layerId: id },
        );
      }
      ids.add(id);
      if (layer.type === "group") {
        visit(
          expectArray(layer.layers, `${context}[${index}].layers`),
          `${context}[${index}].layers`,
          depth + 1,
          budget,
        );
      }
    }
  };

  visit(layers, `${mapPath}.layers`, 0, { count: 0 });
}

function findObjectLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): ObjectLayerView {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (!located) {
    throw new TiledMcpError("LAYER_NOT_FOUND", `Layer ${layerId} does not exist.`, {
      path: mapPath,
      layerId,
    });
  }
  if (located.object.type !== "objectgroup") {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Layer ${layerId} is not an object layer.`,
      { path: mapPath, layerId },
    );
  }
  return {
    object: located.object,
    path: located.path,
    id: expectInteger(located.object.id, `layer ${layerId}.id`),
    name:
      typeof located.object.name === "string"
        ? located.object.name
        : `Layer ${layerId}`,
    objects: expectArray(located.object.objects, `layer ${layerId}.objects`),
    ancestors: located.ancestors,
  };
}

function collectObjectLocations(
  map: JsonObject,
  mapPath: string,
): ObjectLocation[] {
  const locations: ObjectLocation[] = [];
  collectObjectLocationsRecursive(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
    ["layers"],
    locations,
    { count: 0 },
    { count: 0 },
    [],
  );
  assertUniqueObjectIds(locations, mapPath);
  return locations;
}

function collectObjectLocationsFromLayer(
  layer: ObjectLayerView,
  mapPath: string,
): ObjectLocation[] {
  if (layer.objects.length > MAX_OBJECT_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Map contains more than ${MAX_OBJECT_COUNT} objects.`,
      { path: mapPath, limit: MAX_OBJECT_COUNT },
    );
  }
  const locations = layer.objects.map((value, objectIndex) => ({
    object: expectObject(
      value,
      `${mapPath} object layer ${layer.id}.objects[${objectIndex}]`,
    ),
    objectIndex,
    layer,
    ancestors: layer.ancestors,
  }));
  assertUniqueObjectIds(locations, mapPath);
  return locations;
}

function collectObjectLocationsRecursive(
  layers: JsonValue[],
  context: string,
  path: JsonSourcePath,
  output: ObjectLocation[],
  layerBudget: LayerTraversalBudget,
  objectBudget: { count: number },
  ancestors: readonly JsonObject[],
  depth = 0,
): void {
  assertLayerTraversalBudget(layers.length, depth, layerBudget);
  for (const [layerIndex, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${layerIndex}]`);
    const layerPath: JsonSourcePath = [...path, layerIndex];
    if (layer.type === "group") {
      collectObjectLocationsRecursive(
        expectArray(layer.layers, `${context}[${layerIndex}].layers`),
        `${context}[${layerIndex}].layers`,
        [...layerPath, "layers"],
        output,
        layerBudget,
        objectBudget,
        [...ancestors, layer],
        depth + 1,
      );
      continue;
    }
    if (layer.type !== "objectgroup") {
      continue;
    }
    const objects = expectArray(
      layer.objects,
      `${context}[${layerIndex}].objects`,
    );
    if (objectBudget.count + objects.length > MAX_OBJECT_COUNT) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Map contains more than ${MAX_OBJECT_COUNT} objects.`,
        { limit: MAX_OBJECT_COUNT },
      );
    }
    objectBudget.count += objects.length;
    const layerView: ObjectLayerView = {
      object: layer,
      path: layerPath,
      id: expectInteger(layer.id, `${context}[${layerIndex}].id`),
      name:
        typeof layer.name === "string"
          ? layer.name
          : `Layer ${String(layer.id)}`,
      objects,
      ancestors,
    };
    for (const [objectIndex, objectValue] of objects.entries()) {
      output.push({
        object: expectObject(
          objectValue,
          `${context}[${layerIndex}].objects[${objectIndex}]`,
        ),
        objectIndex,
        layer: layerView,
        ancestors,
      });
    }
  }
}

function assertUniqueObjectIds(
  locations: readonly ObjectLocation[],
  mapPath: string,
): void {
  const ids = new Set<number>();
  for (const location of locations) {
    const id = expectInteger(location.object.id, `${mapPath} object id`);
    if (id <= 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${mapPath} contains a non-positive object id.`,
        { path: mapPath, objectId: id },
      );
    }
    if (ids.has(id)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${mapPath} contains duplicate object id ${id}.`,
        { path: mapPath, objectId: id },
      );
    }
    ids.add(id);
  }
}

function buildObjectEditIndex(
  map: JsonObject,
  mapPath: string,
): ObjectEditIndex {
  const locations = collectObjectLocations(map, mapPath);
  const byId = new Map<number, ObjectLocation>();
  let maximumId = 0;
  for (const location of locations) {
    const id = expectInteger(location.object.id, `${mapPath} object id`);
    byId.set(id, location);
    maximumId = Math.max(maximumId, id);
  }
  return { byId, maximumId };
}

function findObjectLocation(
  index: ObjectEditIndex,
  objectId: number,
  mapPath: string,
): ObjectLocation {
  const found = index.byId.get(objectId);
  if (!found) {
    throw new TiledMcpError(
      "OBJECT_NOT_FOUND",
      `Object ${objectId} does not exist in ${mapPath}.`,
      { path: mapPath, objectId },
    );
  }
  return found;
}

function moveExistingLayer(
  map: JsonObject,
  operation: Extract<
    MapEditOperation,
    { type: "moveLayer" }
  >,
  mapPath: string,
  context: string,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["movedLayers"]
  >[number],
  "operationIndex"
> {
  const allowedKeys = new Set([
    "type",
    "layerId",
    "parentGroupId",
    "index",
  ]);
  const unknownKey = Object.keys(operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertPositiveInteger(
    operation.layerId,
    `${context}.layerId`,
  );
  if (operation.parentGroupId !== undefined) {
    assertPositiveInteger(
      operation.parentGroupId,
      `${context}.parentGroupId`,
    );
  }
  if (
    !Number.isSafeInteger(operation.index) ||
    operation.index < 0
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.index must be a non-negative safe integer.`,
    );
  }

  const source = findDeletableLayer(
    map,
    operation.layerId,
    mapPath,
  );
  const inspection = inspectLayerSubtree(
    source.object,
    mapPath,
  );
  const targetParentGroupId =
    operation.parentGroupId ?? null;
  if (
    targetParentGroupId !== null &&
    inspection.layerIds.includes(targetParentGroupId)
  ) {
    throw new TiledMcpError(
      "LAYER_MOVE_CYCLE",
      `Layer ${operation.layerId} cannot be moved into itself or one of its descendants.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
      },
    );
  }

  const sourcePlacement = layerContainerForParent(
    map,
    source.parentGroupId,
    mapPath,
  );
  if (
    sourcePlacement.layers !== source.container ||
    sourcePlacement.layers[source.index] !== source.object
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${operation.layerId} moved during change-set planning.`,
      { path: mapPath, layerId: operation.layerId },
    );
  }
  const targetPlacement = layerContainerForParent(
    map,
    targetParentGroupId,
    mapPath,
  );
  const sameContainer =
    sourcePlacement.layers === targetPlacement.layers;
  const maximumTargetIndex = sameContainer
    ? targetPlacement.layers.length - 1
    : targetPlacement.layers.length;
  if (operation.index > maximumTargetIndex) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      sameContainer
        ? `Final index ${operation.index} is outside sibling range 0..${maximumTargetIndex}.`
        : `Final index ${operation.index} is outside target insertion range 0..${maximumTargetIndex}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        index: operation.index,
        maximumIndex: maximumTargetIndex,
        indexSemantics: "final-index-after-move",
      },
    );
  }
  const resultingDepth =
    targetPlacement.childDepth +
    inspection.maxRelativeDepth;
  if (resultingDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_DEPTH_EXCEEDED",
      `Moving layer ${operation.layerId} would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        resultingDepth,
        maxDepth: MAX_LAYER_DEPTH,
      },
    );
  }

  const wouldChange =
    !sameContainer || source.index !== operation.index;
  const rawName =
    typeof source.object.name === "string"
      ? source.object.name
      : `Layer ${source.id}`;
  const displayName = boundedDisplayString(rawName);
  if (wouldChange) {
    const [moved] = sourcePlacement.layers.splice(
      source.index,
      1,
    );
    if (moved !== source.object) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Layer ${operation.layerId} disappeared during change-set planning.`,
        { path: mapPath, layerId: operation.layerId },
      );
    }
    targetPlacement.layers.splice(
      operation.index,
      0,
      moved,
    );
  }

  const renderContextMayChange =
    wouldChange &&
    source.parentGroupId !== targetParentGroupId;
  const descendantLayerCount =
    inspection.layerIds.length - 1;
  const layerIdSample = inspection.layerIds.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  return {
    layerId: source.id,
    layerType: source.type,
    name: displayName.value,
    nameTruncated: displayName.truncated,
    sourceParentGroupId: source.parentGroupId,
    sourceIndex: source.index,
    targetParentGroupId,
    targetIndex: operation.index,
    subtreeLayerCount: inspection.layerIds.length,
    descendantLayerCount,
    layerIdSample,
    omittedLayerCount:
      inspection.layerIds.length - layerIdSample.length,
    objectCount: inspection.objectIds.length,
    lockedLayerCount: inspection.lockedLayerCount,
    sourceParentLocked: sourcePlacement.parentLocked,
    targetParentLocked: targetPlacement.parentLocked,
    effectivelyLockedLayerCountBefore:
      sourcePlacement.effectiveParentLocked
        ? inspection.layerIds.length
        : inspection.effectivelyLockedLayerCount,
    effectivelyLockedLayerCountAfter:
      targetPlacement.effectiveParentLocked
        ? inspection.layerIds.length
        : inspection.effectivelyLockedLayerCount,
    wouldChange,
    renderOrderMayChange: wouldChange,
    renderContextMayChange,
    affectsDescendants:
      wouldChange &&
      source.type === "group" &&
      descendantLayerCount > 0,
  };
}

// Duplication deliberately has its own exclusive planner because it allocates
// IDs, rewires typed references, and inserts one synthesized subtree.
function duplicateExistingLayer(
  map: JsonObject,
  operation: Extract<
    MapEditOperation,
    { type: "duplicateLayer" }
  >,
  bindings: readonly TilesetBinding[],
  mapPath: string,
  context: string,
  sourceBytes: number | undefined,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["duplicatedLayers"]
  >[number],
  "operationIndex"
> {
  const allowedKeys = new Set([
    "type",
    "layerId",
    "destination",
    "name",
  ]);
  const unknownKey = Object.keys(operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertPositiveInteger(
    operation.layerId,
    `${context}.layerId`,
  );
  if (operation.name !== undefined) {
    assertBoundedString(
      operation.name,
      `${context}.name`,
    );
  }
  if (
    sourceBytes === undefined ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "duplicateLayer requires the original source byte length.",
      { path: mapPath },
    );
  }

  const source = findDeletableLayer(
    map,
    operation.layerId,
    mapPath,
  );
  const sourcePlacement = layerContainerForParent(
    map,
    source.parentGroupId,
    mapPath,
  );
  if (
    sourcePlacement.layers !== source.container ||
    sourcePlacement.layers[source.index] !== source.object
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${operation.layerId} moved during change-set planning.`,
      { path: mapPath, layerId: operation.layerId },
    );
  }
  const sourceName = expectString(
    source.object.name,
    `layer ${operation.layerId}.name`,
  );
  const inspection = inspectLayerSubtree(
    source.object,
    mapPath,
  );

  const destination = operation.destination;
  let targetParentGroupId: number | null;
  let requestedIndex: number | undefined;
  let defaultAdjacent = false;
  if (destination === undefined) {
    targetParentGroupId = source.parentGroupId;
    defaultAdjacent = true;
  } else {
    if (!isRecordValue(destination)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.destination must be an object.`,
      );
    }
    if (destination.kind === "sameParent") {
      assertExactObjectKeys(
        destination,
        new Set(["kind", "index"]),
        `${context}.destination`,
      );
      targetParentGroupId = source.parentGroupId;
      requestedIndex = destination.index;
      defaultAdjacent = destination.index === undefined;
    } else if (destination.kind === "root") {
      assertExactObjectKeys(
        destination,
        new Set(["kind", "index"]),
        `${context}.destination`,
      );
      targetParentGroupId = null;
      requestedIndex = destination.index;
    } else if (destination.kind === "group") {
      assertExactObjectKeys(
        destination,
        new Set(["kind", "parentGroupId", "index"]),
        `${context}.destination`,
      );
      assertPositiveInteger(
        destination.parentGroupId,
        `${context}.destination.parentGroupId`,
      );
      targetParentGroupId = destination.parentGroupId;
      requestedIndex = destination.index;
      if (
        inspection.layerIds.includes(
          destination.parentGroupId,
        )
      ) {
        throw new TiledMcpError(
          "DUPLICATE_LAYER_TARGET_IN_SOURCE_SUBTREE",
          `Layer ${operation.layerId} cannot be duplicated into itself or one of its descendants.`,
          {
            path: mapPath,
            layerId: operation.layerId,
            parentGroupId: destination.parentGroupId,
          },
        );
      }
    } else {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.destination.kind must be sameParent, root, or group.`,
      );
    }
  }
  if (
    requestedIndex !== undefined &&
    (!Number.isSafeInteger(requestedIndex) ||
      requestedIndex < 0)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.destination.index must be a non-negative safe integer.`,
    );
  }

  const targetPlacement = layerContainerForParent(
    map,
    targetParentGroupId,
    mapPath,
  );
  const targetIndex = defaultAdjacent
    ? source.index + 1
    : (requestedIndex ?? targetPlacement.layers.length);
  if (targetIndex > targetPlacement.layers.length) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      `Duplicate insertion index ${targetIndex} is outside target range 0..${targetPlacement.layers.length}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        index: targetIndex,
        maximumIndex: targetPlacement.layers.length,
        indexSemantics: "final-insertion-index",
      },
    );
  }
  const resultingDepth =
    targetPlacement.childDepth +
    inspection.maxRelativeDepth;
  if (resultingDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_DEPTH_EXCEEDED",
      `Duplicating layer ${operation.layerId} at the selected destination would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        resultingDepth,
        maxDepth: MAX_LAYER_DEPTH,
      },
    );
  }

  const rootLayers = expectArray(
    map.layers,
    `${mapPath}.layers`,
  );
  const layerInventory = inspectLayerTree(
    rootLayers,
    mapPath,
  );
  if (
    layerInventory.count + inspection.layerIds.length >
    MAX_LAYER_COUNT
  ) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `Duplicating this subtree would exceed the map layer limit ${MAX_LAYER_COUNT}.`,
      {
        path: mapPath,
        existing: layerInventory.count,
        copied: inspection.layerIds.length,
        limit: MAX_LAYER_COUNT,
      },
    );
  }
  const objectIndex = buildObjectEditIndex(
    map,
    mapPath,
  );
  if (
    objectIndex.byId.size + inspection.objectIds.length >
    MAX_OBJECT_COUNT
  ) {
    throw new TiledMcpError(
      "OBJECT_LIMIT_EXCEEDED",
      `Duplicating this subtree would exceed the map object limit ${MAX_OBJECT_COUNT}.`,
      {
        path: mapPath,
        existing: objectIndex.byId.size,
        copied: inspection.objectIds.length,
        limit: MAX_OBJECT_COUNT,
      },
    );
  }
  if (
    inspection.objectIds.length >
    MAX_OBJECT_MUTATIONS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A duplicateLayer operation may copy at most ${MAX_OBJECT_MUTATIONS} objects.`,
      {
        path: mapPath,
        actual: inspection.objectIds.length,
        limit: MAX_OBJECT_MUTATIONS,
      },
    );
  }

  const nextLayerId = expectInteger(
    map.nextlayerid,
    `${mapPath}.nextlayerid`,
  );
  if (
    nextLayerId <= 0 ||
    nextLayerId <= layerInventory.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_LAYER_ID_INVALID",
      `${mapPath}.nextlayerid must be greater than every existing layer id.`,
      {
        path: mapPath,
        nextLayerId,
        maximumExistingId: layerInventory.maximumId,
      },
    );
  }
  const nextLayerHighWater =
    nextLayerId + inspection.layerIds.length;
  if (
    !Number.isSafeInteger(nextLayerHighWater) ||
    nextLayerHighWater > MAX_TILED_SIGNED_ID
  ) {
    throw new TiledMcpError(
      "LAYER_ID_EXHAUSTED",
      "The duplicated subtree does not fit in Tiled's signed 32-bit layer id space.",
      {
        path: mapPath,
        nextLayerId,
        copiedLayerCount: inspection.layerIds.length,
        maximumHighWaterMark: MAX_TILED_SIGNED_ID,
      },
    );
  }

  const nextObjectId = expectInteger(
    map.nextobjectid,
    `${mapPath}.nextobjectid`,
  );
  if (
    nextObjectId <= 0 ||
    nextObjectId <= objectIndex.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_OBJECT_ID_INVALID",
      `${mapPath}.nextobjectid must be greater than every existing object id.`,
      {
        path: mapPath,
        nextObjectId,
        maximumExistingId: objectIndex.maximumId,
      },
    );
  }
  const nextObjectHighWater =
    nextObjectId + inspection.objectIds.length;
  if (
    !Number.isSafeInteger(nextObjectHighWater) ||
    nextObjectHighWater > MAX_TILED_SIGNED_ID
  ) {
    throw new TiledMcpError(
      "OBJECT_ID_EXHAUSTED",
      "The duplicated subtree does not fit in Tiled's signed 32-bit object id space.",
      {
        path: mapPath,
        nextObjectId,
        copiedObjectCount: inspection.objectIds.length,
        maximumHighWaterMark: MAX_TILED_SIGNED_ID,
      },
    );
  }

  const duplicate = expectObject(
    cloneJson(source.object),
    `duplicate of layer ${operation.layerId}`,
  );
  const layerIdMappings: Array<{
    from: number;
    to: number;
  }> = [];
  const objectIdMappings: Array<{
    from: number;
    to: number;
  }> = [];
  const objectIdMap = new Map<number, number>();
  let allocatedCellCount = 0;
  let tileObjectCount = 0;
  let imageReferenceCount = 0;
  let layerAllocationOffset = 0;
  let objectAllocationOffset = 0;

  const allocateIds = (
    layer: JsonObject,
    layerContext: string,
    depth: number,
  ): void => {
    if (depth > MAX_LAYER_DEPTH) {
      throw new TiledMcpError(
        "LAYER_DEPTH_EXCEEDED",
        `Duplicated layer subtree exceeds depth ${MAX_LAYER_DEPTH}.`,
        { path: mapPath, maxDepth: MAX_LAYER_DEPTH },
      );
    }
    const oldLayerId = expectInteger(
      layer.id,
      `${layerContext}.id`,
    );
    const newLayerId =
      nextLayerId + layerAllocationOffset;
    layerAllocationOffset += 1;
    layer.id = newLayerId;
    layerIdMappings.push({
      from: oldLayerId,
      to: newLayerId,
    });

    const type = expectString(
      layer.type,
      `${layerContext}.type`,
    );
    if (type === "tilelayer") {
      const width = expectInteger(
        layer.width,
        `${layerContext}.width`,
      );
      const height = expectInteger(
        layer.height,
        `${layerContext}.height`,
      );
      const data = expectArray(
        layer.data,
        `${layerContext}.data`,
      );
      const cellCount = width * height;
      if (
        width <= 0 ||
        height <= 0 ||
        !Number.isSafeInteger(cellCount) ||
        data.length !== cellCount ||
        allocatedCellCount + cellCount >
          MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A duplicateLayer operation may copy at most ${MAX_CELL_WRITES} finite uncompressed tile cells.`,
          {
            path: mapPath,
            layerId: oldLayerId,
            actual:
              Number.isSafeInteger(cellCount)
                ? allocatedCellCount + cellCount
                : null,
            limit: MAX_CELL_WRITES,
          },
        );
      }
      for (const [index, gid] of data.entries()) {
        assertResolvableGid(
          gid,
          bindings,
          `${layerContext}.data[${index}]`,
        );
      }
      allocatedCellCount += cellCount;
      return;
    }
    if (type === "imagelayer") {
      if (layer.image !== undefined) {
        expectString(
          layer.image,
          `${layerContext}.image`,
        );
        imageReferenceCount += 1;
      }
      return;
    }
    if (type === "objectgroup") {
      const objects = expectArray(
        layer.objects,
        `${layerContext}.objects`,
      );
      for (const [index, value] of objects.entries()) {
        const object = expectObject(
          value,
          `${layerContext}.objects[${index}]`,
        );
        const oldObjectId = expectInteger(
          object.id,
          `${layerContext}.objects[${index}].id`,
        );
        if (
          Object.prototype.hasOwnProperty.call(
            object,
            "template",
          )
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_DUPLICATE_TEMPLATE",
            `Object ${oldObjectId} uses a template that is not revision-pinned for duplication.`,
            {
              path: mapPath,
              objectId: oldObjectId,
            },
          );
        }
        if (object.gid !== undefined) {
          assertResolvableGid(
            object.gid,
            bindings,
            `${layerContext}.objects[${index}].gid`,
          );
          tileObjectCount += 1;
        }
        const newObjectId =
          nextObjectId + objectAllocationOffset;
        objectAllocationOffset += 1;
        object.id = newObjectId;
        objectIdMap.set(oldObjectId, newObjectId);
        objectIdMappings.push({
          from: oldObjectId,
          to: newObjectId,
        });
      }
      return;
    }
    if (type !== "group") {
      throw new TiledMcpError(
        "LAYER_TYPE_MISMATCH",
        `Layer ${oldLayerId} does not use a supported Tiled layer type.`,
        {
          path: mapPath,
          layerId: oldLayerId,
          layerType: type,
        },
      );
    }
    const children = expectArray(
      layer.layers,
      `${layerContext}.layers`,
    );
    for (const [index, value] of children.entries()) {
      allocateIds(
        expectObject(
          value,
          `${layerContext}.layers[${index}]`,
        ),
        `${layerContext}.layers[${index}]`,
        depth + 1,
      );
    }
  };

  allocateIds(
    duplicate,
    `layer ${operation.layerId} duplicate`,
    0,
  );
  if (
    layerAllocationOffset !== inspection.layerIds.length ||
    objectAllocationOffset !== inspection.objectIds.length
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      "The duplicated subtree changed while IDs were allocated.",
      {
        path: mapPath,
        expectedLayers: inspection.layerIds.length,
        actualLayers: layerAllocationOffset,
        expectedObjects: inspection.objectIds.length,
        actualObjects: objectAllocationOffset,
      },
    );
  }
  if (operation.name !== undefined) {
    duplicate.name = operation.name;
  }

  const referenceSummary =
    rewriteDuplicatePropertyReferences(
      duplicate,
      objectIdMap,
      new Set(objectIndex.byId.keys()),
      mapPath,
    );
  const duplicateText = JSON.stringify(duplicate);
  const serializedDuplicateBytes = Buffer.byteLength(
    duplicateText,
    "utf8",
  );
  if (
    serializedDuplicateBytes >
    MAX_DUPLICATE_LAYER_BYTES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A duplicated layer subtree may serialize to at most ${MAX_DUPLICATE_LAYER_BYTES} bytes.`,
      {
        path: mapPath,
        actual: serializedDuplicateBytes,
        limit: MAX_DUPLICATE_LAYER_BYTES,
      },
    );
  }
  const projectedSourceBytes =
    sourceBytes + serializedDuplicateBytes + 129;
  if (
    !Number.isSafeInteger(projectedSourceBytes) ||
    projectedSourceBytes > MAX_EDITABLE_DOCUMENT_BYTES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Duplicating this layer would exceed the ${MAX_EDITABLE_DOCUMENT_BYTES}-byte document limit.`,
      {
        path: mapPath,
        sourceBytes,
        serializedDuplicateBytes,
        projectedUpperBound: Number.isSafeInteger(
          projectedSourceBytes,
        )
          ? projectedSourceBytes
          : null,
        limit: MAX_EDITABLE_DOCUMENT_BYTES,
      },
    );
  }

  targetPlacement.layers.splice(
    targetIndex,
    0,
    duplicate,
  );
  map.nextlayerid = nextLayerHighWater;
  if (inspection.objectIds.length > 0) {
    map.nextobjectid = nextObjectHighWater;
  }

  const duplicateName = boundedDisplayString(
    operation.name ?? sourceName,
  );
  const layerIdMappingSample = layerIdMappings.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  const objectIdMappingSample = objectIdMappings.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  return {
    sourceLayerId: source.id,
    createdRootLayerId:
      layerIdMappings[0]?.to ??
      (() => {
        throw new Error(
          "Duplicate layer allocation lost its root ID.",
        );
      })(),
    layerType: source.type,
    name: duplicateName.value,
    nameTruncated: duplicateName.truncated,
    sourceParentGroupId: source.parentGroupId,
    targetParentGroupId,
    sourceIndex: source.index,
    targetIndex,
    copiedLayerCount: inspection.layerIds.length,
    descendantLayerCount:
      inspection.layerIds.length - 1,
    copiedObjectCount: inspection.objectIds.length,
    allocatedCellCount,
    serializedDuplicateBytes,
    layerIdMappingSample,
    omittedLayerMappingCount:
      layerIdMappings.length -
      layerIdMappingSample.length,
    objectIdMappingSample,
    omittedObjectMappingCount:
      objectIdMappings.length -
      objectIdMappingSample.length,
    remappedInternalObjectReferenceCount:
      referenceSummary.remappedInternalObjectReferenceCount,
    retainedExternalObjectReferenceCount:
      referenceSummary.retainedExternalObjectReferenceCount,
    fileReferenceCount:
      referenceSummary.fileReferenceCount +
      imageReferenceCount,
    tileObjectCount,
    lockedLayerCount: inspection.lockedLayerCount,
    effectivelyLockedLayerCount:
      targetPlacement.effectiveParentLocked
        ? inspection.layerIds.length
        : inspection.effectivelyLockedLayerCount,
    renderOrderMayChange: true,
    renderContextMayChange:
      source.parentGroupId !== targetParentGroupId,
    affectsDescendants:
      source.type === "group" &&
      inspection.layerIds.length > 1,
  };
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unknownKey = Object.keys(value).find(
    (key) => !allowed.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
}

function rewriteDuplicatePropertyReferences(
  root: JsonObject,
  copiedObjectIds: ReadonlyMap<number, number>,
  existingObjectIds: ReadonlySet<number>,
  mapPath: string,
): {
  remappedInternalObjectReferenceCount: number;
  retainedExternalObjectReferenceCount: number;
  fileReferenceCount: number;
} {
  let visited = 0;
  let remappedInternalObjectReferenceCount = 0;
  let retainedExternalObjectReferenceCount = 0;
  let fileReferenceCount = 0;

  const scanPropertyEntry = (
    value: JsonValue,
    pointer: string,
    depth: number,
  ): void => {
    visited += 1;
    if (visited > 1_000_000 || depth > 512) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "The duplicated subtree is too complex to analyze property references safely.",
        { path: mapPath },
      );
    }
    if (!isJsonObject(value)) {
      return;
    }

    if (value.type === "object") {
      const referencedId = value.value;
      if (
        typeof referencedId !== "number" ||
        !Number.isSafeInteger(referencedId) ||
        referencedId < 0
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "An object property in the duplicated subtree has a malformed reference.",
          {
            path: mapPath,
            jsonPointer: pointer,
          },
        );
      }
      if (referencedId !== 0) {
        const remapped = copiedObjectIds.get(
          referencedId,
        );
        if (remapped !== undefined) {
          value.value = remapped;
          remappedInternalObjectReferenceCount += 1;
        } else if (existingObjectIds.has(referencedId)) {
          retainedExternalObjectReferenceCount += 1;
        } else {
          throw new TiledMcpError(
            "OBJECT_REFERENCE_NOT_FOUND",
            `Object property reference ${referencedId} does not identify an existing object.`,
            {
              path: mapPath,
              objectId: referencedId,
              jsonPointer: pointer,
            },
          );
        }
      }
      return;
    }
    if (value.type === "class") {
      throw new TiledMcpError(
        "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
        "Class properties require a pinned project type schema before a layer can be duplicated safely.",
        {
          path: mapPath,
          jsonPointer: pointer,
        },
      );
    }
    if (value.type === "layer") {
      throw new TiledMcpError(
        "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
        "Non-standard typed layer references are not guessed or rewritten during duplication.",
        {
          path: mapPath,
          jsonPointer: pointer,
        },
      );
    }
    if (value.type === "file") {
      if (typeof value.value !== "string") {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "A file property in the duplicated subtree has a malformed value.",
          {
            path: mapPath,
            jsonPointer: pointer,
          },
        );
      }
      fileReferenceCount += 1;
      return;
    }
    if (value.type === "list") {
      if (!Array.isArray(value.value)) {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "A list property in the duplicated subtree has a malformed value.",
          {
            path: mapPath,
            jsonPointer: pointer,
          },
        );
      }
      const listPointer = appendJsonPointer(
        pointer,
        "value",
      );
      for (const [index, item] of value.value.entries()) {
        scanPropertyEntry(
          item,
          appendJsonPointer(listPointer, index),
          depth + 1,
        );
      }
    }
  };

  const scanOwnerProperties = (
    owner: JsonObject,
    pointer: string,
  ): void => {
    if (
      !Object.prototype.hasOwnProperty.call(
        owner,
        "properties",
      )
    ) {
      return;
    }
    const propertiesPointer = appendJsonPointer(
      pointer,
      "properties",
    );
    if (!Array.isArray(owner.properties)) {
      throw new TiledMcpError(
        "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
        "A layer or object properties member in the duplicated subtree must be an array.",
        {
          path: mapPath,
          jsonPointer: propertiesPointer,
        },
      );
    }
    for (const [index, property] of owner.properties.entries()) {
      if (!isJsonObject(property)) {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "A layer or object property entry in the duplicated subtree must be an object.",
          {
            path: mapPath,
            jsonPointer: appendJsonPointer(
              propertiesPointer,
              index,
            ),
          },
        );
      }
      scanPropertyEntry(
        property,
        appendJsonPointer(propertiesPointer, index),
        0,
      );
    }
  };

  const visitLayer = (
    layer: JsonObject,
    pointer: string,
    depth: number,
  ): void => {
    if (depth > MAX_LAYER_DEPTH) {
      throw new TiledMcpError(
        "LAYER_DEPTH_EXCEEDED",
        `Duplicated layer subtree exceeds depth ${MAX_LAYER_DEPTH}.`,
        { path: mapPath, maxDepth: MAX_LAYER_DEPTH },
      );
    }
    scanOwnerProperties(layer, pointer);
    const type = expectString(
      layer.type,
      `${pointer}/type`,
    );
    if (type === "objectgroup") {
      const objects = expectArray(
        layer.objects,
        `${pointer}/objects`,
      );
      for (const [index, value] of objects.entries()) {
        scanOwnerProperties(
          expectObject(
            value,
            `${pointer}/objects/${index}`,
          ),
          appendJsonPointer(
            appendJsonPointer(pointer, "objects"),
            index,
          ),
        );
      }
      return;
    }
    if (type !== "group") {
      return;
    }
    const layers = expectArray(
      layer.layers,
      `${pointer}/layers`,
    );
    const layersPointer = appendJsonPointer(
      pointer,
      "layers",
    );
    for (const [index, value] of layers.entries()) {
      visitLayer(
        expectObject(
          value,
          `${pointer}/layers/${index}`,
        ),
        appendJsonPointer(layersPointer, index),
        depth + 1,
      );
    }
  };

  visitLayer(root, "", 0);
  return {
    remappedInternalObjectReferenceCount,
    retainedExternalObjectReferenceCount,
    fileReferenceCount,
  };
}

function deleteExistingLayer(
  map: JsonObject,
  operation: Extract<
    MapEditOperation,
    { type: "deleteLayer" }
  >,
  mapPath: string,
  context: string,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["deletedLayers"]
  >[number],
  "operationIndex"
> {
  const allowedKeys = new Set([
    "type",
    "layerId",
    "deleteDescendants",
  ]);
  const unknownKey = Object.keys(operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertPositiveInteger(
    operation.layerId,
    `${context}.layerId`,
  );
  if (
    operation.deleteDescendants !== undefined &&
    typeof operation.deleteDescendants !== "boolean"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.deleteDescendants must be a boolean.`,
    );
  }

  const location = findDeletableLayer(
    map,
    operation.layerId,
    mapPath,
  );
  const inspection = inspectLayerSubtree(
    location.object,
    mapPath,
  );
  const descendantLayerCount =
    inspection.layerIds.length - 1;
  if (
    location.type === "group" &&
    descendantLayerCount > 0 &&
    operation.deleteDescendants !== true
  ) {
    throw new TiledMcpError(
      "LAYER_HAS_DESCENDANTS",
      `Group layer ${operation.layerId} contains ${descendantLayerCount} descendant layer(s). Set deleteDescendants to true to confirm recursive deletion.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        descendantLayerCount,
      },
    );
  }

  if (inspection.objectIds.length > 0) {
    const objectIndex = buildObjectEditIndex(map, mapPath);
    for (const objectId of inspection.objectIds) {
      if (!objectIndex.byId.has(objectId)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `Object ${objectId} disappeared while inspecting layer ${operation.layerId}.`,
          {
            path: mapPath,
            layerId: operation.layerId,
            objectId,
          },
        );
      }
    }
  }

  if (
    location.container[location.index] !==
    location.object
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${operation.layerId} moved during change-set planning.`,
      { path: mapPath, layerId: operation.layerId },
    );
  }
  const rawName =
    typeof location.object.name === "string"
      ? location.object.name
      : `Layer ${location.id}`;
  const displayName = boundedDisplayString(rawName);

  if (inspection.objectIds.length > 0) {
    assertNoDanglingObjectReferences(
      map,
      new Set(inspection.objectIds),
      mapPath,
      location.object,
    );
  }
  location.container.splice(location.index, 1);

  const layerIdSample = inspection.layerIds.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  const objectIdSample = inspection.objectIds.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  return {
    layerId: location.id,
    layerType: location.type,
    name: displayName.value,
    nameTruncated: displayName.truncated,
    parentGroupId: location.parentGroupId,
    index: location.index,
    deletedLayerCount: inspection.layerIds.length,
    descendantLayerCount,
    layerIdSample,
    omittedLayerCount:
      inspection.layerIds.length - layerIdSample.length,
    objectCount: inspection.objectIds.length,
    objectIdSample,
    omittedObjectCount:
      inspection.objectIds.length - objectIdSample.length,
    lockedLayerCount: inspection.lockedLayerCount,
  };
}

function findDeletableLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): DeletableLayerLocation {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const found = findDeletableLayerRecursive(
    layers,
    layerId,
    mapPath,
    `${mapPath}.layers`,
    ["layers"],
    null,
  );
  if (found === undefined) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist.`,
      { path: mapPath, layerId },
    );
  }
  return found;
}

function findDeletableLayerRecursive(
  layers: JsonValue[],
  layerId: number,
  mapPath: string,
  context: string,
  containerPath: JsonSourcePath,
  parentGroupId: number | null,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
): DeletableLayerLocation | undefined {
  assertLayerTraversalBudget(layers.length, depth, budget);
  for (const [index, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${index}]`);
    const id = expectInteger(
      layer.id,
      `${context}[${index}].id`,
    );
    const type = expectString(
      layer.type,
      `${context}[${index}].type`,
    );
    if (id === layerId) {
      if (
        type !== "tilelayer" &&
        type !== "objectgroup" &&
        type !== "imagelayer" &&
        type !== "group"
      ) {
        throw new TiledMcpError(
          "LAYER_TYPE_MISMATCH",
          `Layer ${layerId} does not use a supported Tiled layer type.`,
          { path: mapPath, layerId, layerType: type },
        );
      }
      return {
        object: layer,
        path: [...containerPath, index],
        id,
        type,
        container: layers,
        containerPath,
        index,
        parentGroupId,
      };
    }
    if (type !== "group") {
      continue;
    }
    const nested = findDeletableLayerRecursive(
      expectArray(
        layer.layers,
        `${context}[${index}].layers`,
      ),
      layerId,
      mapPath,
      `${context}[${index}].layers`,
      [...containerPath, index, "layers"],
      id,
      depth + 1,
      budget,
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function inspectLayerSubtree(
  root: JsonObject,
  mapPath: string,
): LayerSubtreeInspection {
  const layerIds: number[] = [];
  const objectIds: number[] = [];
  const seenLayerIds = new Set<number>();
  const seenObjectIds = new Set<number>();
  let lockedLayerCount = 0;
  let effectivelyLockedLayerCount = 0;
  let maxRelativeDepth = 0;

  const visit = (
    layer: JsonObject,
    context: string,
    depth: number,
    inheritedLocked: boolean,
  ): void => {
    if (
      depth > MAX_LAYER_DEPTH ||
      layerIds.length >= MAX_LAYER_COUNT
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Deleted layer subtree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
        {
          path: mapPath,
          maxDepth: MAX_LAYER_DEPTH,
          maxLayers: MAX_LAYER_COUNT,
        },
      );
    }
    const id = expectInteger(layer.id, `${context}.id`);
    if (id <= 0 || seenLayerIds.has(id)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        id <= 0
          ? `${mapPath} contains a non-positive layer id.`
          : `${mapPath} contains duplicate layer id ${id}.`,
        { path: mapPath, layerId: id },
      );
    }
    const type = expectString(
      layer.type,
      `${context}.type`,
    );
    if (
      type !== "tilelayer" &&
      type !== "objectgroup" &&
      type !== "imagelayer" &&
      type !== "group"
    ) {
      throw new TiledMcpError(
        "LAYER_TYPE_MISMATCH",
        `Layer ${id} does not use a supported Tiled layer type.`,
        { path: mapPath, layerId: id, layerType: type },
      );
    }
    seenLayerIds.add(id);
    layerIds.push(id);
    maxRelativeDepth = Math.max(
      maxRelativeDepth,
      depth,
    );
    const explicitlyLocked = layer.locked === true;
    if (explicitlyLocked) {
      lockedLayerCount += 1;
    }
    const effectivelyLocked =
      inheritedLocked || explicitlyLocked;
    if (effectivelyLocked) {
      effectivelyLockedLayerCount += 1;
    }

    if (type === "objectgroup") {
      const objects = expectArray(
        layer.objects,
        `${context}.objects`,
      );
      if (
        objectIds.length + objects.length >
        MAX_OBJECT_COUNT
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Deleted layer subtree contains more than ${MAX_OBJECT_COUNT} objects.`,
          { path: mapPath, limit: MAX_OBJECT_COUNT },
        );
      }
      for (const [index, value] of objects.entries()) {
        const object = expectObject(
          value,
          `${context}.objects[${index}]`,
        );
        const objectId = expectInteger(
          object.id,
          `${context}.objects[${index}].id`,
        );
        if (
          objectId <= 0 ||
          seenObjectIds.has(objectId)
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            objectId <= 0
              ? `${mapPath} contains a non-positive object id.`
              : `${mapPath} contains duplicate object id ${objectId}.`,
            { path: mapPath, objectId },
          );
        }
        seenObjectIds.add(objectId);
        objectIds.push(objectId);
      }
      return;
    }
    if (type !== "group") {
      return;
    }
    const children = expectArray(
      layer.layers,
      `${context}.layers`,
    );
    for (const [index, value] of children.entries()) {
      visit(
        expectObject(
          value,
          `${context}.layers[${index}]`,
        ),
        `${context}.layers[${index}]`,
        depth + 1,
        effectivelyLocked,
      );
    }
  };

  visit(root, `layer ${String(root.id)}`, 0, false);
  return {
    layerIds,
    objectIds,
    lockedLayerCount,
    effectivelyLockedLayerCount,
    maxRelativeDepth,
  };
}

function summarizeMapRootProperties(
  map: JsonObject,
  mapPath: string,
): {
  renderOrder:
    | "right-down"
    | "right-up"
    | "left-down"
    | "left-up";
  backgroundColor?: string;
  className?: string;
  classNameTruncated?: true;
} {
  const rawRenderOrder =
    map.renderorder === undefined
      ? "right-down"
      : map.renderorder;
  if (
    typeof rawRenderOrder !== "string" ||
    !MAP_RENDER_ORDERS.has(rawRenderOrder)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.renderorder is not a supported orthogonal render order.`,
      {
        path: mapPath,
        renderOrder: rawRenderOrder,
      },
    );
  }
  const backgroundColor = map.backgroundcolor;
  if (
    backgroundColor !== undefined &&
    (typeof backgroundColor !== "string" ||
      !TILED_COLOR_PATTERN.test(backgroundColor))
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.backgroundcolor must be #RRGGBB or #AARRGGBB.`,
      { path: mapPath },
    );
  }
  const className = map.class;
  if (
    className !== undefined &&
    typeof className !== "string"
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.class must be a string.`,
      { path: mapPath },
    );
  }
  const boundedClassName =
    className === undefined
      ? undefined
      : boundedMapClassName(className);
  return {
    renderOrder: rawRenderOrder as
      | "right-down"
      | "right-up"
      | "left-down"
      | "left-up",
    ...(backgroundColor === undefined
      ? {}
      : { backgroundColor }),
    ...(boundedClassName === undefined
      ? {}
      : {
          className: boundedClassName.value,
          ...(boundedClassName.truncated
            ? { classNameTruncated: true as const }
            : {}),
        }),
  };
}

function updateCommonMap(
  map: JsonObject,
  patch: Extract<
    MapEditOperation,
    { type: "updateMap" }
  >["patch"],
  context: string,
): {
  requestedFields: MapPatchField[];
  changedFields: MapPatchField[];
} {
  if (!isRecordValue(patch)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  const allowedFields = new Set<string>(MAP_PATCH_FIELDS);
  const unknownKey = keys.find(
    (key) => !allowedFields.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  const requestedFields = MAP_PATCH_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(patch, field),
  );
  for (const field of requestedFields) {
    assertMapPatchValue(
      field,
      (patch as Record<string, unknown>)[field],
      `${context}.${field}`,
    );
  }

  const changedFields: MapPatchField[] = [];
  for (const field of requestedFields) {
    const jsonKey = mapPatchJsonKey(field);
    const value = (patch as Record<string, unknown>)[field];
    if (field === "backgroundColor" && value === null) {
      if (
        Object.prototype.hasOwnProperty.call(map, jsonKey)
      ) {
        delete map[jsonKey];
        changedFields.push(field);
      }
      continue;
    }
    const currentValue = map[jsonKey];
    if (
      !Object.prototype.hasOwnProperty.call(map, jsonKey) ||
      stableJson(currentValue as JsonValue) !==
        stableJson(value as JsonValue)
    ) {
      map[jsonKey] = value as JsonValue;
      changedFields.push(field);
    }
  }
  return { requestedFields, changedFields };
}

function assertMapPatchValue(
  field: MapPatchField,
  value: unknown,
  context: string,
): void {
  if (field === "className") {
    assertMapClassName(value, context);
    return;
  }
  if (field === "backgroundColor") {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !TILED_COLOR_PATTERN.test(value))
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be null, #RRGGBB, or #AARRGGBB.`,
      );
    }
    return;
  }
  if (
    typeof value !== "string" ||
    !MAP_RENDER_ORDERS.has(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} is not a supported orthogonal render order.`,
    );
  }
}

function mapPatchJsonKey(field: MapPatchField): string {
  return MAP_PATCH_JSON_KEYS[field];
}

function assertMapClassName(
  value: unknown,
  context: string,
): void {
  if (
    typeof value !== "string" ||
    !hasAtMostCodePoints(
      value,
      MAX_MAP_CLASS_NAME_CODE_POINTS,
    )
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a string of at most ${MAX_MAP_CLASS_NAME_CODE_POINTS} Unicode code points.`,
    );
  }
}

function boundedMapClassName(value: string): {
  value: string;
  truncated: boolean;
} {
  let displayEnd = 0;
  let codePointCount = 0;
  for (const codePoint of value) {
    codePointCount += 1;
    if (
      codePointCount >
      MAX_MAP_CLASS_NAME_CODE_POINTS
    ) {
      return {
        value: value.slice(0, displayEnd),
        truncated: true,
      };
    }
    displayEnd += codePoint.length;
  }
  return { value, truncated: false };
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

function updateCommonLayer(
  map: JsonObject,
  layerId: number,
  patch: Extract<
    MapEditOperation,
    { type: "updateLayer" }
  >["patch"],
  mapPath: string,
  context: string,
): {
  layer: EditableLayerLocation;
  requestedFields: LayerPatchField[];
  changedFields: LayerPatchField[];
} {
  if (!isRecordValue(patch)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  const allowedFields = new Set<string>(LAYER_PATCH_FIELDS);
  const unknownKey = keys.find(
    (key) => !allowedFields.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  const requestedFields = LAYER_PATCH_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(patch, field),
  );
  for (const field of requestedFields) {
    assertLayerPatchValue(
      field,
      (patch as Record<string, unknown>)[field],
      `${context}.${field}`,
    );
  }

  const layer = findEditableLayer(map, layerId, mapPath);
  const changedFields: LayerPatchField[] = [];
  for (const field of requestedFields) {
    const jsonKey = layerPatchJsonKey(field);
    const value = (patch as Record<string, unknown>)[field];
    if (field === "tintColor" && value === null) {
      if (
        Object.prototype.hasOwnProperty.call(
          layer.object,
          jsonKey,
        )
      ) {
        delete layer.object[jsonKey];
        changedFields.push(field);
      }
      continue;
    }
    const currentValue = layer.object[jsonKey];
    if (
      !Object.prototype.hasOwnProperty.call(
        layer.object,
        jsonKey,
      ) ||
      stableJson(currentValue as JsonValue) !==
        stableJson(value as JsonValue)
    ) {
      layer.object[jsonKey] = value as JsonValue;
      changedFields.push(field);
    }
  }
  return { layer, requestedFields, changedFields };
}

function findEditableLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): EditableLayerLocation {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (located === undefined) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist.`,
      { path: mapPath, layerId },
    );
  }
  const type = expectString(
    located.object.type,
    `layer ${layerId}.type`,
  );
  if (
    type !== "tilelayer" &&
    type !== "objectgroup" &&
    type !== "imagelayer" &&
    type !== "group"
  ) {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Layer ${layerId} does not use a supported Tiled layer type.`,
      { path: mapPath, layerId, layerType: type },
    );
  }
  return {
    object: located.object,
    path: located.path,
    id: expectInteger(
      located.object.id,
      `layer ${layerId}.id`,
    ),
    type,
  };
}

function assertLayerPatchValue(
  field: LayerPatchField,
  value: unknown,
  context: string,
): void {
  if (field === "name" || field === "className") {
    assertBoundedString(value as string, context);
    return;
  }
  if (field === "visible" || field === "locked") {
    if (typeof value !== "boolean") {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be a boolean.`,
      );
    }
    return;
  }
  if (field === "opacity") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be between 0 and 1.`,
      );
    }
    return;
  }
  if (
    field === "offsetX" ||
    field === "offsetY" ||
    field === "parallaxX" ||
    field === "parallaxY"
  ) {
    assertObjectNumber(value, context);
    return;
  }
  if (field === "tintColor") {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !TILED_COLOR_PATTERN.test(value))
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be null, #RRGGBB, or #AARRGGBB.`,
      );
    }
    return;
  }
  if (
    typeof value !== "string" ||
    !LAYER_BLEND_MODES.has(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} is not a supported Tiled blend mode.`,
    );
  }
}

function layerPatchJsonKey(field: LayerPatchField): string {
  return LAYER_PATCH_JSON_KEYS[field];
}

function createBasicObject(
  map: JsonObject,
  layerId: number,
  draft: ObjectDraft,
  mapPath: string,
  context: string,
  index: ObjectEditIndex,
): ObjectLocation {
  if (!isRecordValue(draft)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be an object.`);
  }
  const layer = findObjectLayer(map, layerId, mapPath);
  const nextObjectId = expectInteger(map.nextobjectid, `${mapPath}.nextobjectid`);
  if (nextObjectId <= 0 || nextObjectId >= Number.MAX_SAFE_INTEGER) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.nextobjectid must be a positive incrementable integer.`,
      { path: mapPath, nextObjectId },
    );
  }
  if (nextObjectId <= index.maximumId) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.nextobjectid must be greater than every existing object id.`,
      { path: mapPath, nextObjectId, maximumExistingId: index.maximumId },
    );
  }

  assertObjectDraft(draft, context);
  const hasDimensions =
    draft.shape === "rectangle" ||
    draft.shape === "ellipse" ||
    draft.shape === "capsule" ||
    draft.shape === "text";
  const object: JsonObject = {
    height: hasDimensions ? (draft.height ?? 0) : 0,
    id: nextObjectId,
    name: draft.name ?? "",
    rotation: draft.rotation ?? 0,
    type: draft.className ?? "",
    visible: draft.visible ?? true,
    width: hasDimensions ? (draft.width ?? 0) : 0,
    x: draft.x,
    y: draft.y,
  };
  if (draft.shape === "polygon" || draft.shape === "polyline") {
    object[draft.shape] = draft.points.map((point) => ({
      x: point.x,
      y: point.y,
    }));
  } else if (draft.shape === "text") {
    object.text = serializeTiledTextObjectData(
      textObjectFieldsFromFlatInput(
        draft as unknown as Readonly<
          Record<string, unknown>
        >,
      ),
    );
  } else if (draft.shape !== "rectangle") {
    object[draft.shape] = true;
  }
  if (draft.opacity !== undefined) {
    object.opacity = draft.opacity;
  }
  layer.objects.push(object);
  layer.object.objects = layer.objects;
  map.nextobjectid = nextObjectId + 1;
  const location = {
    object,
    objectIndex: layer.objects.length - 1,
    layer,
    ancestors: layer.ancestors,
  };
  index.byId.set(nextObjectId, location);
  index.maximumId = nextObjectId;
  return location;
}

function updateBasicObject(
  objectId: number,
  patch: Extract<MapEditOperation, { type: "updateObject" }>["patch"],
  mapPath: string,
  context: string,
  index: ObjectEditIndex,
): ObjectLocation {
  if (!isRecordValue(patch)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be an object.`);
  }
  const keys = Object.keys(patch);
  const textObjectFields = new Set<string>(
    TEXT_OBJECT_FIELDS,
  );
  const allowedKeys = new Set([
    "x",
    "y",
    "width",
    "height",
    "name",
    "className",
    "rotation",
    "visible",
    "opacity",
    "points",
    "properties",
    ...TEXT_OBJECT_FIELDS,
  ]);
  if (keys.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  const unknownKey = keys.find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }

  const location = findObjectLocation(index, objectId, mapPath);
  const shape = assertBasicEditableObject(location.object, objectId, mapPath);
  const hasTextPatch = hasTextObjectFields(
    patch as Readonly<Record<string, unknown>>,
  );
  if (hasTextPatch && shape !== "text") {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Text-specific fields can be updated only on text objects.",
      { path: mapPath, objectId, shape },
    );
  }
  const hasPointsPatch =
    Object.prototype.hasOwnProperty.call(
      patch,
      "points",
    );
  if (
    hasPointsPatch &&
    shape !== "polygon" &&
    shape !== "polyline"
  ) {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Points can be updated only on polygon or polyline objects.",
      { path: mapPath, objectId, shape },
    );
  }
  if (
    shape === "point" &&
    (Object.prototype.hasOwnProperty.call(patch, "width") ||
      Object.prototype.hasOwnProperty.call(patch, "height"))
  ) {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Point objects do not have editable width or height.",
      { path: mapPath, objectId },
    );
  }
  if (
    (shape === "polygon" || shape === "polyline") &&
    (Object.prototype.hasOwnProperty.call(patch, "width") ||
      Object.prototype.hasOwnProperty.call(patch, "height"))
  ) {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Polygon and polyline objects do not have editable width or height.",
      { path: mapPath, objectId, shape },
    );
  }
  assertObjectPatch(patch, context);
  if (hasPointsPatch) {
    assertObjectPathPoints(
      patch.points,
      shape as "polygon" | "polyline",
      `${context}.points`,
      "INVALID_ARGUMENT",
    );
  }
  const hasPropertiesPatch =
    patch.properties !== undefined;
  if (hasPropertiesPatch) {
    validatePropertiesPatch(
      patch.properties!,
      `${context}.properties`,
    );
  }

  if (hasTextPatch) {
    location.object.text =
      applyTextObjectFieldsPatch(
        location.object.text,
        patch as Readonly<Record<string, unknown>>,
      );
  }
  if (hasPointsPatch) {
    const points = patch.points as ObjectPathPoint[];
    location.object[
      shape as "polygon" | "polyline"
    ] = points.map((point) => ({
      x: point.x,
      y: point.y,
    }));
  }
  if (hasPropertiesPatch) {
    applyPropertiesPatch(
      location.object,
      patch.properties!,
      `${mapPath} object ${objectId}.properties`,
      { path: mapPath, objectId },
    );
  }
  for (const key of keys) {
    const value = patch[key as keyof typeof patch];
    if (
      key === "points" ||
      key === "properties" ||
      textObjectFields.has(key)
    ) {
      continue;
    } else if (key === "className") {
      location.object.type = value as string;
    } else {
      location.object[key] = value as JsonValue;
    }
  }
  return location;
}

function deleteBasicObjects(
  map: JsonObject,
  objectIds: readonly number[],
  mapPath: string,
  index: ObjectEditIndex,
): ObjectLocation[] {
  const locations = objectIds.map((objectId) => {
    const location = findObjectLocation(index, objectId, mapPath);
    assertBasicEditableObject(location.object, objectId, mapPath);
    return location;
  });
  const byLayer = new Map<
    JsonObject,
    { layer: ObjectLayerView; targets: Set<JsonObject> }
  >();
  for (const location of locations) {
    const existing = byLayer.get(location.layer.object);
    if (existing) {
      existing.targets.add(location.object);
    } else {
      byLayer.set(location.layer.object, {
        layer: location.layer,
        targets: new Set([location.object]),
      });
    }
  }
  for (const { layer, targets } of byLayer.values()) {
    const currentObjects = expectArray(
      layer.object.objects,
      `layer ${layer.id}.objects`,
    );
    const filtered = currentObjects.filter(
      (value) => !isJsonObject(value) || !targets.has(value),
    );
    if (currentObjects.length - filtered.length !== targets.size) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        "An object disappeared from its layer during change-set planning.",
        { path: mapPath, layerId: layer.id },
      );
    }
    layer.object.objects = filtered;
    layer.objects = filtered;
  }
  assertNoDanglingObjectReferences(map, new Set(objectIds), mapPath);
  for (const objectId of objectIds) {
    index.byId.delete(objectId);
  }
  return locations;
}

function assertNoDanglingObjectReferences(
  map: JsonObject,
  deletedIds: ReadonlySet<number>,
  mapPath: string,
  ignoredSubtree?: JsonObject,
): void {
  let visited = 0;

  const scan = (
    value: JsonValue,
    pointer: string,
    depth: number,
    isPropertyEntry: boolean,
  ): void => {
    if (value === ignoredSubtree) {
      return;
    }
    visited += 1;
    if (visited > 1_000_000 || depth > 512) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "Map is too complex to check object references safely.",
        { path: mapPath },
      );
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        scan(item, appendJsonPointer(pointer, index), depth + 1, false);
      }
      return;
    }
    if (!isJsonObject(value)) {
      return;
    }
    if (
      isPropertyEntry &&
      value.type === "object" &&
      typeof value.value === "number" &&
      Number.isSafeInteger(value.value) &&
      deletedIds.has(value.value)
    ) {
      const propertyName = boundedDisplayString(value.name).value;
      throw new TiledMcpError(
        "OBJECT_IN_USE",
        `Object ${value.value} is still referenced by object property ${JSON.stringify(propertyName)}.`,
        {
          path: mapPath,
          objectId: value.value,
          propertyName,
          jsonPointer: pointer,
        },
      );
    }
    if (isPropertyEntry && value.type === "class") {
      const propertyName = boundedDisplayString(value.name).value;
      throw new TiledMcpError(
        "UNSUPPORTED_OBJECT_REFERENCE_ANALYSIS",
        `Cannot safely delete objects while class property ${JSON.stringify(propertyName)} may contain typed object references.`,
        {
          path: mapPath,
          propertyName,
          jsonPointer: pointer,
        },
      );
    }
    if (
      isPropertyEntry &&
      value.type === "list" &&
      Array.isArray(value.value)
    ) {
      const listPointer = appendJsonPointer(pointer, "value");
      for (const [index, item] of value.value.entries()) {
        scan(
          item,
          appendJsonPointer(listPointer, index),
          depth + 1,
          true,
        );
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        isPropertyEntry &&
        value.type === "list" &&
        key === "value" &&
        Array.isArray(item)
      ) {
        continue;
      }
      const childPointer = appendJsonPointer(pointer, key);
      if (key === "properties" && Array.isArray(item)) {
        for (const [index, property] of item.entries()) {
          scan(
            property,
            appendJsonPointer(childPointer, index),
            depth + 1,
            true,
          );
        }
      } else {
        scan(item, childPointer, depth + 1, false);
      }
    }
  };

  scan(map, "", 0, false);
}

function appendJsonPointer(
  pointer: string,
  segment: string | number,
): string {
  const escaped = String(segment)
    .replace(/~/gu, "~0")
    .replace(/\//gu, "~1")
    .slice(0, 128);
  return `${pointer}/${escaped}`.slice(0, 1_024);
}

function assertObjectDraft(draft: ObjectDraft, context: string): void {
  const commonKeys = new Set([
    "shape",
    "x",
    "y",
    "name",
    "className",
    "rotation",
    "visible",
    "opacity",
  ]);
  if (
    draft.shape !== "rectangle" &&
    draft.shape !== "point" &&
    draft.shape !== "ellipse" &&
    draft.shape !== "capsule" &&
    draft.shape !== "polygon" &&
    draft.shape !== "polyline" &&
    draft.shape !== "text"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.shape must be rectangle, point, ellipse, capsule, polygon, polyline or text.`,
    );
  }
  if (draft.shape === "polygon" || draft.shape === "polyline") {
    commonKeys.add("points");
  } else if (draft.shape === "text") {
    commonKeys.add("width");
    commonKeys.add("height");
    for (const field of TEXT_OBJECT_FIELDS) {
      commonKeys.add(field);
    }
  } else if (draft.shape !== "point") {
    commonKeys.add("width");
    commonKeys.add("height");
  }
  const unknownKey = Object.keys(draft).find((key) => !commonKeys.has(key));
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertObjectNumber(draft.x, `${context}.x`);
  assertObjectNumber(draft.y, `${context}.y`);
  if (draft.shape === "polygon" || draft.shape === "polyline") {
    assertObjectPathPoints(
      draft.points,
      draft.shape,
      `${context}.points`,
      "INVALID_ARGUMENT",
    );
  } else if (draft.shape !== "point") {
    const sizedDraft = draft as ObjectDraft & {
      width?: unknown;
      height?: unknown;
    };
    if (
      Object.prototype.hasOwnProperty.call(
        draft,
        "width",
      )
    ) {
      assertObjectSize(sizedDraft.width, `${context}.width`);
    }
    if (
      Object.prototype.hasOwnProperty.call(
        draft,
        "height",
      )
    ) {
      assertObjectSize(sizedDraft.height, `${context}.height`);
    }
  }
  assertOptionalObjectFields(draft, context);
  if (draft.shape === "text") {
    assertTextObjectFlatInput(
      draft as unknown as Readonly<
        Record<string, unknown>
      >,
      context,
      true,
    );
  }
}

function assertObjectPathPoints(
  value: unknown,
  shape: "polygon" | "polyline",
  context: string,
  errorCode: "INVALID_ARGUMENT" | "INVALID_DOCUMENT",
): void {
  const minimum =
    shape === "polygon"
      ? MIN_POLYGON_OBJECT_POINTS
      : MIN_POLYLINE_OBJECT_POINTS;
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > MAX_OBJECT_SHAPE_POINTS
  ) {
    throw new TiledMcpError(
      errorCode,
      `${context} must contain between ${minimum} and ${MAX_OBJECT_SHAPE_POINTS} points for a ${shape}.`,
      {
        shape,
        count: Array.isArray(value) ? value.length : null,
        min: minimum,
        max: MAX_OBJECT_SHAPE_POINTS,
      },
    );
  }
  for (const [pointIndex, point] of value.entries()) {
    if (!isRecordValue(point)) {
      throw new TiledMcpError(
        errorCode,
        `${context}[${pointIndex}] must be an object with exactly x and y.`,
        { shape, pointIndex },
      );
    }
    const keys = Object.keys(point).sort();
    if (keys.length !== 2 || keys[0] !== "x" || keys[1] !== "y") {
      throw new TiledMcpError(
        errorCode,
        `${context}[${pointIndex}] must contain exactly x and y.`,
        { shape, pointIndex },
      );
    }
    assertObjectPathCoordinate(
      point.x,
      `${context}[${pointIndex}].x`,
      errorCode,
    );
    assertObjectPathCoordinate(
      point.y,
      `${context}[${pointIndex}].y`,
      errorCode,
    );
  }
}

function assertObjectPathCoordinate(
  value: unknown,
  context: string,
  errorCode: "INVALID_ARGUMENT" | "INVALID_DOCUMENT",
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      errorCode,
      `${context} must be a finite number between -${MAX_ABSOLUTE_OBJECT_NUMBER} and ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
    );
  }
}

function assertObjectPatch(
  patch: Extract<MapEditOperation, { type: "updateObject" }>["patch"],
  context: string,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "x",
    )
  ) {
    assertObjectNumber(patch.x, `${context}.x`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "y",
    )
  ) {
    assertObjectNumber(patch.y, `${context}.y`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "width",
    )
  ) {
    assertObjectSize(patch.width, `${context}.width`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "height",
    )
  ) {
    assertObjectSize(patch.height, `${context}.height`);
  }
  assertOptionalObjectFields(patch, context);
  if (
    hasTextObjectFields(
      patch as Readonly<Record<string, unknown>>,
    )
  ) {
    assertTextObjectFlatInput(
      patch as Readonly<Record<string, unknown>>,
      context,
      false,
    );
  }
}

function assertOptionalObjectFields(
  value: {
    name?: string;
    className?: string;
    rotation?: number;
    visible?: boolean;
    opacity?: number;
  },
  context: string,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "name",
    )
  ) {
    assertBoundedString(value.name, `${context}.name`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "className",
    )
  ) {
    assertBoundedString(value.className, `${context}.className`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "rotation",
    )
  ) {
    assertObjectNumber(value.rotation, `${context}.rotation`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "visible",
    ) &&
    typeof value.visible !== "boolean"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.visible must be a boolean.`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "opacity",
    ) &&
    (typeof value.opacity !== "number" ||
      !Number.isFinite(value.opacity) ||
      value.opacity < 0 ||
      value.opacity > 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.opacity must be between 0 and 1.`,
    );
  }
}

function assertBoundedString(value: unknown, context: string): void {
  if (typeof value !== "string" || value.length > MAX_OBJECT_STRING_LENGTH) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a string of at most ${MAX_OBJECT_STRING_LENGTH} characters.`,
    );
  }
}

function assertObjectNumber(value: unknown, context: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a finite number between -${MAX_ABSOLUTE_OBJECT_NUMBER} and ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
    );
  }
}

function assertObjectSize(value: unknown, context: string): void {
  assertObjectNumber(value, context);
  if ((value as number) < 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must not be negative.`,
    );
  }
}

function assertTextObjectFlatInput(
  value: Readonly<Record<string, unknown>>,
  context: string,
  requireText: boolean,
): void {
  try {
    if (requireText) {
      textObjectFieldsFromFlatInput(value);
    } else {
      measureTextObjectPayloadBytes(value);
    }
  } catch (error) {
    if (error instanceof TextObjectValidationError) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.${error.field}: ${error.message}`,
        { field: error.field },
      );
    }
    throw error;
  }
}

function assertStoredTextObjectData(
  value: unknown,
  objectId: number,
  mapPath: string,
): EffectiveTextObjectFields {
  try {
    return parseTiledTextObjectData(value);
  } catch (error) {
    if (error instanceof TextObjectValidationError) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object ${objectId}.text is not in the bounded editable text profile: ${error.message}`,
        {
          path: mapPath,
          objectId,
          field: error.field,
        },
      );
    }
    throw error;
  }
}

function assertTextObjectPayloadBudget(
  actual: number,
): void {
  if (
    actual >
    MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET} canonical UTF-8 bytes of text-object fields.`,
      {
        actual,
        limit:
          MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
      },
    );
  }
}

function assertObjectPropertyPatchBudget(
  actual: number,
): void {
  if (
    actual >
    MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET} canonical UTF-8 bytes of object property writes.`,
      {
        actual,
        limit:
          MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
      },
    );
  }
}

function assertObjectShapePointBudget(
  actual: number,
): void {
  if (
    actual >
    MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET} polygon/polyline points across create and update operations.`,
      {
        actual,
        limit:
          MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
      },
    );
  }
}

interface PendingTileObjectFrame {
  entryIndex: number;
  objectId: number;
  assetId: string;
  localId: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
  rawWidth: number;
  rawHeight: number;
}

interface PreparedNativePreviewObjectDebug {
  objects: NativePreviewObjectInput[];
  pendingTileFrames: PendingTileObjectFrame[];
  tileObjectCollision: boolean;
}

function prepareNativePreviewObjectDebug(
  map: JsonObject,
  mapPath: string,
  objectIds: readonly number[] | undefined,
  bindings: readonly TilesetBinding[],
  tileObjectCollision: boolean,
): PreparedNativePreviewObjectDebug | undefined {
  if (objectIds === undefined) {
    if (tileObjectCollision) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "overlays.tileObjectCollision requires overlays.objectIds.",
      );
    }
    return undefined;
  }
  if (
    !Array.isArray(objectIds) ||
    objectIds.length < 1 ||
    objectIds.length > MAX_NATIVE_PREVIEW_OBJECTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `overlays.objectIds must contain between 1 and ${MAX_NATIVE_PREVIEW_OBJECTS} IDs when provided.`,
      {
        count: Array.isArray(objectIds)
          ? objectIds.length
          : null,
        min: 1,
        max: MAX_NATIVE_PREVIEW_OBJECTS,
      },
    );
  }
  const seen = new Set<number>();
  for (const [sourceIndex, objectId] of objectIds.entries()) {
    if (!Number.isSafeInteger(objectId) || objectId <= 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "overlays.objectIds must contain positive safe integers.",
        { sourceIndex, objectId },
      );
    }
    if (seen.has(objectId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `overlays.objectIds contains duplicate object ID ${objectId}.`,
        { sourceIndex, objectId },
      );
    }
    seen.add(objectId);
  }

  const index = buildObjectEditIndex(map, mapPath);
  const selected: NativePreviewObjectInput[] = [];
  const pendingTileFrames: PendingTileObjectFrame[] =
    [];
  let pointCount = 0;
  for (const [sourceIndex, objectId] of objectIds.entries()) {
    const location = findObjectLocation(
      index,
      objectId,
      mapPath,
    );
    if (
      !Object.prototype.hasOwnProperty.call(
        location.object,
        "template",
      ) &&
      Object.prototype.hasOwnProperty.call(
        location.object,
        "gid",
      )
    ) {
      pendingTileFrames.push(
        prepareTileObjectFrameEntry(
          location,
          objectId,
          sourceIndex,
          selected,
          bindings,
          mapPath,
        ),
      );
      continue;
    }
    const shape = assertBasicEditableObject(
      location.object,
      objectId,
      mapPath,
    );
    assertNativePreviewObjectRenderContext(
      location,
      objectId,
      mapPath,
    );
    const common = {
      sourceIndex,
      objectId,
      layerId: location.layer.id,
      x: location.object.x as number,
      y: location.object.y as number,
      rotation: displayNumber(
        location.object.rotation,
        0,
      ),
    };
    if (
      shape === "rectangle" ||
      shape === "ellipse" ||
      shape === "capsule"
    ) {
      selected.push({
        ...common,
        shape,
        representation: "geometry-outline",
        width: displayNumber(
          location.object.width,
          0,
        ),
        height: displayNumber(
          location.object.height,
          0,
        ),
      });
      continue;
    }
    if (shape === "text") {
      selected.push({
        ...common,
        shape,
        representation: "text-box-only",
        width: displayNumber(location.object.width, 0),
        height: displayNumber(location.object.height, 0),
      });
      continue;
    }
    if (shape === "point") {
      selected.push({
        ...common,
        shape,
        representation: "geometry-outline",
      });
      continue;
    }

    const points = expectArray(
      location.object[shape],
      `object ${objectId}.${shape}`,
    ).map((value, pointIndex) => {
      const point = expectObject(
        value,
        `object ${objectId}.${shape}[${pointIndex}]`,
      );
      return {
        x: point.x as number,
        y: point.y as number,
      };
    });
    pointCount += points.length;
    if (
      !Number.isSafeInteger(pointCount) ||
      pointCount > MAX_NATIVE_PREVIEW_OBJECT_POINTS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Native object debug overlay may contain at most ${MAX_NATIVE_PREVIEW_OBJECT_POINTS} polygon/polyline points.`,
        {
          actual: pointCount,
          limit: MAX_NATIVE_PREVIEW_OBJECT_POINTS,
          sourceIndex,
          objectId,
        },
      );
    }
    selected.push({
      ...common,
      shape,
      representation: "geometry-outline",
      points,
    });
  }
  return {
    objects: selected,
    pendingTileFrames,
    tileObjectCollision,
  };
}

const TILESET_OBJECT_ALIGNMENTS = new Set([
  "unspecified",
  "topleft",
  "top",
  "topright",
  "left",
  "center",
  "right",
  "bottomleft",
  "bottom",
  "bottomright",
]);

function prepareTileObjectFrameEntry(
  location: ObjectLocation,
  objectId: number,
  sourceIndex: number,
  selected: NativePreviewObjectInput[],
  bindings: readonly TilesetBinding[],
  mapPath: string,
): PendingTileObjectFrame {
  const object = location.object;
  const gid = object.gid;
  if (
    typeof gid !== "number" ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    gid > 0xffffffff
  ) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Object ${objectId}.gid must be an unsigned 32-bit GID.`,
      { path: mapPath, objectId },
    );
  }
  const tileRef = gidToTileRef(
    gid,
    "orthogonal",
    bindings,
  );
  if (tileRef === null) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.gid must reference a tile; tile objects cannot use the empty GID.`,
      { path: mapPath, objectId },
    );
  }
  const conflictingMarker = [
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ].find((marker) =>
    Object.prototype.hasOwnProperty.call(
      object,
      marker,
    ),
  );
  if (conflictingMarker !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId} combines gid with the ${conflictingMarker} shape marker.`,
      {
        path: mapPath,
        objectId,
        feature: conflictingMarker,
      },
    );
  }
  assertNativePreviewObjectRenderContext(
    location,
    objectId,
    mapPath,
  );
  const rawWidth = readTileObjectDimension(
    object.width,
    objectId,
    "width",
    mapPath,
  );
  const rawHeight = readTileObjectDimension(
    object.height,
    objectId,
    "height",
    mapPath,
  );
  const transform = tileRef.transform as
    | {
        flipH?: boolean;
        flipV?: boolean;
        flipD?: boolean;
      }
    | undefined;
  const pending: PendingTileObjectFrame = {
    entryIndex: selected.length,
    objectId,
    assetId: tileRef.tileset.assetId,
    localId: tileRef.localId,
    flipH: transform?.flipH === true,
    flipV: transform?.flipV === true,
    flipD: transform?.flipD === true,
    rawWidth,
    rawHeight,
  };
  selected.push({
    sourceIndex,
    objectId,
    layerId: location.layer.id,
    x: object.x as number,
    y: object.y as number,
    rotation: displayNumber(object.rotation, 0),
    shape: "tile",
    representation: "tile-frame-only",
    width: 0,
    height: 0,
    boxOffsetX: 0,
    boxOffsetY: 0,
  });
  return pending;
}

function readTileObjectDimension(
  value: JsonValue | undefined,
  objectId: number,
  field: "width" | "height",
  mapPath: string,
): number {
  if (value === undefined) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.${field} must be a finite nonnegative number.`,
      { path: mapPath, objectId, field },
    );
  }
  return value;
}

function readTilesetObjectAlignment(
  document: JsonObject,
  tilesetPath: string,
): string {
  const value = document.objectalignment;
  if (value === undefined) {
    return "unspecified";
  }
  if (
    typeof value !== "string" ||
    !TILESET_OBJECT_ALIGNMENTS.has(value)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.objectalignment is not a supported Tiled alignment.`,
      { path: tilesetPath, value },
    );
  }
  return value;
}

function readTilesetTileOffset(
  document: JsonObject,
  tilesetPath: string,
): { x: number; y: number } {
  const value = document.tileoffset;
  if (value === undefined) {
    return { x: 0, y: 0 };
  }
  if (!isRecordValue(value)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.tileoffset must be an object.`,
      { path: tilesetPath },
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "x,y"
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.tileoffset must contain exactly x and y.`,
      { path: tilesetPath },
    );
  }
  for (const axis of ["x", "y"] as const) {
    const component = record[axis];
    if (
      typeof component !== "number" ||
      !Number.isSafeInteger(component) ||
      Math.abs(component) >
        MAX_ABSOLUTE_OBJECT_NUMBER
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tileoffset.${axis} must be a bounded integer.`,
        { path: tilesetPath, axis },
      );
    }
  }
  return {
    x: record.x as number,
    y: record.y as number,
  };
}

interface TileObjectFrameTileset {
  tileWidth: number;
  tileHeight: number;
  objectAlignment: string;
  tileOffsetX: number;
  tileOffsetY: number;
  collision: ReadonlyMap<
    number,
    readonly TileCollisionSource[]
  >;
}

interface TileCollisionSource {
  kind: NativePreviewCollisionShapeKind;
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
  points?: ObjectPathPoint[];
}

const MAX_TILESET_COLLISION_TILE_SCAN = 100_000;
const COLLISION_GROUP_ALLOWED_KEYS = new Set([
  "class",
  "color",
  "draworder",
  "id",
  "locked",
  "mode",
  "name",
  "objects",
  "offsetx",
  "offsety",
  "opacity",
  "parallaxx",
  "parallaxy",
  "properties",
  "tintcolor",
  "type",
  "visible",
  "x",
  "y",
]);
const COLLISION_OBJECT_ALLOWED_KEYS = new Set([
  "capsule",
  "class",
  "ellipse",
  "height",
  "id",
  "name",
  "opacity",
  "point",
  "polygon",
  "polyline",
  "properties",
  "rotation",
  "text",
  "type",
  "visible",
  "width",
  "x",
  "y",
]);

function readTilesetCollisionSources(
  document: JsonObject,
  tilesetPath: string,
  localIds: ReadonlySet<number>,
): Map<number, readonly TileCollisionSource[]> {
  const fillMode = document.fillmode;
  if (
    fillMode !== undefined &&
    fillMode !== "stretch"
  ) {
    throw new TiledMcpError(
      "UNSUPPORTED_RENDER_FEATURE",
      `${tilesetPath} uses a non-default fillmode, whose collision scaling is not supported.`,
      { path: tilesetPath, feature: "fillmode" },
    );
  }
  const collision = new Map<
    number,
    readonly TileCollisionSource[]
  >();
  if (document.tiles === undefined) {
    return collision;
  }
  const tiles = expectArray(
    document.tiles,
    `${tilesetPath}.tiles`,
  );
  if (tiles.length > MAX_TILESET_COLLISION_TILE_SCAN) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${tilesetPath}.tiles exceeds the ${MAX_TILESET_COLLISION_TILE_SCAN}-entry collision scan limit.`,
      {
        limit: MAX_TILESET_COLLISION_TILE_SCAN,
        actual: tiles.length,
      },
    );
  }
  for (const [tileIndex, value] of tiles.entries()) {
    const tile = expectObject(
      value,
      `${tilesetPath}.tiles[${tileIndex}]`,
    );
    const localId = expectInteger(
      tile.id,
      `${tilesetPath}.tiles[${tileIndex}].id`,
    );
    if (
      !localIds.has(localId) ||
      tile.objectgroup === undefined
    ) {
      continue;
    }
    collision.set(
      localId,
      readTileCollisionObjects(
        tile.objectgroup,
        `${tilesetPath}.tiles[${tileIndex}].objectgroup`,
        tilesetPath,
      ),
    );
  }
  return collision;
}

function readTileCollisionObjects(
  value: JsonValue,
  context: string,
  tilesetPath: string,
): readonly TileCollisionSource[] {
  const group = expectObject(value, context);
  if (group.type !== "objectgroup") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.type must be "objectgroup".`,
      { path: tilesetPath },
    );
  }
  const unknownGroupKey = Object.keys(group).find(
    (key) => !COLLISION_GROUP_ALLOWED_KEYS.has(key),
  );
  if (unknownGroupKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains unsupported member ${unknownGroupKey}.`,
      { path: tilesetPath, member: unknownGroupKey },
    );
  }
  const objects = expectArray(
    group.objects,
    `${context}.objects`,
  );
  if (
    objects.length >
    MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${context}.objects exceeds the ${MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES}-shape collision limit.`,
      {
        limit:
          MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
        actual: objects.length,
      },
    );
  }
  return objects.map((objectValue, objectIndex) =>
    readTileCollisionObject(
      objectValue,
      `${context}.objects[${objectIndex}]`,
      tilesetPath,
    ),
  );
}

function readTileCollisionObject(
  value: JsonValue,
  context: string,
  tilesetPath: string,
): TileCollisionSource {
  const object = expectObject(value, context);
  for (const feature of [
    "gid",
    "template",
  ] as const) {
    if (
      Object.prototype.hasOwnProperty.call(
        object,
        feature,
      )
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_OBJECT_PROFILE",
        `${context} uses ${feature}, which is outside supported tile collision shapes.`,
        { path: tilesetPath, feature },
      );
    }
  }
  const unknownKey = Object.keys(object).find(
    (key) => !COLLISION_OBJECT_ALLOWED_KEYS.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains unsupported member ${unknownKey}.`,
      { path: tilesetPath, member: unknownKey },
    );
  }
  const markers = [
    "polygon",
    "polyline",
    "ellipse",
    "capsule",
    "point",
    "text",
  ].filter((marker) =>
    Object.prototype.hasOwnProperty.call(
      object,
      marker,
    ),
  );
  if (markers.length > 1) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains conflicting shape markers.`,
      { path: tilesetPath },
    );
  }
  const marker = markers[0];
  const readCoordinate = (
    field: "x" | "y" | "rotation",
  ): number => {
    const raw = object[field];
    if (raw === undefined) {
      return 0;
    }
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      Math.abs(raw) > MAX_ABSOLUTE_OBJECT_NUMBER
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${field} must be a bounded finite number.`,
        { path: tilesetPath, field },
      );
    }
    return raw;
  };
  const readExtent = (
    field: "width" | "height",
  ): number => {
    const raw = object[field];
    if (raw === undefined) {
      return 0;
    }
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      raw > MAX_ABSOLUTE_OBJECT_NUMBER
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${field} must be a bounded nonnegative number.`,
        { path: tilesetPath, field },
      );
    }
    return raw;
  };
  const common = {
    x: readCoordinate("x"),
    y: readCoordinate("y"),
    rotation: readCoordinate("rotation"),
    width: readExtent("width"),
    height: readExtent("height"),
  };
  if (
    marker === "polygon" ||
    marker === "polyline"
  ) {
    assertObjectPathPoints(
      object[marker],
      marker,
      `${context}.${marker}`,
      "INVALID_DOCUMENT",
    );
    return {
      kind: marker,
      ...common,
      points: (
        object[marker] as unknown as ObjectPathPoint[]
      ).map((point) => ({
        x: point.x,
        y: point.y,
      })),
    };
  }
  if (
    marker === "ellipse" ||
    marker === "capsule" ||
    marker === "point"
  ) {
    if (object[marker] !== true) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${marker} must be true when present.`,
        { path: tilesetPath, feature: marker },
      );
    }
    return { kind: marker, ...common };
  }
  if (marker === "text") {
    // Tiled's collision shape path draws a text object as its plain bounds
    // rectangle.
    expectObject(object.text, `${context}.text`);
    return { kind: "rectangle", ...common };
  }
  return { kind: "rectangle", ...common };
}

function buildTileCollisionShapeInputs(
  pending: PendingTileObjectFrame,
  frame: TileObjectFrameTileset,
  effective: {
    width: number;
    height: number;
    alignmentOffsetX: number;
    alignmentOffsetY: number;
  },
): NativePreviewCollisionShapeInput[] {
  const sources =
    frame.collision.get(pending.localId) ?? [];
  const scaleX = effective.width / frame.tileWidth;
  const scaleY =
    effective.height / frame.tileHeight;
  let rotated = false;
  let flipH = pending.flipH;
  let flipV = pending.flipV;
  let fragmentX =
    effective.width / 2 +
    frame.tileOffsetX * scaleX;
  let fragmentY =
    effective.height / 2 +
    frame.tileOffsetY * scaleY;
  if (pending.flipD) {
    rotated = true;
    const wasFlippedH = pending.flipH;
    flipH = pending.flipV;
    flipV = !wasFlippedH;
    const halfDiff =
      effective.height / 2 - effective.width / 2;
    fragmentX += halfDiff;
    fragmentY += halfDiff;
  }
  const signedScaleX = (flipH ? -1 : 1) * scaleX;
  const signedScaleY = (flipV ? -1 : 1) * scaleY;
  const linearA = rotated ? 0 : signedScaleX;
  const linearB = rotated ? signedScaleX : 0;
  const linearC = rotated ? -signedScaleY : 0;
  const linearD = rotated ? 0 : signedScaleY;
  return sources.map((source) => {
    const radians =
      (((source.rotation % 360) + 360) % 360) *
      (Math.PI / 180);
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const localX = source.x - frame.tileWidth / 2;
    const localY = source.y - frame.tileHeight / 2;
    const transform = [
      linearA * cosine + linearC * sine,
      linearB * cosine + linearD * sine,
      linearA * -sine + linearC * cosine,
      linearB * -sine + linearD * cosine,
      fragmentX -
        effective.alignmentOffsetX +
        linearA * localX +
        linearC * localY,
      fragmentY -
        effective.alignmentOffsetY +
        linearB * localX +
        linearD * localY,
    ] as const;
    for (const value of transform) {
      if (
        !Number.isFinite(value) ||
        Math.abs(value) >
          MAX_ABSOLUTE_OBJECT_NUMBER
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `Object ${pending.objectId} collision transform is outside the supported numeric range.`,
          { objectId: pending.objectId },
        );
      }
    }
    if (
      source.kind === "polygon" ||
      source.kind === "polyline"
    ) {
      return {
        kind: source.kind,
        transform,
        points: (source.points ?? []).map(
          (point) => ({ x: point.x, y: point.y }),
        ),
      };
    }
    if (source.kind === "point") {
      return { kind: source.kind, transform };
    }
    return {
      kind: source.kind,
      transform,
      width: source.width,
      height: source.height,
    };
  });
}

/**
 * Tiled resolves "unspecified" to bottom-left on orthogonal maps; the offset
 * is subtracted from the object anchor to reach the frame's top-left corner.
 */
function tileObjectAlignmentOffset(
  alignment: string,
  width: number,
  height: number,
): { x: number; y: number } {
  switch (alignment) {
    case "topleft":
      return { x: 0, y: 0 };
    case "top":
      return { x: width / 2, y: 0 };
    case "topright":
      return { x: width, y: 0 };
    case "left":
      return { x: 0, y: height / 2 };
    case "center":
      return { x: width / 2, y: height / 2 };
    case "right":
      return { x: width, y: height / 2 };
    case "bottom":
      return { x: width / 2, y: height };
    case "bottomright":
      return { x: width, y: height };
    default:
      return { x: 0, y: height };
  }
}

function assertNativePreviewObjectRenderContext(
  location: ObjectLocation,
  objectId: number,
  mapPath: string,
): void {
  for (const [ancestorIndex, ancestor] of
    location.ancestors.entries()) {
    assertNativePreviewObjectLayerPosition({
      layer: ancestor,
      context: `${mapPath} ancestor group ${ancestorIndex}`,
      objectId,
      layerId: location.layer.id,
      role: "group",
    });
  }
  assertNativePreviewObjectLayerPosition({
    layer: location.layer.object,
    context: `${mapPath} object layer ${location.layer.id}`,
    objectId,
    layerId: location.layer.id,
    role: "object-layer",
  });
}

function assertNativePreviewObjectLayerPosition(input: {
  layer: JsonObject;
  context: string;
  objectId: number;
  layerId: number;
  role: "group" | "object-layer";
}): void {
  for (const field of ["x", "y"] as const) {
    const value = input.layer[field] ?? 0;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${input.context}.${field} must be a safe integer.`,
        {
          path: input.context,
          objectId: input.objectId,
          layerId: input.layerId,
          field,
          value,
        },
      );
    }
    if (value !== 0) {
      throw unsupportedNativePreviewObjectPosition(
        input,
        input.role === "group"
          ? `group-${field}`
          : `object-layer-${field}`,
        field,
        value,
      );
    }
  }
  for (const [field, fallback] of [
    ["offsetx", 0],
    ["offsety", 0],
    ["parallaxx", 1],
    ["parallaxy", 1],
  ] as const) {
    const value = input.layer[field] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${input.context}.${field} must be a finite number.`,
        {
          path: input.context,
          objectId: input.objectId,
          layerId: input.layerId,
          field,
          value,
        },
      );
    }
    if (value !== fallback) {
      throw unsupportedNativePreviewObjectPosition(
        input,
        field,
        field,
        value,
      );
    }
  }
}

function unsupportedNativePreviewObjectPosition(
  input: {
    context: string;
    objectId: number;
    layerId: number;
    role: "group" | "object-layer";
  },
  feature: string,
  field: string,
  value: number,
): TiledMcpError {
  return new TiledMcpError(
    "UNSUPPORTED_RENDER_FEATURE",
    `Native object debug overlay does not support non-default ${input.role} ${field}.`,
    {
      path: input.context,
      objectId: input.objectId,
      layerId: input.layerId,
      feature,
      value,
    },
  );
}

function assertBasicEditableObject(
  object: JsonObject,
  objectId: number,
  mapPath: string,
): BasicEditableObjectShape {
  const unsupportedKeys = [
    "template",
    "gid",
  ];
  const unsupported = unsupportedKeys.find((key) =>
    Object.prototype.hasOwnProperty.call(object, key),
  );
  if (unsupported !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `Object ${objectId} uses ${unsupported}, which is outside bounded object editing.`,
      { path: mapPath, objectId, feature: unsupported },
    );
  }
  const shapeMarkers = [
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ] as const;
  const presentShapeMarkers =
    shapeMarkers.filter((marker) =>
      Object.prototype.hasOwnProperty.call(
        object,
        marker,
      ),
    );
  for (const marker of presentShapeMarkers) {
    if (marker === "text") {
      assertStoredTextObjectData(
        object.text,
        objectId,
        mapPath,
      );
    } else if (marker === "polygon" || marker === "polyline") {
      assertObjectPathPoints(
        object[marker],
        marker,
        `object ${objectId}.${marker}`,
        "INVALID_DOCUMENT",
      );
    } else if (object[marker] !== true) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object ${objectId}.${marker} must be true when present.`,
        { path: mapPath, objectId, feature: marker },
      );
    }
  }
  if (presentShapeMarkers.length > 1) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId} contains conflicting shape markers.`,
      {
        path: mapPath,
        objectId,
        shapeMarkers: presentShapeMarkers,
      },
    );
  }
  const shape =
    presentShapeMarkers[0] ?? "rectangle";
  assertStoredObjectNumber(
    object.x,
    `object ${objectId}.x`,
    mapPath,
    objectId,
  );
  assertStoredObjectNumber(
    object.y,
    `object ${objectId}.y`,
    mapPath,
    objectId,
  );
  if (shape === "polygon" || shape === "polyline") {
    for (const field of ["width", "height"] as const) {
      if (
        Object.prototype.hasOwnProperty.call(
          object,
          field,
        )
      ) {
        assertStoredPathDimension(
          object[field],
          `object ${objectId}.${field}`,
          mapPath,
          objectId,
        );
      }
    }
  } else {
    const dimensionsMayBeOmitted =
      shape === "ellipse" ||
      shape === "capsule" ||
      shape === "text";
    if (
      !dimensionsMayBeOmitted ||
      Object.prototype.hasOwnProperty.call(
        object,
        "width",
      )
    ) {
      assertStoredObjectSize(
        object.width,
        `object ${objectId}.width`,
        mapPath,
        objectId,
      );
    }
    if (
      !dimensionsMayBeOmitted ||
      Object.prototype.hasOwnProperty.call(
        object,
        "height",
      )
    ) {
      assertStoredObjectSize(
        object.height,
        `object ${objectId}.height`,
        mapPath,
        objectId,
      );
    }
  }
  if (object.rotation !== undefined) {
    assertStoredObjectNumber(
      object.rotation,
      `object ${objectId}.rotation`,
      mapPath,
      objectId,
    );
  }
  if (object.name !== undefined && typeof object.name !== "string") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.name must be a string.`,
      { path: mapPath, objectId },
    );
  }
  if (object.type !== undefined && typeof object.type !== "string") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.type must be a string.`,
      { path: mapPath, objectId },
    );
  }
  if (object.visible !== undefined && typeof object.visible !== "boolean") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.visible must be a boolean.`,
      { path: mapPath, objectId },
    );
  }
  if (
    object.opacity !== undefined &&
    (typeof object.opacity !== "number" ||
      !Number.isFinite(object.opacity) ||
      object.opacity < 0 ||
      object.opacity > 1)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.opacity must be between 0 and 1.`,
      { path: mapPath, objectId },
    );
  }
  return shape;
}

function assertStoredObjectNumber(
  value: unknown,
  context: string,
  mapPath: string,
  objectId: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite number between -${MAX_ABSOLUTE_OBJECT_NUMBER} and ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
      { path: mapPath, objectId },
    );
  }
}

function assertStoredObjectSize(
  value: unknown,
  context: string,
  mapPath: string,
  objectId: number,
): asserts value is number {
  assertStoredObjectNumber(
    value,
    context,
    mapPath,
    objectId,
  );
  if (value < 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must not be negative.`,
      { path: mapPath, objectId },
    );
  }
}

function assertStoredPathDimension(
  value: unknown,
  context: string,
  mapPath: string,
  objectId: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite nonnegative number no greater than ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
      { path: mapPath, objectId },
    );
  }
}

function summarizeObjectLocation(
  location: ObjectLocation,
): Record<string, unknown> {
  const objectId = expectInteger(
    location.object.id,
    `object layer ${location.layer.id} object id`,
  );
  const name = boundedDisplayString(location.object.name);
  const className = boundedDisplayString(location.object.type);
  const layerName = boundedDisplayString(location.layer.name);
  return {
    id: objectId,
    layerId: location.layer.id,
    layerName: layerName.value,
    ...(layerName.truncated ? { layerNameTruncated: true } : {}),
    name: name.value,
    ...(name.truncated ? { nameTruncated: true } : {}),
    className: className.value,
    ...(className.truncated ? { classNameTruncated: true } : {}),
    shape: objectShape(location.object),
    x: displayNumber(location.object.x, 0),
    y: displayNumber(location.object.y, 0),
    width: displayNumber(location.object.width, 0),
    height: displayNumber(location.object.height, 0),
    rotation: displayNumber(location.object.rotation, 0),
    visible: location.object.visible !== false,
    opacity:
      typeof location.object.opacity === "number" &&
      Number.isFinite(location.object.opacity)
        ? location.object.opacity
        : 1,
  };
}

function describeEditableObject(
  location: ObjectLocation,
  shape: BasicEditableObjectShape,
  mapPath: string,
): Record<string, unknown> {
  const objectId = expectInteger(
    location.object.id,
    `${mapPath} object id`,
  );
  const name = boundedDisplayString(location.object.name);
  const className = boundedDisplayString(location.object.type);
  const layerName = boundedDisplayString(location.layer.name);
  const properties = projectScalarProperties(
    location.object,
    `${mapPath} object ${objectId}.properties`,
    { path: mapPath, objectId },
  );
  const common = {
    id: objectId,
    layerId: location.layer.id,
    layerName: layerName.value,
    ...(layerName.truncated
      ? { layerNameTruncated: true }
      : {}),
    name: name.value,
    ...(name.truncated ? { nameTruncated: true } : {}),
    className: className.value,
    ...(className.truncated
      ? { classNameTruncated: true }
      : {}),
    shape,
    x: location.object.x as number,
    y: location.object.y as number,
    rotation: displayNumber(location.object.rotation, 0),
    visible: location.object.visible !== false,
    opacity:
      typeof location.object.opacity === "number"
        ? location.object.opacity
        : 1,
    properties: properties.entries,
    propertyCount: properties.total,
    ...(properties.truncated
      ? { propertiesTruncated: true }
      : {}),
  };

  if (
    shape === "rectangle" ||
    shape === "ellipse" ||
    shape === "capsule"
  ) {
    return {
      ...common,
      width: displayNumber(location.object.width, 0),
      height: displayNumber(location.object.height, 0),
    };
  }
  if (shape === "polygon" || shape === "polyline") {
    return {
      ...common,
      points: expectArray(
        location.object[shape],
        `object ${objectId}.${shape}`,
      ).map((value, pointIndex) => {
        const point = expectObject(
          value,
          `object ${objectId}.${shape}[${pointIndex}]`,
        );
        return {
          x: point.x as number,
          y: point.y as number,
        };
      }),
    };
  }
  if (shape === "text") {
    const text = assertStoredTextObjectData(
      location.object.text,
      objectId,
      mapPath,
    );
    return {
      ...common,
      width: displayNumber(location.object.width, 0),
      height: displayNumber(location.object.height, 0),
      ...text,
    };
  }
  return common;
}

function boundedDisplayString(value: JsonValue | undefined): {
  value: string;
  truncated: boolean;
} {
  if (typeof value !== "string") {
    return { value: "", truncated: false };
  }
  let displayEnd = 0;
  let codePointCount = 0;
  for (const codePoint of value) {
    codePointCount += 1;
    if (codePointCount > MAX_OBJECT_DISPLAY_STRING_LENGTH) {
      return {
        value: value.slice(0, displayEnd),
        truncated: true,
      };
    }
    displayEnd += codePoint.length;
  }
  return { value, truncated: false };
}

function displayNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function objectShape(object: JsonObject): string {
  if (typeof object.template === "string") {
    return "template";
  }
  if (typeof object.gid === "number") {
    return "tile";
  }
  for (const shape of [
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(object, shape)) {
      return shape;
    }
  }
  return "rectangle";
}

function sourcePatchPathsForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonSourcePath[] {
  const paths: JsonSourcePath[] = [];
  for (const layerId of summary.affectedTileLayerIds) {
    paths.push([...findTileLayer(map, layerId, mapPath).path, "data"]);
  }
  for (const layerId of summary.affectedObjectLayerIds) {
    paths.push([...findObjectLayer(map, layerId, mapPath).path, "objects"]);
  }
  if (summary.createdObjectIds.length > 0) {
    paths.push(["nextobjectid"]);
  }
  if ((summary.addedTilesets?.length ?? 0) > 0) {
    paths.push(["tilesets"]);
  }
  if ((summary.createdLayers?.length ?? 0) > 0) {
    paths.push(["nextlayerid"]);
  }
  const duplicatedLayers = summary.duplicatedLayers ?? [];
  if (duplicatedLayers.length > 0) {
    paths.push(["nextlayerid"]);
    if (
      duplicatedLayers.some(
        (duplicated) =>
          duplicated.copiedObjectCount > 0,
      )
    ) {
      paths.push(["nextobjectid"]);
    }
  }
  for (const resize of summary.mapResizes ?? []) {
    const widthChanged =
      resize.newWidth !== resize.oldWidth;
    const heightChanged =
      resize.newHeight !== resize.oldHeight;
    if (widthChanged) {
      paths.push(["width"]);
    }
    if (heightChanged) {
      paths.push(["height"]);
    }
    if (!widthChanged && !heightChanged) {
      continue;
    }
    for (const layerId of resize.resizedTileLayerIds) {
      const layerPath = findTileLayer(
        map,
        layerId,
        mapPath,
      ).path;
      if (widthChanged) {
        paths.push([...layerPath, "width"]);
      }
      if (heightChanged) {
        paths.push([...layerPath, "height"]);
      }
    }
  }
  return paths;
}

function sourceArrayInsertionsForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonArrayInsertion[] {
  const createdLayers = summary.createdLayers ?? [];
  const duplicatedLayers =
    summary.duplicatedLayers ?? [];
  if (
    createdLayers.length + duplicatedLayers.length >
    1
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A layer insertion change set may insert only one root element.",
    );
  }
  return [
    ...createdLayers.map((created) => ({
      path: layerContainerForParent(
        map,
        created.parentGroupId,
        mapPath,
      ).path,
      index: created.index,
    })),
    ...duplicatedLayers.map((duplicated) => ({
      path: layerContainerForParent(
        map,
        duplicated.targetParentGroupId,
        mapPath,
      ).path,
      index: duplicated.targetIndex,
    })),
  ];
}

function sourceArrayDeletionsForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonArrayDeletion[] {
  const deletedLayers = summary.deletedLayers ?? [];
  const removedTilesets =
    summary.removedTilesets ?? [];
  if (
    deletedLayers.length +
      removedTilesets.length >
    1
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A change set may delete only one selected array element.",
    );
  }
  return [
    ...deletedLayers.map((deleted) => ({
      path: layerContainerForParent(
        map,
        deleted.parentGroupId,
        mapPath,
      ).path,
      index: deleted.index,
    })),
    ...removedTilesets.map((removed) => ({
      path: ["tilesets"],
      index: removed.index,
    })),
  ];
}

function sourceArrayMovesForSummary(
  sourceMap: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonArrayMove[] {
  const movedLayers = summary.movedLayers ?? [];
  if (movedLayers.length > 1) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A layer-move change set may move only one selected layer subtree.",
    );
  }
  return movedLayers
    .filter((move) => move.wouldChange)
    .map((move) => ({
      sourcePath: layerContainerForParent(
        sourceMap,
        move.sourceParentGroupId,
        mapPath,
      ).path,
      sourceIndex: move.sourceIndex,
      targetPath: layerContainerForParent(
        sourceMap,
        move.targetParentGroupId,
        mapPath,
      ).path,
      targetIndex: move.targetIndex,
    }));
}

function sourceObjectMemberPatchesForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonObjectMemberPatch[] {
  const patches: JsonObjectMemberPatch[] = [];
  const seen = new Set<string>();
  for (const update of summary.mapUpdates ?? []) {
    for (const field of update.changedFields) {
      if (!isMapPatchField(field)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          `Map update summary contains unsupported field ${field}.`,
          {
            path: mapPath,
            field,
          },
        );
      }
      const patch = {
        path: [] as JsonSourcePath,
        key: mapPatchJsonKey(field),
      };
      const identity = JSON.stringify([
        ...patch.path,
        patch.key,
      ]);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      patches.push(patch);
    }
  }
  for (const update of summary.layerUpdates ?? []) {
    if (update.changedFields.length === 0) {
      continue;
    }
    const layer = findEditableLayer(
      map,
      update.layerId,
      mapPath,
    );
    for (const field of update.changedFields) {
      if (!isLayerPatchField(field)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          `Layer update summary contains unsupported field ${field}.`,
          {
            path: mapPath,
            layerId: update.layerId,
            field,
          },
        );
      }
      const patch = {
        path: layer.path,
        key: layerPatchJsonKey(field),
      };
      const identity = JSON.stringify([
        ...patch.path,
        patch.key,
      ]);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      patches.push(patch);
    }
  }
  for (const resize of summary.mapResizes ?? []) {
    for (const layerId of resize.shiftedImageLayerIds) {
      const layer = findEditableLayer(
        map,
        layerId,
        mapPath,
      );
      for (const [key, delta] of [
        ["offsetx", resize.pixelOffsetX],
        ["offsety", resize.pixelOffsetY],
      ] as const) {
        if (delta === 0) {
          continue;
        }
        const patch = {
          path: layer.path,
          key,
        };
        const identity = JSON.stringify([
          ...patch.path,
          patch.key,
        ]);
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
        patches.push(patch);
      }
    }
  }
  return patches;
}

function isMapPatchField(
  value: string,
): value is MapPatchField {
  return (MAP_PATCH_FIELDS as readonly string[]).includes(
    value,
  );
}

function isLayerPatchField(
  value: string,
): value is LayerPatchField {
  return (LAYER_PATCH_FIELDS as readonly string[]).includes(
    value,
  );
}

function findLayerRecursive(
  layers: JsonValue[],
  layerId: number,
  context: string,
  path: JsonSourcePath,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
  ancestors: readonly JsonObject[] = [],
): {
  object: JsonObject;
  path: JsonSourcePath;
  ancestors: readonly JsonObject[];
} | undefined {
  assertLayerTraversalBudget(layers.length, depth, budget);
  for (const [index, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${index}]`);
    if (layer.id === layerId) {
      return {
        object: layer,
        path: [...path, index],
        ancestors,
      };
    }
    if (layer.type === "group" && Array.isArray(layer.layers)) {
      const nested = findLayerRecursive(
        layer.layers,
        layerId,
        `${context}[${index}].layers`,
        [...path, index, "layers"],
        depth + 1,
        budget,
        [...ancestors, layer],
      );
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function readLayerGid(layer: TileLayerView, x: number, y: number): number {
  const index = (y - layer.y) * layer.width + (x - layer.x);
  const value = layer.data[index];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TiledMcpError("INVALID_TILE_DATA", `Layer ${layer.id} has a non-integer GID.`, {
      layerId: layer.id,
      x,
      y,
    });
  }
  return value;
}

function writeLayerGid(layer: TileLayerView, x: number, y: number, gid: number): void {
  const index = (y - layer.y) * layer.width + (x - layer.x);
  layer.data[index] = gid;
  layer.object.data = layer.data;
}

function readReplaceTilesRegion(
  value: unknown,
  operationIndex: number,
): { x: number; y: number; width: number; height: number } {
  if (!isRecordValue(value)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations[${operationIndex}].region must be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["height", "width", "x", "y"];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key, index) => key !== expectedKeys[index],
    )
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations[${operationIndex}].region must contain exactly x, y, width and height.`,
    );
  }
  const context = `operations[${operationIndex}].region`;
  const { x, y, width, height } = record;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} coordinates and dimensions must be numbers.`,
    );
  }
  assertSafeInteger(x, `${context}.x`);
  assertSafeInteger(y, `${context}.y`);
  assertPositiveInteger(width, `${context}.width`);
  assertPositiveInteger(height, `${context}.height`);
  if (
    !Number.isSafeInteger(x + width) ||
    !Number.isSafeInteger(y + height)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} endpoints must be safe integers.`,
    );
  }
  return {
    x,
    y,
    width,
    height,
  };
}

function readStampPattern(
  value: unknown,
  operationIndex: number,
): Array<Array<TileRef | null>> {
  const context = `operations[${operationIndex}].pattern`;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a non-empty two-dimensional array.`,
    );
  }
  if (value.length > MAX_STAMP_PATTERN_EDGE) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A stamp pattern may have at most ${MAX_STAMP_PATTERN_EDGE} rows.`,
      {
        limit: MAX_STAMP_PATTERN_EDGE,
        actual: value.length,
      },
    );
  }
  const firstRow = value[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}[0] must be a non-empty row.`,
    );
  }
  const width = firstRow.length;
  if (width > MAX_STAMP_PATTERN_EDGE) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A stamp pattern row may have at most ${MAX_STAMP_PATTERN_EDGE} cells.`,
      {
        limit: MAX_STAMP_PATTERN_EDGE,
        actual: width,
      },
    );
  }
  for (const [rowIndex, row] of value.entries()) {
    if (!Array.isArray(row) || row.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}[${rowIndex}] must be a non-empty row.`,
      );
    }
    if (row.length !== width) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be rectangular; row ${rowIndex} has ${row.length} cells instead of ${width}.`,
      );
    }
  }
  const cellCount = value.length * width;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount > MAX_STAMP_PATTERN_CELLS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A stamp pattern may contain at most ${MAX_STAMP_PATTERN_CELLS} cells.`,
      {
        limit: MAX_STAMP_PATTERN_CELLS,
        actual: cellCount,
      },
    );
  }
  return value as Array<Array<TileRef | null>>;
}

function assertRegionInsideLayer(
  layer: TileLayerView,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const regionEndX = x + width;
  const regionEndY = y + height;
  if (
    !Number.isSafeInteger(regionEndX) ||
    !Number.isSafeInteger(regionEndY)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Region endpoints must be safe integers.",
      {
        region: { x, y, width, height },
      },
    );
  }
  const layerEndX = layer.x + layer.width;
  const layerEndY = layer.y + layer.height;
  if (
    !Number.isSafeInteger(layerEndX) ||
    !Number.isSafeInteger(layerEndY)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Tile layer ${layer.id} bounds exceed the safe integer range.`,
      {
        layerId: layer.id,
        layerBounds: {
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
        },
      },
    );
  }
  if (
    x < layer.x ||
    y < layer.y ||
    regionEndX > layerEndX ||
    regionEndY > layerEndY
  ) {
    throw new TiledMcpError(
      "REGION_OUT_OF_BOUNDS",
      `Region is outside tile layer ${layer.id}.`,
      {
        layerId: layer.id,
        region: { x, y, width, height },
        layerBounds: {
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
        },
      },
    );
  }
}

function collectLayerSummaries(
  layers: JsonValue[],
  context: string,
  infinite = false,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
): Array<Record<string, unknown>> {
  assertLayerTraversalBudget(layers.length, depth, budget);
  return layers.map((value, index) => {
    const layer = expectObject(value, `${context}[${index}]`);
    const displayName = boundedDisplayString(layer.name);
    const layerType = expectString(
      layer.type,
      `${context}[${index}].type`,
    );
    if (
      layerType !== "tilelayer" &&
      layerType !== "objectgroup" &&
      layerType !== "imagelayer" &&
      layerType !== "group"
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}[${index}].type is not a supported Tiled layer type.`,
        {
          layerType,
        },
      );
    }
    const summary: Record<string, unknown> = {
      id: expectInteger(layer.id, `${context}[${index}].id`),
      name: displayName.value,
      ...(displayName.truncated ? { nameTruncated: true } : {}),
      type: layerType,
      visible: layer.visible !== false,
      opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
    };
    if (layerType === "tilelayer") {
      const chunked =
        infinite && "chunks" in layer;
      const width = expectInteger(
        layer.width,
        `${context}[${index}].width`,
      );
      const height = expectInteger(
        layer.height,
        `${context}[${index}].height`,
      );
      // Chunked bounds may legitimately be 0 × 0 for an empty layer.
      if (
        (chunked && (width < 0 || height < 0)) ||
        (!chunked && (width <= 0 || height <= 0))
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}[${index}] tile layer dimensions must be positive integers.`,
          {
            width,
            height,
          },
        );
      }
      summary.width = width;
      summary.height = height;
      if (chunked) {
        summary.startX = expectInteger(
          layer.startx ?? 0,
          `${context}[${index}].startx`,
        );
        summary.startY = expectInteger(
          layer.starty ?? 0,
          `${context}[${index}].starty`,
        );
        summary.chunked = true;
      }
      summary.x = expectInteger(
        layer.x ?? 0,
        `${context}[${index}].x`,
      );
      summary.y = expectInteger(
        layer.y ?? 0,
        `${context}[${index}].y`,
      );
    }
    if (layerType === "group") {
      summary.layers = collectLayerSummaries(
        expectArray(
          layer.layers,
          `${context}[${index}].layers`,
        ),
        `${context}[${index}].layers`,
        infinite,
        depth + 1,
        budget,
      );
    }
    return summary;
  });
}

function planId(value: Omit<MapEditPlan, "id">): string {
  const canonical = stableJson(value as unknown as JsonValue);
  return `changeset:${createHash("sha256").update(canonical).digest("hex")}`;
}

function assertPlanShape(plan: MapEditPlan): void {
  if (
    !isRecordValue(plan) ||
    plan.kind !== "mapEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.mapPath !== "string" ||
    typeof plan.baseRevision !== "string" ||
    !isRecordValue(plan.dependencyRevisions) ||
    !Array.isArray(plan.operations) ||
    !isRecordValue(plan.summary)
  ) {
    throw new TiledMcpError("INVALID_CHANGE_SET", "The supplied change set is malformed.");
  }
  try {
    assertDependencyRevisionRecord(plan.dependencyRevisions);
    if (plan.prospectiveDependencyRevisions !== undefined) {
      assertDependencyRevisionRecord(plan.prospectiveDependencyRevisions);
    }
  } catch {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The change set contains malformed dependency revisions.",
    );
  }
}

function assertDependencyRevisions(
  expected: Record<string, string>,
  actual: Record<string, string>,
): void {
  assertDependencyRevisionRecord(expected);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some(
      (key, index) => key !== actualKeys[index] || expected[key] !== actual[key],
    )
  ) {
    throw new TiledMcpError(
      "DEPENDENCY_REVISION_CONFLICT",
      "A referenced tileset changed after this change set was planned.",
      {
        expectedCount: expectedKeys.length,
        actualCount: actualKeys.length,
        differences: dependencyDifferenceSample(expected, actual),
      },
    );
  }
}

function assertRootAtlasTileDefinitions(
  document: JsonObject,
  path: string,
  tileCount: number,
): void {
  if (document.tiles === undefined) {
    return;
  }
  const entries = expectArray(
    document.tiles,
    `${path}.tiles`,
  );
  const seenLocalIds = new Set<number>();
  for (const [index, value] of entries.entries()) {
    const tile = expectObject(
      value,
      `${path}.tiles[${index}]`,
    );
    const localId = expectInteger(
      tile.id,
      `${path}.tiles[${index}].id`,
    );
    if (localId < 0 || localId >= tileCount) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.tiles[${index}].id is outside the tileset local ID range.`,
        {
          path,
          sourceIndex: index,
          localId,
          tileCount,
        },
      );
    }
    if (seenLocalIds.has(localId)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path} contains duplicate tile metadata for local ID ${localId}.`,
        { path, localId },
      );
    }
    seenLocalIds.add(localId);
    assertAtlasTileDefinition(
      tile,
      path,
      localId,
    );
  }
}

function assertSelectedLocalIds(
  localIds: readonly number[],
  tileCount: number,
  path: string,
): void {
  if (
    !Array.isArray(localIds) ||
    localIds.length < 1 ||
    localIds.length > MAX_TILE_RENDER_LOCAL_IDS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `localIds must contain between 1 and ${MAX_TILE_RENDER_LOCAL_IDS} entries.`,
      {
        actual: Array.isArray(localIds)
          ? localIds.length
          : null,
        limit: MAX_TILE_RENDER_LOCAL_IDS,
      },
    );
  }
  const seen = new Set<number>();
  for (const [index, localId] of localIds.entries()) {
    if (!Number.isSafeInteger(localId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `localIds[${index}] must be a safe integer.`,
        { index, localId },
      );
    }
    if (localId < 0 || localId >= tileCount) {
      throw new TiledMcpError(
        "TILE_ID_OUT_OF_RANGE",
        `Tile ${localId} is outside ${path}.`,
        {
          path,
          index,
          localId,
          tileCount,
        },
      );
    }
    if (seen.has(localId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `localIds contains duplicate tile ID ${localId}.`,
        { index, localId },
      );
    }
    seen.add(localId);
  }
}

function assertOptionalRevision(
  revision: string | undefined,
  context: string,
): void {
  if (revision !== undefined && !REVISION_PATTERN.test(revision)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a SHA-256 revision returned by TiledMCP.`,
      { context },
    );
  }
}

function assertRequiredRevision(
  revision: string,
  context: string,
): void {
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a SHA-256 revision returned by TiledMCP.`,
      { context },
    );
  }
}

async function assertRevisionUnchanged(
  store: DocumentStore,
  path: string,
  expectedRevision: string,
  errorCode: "REVISION_CONFLICT" | "DEPENDENCY_REVISION_CONFLICT",
  details: Record<string, unknown> = {},
): Promise<void> {
  const actualRevision = await store.readRevision(path);
  if (actualRevision !== expectedRevision) {
    throw new TiledMcpError(
      errorCode,
      `${path} changed while the add-tileset change set was being prepared.`,
      {
        path,
        ...details,
        expectedRevision,
        actualRevision,
      },
    );
  }
}

function assertDependencyRevisionRecord(
  revisions: Record<string, string>,
): void {
  if (!isRecordValue(revisions)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "expectedDependencyRevisions must be an object.",
    );
  }
  const entries = Object.entries(revisions);
  if (entries.length > MAX_TILESET_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `At most ${MAX_TILESET_COUNT} dependency revisions may be supplied.`,
      { limit: MAX_TILESET_COUNT, actual: entries.length },
    );
  }
  for (const [index, [assetId, revision]] of entries.entries()) {
    if (
      assetId.length === 0 ||
      assetId.length > 128 ||
      typeof revision !== "string" ||
      !REVISION_PATTERN.test(revision)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Dependency revision entry ${index} is malformed.`,
        { index, assetIdLength: assetId.length },
      );
    }
  }
}

function dependencyDifferenceSample(
  expected: Record<string, string>,
  actual: Record<string, string>,
): Array<{
  assetId: string;
  expectedRevision: string | null;
  actualRevision: string | null;
}> {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences: Array<{
    assetId: string;
    expectedRevision: string | null;
    actualRevision: string | null;
  }> = [];
  for (const assetId of [...keys].sort()) {
    if (expected[assetId] === actual[assetId]) {
      continue;
    }
    differences.push({
      assetId,
      expectedRevision: expected[assetId] ?? null,
      actualRevision: actual[assetId] ?? null,
    });
    if (differences.length === 32) {
      break;
    }
  }
  return differences;
}

interface UsageTileCounter {
  assetId: string;
  localId: number;
  bindingIndex: number;
  cellReferences: number;
  objectReferences: number;
  transformedReferences: number;
}

interface UsageTilesetCounter {
  binding: TilesetBinding;
  bindingIndex: number;
  tiles: Map<number, UsageTileCounter>;
  cellReferences: number;
  objectReferences: number;
  transformedReferences: number;
}

function analyzeUsageDocument(input: {
  map: JsonObject;
  mapPath: string;
  bindings: readonly TilesetBinding[];
  topTileLimit: number;
  infinite: boolean;
}): Record<string, unknown> {
  const counters = input.bindings.map(
    (binding, bindingIndex): UsageTilesetCounter => ({
      binding,
      bindingIndex,
      tiles: new Map<number, UsageTileCounter>(),
      cellReferences: 0,
      objectReferences: 0,
      transformedReferences: 0,
    }),
  );
  const counterByAssetId = new Map(
    counters.map((counter) => [
      counter.binding.assetId,
      counter,
    ]),
  );
  let uniqueTileCount = 0;
  let nonEmptyCellCount = 0;
  let tileObjectCount = 0;
  let identityReferenceCount = 0;
  let transformedReferenceCount = 0;
  let tileCellCount = 0;
  let objectCount = 0;
  let tileLayerCount = 0;
  let objectLayerCount = 0;
  let imageLayerCount = 0;
  let groupLayerCount = 0;
  const rawFlagCounts = new Map<number, number>();
  const layerDensities: Array<{
    layerId: number;
    name: string;
    nameTruncated: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    cellCount: number;
    nonEmptyCellCount: number;
  }> = [];

  const recordGid = (
    value: unknown,
    source: "cell" | "object",
    context: string,
  ): boolean => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 0xffffffff
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `${context} must be an unsigned 32-bit GID.`,
        { context },
      );
    }
    const tile = gidToTileRef(
      value,
      "orthogonal",
      input.bindings,
    );
    if (tile === null) {
      return false;
    }
    const counter = counterByAssetId.get(
      tile.tileset.assetId,
    );
    if (counter === undefined) {
      throw new TiledMcpError(
        "GID_OUT_OF_RANGE",
        `${context} resolved to an unknown tileset binding.`,
        { context, tilesetAssetId: tile.tileset.assetId },
      );
    }
    let usage = counter.tiles.get(tile.localId);
    if (usage === undefined) {
      uniqueTileCount += 1;
      if (uniqueTileCount > MAX_USAGE_DISTINCT_TILES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Usage analysis may aggregate at most ${MAX_USAGE_DISTINCT_TILES} distinct tiles.`,
          {
            path: input.mapPath,
            limit: MAX_USAGE_DISTINCT_TILES,
            actual: uniqueTileCount,
          },
        );
      }
      usage = {
        assetId: tile.tileset.assetId,
        localId: tile.localId,
        bindingIndex: counter.bindingIndex,
        cellReferences: 0,
        objectReferences: 0,
        transformedReferences: 0,
      };
      counter.tiles.set(tile.localId, usage);
    }
    if (source === "cell") {
      usage.cellReferences += 1;
      counter.cellReferences += 1;
    } else {
      usage.objectReferences += 1;
      counter.objectReferences += 1;
    }
    const rawFlags = tile.transform?.rawFlags ?? 0;
    rawFlagCounts.set(
      rawFlags,
      (rawFlagCounts.get(rawFlags) ?? 0) + 1,
    );
    const transformed = rawFlags !== 0;
    if (transformed) {
      usage.transformedReferences += 1;
      counter.transformedReferences += 1;
      transformedReferenceCount += 1;
    } else {
      identityReferenceCount += 1;
    }
    return true;
  };

  const scan = { entries: 0 };
  const traversalBudget: LayerTraversalBudget = { count: 0 };
  const visitLayers = (
    layers: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    assertLayerTraversalBudget(
      layers.length,
      depth,
      traversalBudget,
    );
    for (const [layerIndex, layerValue] of layers.entries()) {
      const layerContext = `${context}[${layerIndex}]`;
      const layer = expectObject(layerValue, layerContext);
      const layerId = expectInteger(
        layer.id,
        `${layerContext}.id`,
      );
      const layerType = expectString(
        layer.type,
        `${layerContext}.type`,
      );
      if (layerType === "group") {
        groupLayerCount += 1;
        visitLayers(
          expectArray(
            layer.layers,
            `${layerContext}.layers`,
          ),
          `${layerContext}.layers`,
          depth + 1,
        );
        continue;
      }
      if (layerType === "imagelayer") {
        imageLayerCount += 1;
        continue;
      }
      if (layerType === "objectgroup") {
        objectLayerCount += 1;
        const objects = expectArray(
          layer.objects,
          `${layerContext}.objects`,
        );
        consumeUsageScanBudget(
          objects.length,
          scan,
          input.mapPath,
        );
        objectCount += objects.length;
        for (const [objectIndex, objectValue] of objects.entries()) {
          const object = expectObject(
            objectValue,
            `${layerContext}.objects[${objectIndex}]`,
          );
          if (object.gid === undefined) {
            continue;
          }
          if (
            recordGid(
              object.gid,
              "object",
              `${layerContext}.objects[${objectIndex}].gid`,
            )
          ) {
            tileObjectCount += 1;
          }
        }
        continue;
      }
      if (layerType !== "tilelayer") {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${layerContext}.type is not a supported Tiled layer type.`,
          { path: input.mapPath, layerId, layerType },
        );
      }

      tileLayerCount += 1;
      if (input.infinite && "chunks" in layer) {
        const structure =
          readChunkedTileLayerStructure(
            layer,
            layerId,
            input.mapPath,
          );
        consumeUsageScanBudget(
          structure.totalChunkCells,
          scan,
          input.mapPath,
        );
        tileCellCount +=
          structure.totalChunkCells;
        let layerNonEmptyCellCount = 0;
        for (const [
          chunkIndex,
          chunk,
        ] of structure.chunks.entries()) {
          const cells = decodeChunkCells(
            chunk,
            layer,
            layerId,
            input.mapPath,
          );
          for (const [
            gidIndex,
            gid,
          ] of cells.entries()) {
            if (
              recordGid(
                gid,
                "cell",
                `${layerContext}.chunks[${chunkIndex}].data[${gidIndex}]`,
              )
            ) {
              nonEmptyCellCount += 1;
              layerNonEmptyCellCount += 1;
            }
          }
        }
        const name = boundedDisplayString(
          layer.name,
        );
        layerDensities.push({
          layerId,
          name: name.value,
          nameTruncated: name.truncated,
          x: structure.startX,
          y: structure.startY,
          width: structure.width,
          height: structure.height,
          cellCount: structure.totalChunkCells,
          nonEmptyCellCount:
            layerNonEmptyCellCount,
        });
        continue;
      }
      const width = expectInteger(
        layer.width,
        `${layerContext}.width`,
      );
      const height = expectInteger(
        layer.height,
        `${layerContext}.height`,
      );
      assertPositiveInteger(width, `${layerContext}.width`);
      assertPositiveInteger(height, `${layerContext}.height`);
      const x = readOptionalInteger(
        layer.x,
        `${layerContext}.x`,
        0,
      );
      const y = readOptionalInteger(
        layer.y,
        `${layerContext}.y`,
        0,
      );
      const cellCount = width * height;
      if (!Number.isSafeInteger(cellCount)) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} dimensions overflow the cell count.`,
          { layerId },
        );
      }
      const data = resolveTileLayerCells(
        layer,
        layerId,
        input.mapPath,
        cellCount,
        "read",
        "Usage analysis supports only finite JSON tile layers with numeric data arrays.",
      );
      if (data.length !== cellCount) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} data length does not match width × height.`,
          {
            layerId,
            expected: cellCount,
            actual: data.length,
          },
        );
      }
      consumeUsageScanBudget(
        data.length,
        scan,
        input.mapPath,
      );
      tileCellCount += data.length;
      let layerNonEmptyCellCount = 0;
      for (const [gidIndex, gid] of data.entries()) {
        if (
          recordGid(
            gid,
            "cell",
            `${layerContext}.data[${gidIndex}]`,
          )
        ) {
          nonEmptyCellCount += 1;
          layerNonEmptyCellCount += 1;
        }
      }
      const name = boundedDisplayString(layer.name);
      layerDensities.push({
        layerId,
        name: name.value,
        nameTruncated: name.truncated,
        x,
        y,
        width,
        height,
        cellCount,
        nonEmptyCellCount: layerNonEmptyCellCount,
      });
    }
  };

  visitLayers(
    expectArray(input.map.layers, `${input.mapPath}.layers`),
    `${input.mapPath}.layers`,
    0,
  );

  const allTileCounters = counters.flatMap((counter) =>
    [...counter.tiles.values()],
  );
  allTileCounters.sort(compareUsageTileCounters);
  const topTileItems = allTileCounters
    .slice(0, input.topTileLimit)
    .map(usageTileCounterResult);

  const usedCounters = counters.filter(
    (counter) =>
      counter.cellReferences + counter.objectReferences > 0,
  );
  const unusedCounters = counters.filter(
    (counter) =>
      counter.cellReferences + counter.objectReferences === 0,
  );
  const sortedTilesetCounters = [...counters].sort(
    (left, right) => {
      const leftUsed =
        left.cellReferences + left.objectReferences > 0;
      const rightUsed =
        right.cellReferences + right.objectReferences > 0;
      return (
        Number(leftUsed) - Number(rightUsed) ||
        left.binding.firstGid - right.binding.firstGid
      );
    },
  );
  const tilesetItems = sortedTilesetCounters
    .slice(0, MAX_USAGE_TILESET_SUMMARIES)
    .map((counter) =>
      usageTilesetCounterResult(
        counter,
        MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
      ),
    );
  layerDensities.sort(
    (left, right) =>
      left.nonEmptyCellCount * right.cellCount -
        right.nonEmptyCellCount * left.cellCount ||
      left.layerId - right.layerId,
  );
  const layerDensityItems = layerDensities
    .slice(0, MAX_USAGE_LAYER_SUMMARIES)
    .map((layer) => ({
      layerId: layer.layerId,
      name: layer.name,
      ...(layer.nameTruncated
        ? { nameTruncated: true }
        : {}),
      bounds: {
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
      },
      cellCount: layer.cellCount,
      emptyCellCount:
        layer.cellCount - layer.nonEmptyCellCount,
      nonEmptyCellCount: layer.nonEmptyCellCount,
      density:
        layer.nonEmptyCellCount / layer.cellCount,
    }));
  const rawFlagUsage = [...rawFlagCounts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rawFlags, referenceCount]) => ({
      rawFlags,
      referenceCount,
    }));

  return {
    scope: {
      tileLayers: "all-recursive",
      tileObjects: "all-recursive",
      visibility: "ignored",
      tileIdentity: "external-asset-id-plus-local-id",
      transformAggregation: "base-tile",
      unusedLocalIdDomain:
        "atlas-local-ids-zero-to-tilecount-exclusive",
    },
    scan: {
      tileCellCount,
      objectCount,
      valueCount: scan.entries,
      limit: MAX_USAGE_SCAN_VALUES,
    },
    totals: {
      tileLayerCount,
      objectLayerCount,
      imageLayerCount,
      groupLayerCount,
      emptyTileCellCount:
        tileCellCount - nonEmptyCellCount,
      nonEmptyTileCellCount: nonEmptyCellCount,
      tileObjectCount,
      referenceCount:
        nonEmptyCellCount + tileObjectCount,
      distinctUsedTileCount: uniqueTileCount,
      usedTilesetCount: usedCounters.length,
      unusedTilesetCount: unusedCounters.length,
    },
    transforms: {
      identityReferenceCount,
      transformedReferenceCount,
      rawFlagUsage,
    },
    layerDensity: {
      total: layerDensities.length,
      returned: layerDensityItems.length,
      omitted:
        layerDensities.length - layerDensityItems.length,
      truncated:
        layerDensities.length > layerDensityItems.length,
      order: "density-asc-then-layer-id",
      items: layerDensityItems,
    },
    tilesets: {
      total: counters.length,
      returned: tilesetItems.length,
      omitted: counters.length - tilesetItems.length,
      truncated: counters.length > tilesetItems.length,
      order: "unused-first-then-firstgid",
      items: tilesetItems,
    },
    topTiles: {
      limit: input.topTileLimit,
      returned: topTileItems.length,
      distinctUsedTileCount: uniqueTileCount,
      truncated:
        uniqueTileCount > topTileItems.length,
      order:
        "reference-count-desc-then-firstgid-localid",
      items: topTileItems,
    },
  };
}

function consumeUsageScanBudget(
  count: number,
  budget: { entries: number },
  mapPath: string,
): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    budget.entries + count > MAX_USAGE_SCAN_VALUES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Usage analysis may scan at most ${MAX_USAGE_SCAN_VALUES} tile cells and objects.`,
      {
        path: mapPath,
        limit: MAX_USAGE_SCAN_VALUES,
        scanned: budget.entries,
        nextCount: count,
      },
    );
  }
  budget.entries += count;
}

function compareUsageTileCounters(
  left: UsageTileCounter,
  right: UsageTileCounter,
): number {
  const leftTotal =
    left.cellReferences + left.objectReferences;
  const rightTotal =
    right.cellReferences + right.objectReferences;
  return (
    rightTotal - leftTotal ||
    left.bindingIndex - right.bindingIndex ||
    left.localId - right.localId
  );
}

function usageTileCounterResult(
  usage: UsageTileCounter,
): Record<string, unknown> {
  return {
    tile: {
      tileset: {
        kind: "external",
        assetId: usage.assetId,
      },
      localId: usage.localId,
    },
    references: {
      total:
        usage.cellReferences + usage.objectReferences,
      tileCells: usage.cellReferences,
      tileObjects: usage.objectReferences,
      transformed: usage.transformedReferences,
    },
  };
}

function usageTilesetCounterResult(
  counter: UsageTilesetCounter,
  unusedLocalIdLimit: number,
): Record<string, unknown> {
  const totalReferences =
    counter.cellReferences + counter.objectReferences;
  const unusedLocalIdSample: number[] = [];
  for (
    let localId = 0;
    localId < counter.binding.tileCount &&
    unusedLocalIdSample.length < unusedLocalIdLimit;
    localId += 1
  ) {
    if (!counter.tiles.has(localId)) {
      unusedLocalIdSample.push(localId);
    }
  }
  const unusedLocalIdCount =
    counter.binding.tileCount - counter.tiles.size;
  return {
    assetId: counter.binding.assetId,
    name: counter.binding.name,
    ...(counter.binding.nameTruncated
      ? { nameTruncated: true }
      : {}),
    firstGid: counter.binding.firstGid,
    tileCount: counter.binding.tileCount,
    gidSpan: counter.binding.gidSpan,
    unused: totalReferences === 0,
    referenceCount: totalReferences,
    tileCellReferenceCount: counter.cellReferences,
    tileObjectReferenceCount: counter.objectReferences,
    transformedReferenceCount:
      counter.transformedReferences,
    usedLocalIdCount: counter.tiles.size,
    unusedLocalIds: {
      count: unusedLocalIdCount,
      sample: unusedLocalIdSample,
      truncated:
        unusedLocalIdCount > unusedLocalIdSample.length,
    },
  };
}

function readUsageLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  context: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > maximum
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an integer between 1 and ${maximum}.`,
      { context, maximum },
    );
  }
  return selected;
}

function assertUsageAnalysisResultSize(
  result: Record<string, unknown>,
): void {
  const byteLength = Buffer.byteLength(
    JSON.stringify(result),
    "utf8",
  );
  if (byteLength > MAX_USAGE_RESULT_BYTES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Usage analysis results may contain at most ${MAX_USAGE_RESULT_BYTES} serialized bytes.`,
      {
        limit: MAX_USAGE_RESULT_BYTES,
        actual: byteLength,
      },
    );
  }
}

function validateLayers(
  layers: JsonValue[],
  diagnostics: Diagnostic[],
  seenIds: Set<number>,
  seenObjectIds: Set<number>,
  pointer: string,
  mapWidth: number,
  mapHeight: number,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
  objectBudget: { count: number } = { count: 0 },
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) {
    return;
  }
  if (depth > MAX_LAYER_DEPTH || budget.count + layers.length > MAX_LAYER_COUNT) {
    diagnostics.push(
      errorDiagnostic(
        "LAYER_LIMIT_EXCEEDED",
        `Layer tree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
        pointer,
      ),
    );
    return;
  }
  budget.count += layers.length;
  for (const [index, value] of layers.entries()) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    const layerPointer = `${pointer}/${index}`;
    if (!isJsonObject(value)) {
      diagnostics.push(errorDiagnostic("LAYER_INVALID", "Layer must be an object.", layerPointer));
      continue;
    }
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id <= 0
    ) {
      diagnostics.push(
        errorDiagnostic(
          "LAYER_ID_INVALID",
          "Layer id must be a positive integer.",
          `${layerPointer}/id`,
        ),
      );
    } else if (seenIds.has(value.id)) {
      diagnostics.push(
        errorDiagnostic("LAYER_ID_DUPLICATE", `Duplicate layer id ${value.id}.`, `${layerPointer}/id`),
      );
    } else {
      seenIds.add(value.id);
    }
    if (value.type === "group") {
      if (!Array.isArray(value.layers)) {
        diagnostics.push(
          errorDiagnostic(
            "GROUP_LAYERS_INVALID",
            "Group layer layers must be an array.",
            `${layerPointer}/layers`,
          ),
        );
        continue;
      }
      validateLayers(
        value.layers,
        diagnostics,
        seenIds,
        seenObjectIds,
        `${layerPointer}/layers`,
        mapWidth,
        mapHeight,
        depth + 1,
        budget,
        objectBudget,
      );
      continue;
    }
    if (value.type === "objectgroup") {
      if (!Array.isArray(value.objects)) {
        diagnostics.push(
          errorDiagnostic(
            "OBJECTS_INVALID",
            "Object layer objects must be an array.",
            `${layerPointer}/objects`,
          ),
        );
      } else if (objectBudget.count + value.objects.length > MAX_OBJECT_COUNT) {
        diagnostics.push(
          errorDiagnostic(
            "OBJECT_LIMIT_EXCEEDED",
            `Map contains more than ${MAX_OBJECT_COUNT} objects.`,
            `${layerPointer}/objects`,
          ),
        );
      } else {
        objectBudget.count += value.objects.length;
        for (const [objectIndex, objectValue] of value.objects.entries()) {
          if (diagnostics.length >= MAX_DIAGNOSTICS) {
            return;
          }
          const objectPointer = `${layerPointer}/objects/${objectIndex}`;
          if (!isJsonObject(objectValue)) {
            diagnostics.push(
              errorDiagnostic(
                "OBJECT_INVALID",
                "Object layer entries must be objects.",
                objectPointer,
              ),
            );
            continue;
          }
          if (
            typeof objectValue.id !== "number" ||
            !Number.isSafeInteger(objectValue.id) ||
            objectValue.id <= 0
          ) {
            diagnostics.push(
              errorDiagnostic(
                "OBJECT_ID_INVALID",
                "Object id must be a positive integer.",
                `${objectPointer}/id`,
              ),
            );
          } else if (seenObjectIds.has(objectValue.id)) {
            diagnostics.push(
              errorDiagnostic(
                "OBJECT_ID_DUPLICATE",
                `Duplicate object id ${objectValue.id}.`,
                `${objectPointer}/id`,
              ),
            );
          } else {
            seenObjectIds.add(objectValue.id);
          }
          if (objectValue.gid !== undefined) {
            const gidPointer = `${objectPointer}/gid`;
            const gid = objectValue.gid;
            if (
              typeof gid !== "number" ||
              !Number.isSafeInteger(gid) ||
              gid < 0 ||
              gid > 0xffffffff
            ) {
              diagnostics.push(
                errorDiagnostic(
                  "GID_INVALID",
                  "Every GID must be an unsigned 32-bit integer.",
                  gidPointer,
                ),
              );
              continue;
            }
            try {
              decodeGid(gid, "orthogonal");
            } catch (error) {
              diagnostics.push(
                fromCaughtDiagnostic(
                  error,
                  gidPointer,
                ),
              );
            }
          }
        }
      }
      continue;
    }
    if (value.type === "imagelayer") {
      continue;
    }
    if (value.type !== "tilelayer") {
      diagnostics.push(
        errorDiagnostic(
          "LAYER_TYPE_INVALID",
          "Layer type must be tilelayer, objectgroup, imagelayer or group.",
          `${layerPointer}/type`,
        ),
      );
      continue;
    }
    if ("chunks" in value || typeof value.data === "string") {
      diagnostics.push(
        errorDiagnostic(
          "TILE_ENCODING_UNSUPPORTED",
          "MVP editing requires a finite numeric JSON data array.",
          layerPointer,
        ),
      );
      continue;
    }
    if (!Array.isArray(value.data)) {
      diagnostics.push(
        errorDiagnostic("TILE_DATA_INVALID", "Tile layer data must be an array.", `${layerPointer}/data`),
      );
      continue;
    }
    const width = value.width;
    const height = value.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      value.data.length !== width * height
    ) {
      diagnostics.push(
        errorDiagnostic(
          "TILE_DATA_LENGTH_INVALID",
          "Tile layer data length must equal width × height.",
          `${layerPointer}/data`,
        ),
      );
    }
    for (const [gidIndex, gid] of value.data.entries()) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return;
      }
      if (
        typeof gid !== "number" ||
        !Number.isSafeInteger(gid) ||
        gid < 0 ||
        gid > 0xffffffff
      ) {
        diagnostics.push(
          errorDiagnostic(
            "GID_INVALID",
            "Every GID must be an unsigned 32-bit integer.",
            `${layerPointer}/data/${gidIndex}`,
          ),
        );
        break;
      }
      try {
        decodeGid(gid, "orthogonal");
      } catch (error) {
        diagnostics.push(fromCaughtDiagnostic(error, `${layerPointer}/data/${gidIndex}`));
        break;
      }
    }
  }
}

function validateReferencedGids(
  layers: JsonValue[],
  bindings: readonly TilesetBinding[],
  diagnostics: Diagnostic[],
  pointer: string,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
  objectBudget: { count: number } = {
    count: 0,
  },
): void {
  if (
    diagnostics.length >= MAX_DIAGNOSTICS ||
    depth > MAX_LAYER_DEPTH ||
    budget.count + layers.length > MAX_LAYER_COUNT
  ) {
    return;
  }
  budget.count += layers.length;
  for (const [index, value] of layers.entries()) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    if (!isJsonObject(value)) {
      continue;
    }
    const layerPointer = `${pointer}/${index}`;
    if (value.type === "group" && Array.isArray(value.layers)) {
      validateReferencedGids(
        value.layers,
        bindings,
        diagnostics,
        `${layerPointer}/layers`,
        depth + 1,
        budget,
        objectBudget,
      );
      continue;
    }
    if (
      value.type === "objectgroup" &&
      Array.isArray(value.objects)
    ) {
      if (
        objectBudget.count +
          value.objects.length >
        MAX_OBJECT_COUNT
      ) {
        return;
      }
      objectBudget.count += value.objects.length;
      for (const [
        objectIndex,
        objectValue,
      ] of value.objects.entries()) {
        if (
          diagnostics.length >=
          MAX_DIAGNOSTICS
        ) {
          return;
        }
        if (
          !isJsonObject(objectValue) ||
          objectValue.gid === undefined
        ) {
          continue;
        }
        const gid = objectValue.gid;
        if (
          typeof gid !== "number" ||
          !Number.isSafeInteger(gid) ||
          gid < 0 ||
          gid > 0xffffffff
        ) {
          continue;
        }
        const gidPointer =
          `${layerPointer}/objects/${objectIndex}/gid`;
        let baseGid: number;
        try {
          baseGid = decodeGid(
            gid,
            "orthogonal",
          ).baseGid;
        } catch {
          // The structural pass already reports invalid GID flags.
          continue;
        }
        if (baseGid === 0) {
          continue;
        }
        try {
          gidToTileRef(
            gid,
            "orthogonal",
            bindings,
          );
        } catch (error) {
          diagnostics.push(
            fromCaughtDiagnostic(
              error,
              gidPointer,
            ),
          );
        }
      }
      continue;
    }
    if (value.type !== "tilelayer" || !Array.isArray(value.data)) {
      continue;
    }
    for (const [gidIndex, gid] of value.data.entries()) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return;
      }
      if (typeof gid !== "number" || !Number.isSafeInteger(gid) || gid === 0) {
        continue;
      }
      try {
        gidToTileRef(gid, "orthogonal", bindings);
      } catch (error) {
        diagnostics.push(fromCaughtDiagnostic(error, `${layerPointer}/data/${gidIndex}`));
      }
    }
  }
}

function errorDiagnostic(code: string, message: string, jsonPointer: string): Diagnostic {
  return { code, severity: "error", message, jsonPointer };
}

function fromCaughtDiagnostic(error: unknown, jsonPointer: string): Diagnostic {
  const normalized = asTiledMcpError(error);
  return {
    code: normalized.code,
    severity: "error",
    message:
      normalized.message.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
        ? normalized.message
        : `${normalized.message.slice(
            0,
            MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1,
          )}…`,
    jsonPointer,
  };
}

function validatePositiveIntegerField(
  object: JsonObject,
  key: string,
  diagnostics: Diagnostic[],
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    diagnostics.push(
      errorDiagnostic(
        "POSITIVE_INTEGER_REQUIRED",
        `${key} must be a positive integer.`,
        `/${key}`,
      ),
    );
    return 0;
  }
  return value;
}

function readOptionalInteger(value: JsonValue | undefined, context: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return expectInteger(value, context);
}

function unsupportedRenderFeature(
  feature: string,
  message: string,
  details: Record<string, unknown>,
): TiledMcpError {
  return new TiledMcpError(
    "UNSUPPORTED_RENDER_FEATURE",
    message,
    { feature, ...details },
  );
}

function assertPositiveInteger(value: number, context: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be a positive integer.`);
  }
}

function assertPositiveIntegerAtMost(
  value: number,
  context: string,
  limit: number,
): void {
  assertPositiveInteger(value, context);
  if (value > limit) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be at most ${limit}.`,
      {
        option: context,
        limit,
        actual: value,
      },
    );
  }
}

function assertSafeInteger(value: number, context: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be an integer.`);
  }
}

function assertLayerTraversalBudget(
  nextCount: number,
  depth: number,
  budget: LayerTraversalBudget,
): void {
  if (depth > MAX_LAYER_DEPTH || budget.count + nextCount > MAX_LAYER_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Layer tree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
      { maxDepth: MAX_LAYER_DEPTH, maxLayers: MAX_LAYER_COUNT },
    );
  }
  budget.count += nextCount;
}

function maximumSetValue(values: ReadonlySet<number>): number {
  let maximum = 0;
  for (const value of values) {
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function assertNoTemplateReferences(document: JsonValue, projectPath: string): void {
  const stack: JsonValue[] = [document];
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === undefined || value === null || typeof value !== "object") {
      continue;
    }
    visited += 1;
    if (visited > 1_000_000) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "Document is too complex to validate for safe rendering.",
        { path: projectPath },
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push(item);
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(value, "template")) {
      throw new TiledMcpError(
        "UNSAFE_RENDER_REFERENCE",
        "Object templates are not supported by the sandboxed MVP renderer.",
        { path: projectPath },
      );
    }
    for (const item of Object.values(value)) {
      stack.push(item);
    }
  }
}

function isRecordValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
