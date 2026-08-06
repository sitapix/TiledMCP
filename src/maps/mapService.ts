import {
  type ChangeSetPlan,
  type TransactionApplyOutcome,
  type TransactionMemberApplyResult,
  type TransactionPlan,
  type TransactionPlanTarget,
  transactionPlanId,
} from "../changeSets.js";
import {
  TiledMcpError,
  asTiledMcpError,
} from "../errors.js";
import {
  type JsonObject,
  type JsonValue,
  cloneJson,
  expectArray,
  expectInteger,
  expectObject,
  expectString,
  isJsonObject,
  parseJsonDocument,
  serializeJsonDocument,
  stableJson,
} from "../formats/json.js";
import {
  patchJsonDocumentSource,
} from "../formats/jsonSourcePatch.js";
import {
  parseXmlDocument,
} from "../formats/xml.js";
import {
  type AtlasGeometry,
  parseTransparentColor,
  validateAtlasGeometry,
} from "../images/atlas.js";
import {
  type ImageFileSnapshot,
  readImageFileSnapshot,
} from "../images/imageFile.js";
import {
  type IsometricRenderLayer,
  MAX_ISOMETRIC_REGION_CELLS,
  MAX_ISOMETRIC_RENDER_SCALE,
  renderHexagonalTiles,
  renderIsometricTiles,
} from "../images/isometricPreview.js";
import {
  DEFAULT_NATIVE_PREVIEW_SCALE,
  MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
  MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
  type NativePreviewAtlas,
  prepareNativePreviewHighlightOverlay,
  renderNativePreview,
} from "../images/mapPreview.js";
import {
  type SafeImageFormat,
  decodeSafeImage,
  decodeSafeImageRgba,
  encodeRgbaPng,
  inspectSafeImage,
} from "../images/safeImage.js";
import {
  type CollectionTileSource,
  DEFAULT_TILESET_SHEET_PAGE_SIZE,
  DEFAULT_TILESET_SHEET_SCALE,
  MAX_TILESET_IMAGE_BYTES,
  MAX_TILESET_INPUT_EDGE,
  MAX_TILESET_INPUT_PIXELS,
  MAX_TILE_RENDER_LOCAL_IDS,
  renderCollectionTiles,
  renderTilesetSheet,
  renderTilesetTiles,
} from "../images/tilesetSheet.js";
import {
  AssetRegistry,
} from "../project/assetRegistry.js";
import {
  type ProjectPathResolver,
} from "../project/pathResolver.js";
import {
  MAX_RASTER_INPUT_AGGREGATE_BYTES,
  MAX_RASTER_INPUT_AGGREGATE_PIXELS,
  MAX_RASTER_INPUT_EDGE,
  MAX_RASTER_INPUT_IMAGES,
} from "../rasterContract.js";
import {
  type CommitResult,
  type DocumentSnapshot,
  type DocumentStore,
  type FileDeleteStoreResult,
} from "../storage/documentStore.js";
import {
  revisionOf,
} from "../storage/revision.js";
import {
  type TransactionTargetInput,
} from "../storage/transactions.js";
import {
  MAX_PASSABLE_TILE_SELECTORS,
  analyzeConnectivity,
} from "./connectivity.js";
import {
  type CoordinateConversion,
  type Projection,
  assertUsableProjection,
  convertCoordinates,
  tileSpaceIsDiscrete,
} from "./coordinates.js";
import {
  type TilesetPropertyEditPlan,
  type TilesetPropertyEditSummary,
  type TilesetPropertyPatch,
  applyTilesetPropertyPatch,
  assertTilesetPropertyEditPlan,
  tilesetPropertyEditPlanId,
} from "./tilesetProperties.js";
import {
  type EmbeddedTilesetEditPlan,
  assertEmbeddedTilesetEditPlan,
  embeddedTilesetEditPlanId,
} from "./embeddedTilesetEdit.js";
import {
  type FileDeletePlan,
  type FileDeleteScanSummary,
  MAX_DELETE_REFERENCE_SCAN_ASSETS,
  MAX_DELETE_REFERENCE_SCAN_BYTES,
  MAX_DELETE_REFERRER_SAMPLE,
  assertFileDeletePlan,
  fileDeletePlanId,
  fileDeleteSummary,
} from "./fileDelete.js";
import {
  EXPORT_FORMAT_PATTERN,
  type FileExportPlan,
  MAX_EXPORT_OUTPUT_BYTES,
  assertFileExportPlan,
  fileExportPlanId,
} from "./fileExport.js";
import {
  type GenerateAlgorithmInput,
  type GenerateMappingEntry,
  type GenerateRegion,
  MAX_GENERATE_CELLS,
  computeGeneratedValues,
  mapGeneratedValue,
  validateGenerateMapping,
} from "./generate.js";
import {
  type OrthogonalTransform,
  decodeGid,
} from "./gid.js";
import {
  mergeTemplateInstance,
  readObjectTemplate,
} from "./objectTemplates.js";
import {
  MAX_PREFAB_OBJECTS,
  convertPrefabObject,
  convertPrefabProperties,
} from "./prefab.js";
import {
  MAX_PREVIEW_ATLASES,
  type PreviewScene,
  buildPreviewScene,
} from "./previewScene.js";
import {
  type PropertyTypeEditPlan,
  type PropertyTypeOperation,
  applyPropertyTypeOperations,
  assertPropertyTypeEditPlan,
  projectPropertyTypes,
  propertyTypeEditPlanId,
} from "./propertyTypes.js";
import {
  type ScatterChoice,
  computeScatterPicks,
} from "./scatter.js";
import {
  type ShapeDrawInput,
  computeShapeCells,
} from "./shapeDraw.js";
import {
  type TerrainCornerInput,
  assertTerrainScriptSucceeded,
  buildTerrainPaintScript,
  validateTerrainCorners,
} from "./terrainPaint.js";
import {
  decodeEncodedTileLayerData,
  readChunkedRegionGids,
} from "./tileData.js";
import {
  MAX_TILE_NAMES_BYTES,
  MAX_TILE_NAME_OPERATIONS,
  TILE_NAMES_FILE,
  type TileNameEditApplyResult,
  type TileNameEditPlan,
  type TileNameOperation,
  applyTileNameOperations,
  assertTileNameEditPlan,
  readTileNamesDocument,
  serializeTileNames,
  tileNameEditPlanId,
} from "./tileNames.js";
import {
  DEFAULT_TILE_FIND_LIMIT,
  assertTileFindResultSize,
  searchTilesetDocument,
} from "./tileSearch.js";
import {
  type TilesetCreatePlan,
  assertTilesetCreatePlan,
  buildTilesetDocument,
  computeAtlasGrid,
  tilesetCreatePlanId,
  validateCreateTilesetScalars,
} from "./tilesetCreate.js";
import {
  DEFAULT_TILESET_METADATA_LIMIT,
  assertTilesetDetailResultSize,
  readCollectionTileDefinition,
  summarizeTilesetDocument,
} from "./tilesetDetails.js";
import {
  type TileMetadataUpdate,
  type TilesetEditPlan,
  type TilesetEditSummary,
  applyTileMetadataUpdates,
  assertTilesetEditPlan,
  tilesetEditPlanId,
} from "./tilesetEdits.js";
import {
  type ClassPropertyResolver,
  serializeTmxMap,
  serializeTsxTileset,
  serializeTxTemplate,
} from "./tmxWrite.js";
import {
  type Diagnostic,
  type MapEditOperation,
  type MapEditPlan,
  type PlannedMapEditOperation,
  type ResolvedAddTilesetToMapOperation,
  type ResolvedCreateLayerOperation,
  type TileRef,
} from "./types.js";
import {
  type WangEditOperation,
  type WangEditPlan,
  applyWangEditOperations,
  assertWangEditPlan,
  wangEditPlanId,
} from "./wangEdits.js";
import {
  MAX_WORLD_MAP_MEMBERS,
  type WorldEditOperation,
  type WorldEditPlan,
  applyWorldEditOperations,
  assertWorldPath,
  expandWorldPatterns,
  projectWorldDocument,
  projectWorldPatterns,
  worldEditPlanId,
} from "./worldRead.js";
import {
  collectXmlTilesetReferences,
  findTmxTileLayer,
  parseTmxCsvGids,
  projectTmxMapSummary,
} from "./xmlRead.js";
import {
  createHash,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
  posix,
} from "node:path";
import {
  DEFAULT_USAGE_TOP_TILE_LIMIT,
  MAX_ABSOLUTE_OBJECT_NUMBER,
  MAX_CREATE_MAP_DIMENSION,
  MAX_CREATE_MAP_TILE_EDGE,
  MAX_DIAGNOSTICS,
  MAX_OBJECT_LIST_LIMIT,
  MAX_REGION_CELLS,
  MAX_TILESET_COUNT,
  MAX_TOTAL_DEPENDENCY_BYTES,
  MAX_USAGE_TOP_TILE_LIMIT,
} from "./mapDomain.js";
import type {
  AnalyzeUsageInput,
  CreateMapInput,
  CreateTilesetInput,
  EditableContext,
  EditableContextRevisionGuards,
  EmbeddedTilesetBinding,
  FindTilesInput,
  GetObjectInput,
  GetRegionInput,
  GetTilesetInput,
  LayerTraversalBudget,
  ListObjectsInput,
  PlanAddTilesetToMapInput,
  PlanCreateLayerInput,
  ProspectiveImageBinding,
  ProspectiveTilesetBinding,
  ProspectiveTilesetSource,
  RenderImageBudget,
  RenderPreviewInput,
  RenderPreviewResult,
  RenderSafetySnapshot,
  RenderTilesInput,
  RenderTilesResult,
  RenderTilesetSheetInput,
  RenderTilesetSheetResult,
  SelectBaseMatch,
  TileLayerView,
  TiledExportRunner,
  TilesetBinding,
  TilesetBindingCandidate,
  UpdateTileInput,
  UpdateWangsetsInput,
} from "./mapDomain.js";
import {
  type PreparedNativePreviewObjectDebug,
  type TileObjectFrameTileset,
  analyzeUsageDocument,
  assertBasicEditableObject,
  assertDependencyRevisionRecord,
  assertDependencyRevisions,
  assertEditableLayerIdentities,
  assertLayerTraversalBudget,
  assertNoTemplateReferences,
  assertOptionalRevision,
  assertPlanShape,
  assertPositiveInteger,
  assertPositiveIntegerAtMost,
  assertRegionInsideLayer,
  assertRequiredRevision,
  assertResolvedCreateLayerOperation,
  assertRevisionUnchanged,
  assertRootAtlasTileDefinitions,
  assertSafeInteger,
  assertSelectedLocalIds,
  assertUsageAnalysisResultSize,
  boundedDisplayString,
  buildObjectEditIndex,
  buildTileCollisionShapeInputs,
  collectLayerSummaries,
  collectObjectLocations,
  collectObjectLocationsFromLayer,
  collectSceneCollectionIds,
  collectionProfileOf,
  describeEditableObject,
  errorDiagnostic,
  findChunkedTileLayer,
  findObjectLayer,
  findObjectLocation,
  findTileLayer,
  fromCaughtDiagnostic,
  gidToTileRef,
  inspectTilesetUsage,
  maximumSetValue,
  planId,
  prepareNativePreviewObjectDebug,
  readCollectionTileIds,
  readEmbeddedTilesetBinding,
  readLayerGid,
  readTilesetCollisionSources,
  readTilesetObjectAlignment,
  readTilesetTileOffset,
  readUsageLimit,
  reencodeWrittenTileLayers,
  relativeProjectReference,
  resolveAddTilesetToMapOperation,
  resolveCreateLayerOperation,
  sourceArrayDeletionsForSummary,
  sourceArrayInsertionsForSummary,
  sourceArrayMovesForSummary,
  sourceObjectMemberPatchesForSummary,
  sourcePatchPathsForSummary,
  summarizeMapRootProperties,
  summarizeObjectLocation,
  tileObjectAlignmentOffset,
  tileRefToGid,
  tilesetGidSpan,
  unsupportedRenderFeature,
  validateLayers,
  validatePositiveIntegerField,
  validateReferencedGids,
} from "./mapPrimitives.js";
import { validateAndSummarizeOperations } from "./mapOperations.js";
import type { Revision } from "../storage/revision.js";

