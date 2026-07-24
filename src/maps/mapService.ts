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
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import {
  patchJsonDocumentSource,
  type JsonArrayDeletion,
  type JsonArrayInsertion,
  type JsonArrayMove,
  type JsonObjectMemberPatch,
  type JsonSourcePath,
} from "../formats/jsonSourcePatch.js";
import { readImageFileSnapshot } from "../images/imageFile.js";
import {
  DEFAULT_TILESET_SHEET_PAGE_SIZE,
  DEFAULT_TILESET_SHEET_SCALE,
  MAX_TILESET_IMAGE_BYTES,
  MAX_TILESET_INPUT_EDGE,
  MAX_TILESET_INPUT_PIXELS,
  renderTilesetSheet,
} from "../images/tilesetSheet.js";
import {
  MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
  MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
  DEFAULT_NATIVE_PREVIEW_SCALE,
  renderNativePreview,
  type NativePreviewAtlas,
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
import type { CommitResult, DocumentStore, LoadedDocument } from "../storage/documentStore.js";
import { shortHash } from "../storage/revision.js";
import { decodeGid, encodeGid, type MapOrientation } from "./gid.js";
import {
  buildPreviewScene,
  type PreviewRegion,
} from "./previewScene.js";
import {
  assertTilesetDetailResultSize,
  DEFAULT_TILESET_METADATA_LIMIT,
  MAX_TILESET_METADATA_ENTRIES,
  summarizeTilesetDocument,
} from "./tilesetDetails.js";
import {
  assertTileFindResultSize,
  DEFAULT_TILE_FIND_LIMIT,
  searchTilesetDocument,
  type TileFindQuery,
} from "./tileSearch.js";
import type {
  CreatableLayerType,
  Diagnostic,
  MapEditOperation,
  MapEditPlan,
  ObjectDraft,
  PlannedMapEditOperation,
  ResolvedAddTilesetToMapOperation,
  ResolvedCreateLayerOperation,
  TileRef,
} from "./types.js";

const MAX_PLAN_OPERATIONS = 128;
const MAX_CELL_WRITES = 100_000;
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
const MAX_OBJECT_DISPLAY_STRING_LENGTH = 128;
const MAX_LAYER_OPERATION_ID_SAMPLE = 32;
const MAX_ABSOLUTE_OBJECT_NUMBER = 1_000_000_000;
const MAX_TILED_SIGNED_ID = 0x7fffffff;
const MAX_EDITABLE_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_DUPLICATE_LAYER_BYTES = 16 * 1024 * 1024;
export const MAX_ADD_TILESET_GID_SCANS = 1_000_000;
export const MAX_CREATE_TILE_LAYER_CELLS = MAX_CELL_WRITES;
export const MAX_LAYER_NAME_LENGTH = MAX_OBJECT_STRING_LENGTH;
export const MAX_REPLACE_TILE_MAPPINGS = 128;
export const MAX_REPLACE_TILE_SCANS = 1_000_000;
export const DEFAULT_USAGE_TOP_TILE_LIMIT = 64;
export const MAX_USAGE_TOP_TILE_LIMIT = 128;
export const MAX_USAGE_SCAN_VALUES = 1_000_000;
export const MAX_USAGE_DISTINCT_TILES = 100_000;
export const MAX_USAGE_LAYER_SUMMARIES = 64;
export const MAX_USAGE_TILESET_SUMMARIES = 64;
export const MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE = 16;
export const MAX_USAGE_RESULT_BYTES = 256 * 1024;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TILED_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
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
type LayerPatchField = (typeof LAYER_PATCH_FIELDS)[number];
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

interface EditableContext {
  loaded: LoadedDocument;
  width: number;
  height: number;
  orientation: "orthogonal";
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
}

interface ObjectLocation {
  object: JsonObject;
  objectIndex: number;
  layer: ObjectLayerView;
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

export interface CreateMapInput {
  mapPath: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  backgroundColor?: string;
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

export interface RenderTilesetSheetInput {
  mapPath: string;
  tilesetAssetId: string;
  page?: number;
  pageSize?: number;
  columns?: number;
  scale?: number;
}

export interface GetTilesetInput {
  mapPath: string;
  tilesetAssetId: string;
  startTileId?: number;
  limit?: number;
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

export interface RenderPreviewInput {
  mapPath: string;
  region?: PreviewRegion;
  layerIds?: number[];
  scale?: number;
  overlays?: {
    grid?: boolean;
    coordinates?: boolean;
  };
}

export interface RenderPreviewResult {
  png: Buffer;
  result: Record<string, unknown>;
}

export class MapService {
  constructor(
    private readonly resolver: ProjectPathResolver,
    private readonly store: DocumentStore,
  ) {}

  async createMap(input: CreateMapInput): Promise<CommitResult> {
    const mapPath = this.resolver.normalize(input.mapPath);
    if (posix.extname(mapPath).toLowerCase() !== ".tmj") {
      throw new TiledMcpError("UNSUPPORTED_FORMAT", "MVP map creation requires a .tmj path.");
    }
    assertPositiveInteger(input.width, "width");
    assertPositiveInteger(input.height, "height");
    assertPositiveInteger(input.tileWidth, "tileWidth");
    assertPositiveInteger(input.tileHeight, "tileHeight");
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
    const context = await this.loadEditableContext(mapPath);
    const layers = collectLayerSummaries(
      expectArray(context.loaded.document.layers, `${mapPath}.layers`),
      `${mapPath}.layers`,
    );
    return {
      path: context.loaded.path,
      revision: context.loaded.revision,
      format: "tmj",
      orientation: context.orientation,
      infinite: false,
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
      })),
      dependencyRevisions: context.dependencyRevisions,
      editableProfile: "finite-orthogonal-tmj-external-atlas-tsj",
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

    const tileset = await this.store.read(binding.path);
    if (tileset.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the tileset sheet was being prepared.`,
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
        "Tileset sheets require a root atlas image.",
        { path: binding.path },
      );
    }
    if (
      Array.isArray(document.tiles) &&
      document.tiles.some(
        (value) => isJsonObject(value) && typeof value.image === "string",
      )
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        "Hybrid and image-collection tilesets are not supported by the atlas sheet renderer.",
        { path: binding.path },
      );
    }

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

  async renderPreview(
    input: RenderPreviewInput,
  ): Promise<RenderPreviewResult> {
    const context = await this.loadEditableContext(input.mapPath);
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
    };
    let rendered;
    try {
      rendered = await renderNativePreview({
        tileWidth,
        tileHeight,
        region: scene.region,
        layers: scene.layers,
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
        overlays,
        renderProfile:
          "finite-orthogonal-static-atlas-tilelayers-v1",
        truncated: false,
      },
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

    const context = await this.loadEditableContext(input.mapPath);
    const layer = findTileLayer(context.loaded.document, input.layerId, input.mapPath);
    assertRegionInsideLayer(layer, input.x, input.y, input.width, input.height);

    const rows: Array<Array<TileRef | null>> = [];
    for (let y = input.y; y < input.y + input.height; y += 1) {
      const row: Array<TileRef | null> = [];
      for (let x = input.x; x < input.x + input.width; x += 1) {
        const gid = readLayerGid(layer, x, y);
        row.push(gidToTileRef(gid, context.orientation, context.bindings));
      }
      rows.push(row);
    }

    return {
      mapPath: context.loaded.path,
      revision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      layer: { id: layer.id, name: layer.name },
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

    const context = await this.loadEditableContext(input.mapPath);
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

  async assertRenderSafe(mapPath: string): Promise<{ path: string; revision: string }> {
    const context = await this.loadEditableContext(mapPath);
    await this.assertRenderLayerReferences(
      context.loaded.path,
      expectArray(context.loaded.document.layers, `${mapPath}.layers`),
      0,
      { count: 0 },
    );
    for (const binding of context.bindings) {
      const tileset = await this.store.read(binding.path);
      assertNoTemplateReferences(tileset.document, binding.path);
      if (Array.isArray(tileset.document.tiles)) {
        for (const [index, value] of tileset.document.tiles.entries()) {
          if (!isJsonObject(value) || typeof value.image !== "string") {
            continue;
          }
          const imagePath = await this.resolver.resolveReference(
            binding.path,
            value.image,
          );
          const imageStat = await stat(await this.resolver.resolveExisting(imagePath));
          if (!imageStat.isFile()) {
            throw new TiledMcpError(
              "INVALID_TILESET_IMAGE",
              `${binding.path}.tiles[${index}].image is not a regular file.`,
              { path: imagePath },
            );
          }
        }
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
    return { path: context.loaded.path, revision: context.loaded.revision };
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
    if (map.infinite) {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        "MVP semantic tools support only finite maps.",
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
    return { loaded, width, height, orientation, bindings, dependencyRevisions };
  }

  private async loadTilesetBindings(
    mapPath: string,
    entries: JsonValue[],
    selectedRevisionGuard?: {
      assetId: string;
      expectedRevision: string;
    },
    expectedDependencyRevisions?: Record<string, string>,
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
    const assetIds = new Set<string>();
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
      const assetId = assetIdForPath(tilesetPath);
      if (assetIds.has(assetId)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath} references the same tileset more than once.`,
          { path: tilesetPath },
        );
      }
      assetIds.add(assetId);
      const guardedSelectedTileset =
        selectedRevisionGuard !== undefined &&
        selectedRevisionGuard.assetId === assetId;
      const expectedDependencyRevision =
        expectedDependencyRevisions?.[assetId];
      if (
        expectedDependencyRevisions !== undefined &&
        expectedDependencyRevision === undefined
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          "The expected dependency set does not contain every tileset referenced by the pinned map.",
          {
            path: mapPath,
            assetId,
            tilesetPath,
            expectedCount:
              Object.keys(expectedDependencyRevisions).length,
          },
        );
      }
      if (
        guardedSelectedTileset &&
        expectedDependencyRevision !== undefined &&
        selectedRevisionGuard.expectedRevision !==
          expectedDependencyRevision
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          "Conflicting revision guards were supplied for the same tileset.",
          {
            assetId,
            selectedRevision:
              selectedRevisionGuard.expectedRevision,
            dependencyRevision: expectedDependencyRevision,
          },
        );
      }
      const guardedRevision = guardedSelectedTileset
        ? selectedRevisionGuard.expectedRevision
        : expectedDependencyRevision;
      const tileset = guardedRevision !== undefined
        ? await (async () => {
            const snapshot =
              await this.store.readSnapshot(tilesetPath);
            if (
              snapshot.revision !== guardedRevision
            ) {
              throw new TiledMcpError(
                "DEPENDENCY_REVISION_CONFLICT",
                `${tilesetPath} changed since the requested snapshot.`,
                {
                  assetId,
                  expectedRevision: guardedRevision,
                  actualRevision: snapshot.revision,
                  ...(expectedDependencyRevisions === undefined
                    ? {}
                    : {
                        expectedCount: Object.keys(
                          expectedDependencyRevisions,
                        ).length,
                        actualCount: entries.length,
                        differences: [
                          {
                            assetId,
                            expectedRevision: guardedRevision,
                            actualRevision: snapshot.revision,
                          },
                        ],
                      }),
                },
              );
            }
            return this.store.parseSnapshot(snapshot);
          })()
        : await this.store.read(tilesetPath);
      totalDependencyBytes += tileset.size;
      if (totalDependencyBytes > MAX_TOTAL_DEPENDENCY_BYTES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Referenced tilesets exceed the ${MAX_TOTAL_DEPENDENCY_BYTES} byte aggregate limit.`,
          {
            path: mapPath,
            limit: MAX_TOTAL_DEPENDENCY_BYTES,
            actual: totalDependencyBytes,
          },
        );
      }
      if (tileset.document.type !== "tileset") {
        throw new TiledMcpError("INVALID_DOCUMENT", `${tilesetPath} is not a Tiled tileset.`);
      }
      if (typeof tileset.document.image !== "string") {
        throw new TiledMcpError(
          "UNSUPPORTED_TILESET",
          "MVP editing requires atlas tilesets with a root image field.",
          { path: tilesetPath },
        );
      }
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
      const tileCount = expectInteger(
        tileset.document.tilecount,
        `${tilesetPath}.tilecount`,
      );
      const gidSpan = tilesetGidSpan(
        tileset.document,
        tilesetPath,
        tileCount,
      );
      if (tileCount <= 0 || firstGid + gidSpan - 1 > 0x0fffffff) {
        throw new TiledMcpError("INVALID_DOCUMENT", `${tilesetPath} has an invalid tilecount.`, {
          path: tilesetPath,
          tileCount,
          gidSpan,
        });
      }
      const displayName = boundedDisplayString(
        expectString(tileset.document.name, `${tilesetPath}.name`),
      );
      bindings.push({
        assetId,
        path: tilesetPath,
        firstGid,
        tileCount,
        gidSpan,
        name: displayName.value,
        nameTruncated: displayName.truncated,
        revision: tileset.revision,
      });
    }
    bindings.sort((left, right) => left.firstGid - right.firstGid);
    for (let index = 1; index < bindings.length; index += 1) {
      const previous = bindings[index - 1];
      const current = bindings[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.firstGid + previous.gidSpan > current.firstGid
      ) {
        throw new TiledMcpError(
          "TILESET_GID_RANGE_OVERLAP",
          `Tileset GID ranges overlap at firstgid ${current.firstGid}.`,
          {
            previousAssetId: previous.assetId,
            previousFirstGid: previous.firstGid,
            previousTileCount: previous.tileCount,
            previousGidSpan: previous.gidSpan,
            currentAssetId: current.assetId,
            currentFirstGid: current.firstGid,
          },
        );
      }
    }
    return bindings;
  }

  private async loadProspectiveTilesetBinding(
    tilesetPath: string,
    expectedRevision?: string,
  ): Promise<ProspectiveTilesetBinding> {
    const normalizedPath = this.resolver.normalize(tilesetPath);
    if (posix.extname(normalizedPath).toLowerCase() !== ".tsj") {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Adding a tileset requires an external JSON tileset (.tsj).",
        { path: normalizedPath },
      );
    }
    const assetId = assetIdForPath(normalizedPath);
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
          assetId,
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
  ): Promise<ProspectiveImageBinding> {
    const normalizedPath = this.resolver.normalize(imagePath);
    const assetId = assetIdForImagePath(normalizedPath);
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
          assetId,
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
        );
        continue;
      }
      if (type === "tilelayer") {
        findTileLayer(
          { layers },
          expectInteger(layer.id, `${mapPath}.layers[${index}].id`),
          mapPath,
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
        const imageStat = await stat(await this.resolver.resolveExisting(imagePath));
        if (!imageStat.isFile()) {
          throw new TiledMcpError(
            "UNSAFE_RENDER_REFERENCE",
            `${imagePath} is not a regular image file.`,
            { path: imagePath },
          );
        }
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

  let cellWrites = 0;
  let replaceTileScans = 0;
  let objectMutations = 0;
  const affectedLayerIds = new Set<number>();
  const affectedTileLayerIds = new Set<number>();
  const affectedObjectLayerIds = new Set<number>();
  const createdObjectIds = new Set<number>();
  const updatedObjectIds = new Set<number>();
  const deletedObjectIds = new Set<number>();
  const updatedLayerIds = new Set<number>();
  const changedLayerMembers = new Set<string>();
  const addedTilesets: NonNullable<
    MapEditPlan["summary"]["addedTilesets"]
  > = [];
  const createdLayers: NonNullable<
    MapEditPlan["summary"]["createdLayers"]
  > = [];
  const tileReplacements: NonNullable<
    MapEditPlan["summary"]["tileReplacements"]
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
        replaceTileScans + scannedCellCount >
          MAX_REPLACE_TILE_SCANS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may scan at most ${MAX_REPLACE_TILE_SCANS} cells for tile replacement.`,
          {
            limit: MAX_REPLACE_TILE_SCANS,
            actual: replaceTileScans + scannedCellCount,
          },
        );
      }
      replaceTileScans += scannedCellCount;

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
      assertSafeInteger(operation.layerId, `operations[${operationIndex}].layerId`);
      const created = createBasicObject(
        map,
        operation.layerId,
        operation.object,
        mapPath,
        `operations[${operationIndex}].object`,
        getObjectIndex(),
      );
      affectedLayerIds.add(created.layer.id);
      affectedObjectLayerIds.add(created.layer.id);
      createdObjectIds.add(expectInteger(created.object.id, "created object id"));
      objectMutations += 1;
    } else if (operation.type === "updateObject") {
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
      affectedLayerIds.add(updated.layer.id);
      affectedObjectLayerIds.add(updated.layer.id);
      updatedObjectIds.add(operation.objectId);
      objectMutations += 1;
    } else if (operation.type === "deleteObjects") {
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
    changedLayerMembers.size +
    (createdObjectIds.size > 0 ? 1 : 0) +
    (addedTilesets.length > 0 ? 1 : 0) +
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
    );
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
    ...(addedTilesets.length === 0 ? {} : { addedTilesets }),
    ...(createdLayers.length === 0 ? {} : { createdLayers }),
    ...(deletedLayers.length === 0 ? {} : { deletedLayers }),
    ...(movedLayers.length === 0 ? {} : { movedLayers }),
    ...(duplicatedLayers.length === 0
      ? {}
      : { duplicatedLayers }),
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
  if (
    !isRecordValue(tile.tileset) ||
    tile.tileset.kind !== "external" ||
    typeof tile.tileset.assetId !== "string"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.tileset must identify an external tileset asset.",
    );
  }
  assertSafeInteger(tile.localId, "tile.localId");
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
  if (localId < 0 || localId >= binding.tileCount) {
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

function findTileLayer(map: JsonObject, layerId: number, mapPath: string): TileLayerView {
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
  if ("chunks" in found || typeof found.data === "string") {
    throw new TiledMcpError(
      "UNSUPPORTED_TILE_ENCODING",
      "MVP editing supports only finite JSON tile layers with numeric data arrays.",
      { path: mapPath, layerId },
    );
  }
  const data = expectArray(found.data, `layer ${layerId}.data`);
  const width = expectInteger(found.width, `layer ${layerId}.width`);
  const height = expectInteger(found.height, `layer ${layerId}.height`);
  assertPositiveInteger(width, `layer ${layerId}.width`);
  assertPositiveInteger(height, `layer ${layerId}.height`);
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
    };
    for (const [objectIndex, objectValue] of objects.entries()) {
      output.push({
        object: expectObject(
          objectValue,
          `${context}[${layerIndex}].objects[${objectIndex}]`,
        ),
        objectIndex,
        layer: layerView,
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
  const object: JsonObject = {
    height: draft.shape === "point" ? 0 : (draft.height ?? 0),
    id: nextObjectId,
    name: draft.name ?? "",
    rotation: draft.rotation ?? 0,
    type: draft.className ?? "",
    visible: draft.visible ?? true,
    width: draft.shape === "point" ? 0 : (draft.width ?? 0),
    x: draft.x,
    y: draft.y,
  };
  if (draft.shape === "point") {
    object.point = true;
  }
  if (draft.opacity !== undefined) {
    object.opacity = draft.opacity;
  }
  layer.objects.push(object);
  layer.object.objects = layer.objects;
  map.nextobjectid = nextObjectId + 1;
  const location = { object, objectIndex: layer.objects.length - 1, layer };
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
  assertObjectPatch(patch, context);

  for (const key of keys) {
    const value = patch[key as keyof typeof patch];
    if (key === "className") {
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
  if (draft.shape !== "rectangle" && draft.shape !== "point") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.shape must be rectangle or point.`,
    );
  }
  if (draft.shape === "rectangle") {
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
  if (draft.shape === "rectangle") {
    if (draft.width !== undefined) {
      assertObjectSize(draft.width, `${context}.width`);
    }
    if (draft.height !== undefined) {
      assertObjectSize(draft.height, `${context}.height`);
    }
  }
  assertOptionalObjectFields(draft, context);
}

function assertObjectPatch(
  patch: Extract<MapEditOperation, { type: "updateObject" }>["patch"],
  context: string,
): void {
  if (patch.x !== undefined) {
    assertObjectNumber(patch.x, `${context}.x`);
  }
  if (patch.y !== undefined) {
    assertObjectNumber(patch.y, `${context}.y`);
  }
  if (patch.width !== undefined) {
    assertObjectSize(patch.width, `${context}.width`);
  }
  if (patch.height !== undefined) {
    assertObjectSize(patch.height, `${context}.height`);
  }
  assertOptionalObjectFields(patch, context);
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
  if (value.name !== undefined) {
    assertBoundedString(value.name, `${context}.name`);
  }
  if (value.className !== undefined) {
    assertBoundedString(value.className, `${context}.className`);
  }
  if (value.rotation !== undefined) {
    assertObjectNumber(value.rotation, `${context}.rotation`);
  }
  if (value.visible !== undefined && typeof value.visible !== "boolean") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.visible must be a boolean.`,
    );
  }
  if (
    value.opacity !== undefined &&
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

function assertBoundedString(value: string, context: string): void {
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

function assertBasicEditableObject(
  object: JsonObject,
  objectId: number,
  mapPath: string,
): "rectangle" | "point" {
  const unsupportedKeys = [
    "template",
    "gid",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ];
  const unsupported = unsupportedKeys.find((key) =>
    Object.prototype.hasOwnProperty.call(object, key),
  );
  if (unsupported !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `Object ${objectId} uses ${unsupported}, which is outside basic rectangle/point editing.`,
      { path: mapPath, objectId, feature: unsupported },
    );
  }
  if (object.point !== undefined && object.point !== true) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.point must be true when present.`,
      { path: mapPath, objectId },
    );
  }
  assertObjectNumber(object.x, `object ${objectId}.x`);
  assertObjectNumber(object.y, `object ${objectId}.y`);
  assertObjectSize(object.width, `object ${objectId}.width`);
  assertObjectSize(object.height, `object ${objectId}.height`);
  if (object.rotation !== undefined) {
    assertObjectNumber(object.rotation, `object ${objectId}.rotation`);
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
  return object.point === true ? "point" : "rectangle";
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
  if (deletedLayers.length > 1) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A layer-deletion change set may delete only one selected layer subtree.",
    );
  }
  return deletedLayers.map((deleted) => ({
    path: layerContainerForParent(
      map,
      deleted.parentGroupId,
      mapPath,
    ).path,
    index: deleted.index,
  }));
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
  return patches;
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
): { object: JsonObject; path: JsonSourcePath } | undefined {
  assertLayerTraversalBudget(layers.length, depth, budget);
  for (const [index, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${index}]`);
    if (layer.id === layerId) {
      return { object: layer, path: [...path, index] };
    }
    if (layer.type === "group" && Array.isArray(layer.layers)) {
      const nested = findLayerRecursive(
        layer.layers,
        layerId,
        `${context}[${index}].layers`,
        [...path, index, "layers"],
        depth + 1,
        budget,
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

function assertRegionInsideLayer(
  layer: TileLayerView,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (
    x < layer.x ||
    y < layer.y ||
    x + width > layer.x + layer.width ||
    y + height > layer.y + layer.height
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
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
): Array<Record<string, unknown>> {
  assertLayerTraversalBudget(layers.length, depth, budget);
  return layers.map((value, index) => {
    const layer = expectObject(value, `${context}[${index}]`);
    const displayName = boundedDisplayString(layer.name);
    const summary: Record<string, unknown> = {
      id: expectInteger(layer.id, `${context}[${index}].id`),
      name: displayName.value,
      ...(displayName.truncated ? { nameTruncated: true } : {}),
      type: expectString(layer.type, `${context}[${index}].type`),
      visible: layer.visible !== false,
      opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
    };
    if (layer.type === "tilelayer") {
      summary.width = layer.width;
      summary.height = layer.height;
      summary.x = layer.x ?? 0;
      summary.y = layer.y ?? 0;
    }
    if (layer.type === "group" && Array.isArray(layer.layers)) {
      summary.layers = collectLayerSummaries(
        layer.layers,
        `${context}[${index}].layers`,
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

function assetIdForPath(projectPath: string): string {
  return `asset_${shortHash(`external-tileset:${projectPath}`)}`;
}

function assetIdForImagePath(projectPath: string): string {
  return `asset_${shortHash(`image-layer:${projectPath}`)}`;
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
      if ("chunks" in layer || typeof layer.data === "string") {
        throw new TiledMcpError(
          "UNSUPPORTED_TILE_ENCODING",
          "Usage analysis supports only finite JSON tile layers with numeric data arrays.",
          { path: input.mapPath, layerId },
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
      const data = expectArray(
        layer.data,
        `${layerContext}.data`,
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
      );
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