// Re-exported so this module's public surface is unchanged by the split.
export {
  DEFAULT_USAGE_TOP_TILE_LIMIT,
  MAX_ADD_TILESET_GID_SCANS,
  MAX_CELL_WRITES,
  MAX_CREATE_MAP_DIMENSION,
  MAX_CREATE_MAP_TILE_EDGE,
  MAX_CREATE_TILE_LAYER_CELLS,
  MAX_DUPLICATE_LAYER_BYTES,
  MAX_FLOOD_FILL_SCANS,
  MAX_LAYER_NAME_LENGTH,
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_OBJECT_DISPLAY_STRING_LENGTH,
  MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
  MAX_OBJECT_SHAPE_POINTS,
  MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
  MAX_REMOVE_TILESET_GID_SCANS,
  MAX_REPLACE_TILE_MAPPINGS,
  MAX_REPLACE_TILE_SCANS,
  MAX_RESIZE_CROPPED_CELL_SAMPLE,
  MAX_RESIZE_MAP_DIMENSION,
  MAX_RESIZE_OFFSET_MAGNITUDE,
  MAX_RESIZE_SOURCE_CELL_SCANS,
  MAX_STAMP_PATTERN_CELLS,
  MAX_STAMP_PATTERN_EDGE,
  MAX_TILESET_COUNT,
  MAX_TILE_OPERATION_SCANS,
  MAX_USAGE_DISTINCT_TILES,
  MAX_USAGE_LAYER_SUMMARIES,
  MAX_USAGE_RESULT_BYTES,
  MAX_USAGE_SCAN_VALUES,
  MAX_USAGE_TILESET_SUMMARIES,
  MAX_USAGE_TOP_TILE_LIMIT,
  MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
  MIN_POLYGON_OBJECT_POINTS,
  MIN_POLYLINE_OBJECT_POINTS,
} from "./mapDomain.js";
export type {
  AnalyzeUsageInput,
  CreateMapInput,
  CreateTilesetInput,
  EmbeddedTilesetBinding,
  FindTilesInput,
  GetObjectInput,
  GetRegionInput,
  GetTilesetInput,
  ListObjectsInput,
  PlanAddTilesetToMapInput,
  PlanCreateLayerInput,
  RenderPreviewInput,
  RenderPreviewResult,
  RenderSafetySnapshot,
  RenderTilesInput,
  RenderTilesResult,
  RenderTilesetSheetInput,
  RenderTilesetSheetResult,
  TiledExportRunner,
  UpdateTileInput,
  UpdateWangsetsInput,
} from "./mapDomain.js";

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
    if (
      posix
        .extname(this.resolver.normalize(mapPath))
        .toLowerCase() === ".tmx"
    ) {
      return this.getTmxSummary(mapPath);
    }
    const context = await this.loadEditableContext(mapPath, {
      allowInfinite: true,
      allowCollectionTilesets: true,
      allowEmbeddedTilesets: true,
      allowStaggeredHexagonal: true,
      allowIsometric: true,
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
      // Tiled always serializes the stagger members for these
      // projections; missing ones fail closed above via the reader.
      ...(context.orientation === "staggered" ||
      context.orientation === "hexagonal"
        ? {
            staggerAxis: expectString(
              context.loaded.document
                .staggeraxis,
              `${context.loaded.path}.staggeraxis`,
            ),
            staggerIndex: expectString(
              context.loaded.document
                .staggerindex,
              `${context.loaded.path}.staggerindex`,
            ),
          }
        : {}),
      ...(context.orientation === "hexagonal"
        ? {
            hexSideLength: expectInteger(
              context.loaded.document
                .hexsidelength,
              `${context.loaded.path}.hexsidelength`,
            ),
          }
        : {}),
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
      embeddedTilesets: context.embeddedBindings.map(
        (embedded) => ({
          kind: "embedded",
          sourceIndex: embedded.sourceIndex,
          name: embedded.name,
          ...(embedded.nameTruncated
            ? { nameTruncated: true }
            : {}),
          firstGid: embedded.firstGid,
          tileCount: embedded.tileCount,
          gidSpan: embedded.gidSpan,
          lastPotentialGid:
            embedded.firstGid + embedded.gidSpan - 1,
        }),
      ),
      dependencyRevisions: context.dependencyRevisions,
      editableProfile:
        context.orientation === "staggered" ||
        context.orientation === "hexagonal"
          ? "staggered-hexagonal-tmj-read-only"
          : context.orientation === "isometric"
            ? "isometric-tmj-editable-core"
            : context.infinite
            ? "infinite-orthogonal-tmj-read-only-chunked"
            : "finite-orthogonal-tmj-external-atlas-tsj",
    };
  }

  /**
   * Bounded read-only TMX region: raw GIDs plus the map's tileset
   * ranges, so callers attribute cells by firstgid themselves — TMX
   * tilesets carry no asset IDs, and this projection stays faithful to
   * the on-disk numbers (flip bits included). Only finite csv and
   * base64 layer data decode; plain <tile> children and chunked
   * infinite data fail closed.
   */
  private async getTmxRegion(
    input: GetRegionInput,
  ): Promise<Record<string, unknown>> {
    const normalized = this.resolver.normalize(
      input.mapPath,
    );
    const snapshot =
      await this.store.readSnapshot(normalized);
    const root = parseXmlDocument(
      snapshot.source.toString("utf8"),
      normalized,
    );
    const summary = projectTmxMapSummary(
      root,
      normalized,
    );
    if (summary.infinite === true) {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        "TMX region reads support only finite maps.",
        { path: normalized },
      );
    }
    const mapWidth = summary.width as number;
    const mapHeight = summary.height as number;
    if (
      input.x < 0 ||
      input.y < 0 ||
      input.x + input.width > mapWidth ||
      input.y + input.height > mapHeight
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `The region must lie inside the ${mapWidth}x${mapHeight} map.`,
        { mapWidth, mapHeight },
      );
    }
    const layer = findTmxTileLayer(
      root,
      input.layerId,
      normalized,
    );
    const layerWidth = Number.parseInt(
      layer.attributes.width ?? String(mapWidth),
      10,
    );
    const layerHeight = Number.parseInt(
      layer.attributes.height ??
        String(mapHeight),
      10,
    );
    if (
      layerWidth !== mapWidth ||
      layerHeight !== mapHeight
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        "TMX region reads require map-aligned layer dimensions.",
        { path: normalized },
      );
    }
    const data = layer.children.find(
      (child) => child.name === "data",
    );
    if (data === undefined) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${normalized} layer ${input.layerId} has no data element.`,
        { path: normalized },
      );
    }
    if (
      data.children.some(
        (child) =>
          child.name === "chunk" ||
          child.name === "tile",
      )
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "TMX region reads support csv and base64 data only; plain tile elements and chunks fail closed.",
        { path: normalized },
      );
    }
    const encoding = data.attributes.encoding;
    const cellCount = mapWidth * mapHeight;
    let gids: number[];
    if (encoding === "csv") {
      gids = parseTmxCsvGids(
        data.text,
        cellCount,
        normalized,
        input.layerId,
      );
    } else if (encoding === "base64") {
      gids = decodeEncodedTileLayerData(
        {
          data: data.text.trim(),
          encoding: "base64",
          ...(data.attributes.compression ===
          undefined
            ? {}
            : {
                compression:
                  data.attributes.compression,
              }),
        },
        input.layerId,
        normalized,
        cellCount,
      );
    } else {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "TMX region reads support csv and base64 data only.",
        {
          path: normalized,
          encoding: encoding ?? "xml",
        },
      );
    }
    const rows: number[][] = [];
    for (let y = 0; y < input.height; y += 1) {
      const row: number[] = [];
      for (let x = 0; x < input.width; x += 1) {
        row.push(
          gids[
            (input.y + y) * mapWidth +
              (input.x + x)
          ]!,
        );
      }
      rows.push(row);
    }
    return {
      mapPath: normalized,
      revision: snapshot.revision,
      format: "tmx",
      profile: "tmx-read-only-region-v1",
      layer: {
        id: input.layerId,
        name: layer.attributes.name ?? "",
      },
      region: {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      },
      cellSemantics: "raw-encoded-gids",
      rows,
      tilesets: summary.tilesets,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  /**
   * Bounded read-only TMX summary. XML maps never reach the editable
   * context: the raw bytes parse through the fail-closed XML subset
   * reader, external tileset references resolve with per-file existence
   * and revision pins (the world-member pattern), and nothing here feeds
   * any edit planner.
   */
  private async getTmxSummary(
    mapPath: string,
  ): Promise<Record<string, unknown>> {
    const normalized =
      this.resolver.normalize(mapPath);
    const snapshot =
      await this.store.readSnapshot(normalized);
    const root = parseXmlDocument(
      snapshot.source.toString("utf8"),
      normalized,
    );
    const projection = projectTmxMapSummary(
      root,
      normalized,
    );
    const tilesets = projection.tilesets as Array<
      Record<string, unknown>
    >;
    for (const entry of tilesets) {
      if (typeof entry.source !== "string") {
        continue;
      }
      try {
        const tilesetPath =
          await this.resolver.resolveReference(
            normalized,
            entry.source,
          );
        entry.path = tilesetPath;
        entry.revision =
          await this.store.readRevision(
            tilesetPath,
          );
        entry.exists = true;
      } catch (error) {
        if (
          error instanceof TiledMcpError &&
          error.code === "FILE_NOT_FOUND"
        ) {
          entry.exists = false;
          continue;
        }
        throw error;
      }
    }
    return {
      ...projection,
      revision: snapshot.revision,
      snapshotConsistency:
        "non-atomic-read-set",
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
      allowStaggeredHexagonal: true,
      allowIsometric: true,
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
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "tile usage was analyzed",
    );

    const result = {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      dependencyRevisions: context.dependencyRevisions,
      profile:
        context.orientation === "staggered" ||
        context.orientation === "hexagonal"
          ? "staggered-hexagonal-tmj-read-only"
          : context.orientation === "isometric"
            ? "isometric-tmj-read-only"
            : "finite-orthogonal-tmj-external-atlas-tsj",
      ...projection,
      snapshotConsistency: "non-atomic-read-set",
    };
    assertUsageAnalysisResultSize(result);
    return result;
  }

  async getTileset(input: GetTilesetInput): Promise<Record<string, unknown>> {
    if (
      input.tilesetAssetId !== undefined &&
      input.embeddedIndex !== undefined
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Provide exactly one of tilesetAssetId or embeddedIndex.",
      );
    }
    if (input.embeddedIndex !== undefined) {
      return this.getEmbeddedTilesetDetails(
        input.mapPath,
        input.embeddedIndex,
        input.startTileId,
        input.limit,
      );
    }
    if (input.tilesetAssetId === undefined) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Provide exactly one of tilesetAssetId or embeddedIndex.",
      );
    }
    const context = await this.loadEditableContext(input.mapPath, {
      allowCollectionTilesets: true,
    });
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
    let projection: Record<string, unknown>;
    if (binding.collection === true) {
      if (binding.localIds === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          `${binding.path} is bound as a collection without its sparse tile id set.`,
        );
      }
      projection = summarizeTilesetDocument({
        document: tileset.document,
        path: binding.path,
        name: binding.name,
        nameTruncated: binding.nameTruncated,
        tileCount: binding.tileCount,
        startTileId: input.startTileId ?? 0,
        limit: input.limit ?? DEFAULT_TILESET_METADATA_LIMIT,
        collection: {
          localIds: binding.localIds,
          idSpan: binding.gidSpan,
        },
      });
      await this.verifyCollectionPageImages(
        binding.path,
        projection,
      );
    } else {
      const imageReference = expectString(
        tileset.document.image,
        `${binding.path}.image`,
      );
      const imagePath = await this.resolver.resolveReference(
        binding.path,
        imageReference,
      );
      projection = summarizeTilesetDocument({
        document: tileset.document,
        path: binding.path,
        imagePath,
        name: binding.name,
        nameTruncated: binding.nameTruncated,
        tileCount: binding.tileCount,
        startTileId: input.startTileId ?? 0,
        limit: input.limit ?? DEFAULT_TILESET_METADATA_LIMIT,
      });
    }

    await this.assertDependenciesUnchanged(context.bindings);
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the tileset details were prepared",
    );

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

  /**
   * Details projection for a tileset embedded inline in the map document.
   * The map revision is the only pin: the embedded content has no asset ID,
   * no independent revision, and never appears in dependencyRevisions. Its
   * root image resolves relative to the map file, exactly like Tiled's
   * embedded-variant reader.
   */
  private async getEmbeddedTilesetDetails(
    mapPath: string,
    embeddedIndex: number,
    startTileId?: number,
    limit?: number,
  ): Promise<Record<string, unknown>> {
    assertSafeInteger(embeddedIndex, "embeddedIndex");
    const context = await this.loadEditableContext(mapPath, {
      allowCollectionTilesets: true,
      allowEmbeddedTilesets: true,
    });
    const embedded = context.embeddedBindings.find(
      (candidate) =>
        candidate.sourceIndex === embeddedIndex,
    );
    if (embedded === undefined) {
      throw new TiledMcpError(
        "TILESET_NOT_IN_MAP",
        `${context.loaded.path} has no embedded tileset at tilesets[${embeddedIndex}].`,
        {
          path: context.loaded.path,
          embeddedIndex,
          embeddedIndexes:
            context.embeddedBindings.map(
              (candidate) => candidate.sourceIndex,
            ),
        },
      );
    }
    const entryContext = `${context.loaded.path}.tilesets[${embedded.sourceIndex}]`;
    const imageReference = expectString(
      embedded.document.image,
      `${entryContext}.image`,
    );
    const imagePath =
      await this.resolver.resolveReference(
        context.loaded.path,
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
    const projection = summarizeTilesetDocument({
      document: embedded.document,
      path: entryContext,
      imagePath,
      name: embedded.name,
      nameTruncated: embedded.nameTruncated,
      tileCount: embedded.tileCount,
      startTileId: startTileId ?? 0,
      limit: limit ?? DEFAULT_TILESET_METADATA_LIMIT,
      embeddedSourceIndex: embedded.sourceIndex,
    });

    await this.assertDependenciesUnchanged(context.bindings);
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the tileset details were prepared",
    );

    const result = {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      source: {
        kind: "embedded",
        sourceIndex: embedded.sourceIndex,
        revision: context.loaded.revision,
      },
      binding: {
        firstGid: embedded.firstGid,
        lastGid:
          embedded.firstGid + embedded.gidSpan - 1,
        gidSpan: embedded.gidSpan,
      },
      ...projection,
      snapshotConsistency: "non-atomic-read-set",
    };
    assertTilesetDetailResultSize(result);
    return result;
  }

  /**
   * Verifies and enriches the returned metadata page of an image-collection
   * details projection: each page tile's image is resolved, safely
   * inspected, and pinned by revision, and any declared per-tile dimensions
   * must match the actual image. Only the returned page is read, under a
   * shared aggregate byte budget.
   */
  private async verifyCollectionPageImages(
    tilesetPath: string,
    projection: Record<string, unknown>,
  ): Promise<void> {
    const tileMetadata = expectObject(
      projection.tileMetadata as JsonValue,
      `${tilesetPath} projection.tileMetadata`,
    );
    const items = expectArray(
      tileMetadata.items as JsonValue,
      `${tilesetPath} projection.tileMetadata.items`,
    ) as unknown as Record<string, unknown>[];
    let aggregateBytes = 0;
    for (const item of items) {
      const image = item.image as
        | {
            source: string;
            declaredWidth?: number;
            declaredHeight?: number;
          }
        | undefined;
      if (image === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          `${tilesetPath} produced a collection tile page entry without its image reference.`,
        );
      }
      const imagePath =
        await this.resolver.resolveReference(
          tilesetPath,
          image.source,
        );
      const snapshot = await readImageFileSnapshot(
        this.resolver,
        imagePath,
        MAX_TILESET_IMAGE_BYTES,
      );
      aggregateBytes += snapshot.bytes.byteLength;
      if (
        aggregateBytes >
        MAX_RASTER_INPUT_AGGREGATE_BYTES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `The requested collection tile page reads more than ${MAX_RASTER_INPUT_AGGREGATE_BYTES} aggregate image bytes; request a smaller page.`,
          {
            path: tilesetPath,
            limit: MAX_RASTER_INPUT_AGGREGATE_BYTES,
          },
        );
      }
      const metadata = await inspectSafeImage({
        bytes: snapshot.bytes,
        path: snapshot.path,
        limits: {
          maxInputBytes: MAX_TILESET_IMAGE_BYTES,
          maxInputPixels: MAX_TILESET_INPUT_PIXELS,
          maxInputEdge: MAX_TILESET_INPUT_EDGE,
        },
      });
      if (
        (image.declaredWidth !== undefined &&
          image.declaredWidth !== metadata.width) ||
        (image.declaredHeight !== undefined &&
          image.declaredHeight !== metadata.height)
      ) {
        throw new TiledMcpError(
          "TILESET_IMAGE_DIMENSION_MISMATCH",
          `${imagePath} is ${metadata.width}x${metadata.height} but the tileset declares ${image.declaredWidth ?? "?"}x${image.declaredHeight ?? "?"}.`,
          {
            path: imagePath,
            actualWidth: metadata.width,
            actualHeight: metadata.height,
            declaredWidth: image.declaredWidth ?? null,
            declaredHeight:
              image.declaredHeight ?? null,
          },
        );
      }
      item.image = {
        source: image.source,
        path: snapshot.path,
        revision: snapshot.revision,
        pixelSize: {
          width: metadata.width,
          height: metadata.height,
        },
      };
    }
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
      allowCollectionTilesets: true,
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
      ...(binding.collection === true &&
      binding.localIds !== undefined
        ? {
            collection: {
              localIds: binding.localIds,
              idSpan: binding.gidSpan,
            },
          }
        : {}),
    });

    await this.assertDependenciesUnchanged(context.bindings);
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "tiles were being searched",
    );

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
    const context = await this.loadEditableContext(input.mapPath, {
      allowCollectionTilesets: true,
    });
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
    if (binding.collection === true) {
      return this.renderCollectionSheetPage(
        input,
        context,
        binding,
        document,
      );
    }
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
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the tileset sheet was rendered",
    );

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

  /**
   * Renders one ascending sparse-id page of an image-collection tileset.
   * Every page tile reads its own verified, revision-pinned image;
   * collection pages are bounded by the per-tile image budget rather
   * than the atlas sheet page size.
   */
  private async renderCollectionSheetPage(
    input: RenderTilesetSheetInput,
    context: EditableContext,
    binding: TilesetBinding,
    document: JsonObject,
  ): Promise<RenderTilesetSheetResult> {
    if (binding.localIds === undefined) {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        `${binding.path} is bound as a collection without its sparse tile id set.`,
      );
    }
    const page = input.page ?? 0;
    const pageSize =
      input.pageSize ??
      DEFAULT_TILESET_SHEET_PAGE_SIZE;
    if (
      !Number.isSafeInteger(page) ||
      page < 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "page must be a nonnegative integer.",
        { page },
      );
    }
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_TILE_RENDER_LOCAL_IDS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Collection sheet pages may contain between 1 and ${MAX_TILE_RENDER_LOCAL_IDS} tiles.`,
        {
          pageSize,
          limit: MAX_TILE_RENDER_LOCAL_IDS,
        },
      );
    }
    const orderedIds = [
      ...binding.localIds,
    ].sort((left, right) => left - right);
    const pageCount = Math.max(
      1,
      Math.ceil(orderedIds.length / pageSize),
    );
    if (page >= pageCount) {
      throw new TiledMcpError(
        "PAGE_OUT_OF_RANGE",
        `page ${page} is outside the ${pageCount} available collection sheet pages.`,
        { page, pageCount },
      );
    }
    const pageIds = orderedIds.slice(
      page * pageSize,
      page * pageSize + pageSize,
    );
    const firstId = pageIds[0];
    const lastId = pageIds[pageIds.length - 1];
    if (
      firstId === undefined ||
      lastId === undefined
    ) {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        `${binding.path} produced an empty collection sheet page.`,
      );
    }
    const { tiles, images } =
      await this.loadCollectionTileSources(
        binding,
        document,
        pageIds,
      );
    const rendered = await renderCollectionTiles({
      tiles,
      maxLabelId: binding.gidSpan - 1,
      ...(input.columns === undefined
        ? {}
        : { columns: input.columns }),
      ...(input.scale === undefined
        ? {}
        : { scale: input.scale }),
    });

    await this.assertDependenciesUnchanged([
      binding,
    ]);
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the tileset sheet was rendered",
    );

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
        images,
        tileset: {
          path: binding.path,
          name: binding.name,
          ...(binding.nameTruncated
            ? { nameTruncated: true }
            : {}),
          tileCount: binding.tileCount,
          tileSize: {
            width: expectInteger(
              document.tilewidth,
              `${binding.path}.tilewidth`,
            ),
            height: expectInteger(
              document.tileheight,
              `${binding.path}.tileheight`,
            ),
          },
          collection: {
            sparseLocalIds: true,
            maxLocalId: binding.gidSpan - 1,
            tileSizeSemantics:
              "maximum-tile-image-size",
          },
        },
        page: {
          index: page,
          count: pageCount,
          requestedSize: pageSize,
          size: pageIds.length,
          tileCount: pageIds.length,
          localIdRange: {
            first: firstId,
            last: lastId,
          },
          columns:
            rendered.selection.layout.columns,
          rows: rendered.selection.layout.rows,
        },
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
        allowCollectionTilesets: true,
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
    if (binding.collection === true) {
      return this.renderCollectionTileSelection(
        input,
        context,
        binding,
        document,
      );
    }
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
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the explicit tile selection was rendered",
    );

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

  /**
   * Renders an explicit sparse selection of image-collection tiles. Each
   * selected tile's own image is read, safely decoded, verified against
   * any declared dimensions, and revision-pinned, under shared aggregate
   * byte and pixel budgets.
   */
  /**
   * Loads, safely decodes, verifies, and revision-pins the per-tile
   * images of the given existing collection ids, in order, under shared
   * aggregate byte and pixel budgets.
   */
  private async loadCollectionTileSources(
    binding: TilesetBinding,
    document: JsonObject,
    orderedIds: readonly number[],
  ): Promise<{
    tiles: CollectionTileSource[];
    images: Record<string, unknown>[];
    byteLengths: number[];
  }> {
    const wanted = new Set(orderedIds);
    const byteLengths: number[] = [];
    const definitions = new Map<
      number,
      ReturnType<typeof readCollectionTileDefinition>
    >();
    const entries = expectArray(
      document.tiles,
      `${binding.path}.tiles`,
    );
    for (const [index, value] of entries.entries()) {
      const entry = expectObject(
        value,
        `${binding.path}.tiles[${index}]`,
      );
      const localId = expectInteger(
        entry.id,
        `${binding.path}.tiles[${index}].id`,
      );
      if (!wanted.has(localId)) {
        continue;
      }
      definitions.set(
        localId,
        readCollectionTileDefinition(
          entry,
          binding.path,
          localId,
        ),
      );
    }

    let aggregateBytes = 0;
    let aggregatePixels = 0;
    const tiles: CollectionTileSource[] = [];
    const images: Record<string, unknown>[] = [];
    for (const localId of orderedIds) {
      const definition = definitions.get(localId);
      if (definition === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          `${binding.path} tile ${localId} disappeared while its image was resolved.`,
        );
      }
      const imagePath =
        await this.resolver.resolveReference(
          binding.path,
          definition.source,
        );
      const snapshot = await readImageFileSnapshot(
        this.resolver,
        imagePath,
        MAX_TILESET_IMAGE_BYTES,
      );
      aggregateBytes += snapshot.bytes.byteLength;
      byteLengths.push(snapshot.bytes.byteLength);
      if (
        aggregateBytes >
        MAX_RASTER_INPUT_AGGREGATE_BYTES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `The selected collection tiles read more than ${MAX_RASTER_INPUT_AGGREGATE_BYTES} aggregate image bytes; reduce localIds.`,
          {
            path: binding.path,
            limit: MAX_RASTER_INPUT_AGGREGATE_BYTES,
          },
        );
      }
      const limits = {
        maxInputBytes: MAX_TILESET_IMAGE_BYTES,
        maxInputPixels: MAX_TILESET_INPUT_PIXELS,
        maxInputEdge: MAX_TILESET_INPUT_EDGE,
      };
      const metadata = await inspectSafeImage({
        bytes: snapshot.bytes,
        path: snapshot.path,
        limits,
      });
      const decoded = await decodeSafeImage({
        bytes: snapshot.bytes,
        path: snapshot.path,
        declaredWidth: metadata.width,
        declaredHeight: metadata.height,
        limits,
      });
      aggregatePixels +=
        decoded.pixelSize.width *
        decoded.pixelSize.height;
      if (
        aggregatePixels >
        MAX_RASTER_INPUT_AGGREGATE_PIXELS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `The selected collection tiles decode more than ${MAX_RASTER_INPUT_AGGREGATE_PIXELS} aggregate pixels; reduce localIds.`,
          {
            path: binding.path,
            limit:
              MAX_RASTER_INPUT_AGGREGATE_PIXELS,
          },
        );
      }
      if (
        (definition.declaredWidth !== undefined &&
          definition.declaredWidth !==
            decoded.pixelSize.width) ||
        (definition.declaredHeight !==
          undefined &&
          definition.declaredHeight !==
            decoded.pixelSize.height)
      ) {
        throw new TiledMcpError(
          "TILESET_IMAGE_DIMENSION_MISMATCH",
          `${imagePath} is ${decoded.pixelSize.width}x${decoded.pixelSize.height} but the tileset declares ${definition.declaredWidth ?? "?"}x${definition.declaredHeight ?? "?"}.`,
          {
            path: imagePath,
            actualWidth: decoded.pixelSize.width,
            actualHeight:
              decoded.pixelSize.height,
            declaredWidth:
              definition.declaredWidth ?? null,
            declaredHeight:
              definition.declaredHeight ?? null,
          },
        );
      }
      tiles.push({
        localId,
        imagePath: snapshot.path,
        rgba: decoded.rgba,
        width: decoded.pixelSize.width,
        height: decoded.pixelSize.height,
      });
      images.push({
        localId,
        path: snapshot.path,
        revision: snapshot.revision,
        format: decoded.format,
        pixelSize: {
          width: decoded.pixelSize.width,
          height: decoded.pixelSize.height,
        },
      });
    }

    return { tiles, images, byteLengths };
  }

  private async renderCollectionTileSelection(
    input: RenderTilesInput,
    context: EditableContext,
    binding: TilesetBinding,
    document: JsonObject,
  ): Promise<RenderTilesResult> {
    if (binding.localIds === undefined) {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        `${binding.path} is bound as a collection without its sparse tile id set.`,
      );
    }
    if (
      !Array.isArray(input.localIds) ||
      input.localIds.length < 1 ||
      input.localIds.length >
        MAX_TILE_RENDER_LOCAL_IDS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `localIds must contain between 1 and ${MAX_TILE_RENDER_LOCAL_IDS} IDs.`,
        { count: input.localIds?.length ?? null },
      );
    }
    const seen = new Set<number>();
    for (const [index, localId] of input.localIds.entries()) {
      if (
        !Number.isSafeInteger(localId) ||
        localId < 0
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "localIds must contain non-negative safe integers.",
          { index },
        );
      }
      if (!binding.localIds.has(localId)) {
        throw new TiledMcpError(
          "TILE_ID_OUT_OF_RANGE",
          `Tile ${localId} does not exist in ${binding.path}.`,
          {
            path: binding.path,
            localId,
            index,
          },
        );
      }
      if (seen.has(localId)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `localIds contains duplicate local ID ${localId}.`,
          { localId, duplicateIndex: index },
        );
      }
      seen.add(localId);
    }

    const { tiles, images } =
      await this.loadCollectionTileSources(
        binding,
        document,
        input.localIds,
      );

    const rendered = await renderCollectionTiles({
      tiles,
      maxLabelId: binding.gidSpan - 1,
      ...(input.columns === undefined
        ? {}
        : { columns: input.columns }),
      ...(input.scale === undefined
        ? {}
        : { scale: input.scale }),
    });

    await this.assertDependenciesUnchanged([
      binding,
    ]);
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the explicit tile selection was rendered",
    );

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
        images,
        tileset: {
          path: binding.path,
          name: binding.name,
          ...(binding.nameTruncated
            ? { nameTruncated: true }
            : {}),
          tileCount: binding.tileCount,
          tileSize: {
            width: expectInteger(
              document.tilewidth,
              `${binding.path}.tilewidth`,
            ),
            height: expectInteger(
              document.tileheight,
              `${binding.path}.tileheight`,
            ),
          },
          collection: {
            sparseLocalIds: true,
            maxLocalId: binding.gidSpan - 1,
            tileSizeSemantics:
              "maximum-tile-image-size",
          },
        },
        renderProfile:
          "explicit-local-id-collection-selection-v1",
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
      allowCollectionTilesets: true,
      allowEmbeddedTilesets: true,
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
      [
        ...context.bindings.map((binding) => ({
          assetId: binding.assetId,
          firstGid: binding.firstGid,
          // Collection ranges span the sparse id space; missing ids fail
          // closed when the used tiles are collected.
          tileCount:
            binding.collection === true
              ? binding.gidSpan
              : binding.tileCount,
          name: binding.name,
        })),
        // Embedded entries join the GID space under a synthetic source
        // label; real asset IDs always use the asset_<hex> shape.
        ...context.embeddedBindings.map(
          (embedded) => ({
            assetId: `embedded:${embedded.sourceIndex}`,
            firstGid: embedded.firstGid,
            tileCount: embedded.tileCount,
            name: embedded.name,
          }),
        ),
      ],
      {
        ...(input.region === undefined ? {} : { region: input.region }),
        ...(input.layerIds === undefined ? {} : { layerIds: input.layerIds }),
      },
    );
    await this.resolveBaseTileObjects(
      scene,
      context.bindings,
      context.loaded.path,
      context.embeddedBindings,
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
      if (assetId.startsWith("embedded:")) {
        const sourceIndex = Number.parseInt(
          assetId.slice("embedded:".length),
          10,
        );
        const embedded =
          context.embeddedBindings.find(
            (candidate) =>
              candidate.sourceIndex ===
              sourceIndex,
          );
        if (embedded === undefined) {
          throw new TiledMcpError(
            "INTERNAL_ERROR",
            `Preview source ${assetId} disappeared from the map context.`,
            { assetId },
          );
        }
        const entryPath = `${context.loaded.path}.tilesets[${embedded.sourceIndex}]`;
        const loaded =
          await this.loadPreviewAtlasSource(
            {
              document: embedded.document,
              errorPath: entryPath,
              assetLabel: assetId,
              imageBasePath: context.loaded.path,
            },
            tileWidth,
            tileHeight,
            MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES -
              aggregateImageBytes,
            MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS -
              aggregateDecodedPixels,
          );
        aggregateImageBytes +=
          loaded.image.bytes.byteLength;
        aggregateDecodedPixels +=
          loaded.geometry.imageWidth *
          loaded.geometry.imageHeight;
        atlases.push({
          assetId,
          firstGid: embedded.firstGid,
          tileCount: embedded.tileCount,
          rgba: loaded.decoded.rgba,
          format: loaded.decoded.format,
          geometry: loaded.geometry,
          ...(loaded.transparentColor ===
          undefined
            ? {}
            : {
                transparentColor:
                  loaded.transparentColor,
              }),
        });
        sources.push({
          embedded: {
            sourceIndex: embedded.sourceIndex,
          },
          tileset: {
            path: context.loaded.path,
            revision: context.loaded.revision,
          },
          image: {
            path: loaded.image.path,
            revision: loaded.image.revision,
            format: loaded.decoded.format,
            pixelSize: loaded.decoded.pixelSize,
          },
        });
        continue;
      }
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
      if (binding.collection === true) {
        const usedIds = collectSceneCollectionIds(
          scene,
          binding,
          context.orientation,
        );
        if (
          atlases.length + usedIds.length >
          MAX_PREVIEW_ATLASES
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `Preview sources exceed the ${MAX_PREVIEW_ATLASES} atlas budget; every distinct collection tile image counts as one source.`,
            { limit: MAX_PREVIEW_ATLASES },
          );
        }
        const tilesetSnapshot =
          await this.store.readSnapshot(
            binding.path,
          );
        if (
          tilesetSnapshot.revision !==
          binding.revision
        ) {
          throw new TiledMcpError(
            "DEPENDENCY_REVISION_CONFLICT",
            `${binding.path} changed while the preview was being prepared.`,
            {
              assetId: binding.assetId,
              expectedRevision: binding.revision,
              actualRevision:
                tilesetSnapshot.revision,
            },
          );
        }
        const tilesetDocument =
          this.store.parseSnapshot(
            tilesetSnapshot,
          ).document;
        const collectionSources =
          await this.loadCollectionTileSources(
            binding,
            tilesetDocument,
            usedIds,
          );
        for (const [
          index,
          tile,
        ] of collectionSources.tiles.entries()) {
          aggregateImageBytes +=
            collectionSources.byteLengths[
              index
            ] ?? 0;
          aggregateDecodedPixels +=
            tile.width * tile.height;
          if (
            aggregateImageBytes >
            MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES
          ) {
            throw new TiledMcpError(
              "RESULT_LIMIT_EXCEEDED",
              `Preview atlas inputs exceed the ${MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES} byte aggregate limit.`,
              {
                actual: aggregateImageBytes,
                limit:
                  MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
              },
            );
          }
          if (
            !Number.isSafeInteger(
              aggregateDecodedPixels,
            ) ||
            aggregateDecodedPixels >
              MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS
          ) {
            throw new TiledMcpError(
              "RESULT_LIMIT_EXCEEDED",
              `Preview atlases exceed the ${MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS} decoded-pixel aggregate limit.`,
              {
                actual: aggregateDecodedPixels,
                limit:
                  MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
              },
            );
          }
          const sourceImage =
            collectionSources.images[index] as {
              path: string;
              revision: string;
              format: SafeImageFormat;
              pixelSize: {
                width: number;
                height: number;
              };
            };
          atlases.push({
            assetId: binding.assetId,
            firstGid:
              binding.firstGid + tile.localId,
            tileCount: 1,
            rgba: tile.rgba,
            format: sourceImage.format,
            geometry: {
              imagePath: tile.imagePath,
              imageWidth: tile.width,
              imageHeight: tile.height,
              tileWidth: tile.width,
              tileHeight: tile.height,
              tileCount: 1,
              columns: 1,
              margin: 0,
              spacing: 0,
            },
            collectionLocalId: tile.localId,
          });
          sources.push({
            assetId: binding.assetId,
            tileset: {
              path: binding.path,
              revision: binding.revision,
            },
            image: {
              path: sourceImage.path,
              revision: sourceImage.revision,
              format: sourceImage.format,
              pixelSize: sourceImage.pixelSize,
            },
          });
        }
        continue;
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
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the native preview was rendered",
    );

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
    embeddedBindings: readonly EmbeddedTilesetBinding[] = [],
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
          const embedded = embeddedBindings.find(
            (candidate) =>
              decoded.baseGid >=
                candidate.firstGid &&
              decoded.baseGid <
                candidate.firstGid +
                  candidate.gidSpan,
          );
          if (embedded !== undefined) {
            throw new TiledMcpError(
              "UNSUPPORTED_TILESET",
              `Object ${object.id} references embedded tileset tilesets[${embedded.sourceIndex}]; tile objects backed by embedded tilesets are not renderable yet.`,
              {
                path: mapPath,
                layerId: layer.id,
                objectId: object.id,
                embeddedSourceIndex:
                  embedded.sourceIndex,
              },
            );
          }
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

    if (
      posix
        .extname(
          this.resolver.normalize(input.mapPath),
        )
        .toLowerCase() === ".tmx"
    ) {
      return this.getTmxRegion(input);
    }
    const context = await this.loadEditableContext(input.mapPath, {
      allowInfinite: true,
      allowCollectionTilesets: true,
      allowEmbeddedTilesets: true,
      allowStaggeredHexagonal: true,
      allowIsometric: true,
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
              context.embeddedBindings,
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
          row.push(
            gidToTileRef(
              gid,
              context.orientation,
              context.bindings,
              context.embeddedBindings,
            ),
          );
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

  async listWorldMaps(input: {
    worldPath: string;
    expandPatterns?: boolean | undefined;
  }): Promise<Record<string, unknown>> {
    const worldPath = this.resolver.normalize(
      input.worldPath,
    );
    assertWorldPath(worldPath);
    const snapshot =
      await this.store.readSnapshot(worldPath);
    const parsed =
      this.store.parseSnapshot(snapshot);
    const projection = projectWorldDocument(
      parsed.document,
      worldPath,
    );
    const members: Array<
      Record<string, unknown>
    > = [];
    for (const member of projection.members) {
      let resolvedPath: string | undefined;
      let revision: string | undefined;
      try {
        resolvedPath =
          await this.resolver.resolveReference(
            worldPath,
            member.fileName,
          );
        revision =
          await this.store.readRevision(
            resolvedPath,
          );
      } catch (error) {
        if (
          asTiledMcpError(error)?.code !==
          "FILE_NOT_FOUND"
        ) {
          throw error;
        }
      }
      members.push({
        source: member.fileName,
        exists: resolvedPath !== undefined,
        ...(resolvedPath === undefined
          ? {}
          : { path: resolvedPath }),
        ...(revision === undefined
          ? {}
          : { revision }),
        x: member.x,
        y: member.y,
        declaredSize: member.declaredSize,
      });
    }
    let patternsExpanded = false;
    if (
      input.expandPatterns === true &&
      projection.patternCount > 0
    ) {
      const patterns = projectWorldPatterns(
        parsed.document,
        worldPath,
      );
      const worldDirectory =
        posix.dirname(worldPath);
      const assets =
        await this.resolver.listAssets(10_000);
      // World::allMaps scans exactly the world's own directory.
      const siblingNames = assets
        .filter(
          (asset) =>
            posix.dirname(asset.path) ===
            worldDirectory,
        )
        .map((asset) =>
          posix.basename(asset.path),
        )
        .sort();
      const expanded = expandWorldPatterns(
        patterns,
        siblingNames,
      );
      if (
        members.length + expanded.length >
        MAX_WORLD_MAP_MEMBERS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `${worldPath} expands to more than ${MAX_WORLD_MAP_MEMBERS} members.`,
          {
            path: worldPath,
            limit: MAX_WORLD_MAP_MEMBERS,
          },
        );
      }
      for (const entry of expanded) {
        const resolvedPath =
          await this.resolver.resolveReference(
            worldPath,
            entry.fileName,
          );
        members.push({
          source: entry.fileName,
          exists: true,
          path: resolvedPath,
          revision:
            await this.store.readRevision(
              resolvedPath,
            ),
          x: entry.x,
          y: entry.y,
          declaredSize: {
            width: entry.width,
            height: entry.height,
          },
          fromPattern: true,
          patternIndex: entry.patternIndex,
        });
      }
      patternsExpanded = true;
    }
    const currentRevision =
      await this.store.readRevision(worldPath);
    if (currentRevision !== snapshot.revision) {
      throw new TiledMcpError(
        "DOCUMENT_CHANGED_DURING_READ",
        `${worldPath} changed while its members were being listed.`,
        {
          path: worldPath,
          expectedRevision: snapshot.revision,
          actualRevision: currentRevision,
        },
      );
    }
    return {
      path: worldPath,
      revision: snapshot.revision,
      onlyShowAdjacentMaps:
        projection.onlyShowAdjacentMaps,
      members,
      memberCount: members.length,
      patternCount: projection.patternCount,
      patternsUnexpanded:
        projection.patternCount > 0 &&
        !patternsExpanded,
      properties: projection.properties.entries,
      propertyCount:
        projection.properties.total,
      ...(projection.properties.truncated
        ? { propertiesTruncated: true }
        : {}),
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  async planWorldEdits(input: {
    worldPath: string;
    expectedRevision: string;
    operations: readonly WorldEditOperation[];
  }): Promise<WorldEditPlan> {
    assertRequiredRevision(
      input.expectedRevision,
      "expectedRevision",
    );
    const worldPath = this.resolver.normalize(
      input.worldPath,
    );
    assertWorldPath(worldPath);
    const snapshot =
      await this.store.readSnapshot(worldPath);
    if (
      snapshot.revision !== input.expectedRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${worldPath} does not match expectedRevision.`,
        {
          path: worldPath,
          expectedRevision:
            input.expectedRevision,
          actualRevision: snapshot.revision,
        },
      );
    }
    const parsed =
      this.store.parseSnapshot(snapshot);
    const operations = structuredClone(
      input.operations,
    ) as WorldEditOperation[];
    // Added members must reference existing project-local .tmj maps.
    for (const operation of operations) {
      if (operation.type !== "addMap") {
        continue;
      }
      const memberPath =
        await this.resolver.resolveReference(
          worldPath,
          operation.fileName,
        );
      if (
        posix.extname(memberPath).toLowerCase() !==
        ".tmj"
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_FORMAT",
          `World members must be project-local .tmj maps; got ${memberPath}.`,
          { path: memberPath },
        );
      }
    }
    const applied = applyWorldEditOperations(
      parsed.document,
      worldPath,
      operations,
    );
    const unsigned: Omit<WorldEditPlan, "id"> = {
      kind: "worldEdit",
      version: 1,
      worldPath,
      baseRevision: snapshot.revision,
      operations,
      summary: applied.summary,
    };
    return {
      ...unsigned,
      id: worldEditPlanId(
        unsigned,
        (domain, json) =>
          `changeset:${createHash("sha256")
            .update(domain)
            .update(json)
            .digest("hex")}`,
      ),
    };
  }

  async applyWorldEdits(
    plan: WorldEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    const { id: suppliedId, ...unsigned } = plan;
    const expectedId = worldEditPlanId(
      unsigned,
      (domain, json) =>
        `changeset:${createHash("sha256")
          .update(domain)
          .update(json)
          .digest("hex")}`,
    );
    if (suppliedId !== expectedId) {
      throw new TiledMcpError(
        "CHANGE_SET_TAMPERED",
        "The world edit contents do not match its digest. Preview the edits again.",
        { suppliedId, expectedId },
      );
    }
    const snapshot = await this.store.readSnapshot(
      plan.worldPath,
    );
    if (snapshot.revision !== plan.baseRevision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${plan.worldPath} changed since the world edit was previewed.`,
        {
          path: plan.worldPath,
          expectedRevision: plan.baseRevision,
          actualRevision: snapshot.revision,
        },
      );
    }
    const parsed =
      this.store.parseSnapshot(snapshot);
    const applied = applyWorldEditOperations(
      parsed.document,
      plan.worldPath,
      plan.operations,
    );
    if (
      stableJson(
        applied.summary as unknown as JsonValue,
      ) !==
      stableJson(
        plan.summary as unknown as JsonValue,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The world edit summary does not match its operations.",
      );
    }
    const edited = cloneJson(
      parsed.document,
    ) as JsonObject;
    edited.maps = applied.maps;
    const patchedSource = patchJsonDocumentSource(
      parsed.source,
      edited,
      [],
      plan.worldPath,
      [],
      [{ path: [], key: "maps" }],
      [],
      [],
    );
    const result = await this.store.commitBytes(
      plan.worldPath,
      plan.baseRevision,
      patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
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
    let effectiveLocation = location;
    let templateBlock:
      | Record<string, unknown>
      | undefined;
    if (
      typeof location.object.template === "string"
    ) {
      if (
        posix
          .extname(location.object.template)
          .toLowerCase() !== ".tj"
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_FORMAT",
          `Object ${input.objectId} references a non-JSON template; only .tj templates are readable.`,
          {
            objectId: input.objectId,
            template: location.object.template,
          },
        );
      }
      const templatePath =
        await this.resolver.resolveReference(
          context.loaded.path,
          location.object.template,
        );
      const gid = location.object.gid;
      if (
        typeof gid === "number" &&
        gid !== 0
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_OBJECT_PROFILE",
          `Object ${input.objectId} is a tile template instance, which is outside the supported reading profile.`,
          { objectId: input.objectId },
        );
      }
      const template = await this.store.read(
        templatePath,
      );
      const templateObject = readObjectTemplate(
        template.document,
        templatePath,
      );
      effectiveLocation = {
        ...location,
        object: mergeTemplateInstance(
          location.object,
          templateObject,
        ),
      };
      templateBlock = {
        path: templatePath,
        revision: template.revision,
        mergeProfile:
          "tiled-sync-with-template-v1",
        propertiesSource: "instance-only",
      };
    }
    const shape = assertBasicEditableObject(
      effectiveLocation.object,
      input.objectId,
      context.loaded.path,
    );
    return {
      mapPath: context.loaded.path,
      revision: context.loaded.revision,
      dependencyRevisions: context.dependencyRevisions,
      object: describeEditableObject(
        effectiveLocation,
        shape,
        context.loaded.path,
        context.orientation,
        context.bindings,
      ),
      ...(templateBlock === undefined
        ? {}
        : { template: templateBlock }),
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
        "Adding a tileset to an MVP map requires a .tsj path.",
        { path: tilesetPath },
      );
    }

    let prospectiveSource:
      | ProspectiveTilesetSource
      | undefined;
    if (input.createPlan !== undefined) {
      const createPlan = input.createPlan;
      if (
        this.resolver.normalize(
          createPlan.tilesetPath,
        ) !== tilesetPath
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "The tileset-create plan targets a different path than the attachment.",
          {
            tilesetPath,
            createTilesetPath:
              createPlan.tilesetPath,
          },
        );
      }
      if (
        input.expectedTilesetRevision !==
          undefined &&
        input.expectedTilesetRevision !==
          createPlan.baseRevision
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          "expectedTilesetRevision does not match the tileset-create plan's prospective content.",
          {
            path: tilesetPath,
            expectedRevision:
              input.expectedTilesetRevision,
            actualRevision:
              createPlan.baseRevision,
          },
        );
      }
      const { document } =
        await this.prepareTilesetCreateContent(
          createPlan,
        );
      let existing: DocumentSnapshot | undefined;
      try {
        existing =
          await this.store.readSnapshot(
            tilesetPath,
          );
      } catch (error) {
        if (
          asTiledMcpError(error)?.code !==
          "FILE_NOT_FOUND"
        ) {
          throw error;
        }
      }
      if (existing === undefined) {
        prospectiveSource = {
          document,
          revision: createPlan.baseRevision,
        };
      } else if (
        existing.revision !==
        createPlan.baseRevision
      ) {
        // The tileset appeared with different content; the create plan is
        // stale and pinning its prospective revision would never apply.
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          `${tilesetPath} already exists and no longer matches the tileset-create plan.`,
          {
            path: tilesetPath,
            expectedRevision:
              createPlan.baseRevision,
            actualRevision: existing.revision,
          },
        );
      }
      // An existing file with matching bytes (the create was applied
      // individually) falls through to the normal on-disk path.
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
      input.createPlan === undefined
        ? input.expectedTilesetRevision
        : input.createPlan.baseRevision,
      undefined,
      false,
      prospectiveSource,
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
    if (prospectiveSource === undefined) {
      await assertRevisionUnchanged(
        this.store,
        prospective.path,
        prospective.revision,
        "DEPENDENCY_REVISION_CONFLICT",
        "the add-tileset change set was being prepared",
        {
          assetId: prospective.assetId,
        },
      );
    } else {
      await this.assertCreateTargetAbsent(
        prospective.path,
      );
    }
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the add-tileset change set was being prepared",
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
        allowCollectionTilesets: true,
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
    const guardedUpdates = structuredClone(
      input.updates,
    ) as TileMetadataUpdate[];
    await this.guardCollectionStructuralUpdates(
      context,
      binding,
      guardedUpdates,
    );
    const edited = cloneJson(loaded.document);
    const planned = applyTileMetadataUpdates(
      edited,
      binding.tileCount,
      structuredClone(
        guardedUpdates,
      ) as TileMetadataUpdate[],
      binding.path,
      collectionProfileOf(binding),
    );
    const unsignedPlan: Omit<TilesetEditPlan, "id"> = {
      kind: "tilesetEdit",
      version: 2,
      mapPath: context.loaded.path,
      tilesetPath: binding.path,
      assetId: binding.assetId,
      baseRevision: binding.revision,
      mapRevision: context.loaded.revision,
      updates: guardedUpdates,
      summary: planned.summary,
    };
    await assertRevisionUnchanged(
      this.store,
      binding.path,
      binding.revision,
      "DEPENDENCY_REVISION_CONFLICT",
      "the tile update was being prepared",
      { assetId: binding.assetId },
    );
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the tile update was being prepared",
    );
    return {
      ...unsignedPlan,
      id: tilesetEditPlanId(unsignedPlan),
    };
  }

  /**
   * Verifies structural collection updates against live project state.
   * For creates, the referenced image is read and safely inspected; its
   * actual pixel size is injected into the update (planning) or compared
   * against the pinned size (replay), so declared dimensions are never
   * trusted. For removes, the current map is scanned for any remaining
   * reference to the removed local ID, and every other project asset
   * referencing the tileset blocks the removal wholesale — a shrinking
   * GID span must not strand references this plan cannot see.
   */
  private async guardCollectionStructuralUpdates(
    context: EditableContext,
    binding: TilesetBinding,
    updates: TileMetadataUpdate[],
  ): Promise<void> {
    for (const update of updates) {
      if (
        update.createCollectionTile !== undefined
      ) {
        const create = update.createCollectionTile;
        if (
          typeof create.image !== "string" ||
          create.image.length === 0
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            "createCollectionTile.image must be a non-empty string.",
          );
        }
        const imagePath =
          await this.resolver.resolveReference(
            binding.path,
            create.image,
          );
        const snapshot =
          await readImageFileSnapshot(
            this.resolver,
            imagePath,
            MAX_TILESET_IMAGE_BYTES,
          );
        const metadata = await inspectSafeImage({
          bytes: snapshot.bytes,
          path: snapshot.path,
          limits: {
            maxInputBytes:
              MAX_TILESET_IMAGE_BYTES,
            maxInputPixels:
              MAX_TILESET_INPUT_PIXELS,
            maxInputEdge: MAX_TILESET_INPUT_EDGE,
          },
        });
        if (create.imageWidth === undefined) {
          create.imageWidth = metadata.width;
          create.imageHeight = metadata.height;
        } else if (
          create.imageWidth !== metadata.width ||
          create.imageHeight !== metadata.height
        ) {
          throw new TiledMcpError(
            "TILESET_IMAGE_DIMENSION_MISMATCH",
            `${imagePath} is ${metadata.width}x${metadata.height} but the plan pinned ${create.imageWidth}x${create.imageHeight}.`,
            {
              path: imagePath,
              actualWidth: metadata.width,
              actualHeight: metadata.height,
              plannedWidth: create.imageWidth,
              plannedHeight: create.imageHeight,
            },
          );
        }
      } else if (
        update.removeCollectionTile !== undefined
      ) {
        inspectTilesetUsage(
          context.loaded.document,
          context.bindings,
          binding.assetId,
          context.loaded.path,
          update.tileId,
        );
        await this.scanDeleteReferences(
          binding.path,
          "tileset",
          context.loaded.path,
        );
      }
    }
  }

  async applyTilesetEdit(
    plan: TilesetEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    const patchedSource =
      await this.prepareTilesetEditBytes(plan);
    const result = await this.store.commitBytes(
      plan.tilesetPath,
      plan.baseRevision,
      patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  /**
   * Replays a tileset edit plan against current project state and returns
   * the patched TSJ bytes without committing them.
   */
  private async prepareTilesetEditBytes(
    plan: TilesetEditPlan,
  ): Promise<Buffer> {
    assertTilesetEditPlan(plan);
    const context = await this.loadEditableContext(
      plan.mapPath,
      {
        allowCollectionTilesets: true,
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
    await this.guardCollectionStructuralUpdates(
      context,
      binding,
      structuredClone(
        plan.updates,
      ) as TileMetadataUpdate[],
    );
    const edited = cloneJson(loaded.document);
    const applied = applyTileMetadataUpdates(
      edited,
      binding.tileCount,
      structuredClone(
        plan.updates,
      ) as TileMetadataUpdate[],
      binding.path,
      collectionProfileOf(binding),
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
    return patchJsonDocumentSource(
      loaded.source,
      edited,
      [],
      plan.tilesetPath,
      applied.patches.insertions,
      applied.patches.memberPatches,
      applied.patches.deletions,
      [],
    );
  }

  /**
   * Plans a tileset-level metadata patch against one external TSJ currently
   * referenced by the given map.
   *
   * The map is the addressing context (asset IDs are resolved through its
   * tileset bindings), which is why both revisions are pinned even though only
   * the TSJ is rewritten.
   */
  async planTilesetPropertyEdit(input: {
    mapPath: string;
    tilesetAssetId: string;
    expectedMapRevision: string;
    expectedTilesetRevision: string;
    patch: TilesetPropertyPatch;
  }): Promise<TilesetPropertyEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    assertRequiredRevision(
      input.expectedTilesetRevision,
      "expectedTilesetRevision",
    );
    const prepared =
      await this.prepareTilesetPropertyEdit(
        input.mapPath,
        input.tilesetAssetId,
        input.expectedMapRevision,
        input.expectedTilesetRevision,
        input.patch,
      );
    const unsignedPlan: Omit<
      TilesetPropertyEditPlan,
      "id"
    > = {
      kind: "tilesetPropertyEdit",
      version: 1,
      mapPath: prepared.mapPath,
      tilesetPath: prepared.tilesetPath,
      assetId: input.tilesetAssetId,
      baseRevision: input.expectedTilesetRevision,
      mapRevision: input.expectedMapRevision,
      patch: structuredClone(
        input.patch,
      ) as TilesetPropertyPatch,
      summary: prepared.summary,
    };
    return {
      ...unsignedPlan,
      id: tilesetPropertyEditPlanId(unsignedPlan),
    };
  }

  async applyTilesetPropertyEdit(
    plan: TilesetPropertyEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    assertTilesetPropertyEditPlan(plan);
    const prepared =
      await this.prepareTilesetPropertyEdit(
        plan.mapPath,
        plan.assetId,
        plan.mapRevision,
        plan.baseRevision,
        plan.patch,
      );
    if (
      prepared.tilesetPath !== plan.tilesetPath
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${plan.tilesetPath} no longer matches the pinned tileset binding.`,
        {
          assetId: plan.assetId,
          expectedPath: plan.tilesetPath,
          actualPath: prepared.tilesetPath,
        },
      );
    }
    if (
      stableJson(
        prepared.summary as unknown as JsonValue,
      ) !==
      stableJson(
        plan.summary as unknown as JsonValue,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The tileset property edit summary does not match its patch.",
      );
    }
    const result = await this.store.commitBytes(
      plan.tilesetPath,
      plan.baseRevision,
      prepared.source,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  /**
   * Shared plan/apply body: resolves the binding, replays the patch against a
   * clone, and returns both the summary and the patched bytes. Planning
   * discards the bytes; apply discards nothing.
   */
  private async prepareTilesetPropertyEdit(
    mapPath: string,
    tilesetAssetId: string,
    expectedMapRevision: string,
    expectedTilesetRevision: string,
    patch: TilesetPropertyPatch,
  ): Promise<{
    mapPath: string;
    tilesetPath: string;
    summary: TilesetPropertyEditSummary;
    source: Buffer;
  }> {
    const context = await this.loadEditableContext(
      mapPath,
      {
        allowCollectionTilesets: true,
        allowIsometric: true,
        allowStaggeredHexagonal: true,
        allowInfinite: true,
        expectedMapRevision,
        persistIdentity: true,
      },
    );
    const binding = this.requireTilesetBinding(
      context,
      tilesetAssetId,
    );
    if (
      binding.revision !== expectedTilesetRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed since it was read.`,
        {
          assetId: tilesetAssetId,
          expectedRevision:
            expectedTilesetRevision,
          actualRevision: binding.revision,
        },
      );
    }
    const loaded =
      await this.loadBoundTilesetForEdit(binding);
    const edited = cloneJson(loaded.document);
    const applied =
      applyTilesetPropertyPatch(
        edited,
        structuredClone(
          patch,
        ) as TilesetPropertyPatch,
        binding.path,
      );
    if (!applied.summary.wouldChange) {
      // Fail closed rather than hand back a change set whose apply would be a
      // byte-identical rewrite: an empty plan reads as "approved an edit".
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `The requested patch matches ${binding.path}'s current tileset properties, so there is nothing to apply.`,
        {
          path: binding.path,
          requestedFields:
            applied.summary.requestedFields,
        },
      );
    }
    return {
      mapPath: context.loaded.path,
      tilesetPath: binding.path,
      summary: applied.summary,
      source: patchJsonDocumentSource(
        loaded.source,
        edited,
        [],
        binding.path,
        [],
        applied.memberPatches,
        [],
        [],
      ),
    };
  }

  async planWangsetEdits(
    input: UpdateWangsetsInput,
  ): Promise<WangEditPlan> {
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
        allowCollectionTilesets: true,
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
    if (binding.collection === true) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        `${binding.path} is an image-collection tileset; Wang edits support only atlas tilesets.`,
        { assetId: binding.assetId },
      );
    }
    const loaded =
      await this.loadBoundTilesetForEdit(binding);
    const edited = cloneJson(loaded.document);
    const planned = applyWangEditOperations(
      edited,
      binding.path,
      binding.tileCount,
      structuredClone(
        input.operations,
      ) as WangEditOperation[],
    );
    const unsignedPlan: Omit<WangEditPlan, "id"> = {
      kind: "wangEdit",
      version: 1,
      mapPath: context.loaded.path,
      tilesetPath: binding.path,
      assetId: binding.assetId,
      baseRevision: binding.revision,
      mapRevision: context.loaded.revision,
      operations: structuredClone(
        input.operations,
      ) as WangEditOperation[],
      summary: planned.summary,
    };
    await assertRevisionUnchanged(
      this.store,
      binding.path,
      binding.revision,
      "DEPENDENCY_REVISION_CONFLICT",
      "the wang set edits were being prepared",
      { assetId: binding.assetId },
    );
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the wang set edits were being prepared",
    );
    return {
      ...unsignedPlan,
      id: wangEditPlanId(unsignedPlan),
    };
  }

  async applyWangsetEdit(
    plan: WangEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    const patchedSource =
      await this.prepareWangEditBytes(plan);
    const result = await this.store.commitBytes(
      plan.tilesetPath,
      plan.baseRevision,
      patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  /**
   * Replays a wang edit plan against current project state and returns
   * the patched TSJ bytes without committing them.
   */
  private async prepareWangEditBytes(
    plan: WangEditPlan,
  ): Promise<Buffer> {
    assertWangEditPlan(plan);
    const context = await this.loadEditableContext(
      plan.mapPath,
      {
        allowCollectionTilesets: true,
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
    if (binding.collection === true) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        `${binding.path} is an image-collection tileset; Wang edits support only atlas tilesets.`,
        { assetId: plan.assetId },
      );
    }
    const loaded =
      await this.loadBoundTilesetForEdit(binding);
    const edited = cloneJson(loaded.document);
    const applied = applyWangEditOperations(
      edited,
      binding.path,
      binding.tileCount,
      structuredClone(
        plan.operations,
      ) as WangEditOperation[],
    );
    if (
      stableJson(
        applied.summary as unknown as JsonValue,
      ) !==
      stableJson(plan.summary as unknown as JsonValue)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The wang edit summary does not match its operations.",
      );
    }
    return patchJsonDocumentSource(
      loaded.source,
      edited,
      [],
      plan.tilesetPath,
      [],
      applied.patches.memberPatches,
      [],
      [],
    );
  }

  /**
   * Plans one bounded `tiled --export-map/--export-tileset` conversion.
   * The CLI runs against a server-owned staging file (it never touches the
   * project directly); the approved output bytes' hash becomes the plan's
   * baseRevision, and apply re-runs the export under the pinned source
   * revision and fails closed on any byte drift.
   */
  async planExportFile(
    input: {
      sourcePath: string;
      targetPath: string;
      format?: string;
      expectedSourceRevision?: string;
    },
    runner: TiledExportRunner,
    allowedFormats: {
      map: readonly string[];
      tileset: readonly string[];
    },
  ): Promise<FileExportPlan> {
    const sourcePath = this.resolver.normalize(
      input.sourcePath,
    );
    const targetPath = this.resolver.normalize(
      input.targetPath,
    );
    const sourceExtension = posix
      .extname(sourcePath)
      .toLowerCase();
    const exportKind =
      sourceExtension === ".tmj"
        ? ("map" as const)
        : sourceExtension === ".tsj"
          ? ("tileset" as const)
          : undefined;
    if (exportKind === undefined) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Export sources must be project .tmj maps or .tsj tilesets.",
        { path: sourcePath },
      );
    }
    if (targetPath === sourcePath) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The export target must differ from its source.",
        { path: sourcePath },
      );
    }
    const format =
      input.format ??
      posix
        .extname(targetPath)
        .toLowerCase()
        .slice(1);
    if (!EXPORT_FORMAT_PATTERN.test(format)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The export format must be a short lowercase alphanumeric identifier (explicit or via the target extension).",
        { format },
      );
    }
    const whitelist =
      exportKind === "map"
        ? allowedFormats.map
        : allowedFormats.tileset;
    if (!whitelist.includes(format)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `The installed Tiled CLI does not advertise ${exportKind} export format ${JSON.stringify(format)}.`,
        { format, allowed: [...whitelist] },
      );
    }
    const snapshot =
      await this.store.readSnapshot(sourcePath);
    if (
      input.expectedSourceRevision !== undefined &&
      snapshot.revision !==
        input.expectedSourceRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${sourcePath} does not match the expected source revision.`,
        {
          path: sourcePath,
          expectedRevision:
            input.expectedSourceRevision,
          actualRevision: snapshot.revision,
        },
      );
    }
    await this.assertExportTargetAbsent(
      targetPath,
    );
    const content = await this.runExport(
      runner,
      exportKind,
      format,
      sourcePath,
      snapshot.revision,
    );
    const unsignedPlan: Omit<
      FileExportPlan,
      "id"
    > = {
      kind: "fileExport",
      version: 1,
      producer: "tiled-cli",
      sourcePath,
      sourceRevision: snapshot.revision,
      targetPath,
      exportKind,
      format,
      baseRevision: revisionOf(content),
      summary: {
        sourcePath,
        targetPath,
        exportKind,
        format,
        contentBytes: content.byteLength,
        wouldChange: true,
      },
    };
    return {
      ...unsignedPlan,
      id: fileExportPlanId(unsignedPlan),
    };
  }

  /**
   * Builds a class-property resolver from one .tiled-project document:
   * class name to member-name -> declared type (with propertyType for
   * nested class members). Enum-typed members stay unresolved so the
   * serializer fails closed on them.
   */
  private buildClassResolver(
    document: JsonObject,
    projectFilePath: string,
  ): ClassPropertyResolver {
    const classes = new Map<
      string,
      Map<
        string,
        { type: string; propertyType?: string }
      >
    >();
    const types = document.propertyTypes;
    if (types !== undefined) {
      for (const entry of expectArray(
        types,
        `${projectFilePath}.propertyTypes`,
      )) {
        const record = expectObject(
          entry,
          `${projectFilePath}.propertyTypes[]`,
        );
        if (record.type !== "class") {
          continue;
        }
        const name = expectString(
          record.name,
          `${projectFilePath}.propertyTypes[].name`,
        );
        const members = new Map<
          string,
          {
            type: string;
            propertyType?: string;
          }
        >();
        for (const member of expectArray(
          record.members ?? [],
          `${projectFilePath}.propertyTypes[].members`,
        )) {
          const memberRecord = expectObject(
            member,
            `${projectFilePath} class member`,
          );
          members.set(
            expectString(
              memberRecord.name,
              "member.name",
            ),
            {
              type: expectString(
                memberRecord.type ?? "string",
                "member.type",
              ),
              ...(memberRecord.propertyType ===
              undefined
                ? {}
                : {
                    propertyType: expectString(
                      memberRecord.propertyType,
                      "member.propertyType",
                    ),
                  }),
            },
          );
        }
        classes.set(name, members);
      }
    }
    return (name) => classes.get(name);
  }

  private async loadClassResolver(
    projectFilePath: string | undefined,
  ): Promise<{
    resolver: ClassPropertyResolver | undefined;
    pin?: {
      projectFilePath: string;
      projectRevision: string;
    };
  }> {
    if (projectFilePath === undefined) {
      return { resolver: undefined };
    }
    const normalized = this.resolver.normalize(
      projectFilePath,
    );
    const snapshot =
      await this.store.read(normalized);
    return {
      resolver: this.buildClassResolver(
        snapshot.document,
        normalized,
      ),
      pin: {
        projectFilePath: normalized,
        projectRevision: snapshot.revision,
      },
    };
  }

  /**
   * Native TMX write: serializes one restricted-profile .tmj map to
   * TMX bytes matching Tiled 1.12.2's own writer byte for byte and
   * returns a fileExport change set whose producer is the native
   * serializer, so apply re-serializes and hash-verifies without any
   * CLI. Tileset references and GIDs carry verbatim, which is why the
   * target must live in the source map's directory; anything the
   * serializer does not fully understand fails closed.
   */
  async planWriteTmx(input: {
    mapPath: string;
    targetPath: string;
    expectedMapRevision: string;
    projectFilePath?: string | undefined;
  }): Promise<FileExportPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const sourcePath = this.resolver.normalize(
      input.mapPath,
    );
    const targetPath = this.resolver.normalize(
      input.targetPath,
    );
    if (
      posix.extname(sourcePath).toLowerCase() !==
      ".tmj"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Native TMX writing reads project .tmj maps.",
        { path: sourcePath },
      );
    }
    if (
      posix.extname(targetPath).toLowerCase() !==
      ".tmx"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "The native TMX write target must use the .tmx extension.",
        { path: targetPath },
      );
    }
    if (
      posix.dirname(targetPath) !==
      posix.dirname(sourcePath)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The TMX target must live in the source map's directory so relative tileset references keep resolving.",
        { sourcePath, targetPath },
      );
    }
    const snapshot = await this.store.read(
      sourcePath,
    );
    if (
      snapshot.revision !==
      input.expectedMapRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${sourcePath} does not match the expected map revision.`,
        {
          path: sourcePath,
          expectedRevision:
            input.expectedMapRevision,
          actualRevision: snapshot.revision,
        },
      );
    }
    await this.assertExportTargetAbsent(
      targetPath,
    );
    const project =
      await this.loadClassResolver(
        input.projectFilePath,
      );
    const content = Buffer.from(
      serializeTmxMap(
        snapshot.document,
        sourcePath,
        project.resolver,
      ),
      "utf8",
    );
    const unsignedPlan: Omit<
      FileExportPlan,
      "id"
    > = {
      kind: "fileExport",
      version: 1,
      producer: "native",
      sourcePath,
      sourceRevision: snapshot.revision,
      targetPath,
      exportKind: "map",
      format: "tmx",
      ...(project.pin ?? {}),
      baseRevision: revisionOf(content),
      summary: {
        sourcePath,
        targetPath,
        exportKind: "map",
        format: "tmx",
        contentBytes: content.byteLength,
        wouldChange: true,
      },
    };
    return {
      ...unsignedPlan,
      id: fileExportPlanId(unsignedPlan),
    };
  }

  /**
   * Native TSX write: serializes one restricted-profile .tsj atlas
   * tileset to TSX bytes matching Tiled 1.12.2's own writer, as a new
   * sibling .tsx file. The declared grid must be derivable from the
   * image size (the official exporter recomputes it); per-tile
   * metadata, wang sets, and custom properties fail closed.
   */
  async planWriteTsx(input: {
    tilesetPath: string;
    targetPath: string;
    expectedTilesetRevision: string;
    projectFilePath?: string | undefined;
  }): Promise<FileExportPlan> {
    assertRequiredRevision(
      input.expectedTilesetRevision,
      "expectedTilesetRevision",
    );
    const sourcePath = this.resolver.normalize(
      input.tilesetPath,
    );
    const targetPath = this.resolver.normalize(
      input.targetPath,
    );
    if (
      posix.extname(sourcePath).toLowerCase() !==
      ".tsj"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Native TSX writing reads project .tsj tilesets.",
        { path: sourcePath },
      );
    }
    if (
      posix.extname(targetPath).toLowerCase() !==
      ".tsx"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "The native TSX write target must use the .tsx extension.",
        { path: targetPath },
      );
    }
    if (
      posix.dirname(targetPath) !==
      posix.dirname(sourcePath)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The TSX target must live in the source tileset's directory so the relative image reference keeps resolving.",
        { sourcePath, targetPath },
      );
    }
    const snapshot =
      await this.store.read(sourcePath);
    if (
      snapshot.revision !==
      input.expectedTilesetRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${sourcePath} does not match the expected tileset revision.`,
        {
          path: sourcePath,
          expectedRevision:
            input.expectedTilesetRevision,
          actualRevision: snapshot.revision,
        },
      );
    }
    await this.assertExportTargetAbsent(
      targetPath,
    );
    const project =
      await this.loadClassResolver(
        input.projectFilePath,
      );
    const content = Buffer.from(
      serializeTsxTileset(
        snapshot.document,
        sourcePath,
        project.resolver,
      ),
      "utf8",
    );
    const unsignedPlan: Omit<
      FileExportPlan,
      "id"
    > = {
      kind: "fileExport",
      version: 1,
      producer: "native",
      sourcePath,
      sourceRevision: snapshot.revision,
      targetPath,
      exportKind: "tileset",
      format: "tsx",
      ...(project.pin ?? {}),
      baseRevision: revisionOf(content),
      summary: {
        sourcePath,
        targetPath,
        exportKind: "tileset",
        format: "tsx",
        contentBytes: content.byteLength,
        wouldChange: true,
      },
    };
    return {
      ...unsignedPlan,
      id: fileExportPlanId(unsignedPlan),
    };
  }

  /**
   * Native TX write: serializes one restricted-profile .tj object
   * template to TX bytes following Tiled 1.12.2's writeObjectTemplate
   * (template base objects drop id/x/y), as a new sibling .tx file.
   * Tile templates and nested templates fail closed.
   */
  async planWriteTx(input: {
    templatePath: string;
    targetPath: string;
    expectedTemplateRevision: string;
    projectFilePath?: string | undefined;
  }): Promise<FileExportPlan> {
    assertRequiredRevision(
      input.expectedTemplateRevision,
      "expectedTemplateRevision",
    );
    const sourcePath = this.resolver.normalize(
      input.templatePath,
    );
    const targetPath = this.resolver.normalize(
      input.targetPath,
    );
    if (
      posix.extname(sourcePath).toLowerCase() !==
      ".tj"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Native TX writing reads project .tj templates.",
        { path: sourcePath },
      );
    }
    if (
      posix.extname(targetPath).toLowerCase() !==
      ".tx"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "The native TX write target must use the .tx extension.",
        { path: targetPath },
      );
    }
    if (
      posix.dirname(targetPath) !==
      posix.dirname(sourcePath)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The TX target must live in the source template's directory.",
        { sourcePath, targetPath },
      );
    }
    const snapshot =
      await this.store.read(sourcePath);
    if (
      snapshot.revision !==
      input.expectedTemplateRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${sourcePath} does not match the expected template revision.`,
        {
          path: sourcePath,
          expectedRevision:
            input.expectedTemplateRevision,
          actualRevision: snapshot.revision,
        },
      );
    }
    await this.assertExportTargetAbsent(
      targetPath,
    );
    const project =
      await this.loadClassResolver(
        input.projectFilePath,
      );
    const content = Buffer.from(
      serializeTxTemplate(
        snapshot.document,
        sourcePath,
        project.resolver,
      ),
      "utf8",
    );
    const unsignedPlan: Omit<
      FileExportPlan,
      "id"
    > = {
      kind: "fileExport",
      version: 1,
      producer: "native",
      sourcePath,
      sourceRevision: snapshot.revision,
      targetPath,
      exportKind: "template",
      format: "tx",
      ...(project.pin ?? {}),
      baseRevision: revisionOf(content),
      summary: {
        sourcePath,
        targetPath,
        exportKind: "template",
        format: "tx",
        contentBytes: content.byteLength,
        wouldChange: true,
      },
    };
    return {
      ...unsignedPlan,
      id: fileExportPlanId(unsignedPlan),
    };
  }

  /**
   * Reads the server-owned .tiledmcp/tile-names.json registry: a
   * validated name -> {tileset, localId} map letting later requests
   * reference tiles by semantic name. Every referenced tileset must
   * exist and gets its revision pinned into the result; the registry
   * is weak metadata, so localId is disclosed verbatim without
   * re-checking tileset contents. A missing registry file reads as
   * empty rather than failing.
   */
  async listTileNames(): Promise<
    Record<string, unknown>
  > {
    const directory =
      await this.resolver.ensureInternalDirectory(
        ".tiledmcp",
      );
    const filePath = join(
      directory,
      TILE_NAMES_FILE,
    );
    let raw: Buffer;
    try {
      raw = await readFile(filePath);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return {
          registryPresent: false,
          names: [],
          count: 0,
          snapshotConsistency:
            "non-atomic-read-set",
        };
      }
      throw error;
    }
    if (raw.byteLength > MAX_TILE_NAMES_BYTES) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `The tile-name registry may be at most ${MAX_TILE_NAMES_BYTES} bytes.`,
        { limit: MAX_TILE_NAMES_BYTES },
      );
    }
    let document: JsonObject;
    try {
      document = JSON.parse(
        raw.toString("utf8"),
      ) as JsonObject;
    } catch {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        ".tiledmcp/tile-names.json is not valid JSON.",
      );
    }
    if (
      typeof document !== "object" ||
      document === null ||
      Array.isArray(document)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        ".tiledmcp/tile-names.json must hold a JSON object.",
      );
    }
    const entries = readTileNamesDocument(
      document,
      ".tiledmcp/tile-names.json",
    );
    const names: Array<
      Record<string, unknown>
    > = [];
    for (const entry of entries) {
      const tilesetPath =
        this.resolver.normalize(entry.tileset);
      if (
        posix
          .extname(tilesetPath)
          .toLowerCase() !== ".tsj"
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_FORMAT",
          `Tile name ${JSON.stringify(entry.name)} references ${tilesetPath}; the registry covers project .tsj tilesets.`,
        );
      }
      const revision =
        await this.store.readRevision(
          tilesetPath,
        );
      names.push({
        name: entry.name,
        tileset: {
          path: tilesetPath,
          revision,
        },
        localId: entry.localId,
      });
    }
    return {
      registryPresent: true,
      revision: revisionOf(raw),
      names,
      count: names.length,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  private async readTileNameRegistry(): Promise<{
    revision: Revision | null;
    names: Map<
      string,
      { tileset: string; localId: number }
    >;
  }> {
    const directory =
      await this.resolver.ensureInternalDirectory(
        ".tiledmcp",
      );
    let raw: Buffer;
    try {
      raw = await readFile(
        join(directory, TILE_NAMES_FILE),
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return {
          revision: null,
          names: new Map(),
        };
      }
      throw error;
    }
    if (raw.byteLength > MAX_TILE_NAMES_BYTES) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `The tile-name registry may be at most ${MAX_TILE_NAMES_BYTES} bytes.`,
        { limit: MAX_TILE_NAMES_BYTES },
      );
    }
    let document: JsonObject;
    try {
      document = JSON.parse(
        raw.toString("utf8"),
      ) as JsonObject;
    } catch {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        ".tiledmcp/tile-names.json is not valid JSON.",
      );
    }
    const entries = readTileNamesDocument(
      document,
      ".tiledmcp/tile-names.json",
    );
    return {
      revision: revisionOf(raw),
      names: new Map(
        entries.map((entry) => [
          entry.name,
          {
            tileset: entry.tileset,
            localId: entry.localId,
          },
        ]),
      ),
    };
  }

  /**
   * Previews upsert/delete edits to the server-owned tile-name
   * registry as a tileNameEdit change set. Upserted tilesets must
   * exist as project .tsj files (re-verified at apply); the registry
   * file's revision — or its absence — is pinned so a concurrent
   * registry write fails closed.
   */
  async planTileNameEdits(input: {
    operations: TileNameOperation[];
    expectedRegistryRevision?:
      | string
      | null
      | undefined;
  }): Promise<TileNameEditPlan> {
    if (
      !Array.isArray(input.operations) ||
      input.operations.length === 0 ||
      input.operations.length >
        MAX_TILE_NAME_OPERATIONS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `operations must contain between 1 and ${MAX_TILE_NAME_OPERATIONS} entries.`,
        { limit: MAX_TILE_NAME_OPERATIONS },
      );
    }
    const operations: TileNameOperation[] = [];
    let upserts = 0;
    let deletes = 0;
    for (const operation of input.operations) {
      if (operation.type === "upsertName") {
        const tilesetPath =
          this.resolver.normalize(
            operation.tileset,
          );
        if (
          posix
            .extname(tilesetPath)
            .toLowerCase() !== ".tsj"
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_FORMAT",
            `Tile names reference project .tsj tilesets; got ${tilesetPath}.`,
          );
        }
        await this.store.readRevision(
          tilesetPath,
        );
        operations.push({
          type: "upsertName",
          name: operation.name,
          tileset: tilesetPath,
          localId: operation.localId,
        });
        upserts += 1;
      } else {
        operations.push({
          type: "deleteName",
          name: operation.name,
        });
        deletes += 1;
      }
    }
    const registry =
      await this.readTileNameRegistry();
    if (
      input.expectedRegistryRevision !==
        undefined &&
      registry.revision !==
        input.expectedRegistryRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        "The tile-name registry does not match the expected revision.",
        {
          expectedRevision:
            input.expectedRegistryRevision,
          actualRevision: registry.revision,
        },
      );
    }
    const next = applyTileNameOperations(
      registry.names,
      operations,
    );
    const content = Buffer.from(
      serializeTileNames(next),
      "utf8",
    );
    const unsignedPlan: Omit<
      TileNameEditPlan,
      "id"
    > = {
      kind: "tileNameEdit",
      version: 1,
      registryRevision: registry.revision,
      baseRevision: revisionOf(content),
      operations,
      summary: {
        upserts,
        deletes,
        resultingCount: next.size,
        wouldChange: true,
      },
    };
    return {
      ...unsignedPlan,
      id: tileNameEditPlanId(unsignedPlan),
    };
  }

  async applyTileNameEdit(
    plan: TileNameEditPlan,
  ): Promise<TileNameEditApplyResult> {
    assertTileNameEditPlan(plan);
    const registry =
      await this.readTileNameRegistry();
    if (
      registry.revision !== plan.registryRevision
    ) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        "The tile-name registry changed since the edit was planned.",
        {
          expectedRevision:
            plan.registryRevision,
          actualRevision: registry.revision,
        },
      );
    }
    for (const operation of plan.operations) {
      if (operation.type === "upsertName") {
        await this.store.readRevision(
          operation.tileset,
        );
      }
    }
    const next = applyTileNameOperations(
      registry.names,
      plan.operations,
    );
    const content = Buffer.from(
      serializeTileNames(next),
      "utf8",
    );
    if (revisionOf(content) !== plan.baseRevision) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "Replaying the tile-name edits produced different content than the approved plan; preview again.",
      );
    }
    // Commit through the store so the registry gets the same lock, atomic
    // rename and fsync as every other applied change set. The revision guard
    // above is an early, better-worded rejection; the authoritative one runs
    // inside the lock, where it can actually exclude a concurrent writer.
    const committed =
      await this.store.commitInternalFile(
        ".tiledmcp",
        TILE_NAMES_FILE,
        plan.registryRevision,
        content,
      );
    return {
      path: committed.path,
      beforeRevision: committed.beforeRevision,
      revision: committed.revision,
      changed: true,
      changeSetId: plan.id,
      nameCount: next.size,
    };
  }

  /**
   * Magic-wand selection: four-way flood from the seed cell across
   * cells sharing its base GID (flip bits ignored; an empty seed
   * floods the empty area), bounded by the requested region. The
   * result carries the seed's base GID so callers know what value the
   * wand grabbed.
   */
  private selectMagicWand(
    context: EditableContext,
    view: TileLayerView,
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    },
    seed: { x: number; y: number },
    sampleLimit: number,
  ): Record<string, unknown> {
    if (
      !Number.isSafeInteger(seed.x) ||
      !Number.isSafeInteger(seed.y) ||
      seed.x < region.x ||
      seed.y < region.y ||
      seed.x >= region.x + region.width ||
      seed.y >= region.y + region.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The magic-wand seed must lie inside the selection region.",
        { seed },
      );
    }
    const baseOf = (
      x: number,
      y: number,
    ): number =>
      decodeGid(
        readLayerGid(view, x, y),
        context.orientation,
      ).baseGid;
    const target = baseOf(seed.x, seed.y);
    const visited = new Set<number>();
    const key = (x: number, y: number): number =>
      (y - region.y) * region.width +
      (x - region.x);
    const queue: Array<[number, number]> = [
      [seed.x, seed.y],
    ];
    visited.add(key(seed.x, seed.y));
    let count = 0;
    let minX = seed.x;
    let minY = seed.y;
    let maxX = seed.x;
    let maxY = seed.y;
    const sample: Array<{
      x: number;
      y: number;
    }> = [];
    while (queue.length > 0) {
      const [x, y] = queue.pop()!;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (sample.length < sampleLimit) {
        sample.push({ x, y });
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (
          nx < region.x ||
          ny < region.y ||
          nx >= region.x + region.width ||
          ny >= region.y + region.height ||
          visited.has(key(nx, ny)) ||
          baseOf(nx, ny) !== target
        ) {
          continue;
        }
        visited.add(key(nx, ny));
        queue.push([nx, ny]);
      }
    }
    sample.sort(
      (a, b) => a.y - b.y || a.x - b.x,
    );
    return {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      layerId: view.id,
      region,
      match: "magicWand",
      seed,
      seedBaseGid: target,
      cellCount: count,
      bounds: {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
      cells: sample,
      cellsTruncated: count > sample.length,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  /**
   * Image import: resamples one project reference image onto the
   * target cell grid (each cell averaging its alpha-weighted pixel
   * block), maps every cell to the nearest palette color by squared
   * RGB distance (ties resolve to palette order), and returns an
   * ordinary setTiles change set. Fully transparent blocks are
   * skipped; a null palette tile erases where its color wins. Pure
   * integer arithmetic — the same image and palette always produce
   * the same plan.
   */
  async planImportImage(input: {
    mapPath: string;
    layerId: number;
    imagePath: string;
    region: GenerateRegion;
    palette: Array<{
      color: string;
      tile: TileRef | null;
    }>;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
  }): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const region = input.region;
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1 ||
      region.width * region.height >
        MAX_GENERATE_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must use non-negative integer coordinates, positive dimensions, and at most ${MAX_GENERATE_CELLS} cells.`,
        { limit: MAX_GENERATE_CELLS },
      );
    }
    if (
      input.palette.length < 1 ||
      input.palette.length > 32
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "palette must contain between 1 and 32 colors.",
      );
    }
    const paletteColors = input.palette.map(
      (entry, index) => {
        const match =
          /^#([0-9a-f]{6})$/iu.exec(
            entry.color,
          );
        if (match === null) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `palette[${index}].color must be a #rrggbb color.`,
          );
        }
        const value = Number.parseInt(
          match[1]!,
          16,
        );
        return [
          (value >> 16) & 0xff,
          (value >> 8) & 0xff,
          value & 0xff,
        ] as const;
      },
    );
    const context =
      await this.loadEditableContext(
        input.mapPath,
        {
          allowIsometric: true,
          expectedMapRevision:
            input.expectedMapRevision,
          expectedDependencyRevisions:
            input.expectedDependencyRevisions,
        },
      );
    if (
      region.x + region.width > context.width ||
      region.y + region.height > context.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must lie inside the ${context.width}x${context.height} map.`,
        {
          mapWidth: context.width,
          mapHeight: context.height,
        },
      );
    }
    const snapshot =
      await readImageFileSnapshot(
        this.resolver,
        input.imagePath,
        MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
      );
    const decoded = await decodeSafeImageRgba({
      path: snapshot.path,
      bytes: snapshot.bytes,
      limits: {
        maxInputBytes:
          MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
        maxInputPixels:
          MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
        maxInputEdge: 8_192,
      },
    });
    const { rgba, width: imageWidth, height: imageHeight } =
      decoded;
    const cells: Array<{
      x: number;
      y: number;
      tile: TileRef | null;
    }> = [];
    for (
      let cy = 0;
      cy < region.height;
      cy += 1
    ) {
      const top = Math.floor(
        (cy * imageHeight) / region.height,
      );
      const bottom = Math.max(
        top + 1,
        Math.floor(
          ((cy + 1) * imageHeight) /
            region.height,
        ),
      );
      for (
        let cx = 0;
        cx < region.width;
        cx += 1
      ) {
        const left = Math.floor(
          (cx * imageWidth) / region.width,
        );
        const right = Math.max(
          left + 1,
          Math.floor(
            ((cx + 1) * imageWidth) /
              region.width,
          ),
        );
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumA = 0;
        for (let py = top; py < bottom; py += 1) {
          for (
            let px = left;
            px < right;
            px += 1
          ) {
            const index =
              (py * imageWidth + px) * 4;
            const alpha = rgba[index + 3]!;
            sumR += rgba[index]! * alpha;
            sumG += rgba[index + 1]! * alpha;
            sumB += rgba[index + 2]! * alpha;
            sumA += alpha;
          }
        }
        if (sumA === 0) {
          continue;
        }
        const r = Math.round(sumR / sumA);
        const g = Math.round(sumG / sumA);
        const b = Math.round(sumB / sumA);
        let bestIndex = 0;
        let bestDistance =
          Number.POSITIVE_INFINITY;
        for (const [
          index,
          [pr, pg, pb],
        ] of paletteColors.entries()) {
          const distance =
            (r - pr) * (r - pr) +
            (g - pg) * (g - pg) +
            (b - pb) * (b - pb);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
        cells.push({
          x: region.x + cx,
          y: region.y + cy,
          tile:
            input.palette[bestIndex]!.tile,
        });
      }
    }
    if (cells.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The reference image is fully transparent over the region; nothing to import.",
      );
    }
    return this.planEdits(
      input.mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      [
        {
          type: "setTiles",
          layerId: input.layerId,
          cells,
        },
      ],
    );
  }

  /**
   * Resolves semantic tile names against the registry and the map's
   * tileset bindings: a {name} reference becomes an ordinary external
   * TileRef whose tileset must already be bound to the map (pointing
   * callers at tiled_add_tileset_to_map otherwise) and whose localId
   * must fall inside the atlas. Plain TileRefs and nulls pass through
   * untouched, and the registry is only read when a name appears.
   */
  async resolveNamedTiles<
    T extends TileRef | { name: string } | null,
  >(
    mapPath: string,
    values: readonly T[],
  ): Promise<Array<TileRef | null>> {
    const hasName = values.some(
      (value) =>
        value !== null &&
        typeof (value as { name?: unknown })
          .name === "string",
    );
    if (!hasName) {
      return [...values] as Array<
        TileRef | null
      >;
    }
    const registry =
      await this.readTileNameRegistry();
    const context =
      await this.loadEditableContext(mapPath, {
        allowIsometric: true,
        allowStaggeredHexagonal: true,
      });
    return values.map((value) => {
      if (
        value === null ||
        typeof (value as { name?: unknown })
          .name !== "string"
      ) {
        return value as TileRef | null;
      }
      const name = (value as { name: string })
        .name;
      const entry = registry.names.get(name);
      if (entry === undefined) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `Tile name ${JSON.stringify(name)} is not registered; see tiled_list_tile_names.`,
          { name },
        );
      }
      const tilesetPath =
        this.resolver.normalize(entry.tileset);
      const binding = context.bindings.find(
        (candidate) =>
          candidate.path === tilesetPath,
      );
      if (binding === undefined) {
        throw new TiledMcpError(
          "TILESET_NOT_FOUND",
          `Tile name ${JSON.stringify(name)} resolves to ${tilesetPath}, which is not bound to ${mapPath}; attach it with tiled_add_tileset_to_map first.`,
          { name, tilesetPath },
        );
      }
      if (
        binding.collection !== true &&
        entry.localId >= binding.tileCount
      ) {
        throw new TiledMcpError(
          "TILE_ID_OUT_OF_RANGE",
          `Tile name ${JSON.stringify(name)} points at local id ${entry.localId}, outside ${tilesetPath} (${binding.tileCount} tiles).`,
          { name, localId: entry.localId },
        );
      }
      return {
        tileset: {
          kind: "external" as const,
          assetId: binding.assetId,
        },
        localId: entry.localId,
      };
    });
  }

  /**
   * Stateless selection: evaluates one predicate — a tile set matched
   * by tileset+localId (flip bits ignored), empty cells, or non-empty
   * cells — over one bounded tile-layer region and returns the
   * selection as data: exact count, tight bounding box, and a bounded
   * cell sample. No selection id or server state exists; callers feed
   * the result into region- or cell-based tools explicitly.
   */
  /**
   * Composed selection: starts from the empty set and folds up to 8
   * union/intersect/subtract steps, each evaluating one base predicate
   * to a region mask. Deterministic by construction — the same steps
   * always produce the same mask.
   */
  private selectComposed(
    context: EditableContext,
    layerId: number,
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    },
    steps: Array<{
      op: "union" | "intersect" | "subtract";
      match: SelectBaseMatch;
    }>,
    sampleLimit: number,
  ): Record<string, unknown> {
    if (steps.length < 1 || steps.length > 8) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "compose.steps must contain 1 to 8 steps.",
      );
    }
    const view = findTileLayer(
      context.loaded.document,
      layerId,
      context.loaded.path,
      "read",
    );
    assertRegionInsideLayer(
      view,
      region.x,
      region.y,
      region.width,
      region.height,
    );
    const size = region.width * region.height;
    let mask = new Uint8Array(size);
    for (const step of steps) {
      const stepMask = this.buildSelectionMask(
        context,
        view,
        region,
        step.match,
      );
      const next = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        const a = mask[index] === 1;
        const b = stepMask[index] === 1;
        next[index] =
          step.op === "union"
            ? a || b
              ? 1
              : 0
            : step.op === "intersect"
              ? a && b
                ? 1
                : 0
              : a && !b
                ? 1
                : 0;
      }
      mask = next;
    }
    let count = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const sample: Array<{
      x: number;
      y: number;
    }> = [];
    for (let index = 0; index < size; index += 1) {
      if (mask[index] !== 1) {
        continue;
      }
      const x =
        region.x + (index % region.width);
      const y =
        region.y +
        Math.floor(index / region.width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (sample.length < sampleLimit) {
        sample.push({ x, y });
      }
    }
    return {
      map: {
        path: context.loaded.path,
        revision: context.loaded.revision,
      },
      layerId: view.id,
      region,
      match: "compose",
      cellCount: count,
      ...(count > 0
        ? {
            bounds: {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
          }
        : {}),
      cells: sample,
      cellsTruncated: count > sample.length,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  /** Evaluates one base predicate to a region-local mask. */
  private buildSelectionMask(
    context: EditableContext,
    view: TileLayerView,
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    },
    match: SelectBaseMatch,
  ): Uint8Array {
    const size = region.width * region.height;
    const mask = new Uint8Array(size);
    if (match.kind === "magicWand") {
      const seed = match.seed;
      if (
        !Number.isSafeInteger(seed.x) ||
        !Number.isSafeInteger(seed.y) ||
        seed.x < region.x ||
        seed.y < region.y ||
        seed.x >= region.x + region.width ||
        seed.y >= region.y + region.height
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "The magic-wand seed must lie inside the selection region.",
          { seed },
        );
      }
      const baseOf = (
        x: number,
        y: number,
      ): number =>
        decodeGid(
          readLayerGid(view, x, y),
          context.orientation,
        ).baseGid;
      const target = baseOf(seed.x, seed.y);
      const key = (
        x: number,
        y: number,
      ): number =>
        (y - region.y) * region.width +
        (x - region.x);
      const queue: Array<[number, number]> = [
        [seed.x, seed.y],
      ];
      mask[key(seed.x, seed.y)] = 1;
      while (queue.length > 0) {
        const [x, y] = queue.pop()!;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (
            nx < region.x ||
            ny < region.y ||
            nx >= region.x + region.width ||
            ny >= region.y + region.height ||
            mask[key(nx, ny)] === 1 ||
            baseOf(nx, ny) !== target
          ) {
            continue;
          }
          mask[key(nx, ny)] = 1;
          queue.push([nx, ny]);
        }
      }
      return mask;
    }
    let matchGids: Set<number> | undefined;
    if (match.kind === "tiles") {
      if (
        match.tiles.length < 1 ||
        match.tiles.length > 16
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "match.tiles must contain between 1 and 16 tiles.",
        );
      }
      matchGids = new Set(
        match.tiles.map(
          (tile) =>
            decodeGid(
              tileRefToGid(
                tile,
                context.orientation,
                context.bindings,
              ),
              context.orientation,
            ).baseGid,
        ),
      );
    }
    let insidePolygon:
      | ((x: number, y: number) => boolean)
      | undefined;
    if (match.kind === "polygon") {
      const points = match.points;
      if (
        points.length < 3 ||
        points.length > 64 ||
        points.some(
          (point) =>
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y),
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "match.points must contain 3 to 64 finite pixel-coordinate points.",
        );
      }
      const tilePixelWidth = expectInteger(
        context.loaded.document.tilewidth,
        `${context.loaded.path}.tilewidth`,
      );
      const tilePixelHeight = expectInteger(
        context.loaded.document.tileheight,
        `${context.loaded.path}.tileheight`,
      );
      insidePolygon = (
        cellX: number,
        cellY: number,
      ): boolean => {
        const px =
          (cellX + 0.5) * tilePixelWidth;
        const py =
          (cellY + 0.5) * tilePixelHeight;
        let inside = false;
        for (
          let i = 0, j = points.length - 1;
          i < points.length;
          j = i, i += 1
        ) {
          const a = points[i]!;
          const b = points[j]!;
          if (
            a.y > py !== b.y > py &&
            px <
              ((b.x - a.x) * (py - a.y)) /
                (b.y - a.y) +
                a.x
          ) {
            inside = !inside;
          }
        }
        return inside;
      };
    }
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
        let matched: boolean;
        if (match.kind === "empty") {
          matched =
            readLayerGid(view, x, y) === 0;
        } else if (match.kind === "nonEmpty") {
          matched =
            readLayerGid(view, x, y) !== 0;
        } else if (match.kind === "polygon") {
          matched = insidePolygon!(x, y);
        } else {
          const gid = readLayerGid(view, x, y);
          matched =
            gid !== 0 &&
            matchGids!.has(
              decodeGid(
                gid,
                context.orientation,
              ).baseGid,
            );
        }
        if (matched) {
          mask[
            (y - region.y) * region.width +
              (x - region.x)
          ] = 1;
        }
      }
    }
    return mask;
  }

  async selectCells(input: {
    mapPath: string;
    layerId: number;
    region?:
      | {
          x: number;
          y: number;
          width: number;
          height: number;
        }
      | undefined;
    match:
      | { kind: "tiles"; tiles: TileRef[] }
      | { kind: "empty" }
      | { kind: "nonEmpty" }
      | {
          kind: "magicWand";
          seed: { x: number; y: number };
        }
      | {
          kind: "polygon";
          points: Array<{
            x: number;
            y: number;
          }>;
        }
      | {
          kind: "compose";
          steps: Array<{
            op:
              | "union"
              | "intersect"
              | "subtract";
            match: SelectBaseMatch;
          }>;
        };
    sampleLimit?: number | undefined;
  }): Promise<Record<string, unknown>> {
    const sampleLimit =
      input.sampleLimit ?? 2_048;
    if (
      !Number.isSafeInteger(sampleLimit) ||
      sampleLimit < 1 ||
      sampleLimit > 10_000
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "sampleLimit must be an integer between 1 and 10,000.",
      );
    }
    const context =
      await this.loadEditableContext(
        input.mapPath,
        {
          allowIsometric: true,
          allowStaggeredHexagonal: true,
        },
      );
    const mapPath = context.loaded.path;
    const region = input.region ?? {
      x: 0,
      y: 0,
      width: context.width,
      height: context.height,
    };
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1 ||
      region.x + region.width >
        context.width ||
      region.y + region.height >
        context.height ||
      region.width * region.height >
        MAX_REGION_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must lie inside the ${context.width}x${context.height} map and contain at most ${MAX_REGION_CELLS} cells.`,
        { limit: MAX_REGION_CELLS },
      );
    }
    if (input.match.kind === "compose") {
      return this.selectComposed(
        context,
        input.layerId,
        region,
        input.match.steps,
        sampleLimit,
      );
    }
    const matchGids = new Set<number>();
    if (input.match.kind === "tiles") {
      if (
        input.match.tiles.length < 1 ||
        input.match.tiles.length > 16
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "match.tiles must contain between 1 and 16 tiles.",
        );
      }
      for (const tile of input.match.tiles) {
        matchGids.add(
          decodeGid(
            tileRefToGid(
              tile,
              context.orientation,
              context.bindings,
            ),
            context.orientation,
          ).baseGid,
        );
      }
    }
    const view = findTileLayer(
      context.loaded.document,
      input.layerId,
      mapPath,
      "read",
    );
    assertRegionInsideLayer(
      view,
      region.x,
      region.y,
      region.width,
      region.height,
    );
    const matchKind = input.match.kind;
    let insidePolygon:
      | ((x: number, y: number) => boolean)
      | undefined;
    if (input.match.kind === "polygon") {
      const points = input.match.points;
      if (
        points.length < 3 ||
        points.length > 64 ||
        points.some(
          (point) =>
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y),
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "match.points must contain 3 to 64 finite pixel-coordinate points.",
        );
      }
      const tilePixelWidth = expectInteger(
        context.loaded.document.tilewidth,
        `${mapPath}.tilewidth`,
      );
      const tilePixelHeight = expectInteger(
        context.loaded.document.tileheight,
        `${mapPath}.tileheight`,
      );
      // Even-odd crossing test against the cell centre, with the
      // half-open edge rule so boundary cells resolve consistently.
      insidePolygon = (
        cellX: number,
        cellY: number,
      ): boolean => {
        const px =
          (cellX + 0.5) * tilePixelWidth;
        const py =
          (cellY + 0.5) * tilePixelHeight;
        let inside = false;
        for (
          let i = 0, j = points.length - 1;
          i < points.length;
          j = i, i += 1
        ) {
          const a = points[i]!;
          const b = points[j]!;
          if (
            a.y > py !== b.y > py &&
            px <
              ((b.x - a.x) * (py - a.y)) /
                (b.y - a.y) +
                a.x
          ) {
            inside = !inside;
          }
        }
        return inside;
      };
    }
    if (input.match.kind === "magicWand") {
      return this.selectMagicWand(
        context,
        view,
        region,
        input.match.seed,
        sampleLimit,
      );
    }
    let count = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const sample: Array<{
      x: number;
      y: number;
    }> = [];
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
        const gid = readLayerGid(view, x, y);
        let matched: boolean;
        if (matchKind === "empty") {
          matched = gid === 0;
        } else if (matchKind === "nonEmpty") {
          matched = gid !== 0;
        } else if (
          matchKind === "polygon"
        ) {
          matched = insidePolygon!(x, y);
        } else {
          matched =
            gid !== 0 &&
            matchGids.has(
              decodeGid(
                gid,
                context.orientation,
              ).baseGid,
            );
        }
        if (!matched) {
          continue;
        }
        count += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        if (sample.length < sampleLimit) {
          sample.push({ x, y });
        }
      }
    }
    return {
      map: {
        path: mapPath,
        revision: context.loaded.revision,
      },
      layerId: view.id,
      region,
      match: matchKind,
      cellCount: count,
      ...(count > 0
        ? {
            bounds: {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
          }
        : {}),
      cells: sample,
      cellsTruncated: count > sample.length,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  /**
   * Dedicated isometric tile-layer renderer using the exact Tiled
   * 1.12.2 IsometricRenderer placement math. The profile is strict:
   * finite isometric TMJ maps, external atlas tilesets whose tile size
   * matches the grid, no transparent-color keying, no anti-diagonal
   * flips; object layers are skipped with disclosure, and image or
   * group layers fail closed. Orthogonal maps belong to
   * tiled_render_preview.
   */
  async renderIsometric(input: {
    mapPath: string;
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    layerIds?: number[] | undefined;
    scale?: number | undefined;
  }): Promise<{
    png: Buffer;
    result: Record<string, unknown>;
  }> {
    const scale = input.scale ?? 1;
    if (
      !Number.isSafeInteger(scale) ||
      scale < 1 ||
      scale > MAX_ISOMETRIC_RENDER_SCALE
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `scale must be an integer between 1 and ${MAX_ISOMETRIC_RENDER_SCALE}.`,
        { scale },
      );
    }
    const region = input.region;
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      !Number.isSafeInteger(region.width) ||
      !Number.isSafeInteger(region.height) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1 ||
      region.width * region.height >
        MAX_ISOMETRIC_REGION_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must use non-negative integer coordinates, positive dimensions, and at most ${MAX_ISOMETRIC_REGION_CELLS} cells.`,
        { limit: MAX_ISOMETRIC_REGION_CELLS },
      );
    }
    const context =
      await this.loadEditableContext(
        input.mapPath,
        { allowIsometric: true },
      );
    if (context.orientation !== "isometric") {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "tiled_render_isometric renders isometric maps; use tiled_render_preview for orthogonal maps.",
        { orientation: context.orientation },
      );
    }
    if (
      region.x + region.width > context.width ||
      region.y + region.height > context.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must lie inside the ${context.width}x${context.height} map.`,
        {
          mapWidth: context.width,
          mapHeight: context.height,
        },
      );
    }
    const map = context.loaded.document;
    const mapPath = context.loaded.path;
    const tileWidth = expectInteger(
      map.tilewidth,
      `${mapPath}.tilewidth`,
    );
    const tileHeight = expectInteger(
      map.tileheight,
      `${mapPath}.tileheight`,
    );

    const requestedLayerIds =
      input.layerIds === undefined
        ? undefined
        : new Set(input.layerIds);
    const renderLayers: IsometricRenderLayer[] =
      [];
    const renderedLayerSummaries: Array<{
      id: number;
      name: string;
      nameTruncated?: true;
    }> = [];
    const omittedObjectLayerIds: number[] = [];
    const topLayers = expectArray(
      map.layers,
      `${mapPath}.layers`,
    );
    const seenLayerIds = new Set<number>();
    for (const [
      index,
      entry,
    ] of topLayers.entries()) {
      const layer = expectObject(
        entry,
        `${mapPath}.layers[${index}]`,
      );
      const layerId = expectInteger(
        layer.id,
        `${mapPath}.layers[${index}].id`,
      );
      seenLayerIds.add(layerId);
      if (layer.type === "objectgroup") {
        omittedObjectLayerIds.push(layerId);
        continue;
      }
      if (layer.type !== "tilelayer") {
        throw new TiledMcpError(
          "UNSUPPORTED_RENDER_FEATURE",
          `${mapPath}.layers[${index}] has type ${String(layer.type)}, which is outside the isometric render profile.`,
          {
            feature: "isometric-layer-type",
            layerId,
          },
        );
      }
      if (
        requestedLayerIds === undefined
          ? layer.visible === false
          : !requestedLayerIds.has(layerId)
      ) {
        continue;
      }
      const view = findTileLayer(
        map,
        layerId,
        mapPath,
        "read",
      );
      assertRegionInsideLayer(
        view,
        region.x,
        region.y,
        region.width,
        region.height,
      );
      const gids: number[] = [];
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
          gids.push(readLayerGid(view, x, y));
        }
      }
      const opacity =
        layer.opacity === undefined
          ? 1
          : layer.opacity;
      if (
        typeof opacity !== "number" ||
        !(opacity >= 0) ||
        !(opacity <= 1)
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath}.layers[${index}].opacity must be in [0, 1].`,
        );
      }
      renderLayers.push({
        id: layerId,
        name: view.name,
        opacity,
        gids,
      });
      renderedLayerSummaries.push({
        id: layerId,
        name: view.name.slice(0, 128),
        ...(view.name.length > 128
          ? { nameTruncated: true as const }
          : {}),
      });
    }
    if (requestedLayerIds !== undefined) {
      for (const layerId of requestedLayerIds) {
        if (!seenLayerIds.has(layerId)) {
          throw new TiledMcpError(
            "LAYER_NOT_FOUND",
            `Layer ${layerId} does not exist at the top level of ${mapPath}.`,
            { layerId },
          );
        }
      }
    }
    if (renderLayers.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "No tile layers were selected for the isometric render.",
      );
    }

    const usedBindings = new Map<
      string,
      TilesetBinding
    >();
    for (const layer of renderLayers) {
      for (const gid of layer.gids) {
        if (gid === 0) {
          continue;
        }
        const decoded = decodeGid(
          gid,
          "isometric",
        );
        const binding = context.bindings.find(
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
            `GID ${decoded.baseGid} does not fall inside any tileset range of ${mapPath}.`,
            { gid: decoded.baseGid },
          );
        }
        if (binding.collection === true) {
          throw new TiledMcpError(
            "UNSUPPORTED_RENDER_FEATURE",
            "Image-collection tilesets are outside the isometric render profile.",
            {
              feature: "isometric-collection",
              assetId: binding.assetId,
            },
          );
        }
        usedBindings.set(
          binding.assetId,
          binding,
        );
      }
    }

    const atlases: NativePreviewAtlas[] = [];
    let remainingImageBytes =
      MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES;
    let remainingDecodedPixels =
      MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS;
    const sources: Array<
      Record<string, unknown>
    > = [];
    for (const binding of usedBindings.values()) {
      const loaded = await this.loadPreviewAtlas(
        binding,
        tileWidth,
        tileHeight,
        remainingImageBytes,
        remainingDecodedPixels,
      );
      if (loaded.transparentColor !== undefined) {
        throw new TiledMcpError(
          "UNSUPPORTED_RENDER_FEATURE",
          "Transparent-color keyed tilesets are outside the isometric render profile.",
          {
            feature:
              "isometric-transparent-color",
            assetId: binding.assetId,
          },
        );
      }
      remainingImageBytes -=
        loaded.image.bytes.byteLength;
      remainingDecodedPixels -=
        loaded.geometry.imageWidth *
        loaded.geometry.imageHeight;
      atlases.push({
        assetId: binding.assetId,
        firstGid: binding.firstGid,
        tileCount: binding.tileCount,
        rgba: loaded.decoded.rgba,
        format: loaded.decoded.format,
        geometry: loaded.geometry,
      });
      sources.push({
        tileset: {
          assetId: binding.assetId,
          path: binding.path,
          revision: binding.revision,
        },
        image: {
          path: loaded.image.path,
          revision: loaded.image.revision,
        },
      });
    }

    const rendered = renderIsometricTiles({
      tileWidth,
      tileHeight,
      regionWidth: region.width,
      regionHeight: region.height,
      layers: renderLayers,
      atlases,
      scale,
    });
    const png = await encodeRgbaPng({
      rgba: rendered.rgba,
      width: rendered.width,
      height: rendered.height,
    });
    return {
      png,
      result: {
        mimeType: "image/png",
        pixelSize: {
          width: rendered.width,
          height: rendered.height,
        },
        byteLength: png.byteLength,
        sha256: revisionOf(png),
        map: {
          path: mapPath,
          revision: context.loaded.revision,
        },
        dependencyRevisions:
          context.dependencyRevisions,
        region,
        scale,
        projection: {
          orientation: "isometric",
          tileWidth,
          tileHeight,
          originPixel: {
            x:
              ((region.height * tileWidth) / 2) *
              scale,
            y: 0,
          },
        },
        layers: renderedLayerSummaries,
        omittedObjectLayerIds,
        sources,
        renderProfile:
          "isometric-tile-layers-v1",
        snapshotConsistency:
          "non-atomic-read-set",
      },
    };
  }

  /**
   * Staggered/hexagonal tile-layer renderer using the exact Tiled
   * 1.12.2 HexagonalRenderer transform (staggered maps are the
   * hexSideLength=0 degenerate case, matching the official class
   * hierarchy). Same strict profile as the isometric renderer;
   * hexagonal rotation flags fail closed.
   */
  async renderHexagonal(input: {
    mapPath: string;
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    layerIds?: number[] | undefined;
    scale?: number | undefined;
  }): Promise<{
    png: Buffer;
    result: Record<string, unknown>;
  }> {
    const scale = input.scale ?? 1;
    if (
      !Number.isSafeInteger(scale) ||
      scale < 1 ||
      scale > MAX_ISOMETRIC_RENDER_SCALE
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `scale must be an integer between 1 and ${MAX_ISOMETRIC_RENDER_SCALE}.`,
        { scale },
      );
    }
    const region = input.region;
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1 ||
      region.width * region.height >
        MAX_ISOMETRIC_REGION_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must use non-negative integer coordinates, positive dimensions, and at most ${MAX_ISOMETRIC_REGION_CELLS} cells.`,
        { limit: MAX_ISOMETRIC_REGION_CELLS },
      );
    }
    const context =
      await this.loadEditableContext(
        input.mapPath,
        { allowStaggeredHexagonal: true },
      );
    if (
      context.orientation !== "staggered" &&
      context.orientation !== "hexagonal"
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "tiled_render_hexagonal renders staggered and hexagonal maps; use tiled_render_preview or tiled_render_isometric otherwise.",
        { orientation: context.orientation },
      );
    }
    if (
      region.x + region.width > context.width ||
      region.y + region.height > context.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must lie inside the ${context.width}x${context.height} map.`,
        {
          mapWidth: context.width,
          mapHeight: context.height,
        },
      );
    }
    const map = context.loaded.document;
    const mapPath = context.loaded.path;
    const tileWidth = expectInteger(
      map.tilewidth,
      `${mapPath}.tilewidth`,
    );
    const tileHeight = expectInteger(
      map.tileheight,
      `${mapPath}.tileheight`,
    );
    const staggerAxis = expectString(
      map.staggeraxis,
      `${mapPath}.staggeraxis`,
    );
    const staggerIndex = expectString(
      map.staggerindex,
      `${mapPath}.staggerindex`,
    );
    if (
      (staggerAxis !== "x" &&
        staggerAxis !== "y") ||
      (staggerIndex !== "odd" &&
        staggerIndex !== "even")
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${mapPath} must declare staggeraxis x|y and staggerindex odd|even.`,
      );
    }
    const hexSideLength =
      context.orientation === "hexagonal"
        ? expectInteger(
            map.hexsidelength,
            `${mapPath}.hexsidelength`,
          )
        : 0;

    const requestedLayerIds =
      input.layerIds === undefined
        ? undefined
        : new Set(input.layerIds);
    const renderLayers: IsometricRenderLayer[] =
      [];
    const renderedLayerSummaries: Array<{
      id: number;
      name: string;
      nameTruncated?: true;
    }> = [];
    const omittedObjectLayerIds: number[] = [];
    const topLayers = expectArray(
      map.layers,
      `${mapPath}.layers`,
    );
    const seenLayerIds = new Set<number>();
    for (const [
      index,
      entry,
    ] of topLayers.entries()) {
      const layer = expectObject(
        entry,
        `${mapPath}.layers[${index}]`,
      );
      const layerId = expectInteger(
        layer.id,
        `${mapPath}.layers[${index}].id`,
      );
      seenLayerIds.add(layerId);
      if (layer.type === "objectgroup") {
        omittedObjectLayerIds.push(layerId);
        continue;
      }
      if (layer.type !== "tilelayer") {
        throw new TiledMcpError(
          "UNSUPPORTED_RENDER_FEATURE",
          `${mapPath}.layers[${index}] has type ${String(layer.type)}, which is outside the staggered/hexagonal render profile.`,
          {
            feature: "hexagonal-layer-type",
            layerId,
          },
        );
      }
      if (
        requestedLayerIds === undefined
          ? layer.visible === false
          : !requestedLayerIds.has(layerId)
      ) {
        continue;
      }
      const view = findTileLayer(
        map,
        layerId,
        mapPath,
        "read",
      );
      assertRegionInsideLayer(
        view,
        region.x,
        region.y,
        region.width,
        region.height,
      );
      const gids: number[] = [];
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
          gids.push(readLayerGid(view, x, y));
        }
      }
      const opacity =
        layer.opacity === undefined
          ? 1
          : layer.opacity;
      if (
        typeof opacity !== "number" ||
        !(opacity >= 0) ||
        !(opacity <= 1)
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath}.layers[${index}].opacity must be in [0, 1].`,
        );
      }
      renderLayers.push({
        id: layerId,
        name: view.name,
        opacity,
        gids,
      });
      renderedLayerSummaries.push({
        id: layerId,
        name: view.name.slice(0, 128),
        ...(view.name.length > 128
          ? { nameTruncated: true as const }
          : {}),
      });
    }
    if (requestedLayerIds !== undefined) {
      for (const layerId of requestedLayerIds) {
        if (!seenLayerIds.has(layerId)) {
          throw new TiledMcpError(
            "LAYER_NOT_FOUND",
            `Layer ${layerId} does not exist at the top level of ${mapPath}.`,
            { layerId },
          );
        }
      }
    }
    if (renderLayers.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "No tile layers were selected for the render.",
      );
    }

    const usedBindings = new Map<
      string,
      TilesetBinding
    >();
    for (const layer of renderLayers) {
      for (const gid of layer.gids) {
        if (gid === 0) {
          continue;
        }
        const decoded = decodeGid(
          gid,
          "hexagonal",
        );
        const binding = context.bindings.find(
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
            `GID ${decoded.baseGid} does not fall inside any tileset range of ${mapPath}.`,
            { gid: decoded.baseGid },
          );
        }
        if (binding.collection === true) {
          throw new TiledMcpError(
            "UNSUPPORTED_RENDER_FEATURE",
            "Image-collection tilesets are outside the staggered/hexagonal render profile.",
            {
              feature: "hexagonal-collection",
              assetId: binding.assetId,
            },
          );
        }
        usedBindings.set(
          binding.assetId,
          binding,
        );
      }
    }

    const atlases: NativePreviewAtlas[] = [];
    let remainingImageBytes =
      MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES;
    let remainingDecodedPixels =
      MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS;
    const sources: Array<
      Record<string, unknown>
    > = [];
    for (const binding of usedBindings.values()) {
      const loaded = await this.loadPreviewAtlas(
        binding,
        tileWidth,
        tileHeight,
        remainingImageBytes,
        remainingDecodedPixels,
      );
      if (loaded.transparentColor !== undefined) {
        throw new TiledMcpError(
          "UNSUPPORTED_RENDER_FEATURE",
          "Transparent-color keyed tilesets are outside the staggered/hexagonal render profile.",
          {
            feature:
              "hexagonal-transparent-color",
            assetId: binding.assetId,
          },
        );
      }
      remainingImageBytes -=
        loaded.image.bytes.byteLength;
      remainingDecodedPixels -=
        loaded.geometry.imageWidth *
        loaded.geometry.imageHeight;
      atlases.push({
        assetId: binding.assetId,
        firstGid: binding.firstGid,
        tileCount: binding.tileCount,
        rgba: loaded.decoded.rgba,
        format: loaded.decoded.format,
        geometry: loaded.geometry,
      });
      sources.push({
        tileset: {
          assetId: binding.assetId,
          path: binding.path,
          revision: binding.revision,
        },
        image: {
          path: loaded.image.path,
          revision: loaded.image.revision,
        },
      });
    }

    const rendered = renderHexagonalTiles({
      params: {
        tileWidth,
        tileHeight,
        hexSideLength,
        staggerAxis,
        staggerIndex,
      },
      region,
      layers: renderLayers,
      atlases,
      scale,
    });
    const png = await encodeRgbaPng({
      rgba: rendered.rgba,
      width: rendered.width,
      height: rendered.height,
    });
    return {
      png,
      result: {
        mimeType: "image/png",
        pixelSize: {
          width: rendered.width,
          height: rendered.height,
        },
        byteLength: png.byteLength,
        sha256: revisionOf(png),
        map: {
          path: mapPath,
          revision: context.loaded.revision,
        },
        dependencyRevisions:
          context.dependencyRevisions,
        region,
        scale,
        projection: {
          orientation: context.orientation,
          tileWidth,
          tileHeight,
          staggerAxis,
          staggerIndex,
          hexSideLength,
          originPixel: rendered.originPixel,
        },
        layers: renderedLayerSummaries,
        omittedObjectLayerIds,
        sources,
        renderProfile:
          "staggered-hexagonal-tile-layers-v1",
        snapshotConsistency:
          "non-atomic-read-set",
      },
    };
  }

  /**
   * Renders the same bounded region of two maps through the native
   * preview and compares them pixel by pixel. Differing pixels paint
   * solid red over a faded copy of the first render; matching pixels
   * keep the first render at reduced opacity, so the diff is readable
   * on its own. Differences also aggregate to tile-cell granularity.
   */
  async renderDiff(input: {
    mapPathA: string;
    mapPathB: string;
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    layerIdsA?: number[] | undefined;
    layerIdsB?: number[] | undefined;
    scale?: number | undefined;
  }): Promise<{
    png: Buffer;
    result: Record<string, unknown>;
  }> {
    const renderedA = await this.renderPreview({
      mapPath: input.mapPathA,
      region: input.region,
      ...(input.layerIdsA === undefined
        ? {}
        : { layerIds: input.layerIdsA }),
      ...(input.scale === undefined
        ? {}
        : { scale: input.scale }),
    });
    const renderedB = await this.renderPreview({
      mapPath: input.mapPathB,
      region: input.region,
      ...(input.layerIdsB === undefined
        ? {}
        : { layerIds: input.layerIdsB }),
      ...(input.scale === undefined
        ? {}
        : { scale: input.scale }),
    });
    const sizeA = (
      renderedA.result as {
        pixelSize: {
          width: number;
          height: number;
        };
      }
    ).pixelSize;
    const sizeB = (
      renderedB.result as {
        pixelSize: {
          width: number;
          height: number;
        };
      }
    ).pixelSize;
    const rawA = await decodeSafeImage({
      bytes: renderedA.png,
      path: `${input.mapPathA} (render)`,
      declaredWidth: sizeA.width,
      declaredHeight: sizeA.height,
      limits: {
        maxInputBytes: renderedA.png.byteLength,
        maxInputPixels:
          MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
        maxInputEdge: 65_535,
      },
    });
    const rawB = await decodeSafeImage({
      bytes: renderedB.png,
      path: `${input.mapPathB} (render)`,
      declaredWidth: sizeB.width,
      declaredHeight: sizeB.height,
      limits: {
        maxInputBytes: renderedB.png.byteLength,
        maxInputPixels:
          MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
        maxInputEdge: 65_535,
      },
    });
    if (
      rawA.pixelSize.width !==
        rawB.pixelSize.width ||
      rawA.pixelSize.height !==
        rawB.pixelSize.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Both renders must produce identical pixel sizes; the maps disagree on tile size for this region.",
        {
          a: rawA.pixelSize,
          b: rawB.pixelSize,
        },
      );
    }
    const { width, height } = rawA.pixelSize;
    const pixelsPerTileX =
      (renderedA.result.coordinateTransform as {
        pixelsPerTile: { x: number; y: number };
      }).pixelsPerTile.x;
    const pixelsPerTileY =
      (renderedA.result.coordinateTransform as {
        pixelsPerTile: { x: number; y: number };
      }).pixelsPerTile.y;

    const diff = Buffer.alloc(width * height * 4);
    const differingCellKeys = new Set<string>();
    let differingPixelCount = 0;
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      const same =
        rawA.rgba[offset] === rawB.rgba[offset] &&
        rawA.rgba[offset + 1] ===
          rawB.rgba[offset + 1] &&
        rawA.rgba[offset + 2] ===
          rawB.rgba[offset + 2] &&
        rawA.rgba[offset + 3] ===
          rawB.rgba[offset + 3];
      if (same) {
        diff[offset] = rawA.rgba[offset]!;
        diff[offset + 1] =
          rawA.rgba[offset + 1]!;
        diff[offset + 2] =
          rawA.rgba[offset + 2]!;
        diff[offset + 3] = Math.floor(
          rawA.rgba[offset + 3]! / 4,
        );
        continue;
      }
      differingPixelCount += 1;
      diff[offset] = 255;
      diff[offset + 1] = 0;
      diff[offset + 2] = 0;
      diff[offset + 3] = 255;
      const pixelX = index % width;
      const pixelY = Math.floor(index / width);
      differingCellKeys.add(
        `${input.region.x + Math.floor(pixelX / pixelsPerTileX)},${input.region.y + Math.floor(pixelY / pixelsPerTileY)}`,
      );
    }
    const differingCells = [
      ...differingCellKeys,
    ].map((key) => {
      const [x, y] = key.split(",");
      return {
        x: Number.parseInt(x!, 10),
        y: Number.parseInt(y!, 10),
      };
    });
    differingCells.sort(
      (left, right) =>
        left.y - right.y || left.x - right.x,
    );
    const png = await encodeRgbaPng({
      rgba: diff,
      width,
      height,
    });
    return {
      png,
      result: {
        mimeType: "image/png",
        pixelSize: { width, height },
        byteLength: png.byteLength,
        sha256: revisionOf(png),
        a: {
          path: (renderedA.result.map as {
            path: string;
          }).path,
          revision: (renderedA.result.map as {
            revision: string;
          }).revision,
        },
        b: {
          path: (renderedB.result.map as {
            path: string;
          }).path,
          revision: (renderedB.result.map as {
            revision: string;
          }).revision,
        },
        region: input.region,
        identical: differingPixelCount === 0,
        differingPixelCount,
        totalPixels: width * height,
        differingCells: {
          count: differingCells.length,
          sample: differingCells.slice(0, 64),
          truncated: differingCells.length > 64,
        },
        renderProfile:
          "native-preview-pixel-diff-v1",
        snapshotConsistency:
          "non-atomic-read-set",
      },
    };
  }

  /**
   * Bounded four-way connectivity analysis over one finite tile layer.
   * Passability is explicit: either empty cells walk (non-empty block)
   * or a listed tile set walks (everything else blocks, empty included
   * only when listed via includeEmpty). Flip bits never affect
   * passability — matching is by tileset and local id.
   */
  async checkConnectivity(input: {
    mapPath: string;
    layerId: number;
    passable:
      | { mode: "empty-cells" }
      | {
          mode: "listed-tiles";
          tiles: TileRef[];
          includeEmpty?: boolean | undefined;
        };
    from?: { x: number; y: number } | undefined;
    to?: { x: number; y: number } | undefined;
  }): Promise<Record<string, unknown>> {
    if (
      (input.from === undefined) !==
      (input.to === undefined)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "from and to must be provided together.",
      );
    }
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        allowCollectionTilesets: true,
        allowIsometric: true,
      },
    );
    const layer = findTileLayer(
      context.loaded.document,
      input.layerId,
      input.mapPath,
      "read",
    );
    let passableKeys: Set<string> | undefined;
    let includeEmpty = false;
    if (input.passable.mode === "listed-tiles") {
      const tiles = input.passable.tiles;
      if (
        !Array.isArray(tiles) ||
        tiles.length === 0 ||
        tiles.length > MAX_PASSABLE_TILE_SELECTORS
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `passable.tiles must list between 1 and ${MAX_PASSABLE_TILE_SELECTORS} tiles.`,
          {
            limit: MAX_PASSABLE_TILE_SELECTORS,
          },
        );
      }
      passableKeys = new Set();
      for (const tile of tiles) {
        const tilesetRef = tile.tileset;
        if (tilesetRef.kind !== "external") {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            "passable.tiles must reference external tilesets.",
          );
        }
        const binding = context.bindings.find(
          (candidate) =>
            candidate.assetId ===
            tilesetRef.assetId,
        );
        if (binding === undefined) {
          throw new TiledMcpError(
            "TILESET_NOT_IN_MAP",
            `Tileset ${tilesetRef.assetId} is not referenced by this map.`,
            {
              tilesetAssetId: tilesetRef.assetId,
            },
          );
        }
        passableKeys.add(
          `${binding.assetId}:${tile.localId}`,
        );
      }
      includeEmpty =
        input.passable.includeEmpty === true;
    }

    const passable = new Uint8Array(
      context.width * context.height,
    );
    for (let y = 0; y < context.height; y += 1) {
      for (let x = 0; x < context.width; x += 1) {
        const gid = readLayerGid(layer, x, y);
        const tile = gidToTileRef(
          gid,
          context.orientation,
          context.bindings,
        );
        let walkable: boolean;
        if (passableKeys === undefined) {
          walkable = tile === null;
        } else if (tile === null) {
          walkable = includeEmpty;
        } else {
          walkable =
            tile.tileset.kind === "external" &&
            passableKeys.has(
              `${tile.tileset.assetId}:${tile.localId}`,
            );
        }
        passable[y * context.width + x] = walkable
          ? 1
          : 0;
      }
    }

    const endpoints =
      input.from !== undefined &&
      input.to !== undefined
        ? { from: input.from, to: input.to }
        : undefined;
    if (endpoints !== undefined) {
      for (const [label, point] of [
        ["from", endpoints.from],
        ["to", endpoints.to],
      ] as const) {
        if (
          !Number.isSafeInteger(point.x) ||
          !Number.isSafeInteger(point.y) ||
          point.x < 0 ||
          point.y < 0 ||
          point.x >= context.width ||
          point.y >= context.height
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${label} must address a cell inside the ${context.width}x${context.height} map.`,
            { [label]: point },
          );
        }
      }
    }
    const analysis = analyzeConnectivity(
      passable,
      context.width,
      context.height,
      endpoints,
    );
    return {
      mapPath: context.loaded.path,
      revision: context.loaded.revision,
      layer: { id: layer.id, name: layer.name },
      profile:
        "four-way-explicit-passability-v1",
      adjacency: "orthogonal-4-way",
      ...analysis,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  /**
   * Bounded read-only batch of Tiled 1.12.2 renderer coordinate transforms.
   *
   * Deliberately reads only the map header rather than going through
   * `loadEditableContext`: the transforms depend on orientation, tile size,
   * map height and the stagger parameters alone, so requiring resolvable
   * tilesets would fail conversions for exactly the broken maps where working
   * out a cell position by hand is hardest.
   */
  async convertCoordinates(input: {
    mapPath: string;
    conversions: CoordinateConversion[];
  }): Promise<Record<string, unknown>> {
    const normalized = this.resolver.normalize(
      input.mapPath,
    );
    // Checked before the read so a TMX path reports the format it needs
    // instead of surfacing a JSON parse failure.
    if (
      posix
        .extname(normalized)
        .toLowerCase() !== ".tmj"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Coordinate conversion reads TMJ maps.",
        { path: normalized },
      );
    }
    const loaded =
      await this.store.read(normalized);
    const map = loaded.document;
    if (map.type !== "map") {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${loaded.path} is not a Tiled map.`,
      );
    }
    const orientation = expectString(
      map.orientation,
      `${loaded.path}.orientation`,
    );
    if (
      orientation !== "orthogonal" &&
      orientation !== "isometric" &&
      orientation !== "staggered" &&
      orientation !== "hexagonal"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        `${loaded.path} declares an unknown orientation.`,
        {
          path: loaded.path,
          orientation,
        },
      );
    }
    const staggered =
      orientation === "staggered" ||
      orientation === "hexagonal";
    const staggerAxis = staggered
      ? expectString(
          map.staggeraxis,
          `${loaded.path}.staggeraxis`,
        )
      : "y";
    const staggerIndex = staggered
      ? expectString(
          map.staggerindex,
          `${loaded.path}.staggerindex`,
        )
      : "odd";
    if (
      (staggerAxis !== "x" &&
        staggerAxis !== "y") ||
      (staggerIndex !== "odd" &&
        staggerIndex !== "even")
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${loaded.path} must declare staggeraxis x|y and staggerindex odd|even.`,
        { path: loaded.path },
      );
    }
    const projection: Projection = {
      orientation,
      tileWidth: expectInteger(
        map.tilewidth,
        `${loaded.path}.tilewidth`,
      ),
      tileHeight: expectInteger(
        map.tileheight,
        `${loaded.path}.tileheight`,
      ),
      // Infinite maps carry no meaningful `height`; only the isometric origin
      // reads it, and Tiled itself treats a missing value as zero there.
      mapHeight:
        map.height === undefined
          ? 0
          : expectInteger(
              map.height,
              `${loaded.path}.height`,
            ),
      staggerAxis,
      staggerIndex,
      hexSideLength:
        orientation === "hexagonal"
          ? expectInteger(
              map.hexsidelength,
              `${loaded.path}.hexsidelength`,
            )
          : 0,
    };
    assertUsableProjection(
      projection,
      loaded.path,
    );
    return {
      mapPath: loaded.path,
      revision: loaded.revision,
      profile:
        "tiled-1.12.2-renderer-transforms-v1",
      projection: {
        orientation: projection.orientation,
        tileWidth: projection.tileWidth,
        tileHeight: projection.tileHeight,
        mapHeight: projection.mapHeight,
        ...(staggered
          ? {
              staggerAxis: projection.staggerAxis,
              staggerIndex:
                projection.staggerIndex,
            }
          : {}),
        ...(orientation === "hexagonal"
          ? {
              hexSideLength:
                projection.hexSideLength,
            }
          : {}),
        tileSpace: tileSpaceIsDiscrete(
          projection.orientation,
        )
          ? "discrete"
          : "continuous",
        pixelSpace:
          projection.orientation === "isometric"
            ? "distinct-from-screen"
            : "same-as-screen",
      },
      conversions: convertCoordinates(
        projection,
        input.conversions,
      ),
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  /**
   * Bounded read-only projection of a .tiled-project's property type
   * definitions — the authoritative source of class member and enum
   * type annotations that TMJ documents themselves never carry.
   */
  async listPropertyTypes(
    projectFilePath: string,
  ): Promise<Record<string, unknown>> {
    const normalized = this.resolver.normalize(
      projectFilePath,
    );
    this.assertTiledProjectPath(normalized);
    const loaded =
      await this.store.read(normalized);
    const types = projectPropertyTypes(
      loaded.document,
      normalized,
    );
    return {
      path: normalized,
      revision: loaded.revision,
      propertyTypes: types,
      typeCount: types.length,
      snapshotConsistency:
        "non-atomic-read-set",
    };
  }

  async planPropertyTypeEdits(input: {
    projectFilePath: string;
    expectedRevision: string;
    operations: PropertyTypeOperation[];
  }): Promise<PropertyTypeEditPlan> {
    assertRequiredRevision(
      input.expectedRevision,
      "expectedRevision",
    );
    const prepared =
      await this.preparePropertyTypeEdit(
        input.projectFilePath,
        input.expectedRevision,
        input.operations,
      );
    const unsignedPlan: Omit<
      PropertyTypeEditPlan,
      "id"
    > = {
      kind: "propertyTypeEdit",
      version: 1,
      projectFilePath: prepared.projectFilePath,
      baseRevision: input.expectedRevision,
      operations: structuredClone(
        input.operations,
      ) as PropertyTypeOperation[],
      summary: prepared.summary,
    };
    await assertRevisionUnchanged(
      this.store,
      prepared.projectFilePath,
      input.expectedRevision,
      "REVISION_CONFLICT",
      "the property type edits were being prepared",
    );
    return {
      ...unsignedPlan,
      id: propertyTypeEditPlanId(unsignedPlan),
    };
  }

  async applyPropertyTypeEdit(
    plan: PropertyTypeEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    assertPropertyTypeEditPlan(plan);
    const prepared =
      await this.preparePropertyTypeEdit(
        plan.projectFilePath,
        plan.baseRevision,
        structuredClone(
          plan.operations,
        ) as PropertyTypeOperation[],
      );
    if (
      stableJson(
        prepared.summary as unknown as JsonValue,
      ) !==
      stableJson(plan.summary as unknown as JsonValue)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The property type edit summary does not match its operations.",
      );
    }
    const result = await this.store.commitBytes(
      plan.projectFilePath,
      plan.baseRevision,
      prepared.patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  private assertTiledProjectPath(
    normalized: string,
  ): void {
    if (
      !normalized
        .toLowerCase()
        .endsWith(".tiled-project")
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Property types live in a .tiled-project file.",
        { path: normalized },
      );
    }
  }

  private async preparePropertyTypeEdit(
    projectFilePath: string,
    expectedRevision: string,
    operations: PropertyTypeOperation[],
  ): Promise<{
    projectFilePath: string;
    summary: PropertyTypeEditPlan["summary"];
    patchedSource: Buffer;
  }> {
    const normalized = this.resolver.normalize(
      projectFilePath,
    );
    this.assertTiledProjectPath(normalized);
    const loaded =
      await this.store.read(normalized);
    if (loaded.revision !== expectedRevision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${normalized} does not match the expected revision.`,
        {
          path: normalized,
          expectedRevision,
          actualRevision: loaded.revision,
        },
      );
    }
    const edited = cloneJson(loaded.document);
    const applied = applyPropertyTypeOperations(
      edited,
      normalized,
      operations,
    );
    const patchedSource = patchJsonDocumentSource(
      loaded.source,
      edited,
      [],
      normalized,
      [],
      [{ path: [], key: "propertyTypes" }],
      [],
      [],
    );
    return {
      projectFilePath: normalized,
      summary: applied.summary,
      patchedSource,
    };
  }

  /**
   * Deterministic procedural generation: computes a seeded value field
   * (smooth value noise, or a cellular cave automaton yielding 0/1) over
   * one bounded region, maps values to tiles through explicit [min, max)
   * intervals, and returns an ordinary setTiles map-edit change set.
   * The same seed always produces the same output — the generator is a
   * stateless coordinate hash, so results are also translation-stable.
   */
  async planGenerate(input: {
    mapPath: string;
    layerId: number;
    region: GenerateRegion;
    seed: number;
    generator: GenerateAlgorithmInput;
    mapping: GenerateMappingEntry<TileRef | null>[];
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
  }): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    if (!Number.isSafeInteger(input.seed)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "seed must be a safe integer.",
      );
    }
    const region = input.region;
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      !Number.isSafeInteger(region.width) ||
      !Number.isSafeInteger(region.height) ||
      region.width < 1 ||
      region.height < 1 ||
      region.width * region.height >
        MAX_GENERATE_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must use integer coordinates, positive dimensions, and at most ${MAX_GENERATE_CELLS} cells.`,
        { limit: MAX_GENERATE_CELLS },
      );
    }
    validateGenerateMapping(input.mapping);
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        allowIsometric: true,
        expectedMapRevision:
          input.expectedMapRevision,
        expectedDependencyRevisions:
          input.expectedDependencyRevisions,
      },
    );
    if (
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.width > context.width ||
      region.y + region.height > context.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must lie inside the ${context.width}x${context.height} map.`,
        {
          mapWidth: context.width,
          mapHeight: context.height,
        },
      );
    }
    const values = computeGeneratedValues(
      input.generator,
      input.seed,
      region,
    );
    const cells: Array<{
      x: number;
      y: number;
      tile: TileRef | null;
    }> = [];
    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const tile = mapGeneratedValue(
          values[y * region.width + x]!,
          input.mapping,
        );
        if (tile !== undefined) {
          cells.push({
            x: region.x + x,
            y: region.y + y,
            tile,
          });
        }
      }
    }
    if (cells.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The generation mapping matched no cells; widen the intervals or adjust the generator options.",
      );
    }
    return this.planEdits(
      input.mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      [
        {
          type: "setTiles",
          layerId: input.layerId,
          cells,
        },
      ],
    );
  }

  /**
   * Deterministic density scatter: each region cell independently rolls
   * a stateless coordinate hash against the density, and matched cells
   * pick one weighted tile from the choice list — decoration placement
   * that is reproducible and translation-stable by construction. With
   * skipOccupied, cells that already hold a tile are left untouched.
   * The result is an ordinary setTiles map-edit change set.
   */
  async planScatter(input: {
    mapPath: string;
    layerId: number;
    region: GenerateRegion;
    seed: number;
    density: number;
    choices: Array<ScatterChoice<TileRef | null>>;
    skipOccupied?: boolean | undefined;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
  }): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    if (!Number.isSafeInteger(input.seed)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "seed must be a safe integer.",
      );
    }
    const region = input.region;
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      !Number.isSafeInteger(region.width) ||
      !Number.isSafeInteger(region.height) ||
      region.width < 1 ||
      region.height < 1 ||
      region.width * region.height >
        MAX_GENERATE_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must use integer coordinates, positive dimensions, and at most ${MAX_GENERATE_CELLS} cells.`,
        { limit: MAX_GENERATE_CELLS },
      );
    }
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        allowIsometric: true,
        expectedMapRevision:
          input.expectedMapRevision,
        expectedDependencyRevisions:
          input.expectedDependencyRevisions,
      },
    );
    if (
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.width > context.width ||
      region.y + region.height > context.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region must lie inside the ${context.width}x${context.height} map.`,
        {
          mapWidth: context.width,
          mapHeight: context.height,
        },
      );
    }
    let picks = computeScatterPicks(
      input.seed,
      region,
      input.density,
      input.choices,
    );
    if (input.skipOccupied === true) {
      const layer = findTileLayer(
        context.loaded.document,
        input.layerId,
        input.mapPath,
        "read",
      );
      picks = picks.filter(
        (pick) =>
          readLayerGid(layer, pick.x, pick.y) ===
          0,
      );
    }
    if (picks.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The scatter matched no cells; raise the density, enlarge the region, or drop skipOccupied.",
      );
    }
    return this.planEdits(
      input.mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      [
        {
          type: "setTiles",
          layerId: input.layerId,
          cells: picks,
        },
      ],
    );
  }

  /**
   * Mechanical validation fixes: scans every tile layer for cells
   * whose base GID falls outside all bound tileset ranges and returns
   * an ordinary setTiles change set that erases exactly those cells.
   * Erasing data is destructive in spirit, so nothing applies without
   * the usual preview and approval; a map with nothing to fix fails
   * closed instead of returning an empty plan. Dangling tile-object
   * GIDs are reported by tiled_validate but deliberately not auto-
   * fixed — deleting objects is a human decision.
   */
  async planValidationFixes(input: {
    mapPath: string;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
  }): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const context =
      await this.loadEditableContext(
        input.mapPath,
        {
          allowIsometric: true,
          expectedMapRevision:
            input.expectedMapRevision,
          expectedDependencyRevisions:
            input.expectedDependencyRevisions,
        },
      );
    const mapPath = context.loaded.path;
    const map = context.loaded.document;
    const ranges = context.bindings.map(
      (binding) => ({
        first: binding.firstGid,
        last:
          binding.firstGid +
          binding.gidSpan -
          1,
      }),
    );
    const resolvable = (
      baseGid: number,
    ): boolean =>
      ranges.some(
        (range) =>
          baseGid >= range.first &&
          baseGid <= range.last,
      );

    const tileLayerIds: number[] = [];
    const collect = (
      layers: JsonValue | undefined,
      context_: string,
    ): void => {
      for (const [
        index,
        entry,
      ] of expectArray(
        layers,
        context_,
      ).entries()) {
        const layer = expectObject(
          entry,
          `${context_}[${index}]`,
        );
        if (layer.type === "tilelayer") {
          tileLayerIds.push(
            expectInteger(
              layer.id,
              `${context_}[${index}].id`,
            ),
          );
        } else if (layer.type === "group") {
          collect(
            layer.layers ?? [],
            `${context_}[${index}].layers`,
          );
        }
      }
    };
    collect(map.layers, `${mapPath}.layers`);

    const operations: MapEditOperation[] = [];
    let totalCells = 0;
    for (const layerId of tileLayerIds) {
      const view = findTileLayer(
        map,
        layerId,
        mapPath,
        "read",
      );
      const cells: Array<{
        x: number;
        y: number;
        tile: null;
      }> = [];
      for (
        let y = view.y;
        y < view.y + view.height;
        y += 1
      ) {
        for (
          let x = view.x;
          x < view.x + view.width;
          x += 1
        ) {
          const gid = readLayerGid(view, x, y);
          if (gid === 0) {
            continue;
          }
          const decoded = decodeGid(
            gid,
            context.orientation,
          );
          if (!resolvable(decoded.baseGid)) {
            cells.push({ x, y, tile: null });
            totalCells += 1;
            if (totalCells > 10_000) {
              throw new TiledMcpError(
                "RESULT_LIMIT_EXCEEDED",
                "More than 10,000 cells carry dangling GIDs; fix the tileset references instead of erasing this much data.",
                { limit: 10_000 },
              );
            }
          }
        }
      }
      if (cells.length > 0) {
        operations.push({
          type: "setTiles",
          layerId,
          cells,
        });
      }
    }
    if (operations.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Validation found no mechanically fixable issues; nothing to erase.",
      );
    }
    return this.planEdits(
      mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      operations,
    );
  }

  /**
   * Prefab stamping: reads one source-map region — tiles from one tile
   * layer, optionally objects anchored inside the region's pixel bounds
   * from one object layer — and materializes it at planning time into
   * ordinary setTiles and createObject operations against the target
   * map. Nothing is re-read at apply, so the plan itself is the frozen
   * prefab; an optional expectedSourceRevision asserts the source
   * up front. Tiles carry as tileset+localId references, so a target
   * map missing the tileset fails closed in draft validation, and
   * objects outside the supported draft profile (custom properties,
   * template instances, unknown members) fail closed rather than being
   * silently dropped.
   */
  async planStampPrefab(input: {
    mapPath: string;
    sourceMapPath: string;
    source: {
      layerId: number;
      x: number;
      y: number;
      width: number;
      height: number;
    };
    target: {
      layerId: number;
      x: number;
      y: number;
    };
    objects?:
      | {
          sourceLayerId: number;
          targetLayerId: number;
        }
      | undefined;
    extraTileLayers?:
      | Array<{
          sourceLayerId: number;
          targetLayerId: number;
        }>
      | undefined;
    flipHorizontal?: boolean | undefined;
    copyEmpty?: boolean | undefined;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
    expectedSourceRevision?: string | undefined;
  }): Promise<MapEditPlan> {
    if (
      input.flipHorizontal === true &&
      input.objects !== undefined
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "flipHorizontal covers tile layers only; stamp objects without flipping or flip without objects.",
      );
    }
    if (
      input.extraTileLayers !== undefined &&
      input.extraTileLayers.length > 16
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "extraTileLayers may list at most 16 layer pairs.",
      );
    }
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const source = input.source;
    if (
      !Number.isSafeInteger(source.x) ||
      !Number.isSafeInteger(source.y) ||
      !Number.isSafeInteger(source.width) ||
      !Number.isSafeInteger(source.height) ||
      source.x < 0 ||
      source.y < 0 ||
      source.width < 1 ||
      source.height < 1 ||
      source.width * source.height >
        MAX_GENERATE_CELLS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `source must use non-negative integer coordinates, positive dimensions, and at most ${MAX_GENERATE_CELLS} cells.`,
        { limit: MAX_GENERATE_CELLS },
      );
    }
    if (
      !Number.isSafeInteger(input.target.x) ||
      !Number.isSafeInteger(input.target.y) ||
      input.target.x < 0 ||
      input.target.y < 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "target coordinates must be non-negative integers.",
      );
    }
    const sourceMapPath = this.resolver.normalize(
      input.sourceMapPath,
    );
    const sourceContext =
      await this.loadEditableContext(
        sourceMapPath,
        { allowIsometric: true },
      );
    if (
      input.expectedSourceRevision !==
        undefined &&
      sourceContext.loaded.revision !==
        input.expectedSourceRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${sourceMapPath} does not match the expected source revision.`,
        {
          path: sourceMapPath,
          expectedRevision:
            input.expectedSourceRevision,
          actualRevision:
            sourceContext.loaded.revision,
        },
      );
    }
    if (
      source.x + source.width >
        sourceContext.width ||
      source.y + source.height >
        sourceContext.height
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `source must lie inside the ${sourceContext.width}x${sourceContext.height} source map.`,
        {
          mapWidth: sourceContext.width,
          mapHeight: sourceContext.height,
        },
      );
    }

    // Official TileLayer::flip semantics: anti-diagonal cells toggle
    // the vertical bit instead of the horizontal one.
    const flipTile = (
      tile: TileRef | null,
    ): TileRef | null => {
      if (tile === null) {
        return null;
      }
      const current =
        tile.transform !== undefined &&
        (tile.transform.kind === undefined ||
          tile.transform.kind === "orthogonal")
          ? (tile.transform as Partial<OrthogonalTransform>)
          : undefined;
      const hadH = current?.flipH === true;
      const hadV = current?.flipV === true;
      const hadD = current?.flipD === true;
      const flipH = hadD ? hadH : !hadH;
      const flipV = hadD ? !hadV : hadV;
      const rawFlags =
        ((flipH ? 0x80000000 : 0) |
          (flipV ? 0x40000000 : 0) |
          (hadD ? 0x20000000 : 0)) >>>
        0;
      return {
        ...tile,
        transform: {
          kind: "orthogonal",
          flipH,
          flipV,
          flipD: hadD,
          rawFlags,
        },
      };
    };
    const readStampCells = (
      sourceLayerId: number,
    ): Array<{
      x: number;
      y: number;
      tile: TileRef | null;
    }> => {
      const sourceLayer = findTileLayer(
        sourceContext.loaded.document,
        sourceLayerId,
        sourceMapPath,
        "read",
      );
      assertRegionInsideLayer(
        sourceLayer,
        source.x,
        source.y,
        source.width,
        source.height,
      );
      const cells: Array<{
        x: number;
        y: number;
        tile: TileRef | null;
      }> = [];
      for (
        let y = 0;
        y < source.height;
        y += 1
      ) {
        for (
          let x = 0;
          x < source.width;
          x += 1
        ) {
          const gid = readLayerGid(
            sourceLayer,
            source.x + x,
            source.y + y,
          );
          if (
            gid === 0 &&
            input.copyEmpty !== true
          ) {
            continue;
          }
          const destX =
            input.flipHorizontal === true
              ? input.target.x +
                (source.width - 1 - x)
              : input.target.x + x;
          let tile = gidToTileRef(
            gid,
            sourceContext.orientation,
            sourceContext.bindings,
            sourceContext.embeddedBindings,
          );
          if (input.flipHorizontal === true) {
            tile = flipTile(tile);
          }
          cells.push({
            x: destX,
            y: input.target.y + y,
            tile,
          });
        }
      }
      return cells;
    };

    const operations: MapEditOperation[] = [];
    const layerPairs = [
      {
        sourceLayerId: source.layerId,
        targetLayerId: input.target.layerId,
      },
      ...(input.extraTileLayers ?? []),
    ];
    for (const pair of layerPairs) {
      const cells = readStampCells(
        pair.sourceLayerId,
      );
      if (cells.length > 0) {
        operations.push({
          type: "setTiles",
          layerId: pair.targetLayerId,
          cells,
        });
      }
    }
    if (input.objects !== undefined) {
      const sourceDocument =
        sourceContext.loaded.document;
      const tileWidth = expectInteger(
        sourceDocument.tilewidth,
        `${sourceMapPath}.tilewidth`,
      );
      const tileHeight = expectInteger(
        sourceDocument.tileheight,
        `${sourceMapPath}.tileheight`,
      );
      const targetMapPath =
        this.resolver.normalize(input.mapPath);
      let targetNextObjectId = expectInteger(
        sourceDocument.nextobjectid,
        `${sourceMapPath}.nextobjectid`,
      );
      if (targetMapPath !== sourceMapPath) {
        const targetDocument = (
          await this.loadEditableContext(
            targetMapPath,
            {
              allowIsometric: true,
              expectedMapRevision:
                input.expectedMapRevision,
              expectedDependencyRevisions:
                input.expectedDependencyRevisions,
            },
          )
        ).loaded.document;
        targetNextObjectId = expectInteger(
          targetDocument.nextobjectid,
          `${targetMapPath}.nextobjectid`,
        );
        // Object offsets are pixel math in tile units; differing grids
        // would silently misplace every stamped object.
        if (
          expectInteger(
            targetDocument.tilewidth,
            `${targetMapPath}.tilewidth`,
          ) !== tileWidth ||
          expectInteger(
            targetDocument.tileheight,
            `${targetMapPath}.tileheight`,
          ) !== tileHeight
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            "Object stamping requires the source and target maps to share the same tile size.",
            {
              sourceMapPath,
              targetMapPath,
            },
          );
        }
      }
      const objectLayer = findObjectLayer(
        sourceDocument,
        input.objects.sourceLayerId,
        sourceMapPath,
      );
      const boundsLeft = source.x * tileWidth;
      const boundsTop = source.y * tileHeight;
      const boundsRight =
        (source.x + source.width) * tileWidth;
      const boundsBottom =
        (source.y + source.height) * tileHeight;
      const selected: JsonObject[] = [];
      for (const [
        entryIndex,
        raw,
      ] of objectLayer.objects.entries()) {
        const record = expectObject(
          raw,
          `${sourceMapPath} layer ${input.objects.sourceLayerId} objects[${entryIndex}]`,
        );
        const rawX = record.x;
        const rawY = record.y;
        if (
          typeof rawX === "number" &&
          typeof rawY === "number" &&
          rawX >= boundsLeft &&
          rawX < boundsRight &&
          rawY >= boundsTop &&
          rawY < boundsBottom
        ) {
          selected.push(record);
        }
      }
      if (selected.length > MAX_PREFAB_OBJECTS) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `The source region anchors ${selected.length} objects; a prefab stamp carries at most ${MAX_PREFAB_OBJECTS}.`,
          { limit: MAX_PREFAB_OBJECTS },
        );
      }
      const offsetX =
        input.target.x * tileWidth - boundsLeft;
      const offsetY =
        input.target.y * tileHeight - boundsTop;
      for (const [
        rawIndex,
        raw,
      ] of selected.entries()) {
        const draft = convertPrefabObject(
          raw,
          `${sourceMapPath} object ${String(raw.id ?? rawIndex)}`,
          (gid) => {
            const tile = gidToTileRef(
              gid,
              sourceContext.orientation,
              sourceContext.bindings,
              sourceContext.embeddedBindings,
            );
            if (tile === null) {
              throw new TiledMcpError(
                "GID_OUT_OF_RANGE",
                `${sourceMapPath} object ${String(raw.id ?? rawIndex)} carries an unresolvable gid.`,
                { gid },
              );
            }
            return tile;
          },
        );
        draft.x += offsetX;
        draft.y += offsetY;
        operations.push({
          type: "createObject",
          layerId: input.objects.targetLayerId,
          object: draft,
        });
        // createObject assigns ids sequentially from nextobjectid, so
        // the follow-up property patch can address the new object; the
        // revision pin makes the prediction stable through apply.
        const properties =
          convertPrefabProperties(
            raw,
            `${sourceMapPath} object ${String(raw.id ?? rawIndex)}`,
          );
        const assignedId = targetNextObjectId;
        targetNextObjectId += 1;
        if (
          properties !== undefined &&
          properties.length > 0
        ) {
          operations.push({
            type: "updateObject",
            objectId: assignedId,
            patch: {
              properties: { set: properties },
            },
          });
        }
      }
    }
    if (operations.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The prefab stamp matched nothing; the source tile region is empty and no objects were requested.",
      );
    }
    return this.planEdits(
      input.mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      operations,
    );
  }

  /**
   * Places one JSON object template instance in Tiled's minimal
   * serialized form ({id, template, x, y}). The template is read and
   * validated through the same fail-closed profile as template
   * expansion (tile and nested templates reject), its revision is
   * pinned into the plan, and replay re-verifies both the pin and that
   * the map-relative reference still resolves to the pinned path.
   */
  async planInstantiateTemplate(input: {
    mapPath: string;
    layerId: number;
    templatePath: string;
    x: number;
    y: number;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
    expectedTemplateRevision?:
      | string
      | undefined;
  }): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const templatePath = this.resolver.normalize(
      input.templatePath,
    );
    if (
      posix
        .extname(templatePath)
        .toLowerCase() !== ".tj"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Template instantiation requires a JSON .tj template.",
        { path: templatePath },
      );
    }
    const template = await this.store.read(
      templatePath,
    );
    readObjectTemplate(
      template.document,
      templatePath,
    );
    if (
      input.expectedTemplateRevision !==
        undefined &&
      template.revision !==
        input.expectedTemplateRevision
    ) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${templatePath} does not match the expected template revision.`,
        {
          path: templatePath,
          expectedRevision:
            input.expectedTemplateRevision,
          actualRevision: template.revision,
        },
      );
    }
    const mapPath = this.resolver.normalize(
      input.mapPath,
    );
    const source = posix.relative(
      posix.dirname(mapPath),
      templatePath,
    );
    return this.planEdits(
      mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      [
        {
          type: "instantiateTemplate",
          layerId: input.layerId,
          templatePath,
          source,
          x: input.x,
          y: input.y,
          expectedTemplateRevision:
            template.revision,
        },
      ],
    );
  }

  /**
   * Deterministic geometry painting: rasterizes one line, rectangle, or
   * ellipse into exact cells and returns an ordinary setTiles map-edit
   * change set. Pure computation — no randomness, no clipping; a shape
   * that leaves the map fails closed.
   */
  async planDrawShape(input: {
    mapPath: string;
    layerId: number;
    draw: ShapeDrawInput;
    tile: TileRef | null;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
  }): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        allowIsometric: true,
        expectedMapRevision:
          input.expectedMapRevision,
        expectedDependencyRevisions:
          input.expectedDependencyRevisions,
      },
    );
    const cells = computeShapeCells(
      input.draw,
      context.width,
      context.height,
    ).map((cell) => ({
      ...cell,
      tile: input.tile,
    }));
    return this.planEdits(
      input.mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      [
        {
          type: "setTiles",
          layerId: input.layerId,
          cells,
        },
      ],
    );
  }

  /**
   * Per-tile metadata edits for an embedded (inline) map tileset. Reuses
   * the exact tileset-edit validation and application logic against the
   * inline document, then rebases every source patch under the map's
   * `tilesets[embeddedIndex]` entry — the map revision is the only CAS.
   */
  async planEmbeddedTileUpdate(input: {
    mapPath: string;
    embeddedIndex: number;
    expectedMapRevision: string;
    updates: TileMetadataUpdate[];
  }): Promise<EmbeddedTilesetEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    const prepared =
      await this.prepareEmbeddedTilesetEdit(
        input.mapPath,
        input.expectedMapRevision,
        input.embeddedIndex,
        input.updates,
      );
    const unsignedPlan: Omit<
      EmbeddedTilesetEditPlan,
      "id"
    > = {
      kind: "embeddedTilesetEdit",
      version: 1,
      mapPath: prepared.mapPath,
      baseRevision: prepared.mapRevision,
      embeddedIndex: input.embeddedIndex,
      updates: structuredClone(
        input.updates,
      ) as TileMetadataUpdate[],
      summary: prepared.summary,
    };
    await assertRevisionUnchanged(
      this.store,
      prepared.mapPath,
      prepared.mapRevision,
      "REVISION_CONFLICT",
      "the embedded tile update was being prepared",
    );
    return {
      ...unsignedPlan,
      id: embeddedTilesetEditPlanId(unsignedPlan),
    };
  }

  async applyEmbeddedTilesetEdit(
    plan: EmbeddedTilesetEditPlan,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    assertEmbeddedTilesetEditPlan(plan);
    const prepared =
      await this.prepareEmbeddedTilesetEdit(
        plan.mapPath,
        plan.baseRevision,
        plan.embeddedIndex,
        structuredClone(
          plan.updates,
        ) as TileMetadataUpdate[],
      );
    if (
      stableJson(
        prepared.summary as unknown as JsonValue,
      ) !==
      stableJson(plan.summary as unknown as JsonValue)
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The embedded tileset edit summary does not match its updates.",
      );
    }
    const result = await this.store.commitBytes(
      plan.mapPath,
      plan.baseRevision,
      prepared.patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  private async prepareEmbeddedTilesetEdit(
    mapPath: string,
    expectedMapRevision: string,
    embeddedIndex: number,
    updates: TileMetadataUpdate[],
  ): Promise<{
    mapPath: string;
    mapRevision: string;
    summary: TilesetEditSummary;
    patchedSource: Buffer;
  }> {
    if (
      !Number.isSafeInteger(embeddedIndex) ||
      embeddedIndex < 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "embeddedIndex must be a nonnegative integer.",
      );
    }
    const context = await this.loadEditableContext(
      mapPath,
      {
        expectedMapRevision,
        allowCollectionTilesets: true,
        allowEmbeddedTilesets: true,
        persistIdentity: true,
      },
    );
    const embedded =
      context.embeddedBindings.find(
        (candidate) =>
          candidate.sourceIndex === embeddedIndex,
      );
    if (embedded === undefined) {
      throw new TiledMcpError(
        "TILESET_NOT_IN_MAP",
        `${context.loaded.path} has no embedded tileset at tilesets[${embeddedIndex}].`,
        {
          path: context.loaded.path,
          embeddedIndex,
          embeddedIndexes:
            context.embeddedBindings.map(
              (candidate) =>
                candidate.sourceIndex,
            ),
        },
      );
    }
    const editedMap = cloneJson(
      context.loaded.document,
    );
    const editedEntry = expectObject(
      expectArray(
        editedMap.tilesets,
        `${context.loaded.path}.tilesets`,
      )[embeddedIndex] as JsonValue,
      `${context.loaded.path}.tilesets[${embeddedIndex}]`,
    );
    const applied = applyTileMetadataUpdates(
      editedEntry,
      embedded.tileCount,
      structuredClone(
        updates,
      ) as TileMetadataUpdate[],
      `${context.loaded.path}.tilesets[${embeddedIndex}]`,
    );
    const prefix = [
      "tilesets",
      embeddedIndex,
    ] as const;
    const patchedSource = patchJsonDocumentSource(
      context.loaded.source,
      editedMap,
      [],
      context.loaded.path,
      applied.patches.insertions.map(
        (insertion) => ({
          ...insertion,
          path: [...prefix, ...insertion.path],
        }),
      ),
      applied.patches.memberPatches.map(
        (memberPatch) => ({
          ...memberPatch,
          path: [...prefix, ...memberPatch.path],
        }),
      ),
      applied.patches.deletions.map(
        (deletion) => ({
          ...deletion,
          path: [...prefix, ...deletion.path],
        }),
      ),
      [],
    );
    return {
      mapPath: context.loaded.path,
      mapRevision: context.loaded.revision,
      summary: applied.summary,
      patchedSource,
    };
  }

  /**
   * Terrain painting through Tiled's own Wang matcher: a server-authored
   * static script runs `TileLayer.wangEdit()` headlessly against the
   * pinned map and writes only a staging copy; the service then diffs the
   * target layer and turns the exact cell changes into an ordinary
   * setTiles map-edit change set. The CLI is a pure calculator here — the
   * plan carries plain cell data, so apply needs no CLI replay, untouched
   * fragments keep their exact bytes, and every existing preview, pin,
   * and transaction rule applies unchanged.
   */
  async planTerrainPaint(
    input: {
      mapPath: string;
      layerId: number;
      tilesetAssetId: string;
      wangSetIndex: number;
      corners: TerrainCornerInput[];
      expectedMapRevision: string;
      expectedDependencyRevisions: Record<
        string,
        string
      >;
    },
    evaluate: (scriptPath: string) => Promise<{
      stdout: string;
      stderr: string;
    }>,
  ): Promise<MapEditPlan> {
    assertRequiredRevision(
      input.expectedMapRevision,
      "expectedMapRevision",
    );
    if (
      !Number.isSafeInteger(input.wangSetIndex) ||
      input.wangSetIndex < 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "wangSetIndex must be a nonnegative integer.",
      );
    }
    const context = await this.loadEditableContext(
      input.mapPath,
      {
        // Verified against the real CLI: wangEdit on an isometric
        // staging map behaves identically to orthogonal — wang
        // adjacency is orientation-independent.
        allowIsometric: true,
        expectedMapRevision:
          input.expectedMapRevision,
        expectedDependencyRevisions:
          input.expectedDependencyRevisions,
      },
    );
    const binding = this.requireTilesetBinding(
      context,
      input.tilesetAssetId,
    );
    if (binding.collection === true) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        `${binding.path} is an image-collection tileset; terrain painting supports only atlas tilesets.`,
        { assetId: binding.assetId },
      );
    }
    const tilesetIndex =
      context.bindings.indexOf(binding);
    const tileset = await this.store.read(
      binding.path,
    );
    if (tileset.revision !== binding.revision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${binding.path} changed while the terrain paint was being prepared.`,
        {
          assetId: binding.assetId,
          expectedRevision: binding.revision,
          actualRevision: tileset.revision,
        },
      );
    }
    const wangSets = tileset.document.wangsets;
    const wangSetValue = Array.isArray(wangSets)
      ? wangSets[input.wangSetIndex]
      : undefined;
    if (
      typeof wangSetValue !== "object" ||
      wangSetValue === null ||
      Array.isArray(wangSetValue)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${binding.path} has no Wang set at index ${input.wangSetIndex}.`,
        {
          wangSetIndex: input.wangSetIndex,
          wangSetCount: Array.isArray(wangSets)
            ? wangSets.length
            : 0,
        },
      );
    }
    const wangSet = wangSetValue as JsonObject;
    if (
      wangSet.edgecolors !== undefined ||
      wangSet.cornercolors !== undefined
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${binding.path}.wangsets[${input.wangSetIndex}] uses pre-1.5 edgecolors/cornercolors; their color remapping semantics are not supported.`,
        { wangSetIndex: input.wangSetIndex },
      );
    }
    if (
      wangSet.type !== "corner" &&
      wangSet.type !== "mixed"
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Corner painting requires a corner or mixed Wang set.",
        {
          wangSetIndex: input.wangSetIndex,
          type: wangSet.type ?? null,
        },
      );
    }
    const colorCount = Array.isArray(
      wangSet.colors,
    )
      ? wangSet.colors.length
      : 0;
    validateTerrainCorners(
      input.corners,
      context.width,
      context.height,
      colorCount,
    );
    const layer = findTileLayer(
      context.loaded.document,
      input.layerId,
      input.mapPath,
      "read",
    );

    const absoluteSource =
      await this.resolver.resolveExisting(
        input.mapPath,
      );
    const stagingDir = await mkdtemp(
      join(tmpdir(), "tiledmcp-terrain-"),
    );
    let outputDocument: JsonObject;
    try {
      const outputPath = join(
        stagingDir,
        "out.tmj",
      );
      const scriptPath = join(
        stagingDir,
        "paint.js",
      );
      await writeFile(
        scriptPath,
        buildTerrainPaintScript({
          sourcePath: absoluteSource,
          outputPath,
          layerId: input.layerId,
          tilesetIndex,
          wangSetIndex: input.wangSetIndex,
          corners: input.corners,
        }),
        "utf8",
      );
      const result = await evaluate(scriptPath);
      assertTerrainScriptSucceeded(result.stdout);
      outputDocument = parseJsonDocument(
        (await readFile(outputPath)).toString(
          "utf8",
        ),
        input.mapPath,
      );
    } finally {
      await rm(stagingDir, {
        recursive: true,
        force: true,
      });
    }
    await assertRevisionUnchanged(
      this.store,
      input.mapPath,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "the terrain paint was being prepared",
    );

    const outputLayer = findTileLayer(
      outputDocument,
      input.layerId,
      input.mapPath,
      "read",
    );
    const cells: Array<{
      x: number;
      y: number;
      tile: TileRef | null;
    }> = [];
    for (let y = 0; y < context.height; y += 1) {
      for (let x = 0; x < context.width; x += 1) {
        const before = readLayerGid(layer, x, y);
        const after = readLayerGid(
          outputLayer,
          x,
          y,
        );
        if (before !== after) {
          cells.push({
            x,
            y,
            tile: gidToTileRef(
              after,
              context.orientation,
              context.bindings,
            ),
          });
        }
      }
    }
    if (cells.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The terrain paint produced no cell changes; the painted corners already match the Wang set.",
        { cornerCount: input.corners.length },
      );
    }
    return this.planEdits(
      input.mapPath,
      input.expectedMapRevision,
      input.expectedDependencyRevisions,
      [
        {
          type: "setTiles",
          layerId: input.layerId,
          cells,
        },
      ],
    );
  }

  async applyExportFile(
    plan: FileExportPlan,
    runner: TiledExportRunner,
  ): Promise<
    CommitResult & { changeSetId: string }
  > {
    assertFileExportPlan(plan);
    const currentSource =
      await this.store.readRevision(
        plan.sourcePath,
      );
    if (currentSource !== plan.sourceRevision) {
      throw new TiledMcpError(
        "DEPENDENCY_REVISION_CONFLICT",
        `${plan.sourcePath} changed since the export was previewed.`,
        {
          path: plan.sourcePath,
          expectedRevision: plan.sourceRevision,
          actualRevision: currentSource,
        },
      );
    }
    let applyResolver:
      | ClassPropertyResolver
      | undefined;
    if (
      plan.producer === "native" &&
      plan.projectFilePath !== undefined
    ) {
      const projectSnapshot =
        await this.store.read(
          plan.projectFilePath,
        );
      if (
        projectSnapshot.revision !==
        plan.projectRevision
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          `${plan.projectFilePath} changed since the export was previewed; class member types could differ.`,
          {
            path: plan.projectFilePath,
            expectedRevision:
              plan.projectRevision,
            actualRevision:
              projectSnapshot.revision,
          },
        );
      }
      applyResolver = this.buildClassResolver(
        projectSnapshot.document,
        plan.projectFilePath,
      );
    }
    const content =
      plan.producer === "native"
        ? Buffer.from(
            (plan.exportKind === "tileset"
              ? serializeTsxTileset
              : plan.exportKind === "template"
                ? serializeTxTemplate
                : serializeTmxMap)(
              (
                await this.store.read(
                  plan.sourcePath,
                )
              ).document,
              plan.sourcePath,
              applyResolver,
            ),
            "utf8",
          )
        : await this.runExport(
            runner,
            // CLI plans never carry the template kind — only the
            // native producer creates it.
            plan.exportKind as
              | "map"
              | "tileset",
            plan.format,
            plan.sourcePath,
            plan.sourceRevision,
          );
    if (revisionOf(content) !== plan.baseRevision) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "Re-running the export produced different bytes than the approved plan; preview the export again.",
        {
          path: plan.targetPath,
          expectedRevision: plan.baseRevision,
          actualRevision: revisionOf(content),
        },
      );
    }
    const result = await this.store.createBytes(
      plan.targetPath,
      content,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  private async assertExportTargetAbsent(
    targetPath: string,
  ): Promise<void> {
    try {
      await this.resolver.resolveExisting(
        targetPath,
      );
    } catch (error) {
      if (
        error instanceof TiledMcpError &&
        error.code === "FILE_NOT_FOUND"
      ) {
        return;
      }
      throw error;
    }
    throw new TiledMcpError(
      "FILE_ALREADY_EXISTS",
      `Refusing to overwrite existing file ${targetPath}; exports only create new files.`,
      { path: targetPath },
    );
  }

  private async runExport(
    runner: TiledExportRunner,
    kind: "map" | "tileset",
    format: string,
    sourcePath: string,
    expectedSourceRevision: string,
  ): Promise<Buffer> {
    const absoluteSource =
      await this.resolver.resolveExisting(
        sourcePath,
      );
    const stagingDir = await mkdtemp(
      join(tmpdir(), "tiledmcp-export-"),
    );
    try {
      const content = await runner({
        kind,
        format,
        sourcePath: absoluteSource,
        outputPath: join(
          stagingDir,
          `out.${format}`,
        ),
        maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES,
      });
      await assertRevisionUnchanged(
        this.store,
        sourcePath,
        expectedSourceRevision,
        "REVISION_CONFLICT",
        "it was being exported",
      );
      return content;
    } finally {
      await rm(stagingDir, {
        recursive: true,
        force: true,
      });
    }
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
    const { document } =
      await this.prepareTilesetCreateContent(
        plan,
      );
    const result = await this.store.create(
      plan.tilesetPath,
      document,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  /**
   * Replays a tileset create plan and returns the prospective document
   * plus its exact serialized bytes without creating the file.
   */
  private async prepareTilesetCreateContent(
    plan: TilesetCreatePlan,
  ): Promise<{
    document: JsonObject;
    content: Buffer;
  }> {
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
    return { document, content };
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
    await this.prepareDeleteFile(plan);
    const result =
      await this.store.deleteDocument(
        plan.targetPath,
        plan.baseRevision,
        `apply change set ${plan.id}`,
      );
    return { ...result, changeSetId: plan.id };
  }

  /**
   * Re-validates a delete plan without unlinking. References may have
   * appeared since the preview; the scan is fail-closed evidence, so it
   * re-runs against the current project state.
   */
  private async prepareDeleteFile(
    plan: FileDeletePlan,
  ): Promise<void> {
    assertFileDeletePlan(plan);
    await this.scanDeleteReferences(
      plan.targetPath,
      plan.targetKind,
    );
  }

  async applyTransaction(
    plan: TransactionPlan,
    memberPlans: readonly ChangeSetPlan[],
  ): Promise<{
    result: TransactionApplyOutcome;
    memberResults: Map<
      string,
      TransactionMemberApplyResult
    >;
  }> {
    const { id: suppliedId, ...unsigned } = plan;
    if (
      suppliedId !== transactionPlanId(unsigned)
    ) {
      throw new TiledMcpError(
        "CHANGE_SET_TAMPERED",
        "The transaction plan contents do not match its digest. Preview the transaction again.",
        { suppliedId },
      );
    }
    if (
      memberPlans.length !== plan.targets.length
    ) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The transaction member plans do not match the approved targets.",
      );
    }
    const pairs: {
      target: TransactionPlanTarget;
      memberPlan: ChangeSetPlan;
    }[] = [];
    for (
      let index = 0;
      index < plan.targets.length;
      index += 1
    ) {
      const target = plan.targets[index];
      const memberPlan = memberPlans[index];
      if (
        target === undefined ||
        memberPlan === undefined ||
        memberPlan.kind !== target.planKind ||
        memberPlan.id !== target.memberPlanDigest
      ) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "A transaction member plan does not match the approved target it was locked for.",
          { index },
        );
      }
      pairs.push({ target, memberPlan });
    }
    // Replay create members first so map-edit members can bind prospective
    // TSJs that only materialize inside this transaction.
    const prospectiveTilesetSources = new Map<
      string,
      ProspectiveTilesetSource
    >();
    const preparedByIndex = new Array<
      TransactionTargetInput | undefined
    >(pairs.length).fill(undefined);
    for (const [index, pair] of pairs.entries()) {
      if (pair.memberPlan.kind !== "tilesetCreate") {
        continue;
      }
      const { document, content } =
        await this.prepareTilesetCreateContent(
          pair.memberPlan,
        );
      prospectiveTilesetSources.set(
        pair.memberPlan.tilesetPath,
        {
          document,
          revision: pair.memberPlan.baseRevision,
        },
      );
      preparedByIndex[index] = {
        kind: "create",
        path: pair.memberPlan.tilesetPath,
        content,
      };
    }
    const targets: TransactionTargetInput[] = [];
    for (const [index, pair] of pairs.entries()) {
      const prepared =
        preparedByIndex[index] ??
        (await this.prepareTransactionTarget(
          pair.memberPlan,
          prospectiveTilesetSources,
        ));
      if (
        prepared.path !== pair.target.path ||
        ("expectedRevision" in prepared
          ? prepared.expectedRevision
          : null) !== pair.target.expectedRevision
      ) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "A prepared transaction target no longer matches its approved path or revision pin.",
          { index, path: pair.target.path },
        );
      }
      targets.push(prepared);
    }
    const commit =
      await this.store.commitTransaction(
        targets,
        `apply transaction change set ${plan.id}`,
      );
    // The store reports per-target results in its deterministic canonical
    // path order; the wire result follows the approved member order.
    const resultByPath = new Map(
      commit.results.map((targetResult) => [
        targetResult.path,
        targetResult,
      ]),
    );
    const memberResults = new Map<
      string,
      TransactionMemberApplyResult
    >();
    const results: TransactionMemberApplyResult[] =
      [];
    for (
      let index = 0;
      index < plan.targets.length;
      index += 1
    ) {
      const target = plan.targets[index];
      const targetResult =
        target === undefined
          ? undefined
          : resultByPath.get(target.path);
      if (
        target === undefined ||
        targetResult === undefined ||
        resultByPath.size !==
          plan.targets.length
      ) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          "The transaction commit results do not line up with the approved targets.",
        );
      }
      let memberResult: TransactionMemberApplyResult;
      if (targetResult.kind === "delete") {
        if (targetResult.beforeRevision === null) {
          throw new TiledMcpError(
            "INTERNAL_ERROR",
            "A transaction deletion result is missing its before revision.",
          );
        }
        memberResult = {
          kind: "fileDelete",
          path: targetResult.path,
          beforeRevision:
            targetResult.beforeRevision,
          checkpointId: targetResult.checkpointId,
          deleted: true,
          changeSetId: target.memberChangeSetId,
        };
      } else {
        if (targetResult.revision === null) {
          throw new TiledMcpError(
            "INTERNAL_ERROR",
            "A transaction commit result is missing its content revision.",
          );
        }
        memberResult = {
          path: targetResult.path,
          beforeRevision:
            targetResult.beforeRevision,
          revision: targetResult.revision,
          checkpointId: targetResult.checkpointId,
          changed: true,
          changeSetId: target.memberChangeSetId,
        };
      }
      results.push(memberResult);
      memberResults.set(
        target.memberChangeSetId,
        memberResult,
      );
    }
    const result: TransactionApplyOutcome = {
      kind: "transaction",
      transactionId: commit.transactionId,
      results,
      ...(commit.warnings === undefined
        ? {}
        : { warnings: commit.warnings }),
    };
    return { result, memberResults };
  }

  /**
   * Replays one transaction member plan into the exact bytes-level target
   * the journaled commit protocol consumes, without touching the store.
   */
  private async prepareTransactionTarget(
    memberPlan: ChangeSetPlan,
    prospectiveTilesetSources?: ReadonlyMap<
      string,
      ProspectiveTilesetSource
    >,
  ): Promise<TransactionTargetInput> {
    if (memberPlan.kind === "mapEdit") {
      return {
        kind: "replace",
        path: memberPlan.mapPath,
        expectedRevision: memberPlan.baseRevision,
        content:
          await this.prepareMapEditBytes(
            memberPlan,
            prospectiveTilesetSources,
          ),
      };
    }
    if (memberPlan.kind === "tilesetEdit") {
      return {
        kind: "replace",
        path: memberPlan.tilesetPath,
        expectedRevision: memberPlan.baseRevision,
        content:
          await this.prepareTilesetEditBytes(
            memberPlan,
          ),
      };
    }
    if (memberPlan.kind === "tilesetCreate") {
      const { content } =
        await this.prepareTilesetCreateContent(
          memberPlan,
        );
      return {
        kind: "create",
        path: memberPlan.tilesetPath,
        content,
      };
    }
    if (memberPlan.kind === "fileDelete") {
      await this.prepareDeleteFile(memberPlan);
      return {
        kind: "delete",
        path: memberPlan.targetPath,
        expectedRevision: memberPlan.baseRevision,
      };
    }
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A transaction member plan has an unsupported kind.",
      { kind: memberPlan.kind },
    );
  }

  private async scanDeleteReferences(
    targetPath: string,
    targetKind: "map" | "tileset",
    excludeReferrerPath?: string,
  ): Promise<FileDeleteScanSummary> {
    const assets =
      await this.resolver.listAssets(10_000);
    const referrers = assets.filter((asset) => {
      if (
        asset.path === targetPath ||
        asset.path === excludeReferrerPath
      ) {
        return false;
      }
      const lower = asset.path.toLowerCase();
      if (targetKind === "tileset") {
        // XML maps and templates reference tilesets too; the bounded
        // fail-closed XML reader lets the scan prove them clean.
        return (
          lower.endsWith(".tmj") ||
          lower.endsWith(".tj") ||
          lower.endsWith(".tmx") ||
          lower.endsWith(".tx")
        );
      }
      return lower.endsWith(".world");
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
      const lower = referrer.path.toLowerCase();
      let references = false;
      if (
        lower.endsWith(".tmx") ||
        lower.endsWith(".tx")
      ) {
        if (lower.endsWith(".tmx")) {
          scan.scannedMaps += 1;
        } else {
          scan.scannedTemplates += 1;
        }
        let sources: string[];
        try {
          sources = collectXmlTilesetReferences(
            parseXmlDocument(
              snapshot.source.toString("utf8"),
              referrer.path,
            ),
          );
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
        for (const source of sources) {
          if (
            await this.referenceResolvesTo(
              referrer.path,
              source,
              targetPath,
            )
          ) {
            references = true;
            break;
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
        continue;
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
    // Reuse the bounded semantic scanner as the tileset write-profile gate;
    // it rejects malformed tiles, duplicate or out-of-range ids, and
    // malformed probability/animation metadata before any mutation.
    const collection = collectionProfileOf(binding);
    if (collection === undefined) {
      const imageReference = expectString(
        tileset.document.image,
        `${binding.path}.image`,
      );
      const imagePath =
        await this.resolver.resolveReference(
          binding.path,
          imageReference,
        );
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
    } else {
      summarizeTilesetDocument({
        document: tileset.document,
        path: binding.path,
        name: binding.name,
        nameTruncated: binding.nameTruncated,
        tileCount: binding.tileCount,
        startTileId: 0,
        limit: 1,
        collection,
      });
    }
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
      "the layer creation was being prepared",
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
      allowInfinite: true,
      // Cell storage and object pixel coordinates are
      // orientation-independent, so isometric maps take the same edit
      // path as orthogonal ones.
      allowIsometric: true,
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
    const patchedSource =
      await this.prepareMapEditBytes(plan);
    const result = await this.store.commitBytes(
      plan.mapPath,
      plan.baseRevision,
      patchedSource,
      `apply change set ${plan.id}`,
    );
    return { ...result, changeSetId: plan.id };
  }

  /**
   * Replays a map edit plan against current project state and returns the
   * patched TMJ bytes without committing them.
   */
  private async prepareMapEditBytes(
    plan: MapEditPlan,
    prospectiveTilesetSources?: ReadonlyMap<
      string,
      ProspectiveTilesetSource
    >,
  ): Promise<Buffer> {
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
      allowInfinite: true,
      allowIsometric: true,
      expectedMapRevision: plan.baseRevision,
      expectedDependencyRevisions: plan.dependencyRevisions,
      persistIdentity: true,
    });
    assertDependencyRevisions(plan.dependencyRevisions, context.dependencyRevisions);

    for (const operation of plan.operations) {
      if (
        operation.type !== "instantiateTemplate"
      ) {
        continue;
      }
      // The pinned template must be unchanged and the serialized
      // relative reference must still resolve to the pinned path.
      const currentRevision =
        await this.store.readRevision(
          operation.templatePath,
        );
      if (
        currentRevision !==
        operation.expectedTemplateRevision
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          `${operation.templatePath} changed since the template instance was planned.`,
          {
            path: operation.templatePath,
            expectedRevision:
              operation.expectedTemplateRevision,
            actualRevision: currentRevision,
          },
        );
      }
      const resolved =
        await this.resolver.resolveReference(
          plan.mapPath,
          operation.source,
        );
      if (resolved !== operation.templatePath) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The template instance's relative reference no longer resolves to its pinned template path.",
          {
            source: operation.source,
            resolved,
            templatePath: operation.templatePath,
          },
        );
      }
    }

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
      const transactionSource =
        prospectiveTilesetSources?.get(
          plannedOperation.tilesetPath,
        );
      prospectiveTileset = await this.loadProspectiveTilesetBinding(
        plannedOperation.tilesetPath,
        plannedOperation.tilesetRevision,
        plannedOperation.assetId,
        transactionSource === undefined,
        transactionSource,
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
    if (
      prospectiveTileset !== undefined &&
      prospectiveTilesetSources?.has(
        prospectiveTileset.path,
      ) !== true
    ) {
      await assertRevisionUnchanged(
        this.store,
        prospectiveTileset.path,
        prospectiveTileset.revision,
        "DEPENDENCY_REVISION_CONFLICT",
        "the map edit was being applied",
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
    return patchJsonDocumentSource(
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
    await assertRevisionUnchanged(
      this.store,
      context.loaded.path,
      context.loaded.revision,
      "REVISION_CONFLICT",
      "its render dependencies were validated",
    );
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
    if (
      orientation !== "orthogonal" &&
      !(
        orientation === "isometric" &&
        revisionGuards.allowIsometric === true
      ) &&
      !(
        (orientation === "staggered" ||
          orientation === "hexagonal") &&
        revisionGuards
          .allowStaggeredHexagonal === true
      )
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_MAP_PROFILE",
        orientation === "isometric"
          ? "This tool supports only orthogonal maps; isometric maps are readable everywhere and editable through the standard map-edit path."
          : orientation === "staggered" ||
              orientation === "hexagonal"
            ? "This tool supports only orthogonal maps; staggered and hexagonal maps are readable through the summary, region, and usage tools."
            : "MVP semantic tools support only orthogonal maps.",
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

    const embeddedBindings: EmbeddedTilesetBinding[] = [];
    const bindings = await this.loadTilesetBindings(
      loaded.path,
      expectArray(map.tilesets, `${loaded.path}.tilesets`),
      revisionGuards.selectedTileset,
      revisionGuards.expectedDependencyRevisions,
      revisionGuards.persistIdentity === true,
      revisionGuards.allowCollectionTilesets ===
        true,
      revisionGuards.allowEmbeddedTilesets === true
        ? embeddedBindings
        : undefined,
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
      embeddedBindings,
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
    embeddedSink?: EmbeddedTilesetBinding[],
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
        if (
          embeddedSink !== undefined &&
          entry.source === undefined
        ) {
          embeddedSink.push(
            readEmbeddedTilesetBinding(
              mapPath,
              entry,
              index,
              firstGid,
            ),
          );
          continue;
        }
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
              "This tool requires atlas tilesets with a root image field; maps referencing image-collection tilesets are readable through the summary, region, object, tileset-detail, and tile-search tools.",
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
            .concat(
              (embeddedSink ?? []).map(
                (embedded) => ({
                  assetId: `embedded:${embedded.sourceIndex}`,
                  firstGid: embedded.firstGid,
                  tileCount: embedded.tileCount,
                  gidSpan: embedded.gidSpan,
                }),
              ),
            )
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
    prospectiveSource?: ProspectiveTilesetSource,
  ): Promise<ProspectiveTilesetBinding> {
    const normalizedPath = this.resolver.normalize(tilesetPath);
    if (posix.extname(normalizedPath).toLowerCase() !== ".tsj") {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        "Adding a tileset requires an external JSON tileset (.tsj).",
        { path: normalizedPath },
      );
    }
    let document: JsonObject;
    let revision: string;
    let identity: DocumentSnapshot["identity"] | undefined;
    if (prospectiveSource === undefined) {
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
      document = loaded.document;
      revision = loaded.revision;
      identity = snapshot.identity;
    } else {
      if (
        expectedRevision !== undefined &&
        prospectiveSource.revision !== expectedRevision
      ) {
        throw new TiledMcpError(
          "DEPENDENCY_REVISION_CONFLICT",
          `${normalizedPath} no longer matches the approved prospective tileset content.`,
          {
            path: normalizedPath,
            ...(expectedAssetId === undefined
              ? {}
              : { assetId: expectedAssetId }),
            expectedRevision,
            actualRevision: prospectiveSource.revision,
          },
        );
      }
      document = prospectiveSource.document;
      revision = prospectiveSource.revision;
    }
    if (document.type !== "tileset") {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${normalizedPath} is not a Tiled tileset.`,
        { path: normalizedPath },
      );
    }
    const imageReference = expectString(
      document.image,
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
      document.tilecount,
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
      document,
      normalizedPath,
      tileCount,
    );
    const displayName = boundedDisplayString(
      expectString(document.name, `${normalizedPath}.name`),
    );
    // Reuse the bounded semantic scanner as the write-profile gate. In
    // addition to atlas geometry, this rejects duplicate/out-of-range tile
    // definitions and per-tile image/subrect overrides.
    summarizeTilesetDocument({
      document,
      path: normalizedPath,
      imagePath,
      name: displayName.value,
      nameTruncated: displayName.truncated,
      tileCount,
      startTileId: 0,
      limit: 1,
    });
    const assetId =
      identity === undefined
        ? await this.assetRegistry.resolveProspectivePath(
            "external-tileset",
            normalizedPath,
          )
        : await this.assetRegistry.resolve(
            {
              kind: "external-tileset",
              path: normalizedPath,
              identity,
            },
            { persistIdentity },
          );
    return {
      assetId,
      path: normalizedPath,
      tileCount,
      gidSpan,
      revision,
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
    return this.loadPreviewAtlasSource(
      {
        document: tileset.document,
        errorPath: binding.path,
        assetLabel: binding.assetId,
        imageBasePath: binding.path,
      },
      mapTileWidth,
      mapTileHeight,
      remainingImageBytes,
      remainingDecodedPixels,
    );
  }

  /**
   * Shared atlas-source loader for the native preview: external TSJ
   * documents resolve their image relative to the tileset file, while
   * embedded map tilesets resolve theirs relative to the map file.
   */
  private async loadPreviewAtlasSource(
    source: {
      document: JsonObject;
      errorPath: string;
      assetLabel: string;
      imageBasePath: string;
    },
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
          assetId: source.assetLabel,
          remainingImageBytes: Math.max(0, remainingImageBytes),
          remainingDecodedPixels: Math.max(0, remainingDecodedPixels),
        },
      );
    }
    const document = source.document;
    if (typeof document.image !== "string") {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        "Native preview v1 requires a root atlas image.",
        { path: source.errorPath, assetId: source.assetLabel },
      );
    }

    const tileWidth = expectInteger(
      document.tilewidth,
      `${source.errorPath}.tilewidth`,
    );
    const tileHeight = expectInteger(
      document.tileheight,
      `${source.errorPath}.tileheight`,
    );
    if (tileWidth !== mapTileWidth || tileHeight !== mapTileHeight) {
      throw new TiledMcpError(
        "UNSUPPORTED_RENDER_FEATURE",
        "Native preview v1 requires every atlas tile size to match the map grid size.",
        {
          feature: "tileset-tile-size",
          assetId: source.assetLabel,
          path: source.errorPath,
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
          assetId: source.assetLabel,
          path: source.errorPath,
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
          assetId: source.assetLabel,
          path: source.errorPath,
          fillMode,
        },
      );
    }
    if (document.tileoffset !== undefined) {
      const tileOffset = expectObject(
        document.tileoffset,
        `${source.errorPath}.tileoffset`,
      );
      const offsetX = expectInteger(
        tileOffset.x ?? 0,
        `${source.errorPath}.tileoffset.x`,
      );
      const offsetY = expectInteger(
        tileOffset.y ?? 0,
        `${source.errorPath}.tileoffset.y`,
      );
      if (offsetX !== 0 || offsetY !== 0) {
        throw unsupportedRenderFeature(
          "tileset-tile-offset",
          "Native preview v1 does not support a non-zero tileset tileoffset.",
          {
            assetId: source.assetLabel,
            path: source.errorPath,
            tileOffset: { x: offsetX, y: offsetY },
          },
        );
      }
    }
    if (document.tiles !== undefined) {
      const tileEntries = expectArray(
        document.tiles,
        `${source.errorPath}.tiles`,
      );
      for (const [index, value] of tileEntries.entries()) {
        const tile = expectObject(value, `${source.errorPath}.tiles[${index}]`);
        if (tile.image !== undefined) {
          throw new TiledMcpError(
            "UNSUPPORTED_TILESET",
            "Native preview v1 does not support hybrid or image-collection tilesets.",
            {
              assetId: source.assetLabel,
              path: source.errorPath,
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
              assetId: source.assetLabel,
              path: source.errorPath,
              tileIndex: index,
            },
          );
        }
        // Animated tiles draw their own base tile image: TmxRasterizer
        // never sets ShowTileAnimations, so the static reference output
        // ignores animation frames too.
      }
    }

    const imagePath = await this.resolver.resolveReference(
      source.imageBasePath,
      document.image,
    );
    const geometry: AtlasGeometry = {
      imagePath,
      imageWidth: expectInteger(
        document.imagewidth,
        `${source.errorPath}.imagewidth`,
      ),
      imageHeight: expectInteger(
        document.imageheight,
        `${source.errorPath}.imageheight`,
      ),
      tileWidth,
      tileHeight,
      tileCount: expectInteger(
        document.tilecount,
        `${source.errorPath}.tilecount`,
      ),
      columns: expectInteger(
        document.columns,
        `${source.errorPath}.columns`,
      ),
      margin: expectInteger(
        document.margin ?? 0,
        `${source.errorPath}.margin`,
      ),
      spacing: expectInteger(
        document.spacing ?? 0,
        `${source.errorPath}.spacing`,
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
          assetId: source.assetLabel,
          path: source.errorPath,
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
              `${source.errorPath}.transparentcolor`,
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

