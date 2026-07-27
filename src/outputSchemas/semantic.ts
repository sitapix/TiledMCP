import { z } from "zod";

import {
  MAX_USAGE_LAYER_SUMMARIES,
  MAX_USAGE_SCAN_VALUES,
  MAX_USAGE_TILESET_SUMMARIES,
  MAX_USAGE_TOP_TILE_LIMIT,
  MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
} from "../maps/mapService.js";
import {
  MAX_TILE_FIND_CLAUSES,
  MAX_TILE_FIND_LIMIT,
  MAX_TILE_FIND_QUERY_CODE_POINTS,
  MAX_TILE_FIND_VALUE_CODE_POINTS,
} from "../maps/tileSearch.js";
import {
  MAX_TILESET_ANIMATION_FRAME_SAMPLE,
  MAX_TILESET_METADATA_LIMIT,
  MAX_TILESET_WANG_COLORS_PER_SET,
  MAX_TILESET_WANG_SET_SUMMARIES,
  MAX_TILESET_WANG_TILE_SAMPLE,
  WANG_ID_INDEX_COUNT,
} from "../maps/tilesetDetails.js";
import {
  assetIdOutputSchema,
  dependencyRevisionsOutputSchema,
  integerOutputSchema,
  mapSnapshotOutputSchema,
  nonnegativeIntegerOutputSchema,
  positiveIntegerOutputSchema,
  projectPathOutputSchema,
  projectedPropertyOutputSchema,
  revisionOutputSchema,
  toolOutputSchema,
} from "./common.js";

const externalTileIdentityOutputSchema = z
  .object({
    tileset: z
      .object({
        kind: z.literal("external"),
        assetId: assetIdOutputSchema,
      })
      .strict(),
    localId: nonnegativeIntegerOutputSchema,
  })
  .strict();

const tilesetSourceOutputSchema = z
  .object({
    assetId: assetIdOutputSchema,
    revision: revisionOutputSchema,
  })
  .strict();

const tileFindSelectorOutputSchema = z
  .string()
  .min(1)
  .max(MAX_TILE_FIND_QUERY_CODE_POINTS * 2)
  .refine(
    (value) =>
      Array.from(value).length <=
      MAX_TILE_FIND_QUERY_CODE_POINTS,
  );

const tileFindStringValueOutputSchema = z
  .string()
  .max(MAX_TILE_FIND_VALUE_CODE_POINTS * 2)
  .refine(
    (value) =>
      Array.from(value).length <=
      MAX_TILE_FIND_VALUE_CODE_POINTS,
  );

const declaredPixelSizeOutputSchema = z
  .object({
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict();

const tilesetRenderingOutputSchema = z
  .object({
    objectAlignment: z
      .enum([
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
      ])
      .optional(),
    tileRenderSize: z.enum(["tile", "grid"]),
    fillMode: z.enum([
      "stretch",
      "preserve-aspect-fit",
    ]),
    tileOffset: z
      .object({
        x: integerOutputSchema,
        y: integerOutputSchema,
      })
      .strict()
      .optional(),
    transformations: z
      .object({
        flipH: z.boolean(),
        flipV: z.boolean(),
        rotate: z.boolean(),
        preferUntransformed: z.boolean(),
      })
      .strict()
      .optional(),
    grid: z
      .object({
        orientation: z.enum([
          "orthogonal",
          "isometric",
        ]),
        width: positiveIntegerOutputSchema,
        height: positiveIntegerOutputSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const collisionShapeIdentityShape = {
  index: nonnegativeIntegerOutputSchema,
  id: nonnegativeIntegerOutputSchema.optional(),
  name: z.string().optional(),
  nameTruncated: z.literal(true).optional(),
  className: z.string().optional(),
  classNameTruncated: z
    .literal(true)
    .optional(),
  propertyCount:
    nonnegativeIntegerOutputSchema.optional(),
} as const;

const collisionCoordinateOutputSchema = z
  .number()
  .min(-1_000_000_000)
  .max(1_000_000_000);

const projectedCollisionShapeOutputSchema =
  z.union([
    z
      .object({
        ...collisionShapeIdentityShape,
        shape: z.enum([
          "rectangle",
          "point",
          "ellipse",
          "capsule",
          "text",
        ]),
        x: collisionCoordinateOutputSchema,
        y: collisionCoordinateOutputSchema,
        width: collisionCoordinateOutputSchema,
        height: collisionCoordinateOutputSchema,
        rotation:
          collisionCoordinateOutputSchema,
        textBoundsOnly: z
          .literal(true)
          .optional(),
      })
      .strict(),
    z
      .object({
        ...collisionShapeIdentityShape,
        shape: z.enum(["polygon", "polyline"]),
        x: collisionCoordinateOutputSchema,
        y: collisionCoordinateOutputSchema,
        rotation:
          collisionCoordinateOutputSchema,
        pointCount:
          nonnegativeIntegerOutputSchema,
        points: z
          .array(
            z
              .object({
                x: collisionCoordinateOutputSchema,
                y: collisionCoordinateOutputSchema,
              })
              .strict(),
          )
          .max(256)
          .optional(),
        pointsOmitted: z
          .literal(true)
          .optional(),
      })
      .strict(),
    z
      .object({
        ...collisionShapeIdentityShape,
        geometryOmitted: z.literal(true),
        reason: z.enum([
          "tile-object",
          "template",
        ]),
      })
      .strict(),
  ]);

const tilesetMetadataItemOutputSchema = z
  .object({
    localId: nonnegativeIntegerOutputSchema,
    sourceIndex: nonnegativeIntegerOutputSchema,
    className: z.string().optional(),
    classNameSource: z
      .enum(["class", "type"])
      .optional(),
    classNameTruncated: z
      .literal(true)
      .optional(),
    probability: z.number().nonnegative().optional(),
    properties: z.array(
      projectedPropertyOutputSchema,
    ),
    propertyCount:
      nonnegativeIntegerOutputSchema,
    propertiesTruncated: z
      .literal(true)
      .optional(),
    collision: z
      .object({
        objectCount:
          nonnegativeIntegerOutputSchema,
        shapes: z
          .array(
            projectedCollisionShapeOutputSchema,
          )
          .max(128),
        shapesTruncated: z
          .literal(true)
          .optional(),
      })
      .strict()
      .optional(),
    animation: z
      .object({
        frameCount:
          nonnegativeIntegerOutputSchema,
        totalDurationMs:
          nonnegativeIntegerOutputSchema,
        frames: z
          .array(
            z
              .object({
                tileId:
                  nonnegativeIntegerOutputSchema,
                durationMs:
                  positiveIntegerOutputSchema,
              })
              .strict(),
          )
          .max(
            MAX_TILESET_ANIMATION_FRAME_SAMPLE,
          ),
        framesTruncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const wangColorOutputSchema = z
  .object({
    index: positiveIntegerOutputSchema.max(
      MAX_TILESET_WANG_COLORS_PER_SET,
    ),
    name: z.string(),
    nameTruncated: z.literal(true).optional(),
    color: z.string(),
    colorTruncated: z.literal(true).optional(),
    className: z.string().optional(),
    classNameTruncated: z
      .literal(true)
      .optional(),
    probability: z.number(),
    imageTileId: integerOutputSchema,
    properties: z.array(
      projectedPropertyOutputSchema,
    ),
    propertyCount:
      nonnegativeIntegerOutputSchema,
    propertiesTruncated: z
      .literal(true)
      .optional(),
  })
  .strict();

const wangTileOutputSchema = z
  .object({
    tileId: nonnegativeIntegerOutputSchema,
    wangId: z
      .array(
        nonnegativeIntegerOutputSchema.max(
          MAX_TILESET_WANG_COLORS_PER_SET,
        ),
      )
      .length(WANG_ID_INDEX_COUNT),
  })
  .strict();

const wangSetSummaryOutputSchema = z
  .object({
    sourceIndex: nonnegativeIntegerOutputSchema,
    name: z.string(),
    nameTruncated: z.literal(true).optional(),
    type: z.enum(["corner", "edge", "mixed"]),
    className: z.string().optional(),
    classNameTruncated: z
      .literal(true)
      .optional(),
    imageTileId: integerOutputSchema,
    colorCount: nonnegativeIntegerOutputSchema,
    colors: z
      .array(wangColorOutputSchema)
      .max(MAX_TILESET_WANG_COLORS_PER_SET),
    wangTileCount:
      nonnegativeIntegerOutputSchema,
    wangTiles: z
      .object({
        order: z.literal("source"),
        wangIdOrder: z.literal(
          "clockwise-from-top",
        ),
        total: nonnegativeIntegerOutputSchema,
        returned:
          nonnegativeIntegerOutputSchema,
        truncated: z.boolean(),
        items: z
          .array(wangTileOutputSchema)
          .max(MAX_TILESET_WANG_TILE_SAMPLE),
      })
      .strict(),
    properties: z.array(
      projectedPropertyOutputSchema,
    ),
    propertyCount:
      nonnegativeIntegerOutputSchema,
    propertiesTruncated: z
      .literal(true)
      .optional(),
  })
  .strict();

const collectionTilesetMetadataItemOutputSchema =
  tilesetMetadataItemOutputSchema.extend({
    image: z
      .object({
        source: z.string().min(1),
        path: projectPathOutputSchema,
        revision: revisionOutputSchema,
        pixelSize: z
          .object({
            width: positiveIntegerOutputSchema,
            height: positiveIntegerOutputSchema,
          })
          .strict(),
      })
      .strict(),
  });

const tilesetDetailProjectionOutputSchema = <
  WangSets extends string,
  SourceImage extends string,
>(
  wangSets: WangSets,
  sourceImage: SourceImage,
) =>
  z
    .object({
      kind: z.literal(
        "bounded-semantic-summary",
      ),
      classResolution: z.literal("name-only"),
      tileClassField: z.literal(
        "type-with-class-compatibility-fallback",
      ),
      properties: z.literal(
        "typed-values-with-raw-nested-class-list-and-oversized-omission-markers",
      ),
      collision: z.literal(
        "bounded-shape-geometry-with-omission-markers",
      ),
      wangSets: z.literal(wangSets),
      sourceImage: z.literal(sourceImage),
    })
    .strict();

const tilesetDetailTilesetCoreShape = {
  name: z.string(),
  nameTruncated: z.literal(true).optional(),
  className: z.string().optional(),
  classNameTruncated: z.literal(true).optional(),
  tileSize: z
    .object({
      width: positiveIntegerOutputSchema,
      height: positiveIntegerOutputSchema,
    })
    .strict(),
  tileCount: positiveIntegerOutputSchema,
  rendering: tilesetRenderingOutputSchema,
  propertyCount: nonnegativeIntegerOutputSchema,
  featureCounts: z
    .object({
      metadataTiles:
        nonnegativeIntegerOutputSchema,
      animatedTiles:
        nonnegativeIntegerOutputSchema,
      animationFrames:
        nonnegativeIntegerOutputSchema,
      collisionTiles:
        nonnegativeIntegerOutputSchema,
      collisionObjects:
        nonnegativeIntegerOutputSchema,
      propertyTiles:
        nonnegativeIntegerOutputSchema,
      tileProperties:
        nonnegativeIntegerOutputSchema,
      wangSets: nonnegativeIntegerOutputSchema,
    })
    .strict(),
} as const;

const tilesetDetailTilesetBaseShape = {
  path: projectPathOutputSchema,
  ...tilesetDetailTilesetCoreShape,
} as const;

const tilesetDetailAtlasBlockShape = {
  atlas: z
    .object({
      columns: positiveIntegerOutputSchema,
      rows: positiveIntegerOutputSchema,
      margin: nonnegativeIntegerOutputSchema,
      spacing: nonnegativeIntegerOutputSchema,
    })
    .strict(),
  image: z
    .object({
      path: projectPathOutputSchema,
      declaredPixelSize:
        declaredPixelSizeOutputSchema,
      transparentColor: z
        .string()
        .regex(/^#[0-9a-f]{6}$/iu)
        .optional(),
    })
    .strict(),
} as const;

const tilesetDetailTileMetadataOutputSchema = <
  Item extends z.ZodType,
>(
  itemSchema: Item,
) =>
  z
    .object({
      order: z.literal("local-id"),
      startTileId:
        nonnegativeIntegerOutputSchema,
      limit: positiveIntegerOutputSchema.max(
        MAX_TILESET_METADATA_LIMIT,
      ),
      total: nonnegativeIntegerOutputSchema,
      returned: nonnegativeIntegerOutputSchema,
      hasEarlier: z.boolean(),
      hasMore: z.boolean(),
      truncated: z.boolean(),
      nextStartTileId:
        nonnegativeIntegerOutputSchema.optional(),
      items: z
        .array(itemSchema)
        .max(MAX_TILESET_METADATA_LIMIT),
    })
    .strict();

const tilesetDetailWangSetsOutputSchema = z
  .object({
    order: z.literal("source"),
    total: nonnegativeIntegerOutputSchema,
    returned: nonnegativeIntegerOutputSchema,
    truncated: z.boolean(),
    items: z
      .array(wangSetSummaryOutputSchema)
      .max(MAX_TILESET_WANG_SET_SUMMARIES),
  })
  .strict();

const tilesetDetailEnvelopeShape = {
  map: mapSnapshotOutputSchema,
  source: tilesetSourceOutputSchema,
  binding: z
    .object({
      firstGid: positiveIntegerOutputSchema,
      lastGid: positiveIntegerOutputSchema,
      gidSpan: positiveIntegerOutputSchema,
    })
    .strict(),
  truncated: z.boolean(),
  snapshotConsistency: z.literal(
    "non-atomic-read-set",
  ),
} as const;

const atlasTilesetDetailSuccessOutputSchema = z
  .object({
    ...tilesetDetailEnvelopeShape,
    projection:
      tilesetDetailProjectionOutputSchema(
        "expanded-colors-and-sampled-wang-tiles",
        "declared-metadata-only",
      ),
    tileset: z
      .object({
        ...tilesetDetailTilesetBaseShape,
        ...tilesetDetailAtlasBlockShape,
      })
      .strict(),
    tileMetadata:
      tilesetDetailTileMetadataOutputSchema(
        tilesetMetadataItemOutputSchema,
      ),
    wangSets: tilesetDetailWangSetsOutputSchema,
  })
  .strict();

const embeddedTilesetDetailSuccessOutputSchema =
  z
    .object({
      ...tilesetDetailEnvelopeShape,
      source: z
        .object({
          kind: z.literal("embedded"),
          sourceIndex:
            nonnegativeIntegerOutputSchema,
          revision: revisionOutputSchema,
        })
        .strict(),
      projection:
        tilesetDetailProjectionOutputSchema(
          "expanded-colors-and-sampled-wang-tiles",
          "declared-metadata-only",
        ),
      tileset: z
        .object({
          embedded: z
            .object({
              sourceIndex:
                nonnegativeIntegerOutputSchema,
            })
            .strict(),
          ...tilesetDetailTilesetCoreShape,
          ...tilesetDetailAtlasBlockShape,
        })
        .strict(),
      tileMetadata:
        tilesetDetailTileMetadataOutputSchema(
          tilesetMetadataItemOutputSchema,
        ),
      wangSets:
        tilesetDetailWangSetsOutputSchema,
    })
    .strict();

const collectionTilesetDetailSuccessOutputSchema =
  z
    .object({
      ...tilesetDetailEnvelopeShape,
      projection:
        tilesetDetailProjectionOutputSchema(
          "fail-closed",
          "per-tile-returned-page-verified",
        ),
      tileset: z
        .object({
          ...tilesetDetailTilesetBaseShape,
          collection: z
            .object({
              sparseLocalIds: z.literal(true),
              maxLocalId:
                nonnegativeIntegerOutputSchema,
              tileSizeSemantics: z.literal(
                "maximum-tile-image-size",
              ),
            })
            .strict(),
        })
        .strict(),
      tileMetadata:
        tilesetDetailTileMetadataOutputSchema(
          collectionTilesetMetadataItemOutputSchema,
        ),
      wangSets:
        tilesetDetailWangSetsOutputSchema,
    })
    .strict();

const tilesetDetailSuccessOutputSchema = z.union([
  atlasTilesetDetailSuccessOutputSchema,
  collectionTilesetDetailSuccessOutputSchema,
  embeddedTilesetDetailSuccessOutputSchema,
]);

export const tilesetDetailToolOutputSchema =
  toolOutputSchema(
    tilesetDetailSuccessOutputSchema,
  );

const tileFindClauseOutputSchema = z.union([
  z
    .object({
      kind: z.literal("class"),
      equals: tileFindSelectorOutputSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyExists"),
      name: tileFindSelectorOutputSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorOutputSchema,
      type: z.enum(["string", "file"]),
      value: tileFindStringValueOutputSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorOutputSchema,
      type: z.literal("color"),
      value: z
        .string()
        .regex(
          /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu,
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorOutputSchema,
      type: z.literal("int"),
      value: integerOutputSchema
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorOutputSchema,
      type: z.literal("float"),
      value: z
        .number()
        .min(-Number.MAX_VALUE)
        .max(Number.MAX_VALUE),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorOutputSchema,
      type: z.literal("bool"),
      value: z.boolean(),
    })
    .strict(),
]);

const tileFindSuccessOutputSchema = z
  .object({
    map: mapSnapshotOutputSchema,
    source: tilesetSourceOutputSchema,
    projection: z
      .object({
        kind: z.literal(
          "explicit-tile-semantics-search",
        ),
        classResolution: z.literal("name-only"),
        tileClassField: z.literal(
          "type-with-class-compatibility-fallback",
        ),
        properties: z.literal(
          "explicit-serialized-only",
        ),
        propertyValuesReturned: z.literal(false),
        inheritedPropertiesResolved:
          z.literal(false),
        wangAssignments:
          z.literal("not-indexed"),
        sourceImages: z.literal("not-read"),
        comparison: z.literal(
          "case-sensitive-exact",
        ),
      })
      .strict(),
    query: z
      .object({
        mode: z.enum(["all", "any"]),
        clauses: z
          .array(tileFindClauseOutputSchema)
          .min(1)
          .max(MAX_TILE_FIND_CLAUSES),
      })
      .strict(),
    scan: z
      .object({
        metadataEntries:
          nonnegativeIntegerOutputSchema,
        propertyEntries:
          nonnegativeIntegerOutputSchema,
        evaluations:
          nonnegativeIntegerOutputSchema,
      })
      .strict(),
    page: z
      .object({
        order: z.literal("local-id"),
        startTileId:
          nonnegativeIntegerOutputSchema,
        limit: positiveIntegerOutputSchema.max(
          MAX_TILE_FIND_LIMIT,
        ),
        totalMatches:
          nonnegativeIntegerOutputSchema,
        returned:
          nonnegativeIntegerOutputSchema,
        hasEarlier: z.boolean(),
        hasMore: z.boolean(),
        truncated: z.boolean(),
        nextStartTileId:
          nonnegativeIntegerOutputSchema.optional(),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            tile:
              externalTileIdentityOutputSchema,
            sourceIndex:
              nonnegativeIntegerOutputSchema,
            matchedClauseIndexes: z
              .array(
                nonnegativeIntegerOutputSchema.max(
                  MAX_TILE_FIND_CLAUSES - 1,
                ),
              )
              .min(1)
              .max(MAX_TILE_FIND_CLAUSES),
            class: z
              .object({
                name: z.string(),
                source: z.enum([
                  "type",
                  "class",
                ]),
                truncated: z
                  .literal(true)
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(MAX_TILE_FIND_LIMIT),
    nextPage: z
      .object({
        startTileId:
          nonnegativeIntegerOutputSchema,
        expectedMapRevision:
          revisionOutputSchema,
        expectedTilesetRevision:
          revisionOutputSchema,
      })
      .strict()
      .optional(),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    truncated: z.boolean(),
  })
  .strict();

export const tileFindToolOutputSchema =
  toolOutputSchema(tileFindSuccessOutputSchema);

const usageLayerDensityOutputSchema = z
  .object({
    layerId: positiveIntegerOutputSchema,
    name: z.string(),
    nameTruncated: z.literal(true).optional(),
    bounds: z
      .object({
        x: integerOutputSchema,
        y: integerOutputSchema,
        width: positiveIntegerOutputSchema,
        height: positiveIntegerOutputSchema,
      })
      .strict(),
    cellCount: positiveIntegerOutputSchema,
    emptyCellCount:
      nonnegativeIntegerOutputSchema,
    nonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    density: z.number().min(0).max(1),
  })
  .strict();

const usageTilesetOutputSchema = z
  .object({
    assetId: assetIdOutputSchema,
    name: z.string(),
    nameTruncated: z.literal(true).optional(),
    firstGid: positiveIntegerOutputSchema,
    tileCount: positiveIntegerOutputSchema,
    gidSpan: positiveIntegerOutputSchema,
    unused: z.boolean(),
    referenceCount:
      nonnegativeIntegerOutputSchema,
    tileCellReferenceCount:
      nonnegativeIntegerOutputSchema,
    tileObjectReferenceCount:
      nonnegativeIntegerOutputSchema,
    transformedReferenceCount:
      nonnegativeIntegerOutputSchema,
    usedLocalIdCount:
      nonnegativeIntegerOutputSchema,
    unusedLocalIds: z
      .object({
        count: nonnegativeIntegerOutputSchema,
        sample: z
          .array(
            nonnegativeIntegerOutputSchema,
          )
          .max(
            MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
          ),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

const usageTopTileOutputSchema = z
  .object({
    tile: externalTileIdentityOutputSchema,
    references: z
      .object({
        total: nonnegativeIntegerOutputSchema,
        tileCells:
          nonnegativeIntegerOutputSchema,
        tileObjects:
          nonnegativeIntegerOutputSchema,
        transformed:
          nonnegativeIntegerOutputSchema,
      })
      .strict(),
  })
  .strict();

const usageAnalysisSuccessOutputSchema = z
  .object({
    map: mapSnapshotOutputSchema,
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    profile: z.literal(
      "finite-orthogonal-tmj-external-atlas-tsj",
    ),
    scope: z
      .object({
        tileLayers: z.literal("all-recursive"),
        tileObjects: z.literal("all-recursive"),
        visibility: z.literal("ignored"),
        tileIdentity: z.literal(
          "external-asset-id-plus-local-id",
        ),
        transformAggregation:
          z.literal("base-tile"),
        unusedLocalIdDomain: z.literal(
          "atlas-local-ids-zero-to-tilecount-exclusive",
        ),
      })
      .strict(),
    scan: z
      .object({
        tileCellCount:
          nonnegativeIntegerOutputSchema,
        objectCount:
          nonnegativeIntegerOutputSchema,
        valueCount:
          nonnegativeIntegerOutputSchema,
        limit: z.literal(MAX_USAGE_SCAN_VALUES),
      })
      .strict(),
    totals: z
      .object({
        tileLayerCount:
          nonnegativeIntegerOutputSchema,
        objectLayerCount:
          nonnegativeIntegerOutputSchema,
        imageLayerCount:
          nonnegativeIntegerOutputSchema,
        groupLayerCount:
          nonnegativeIntegerOutputSchema,
        emptyTileCellCount:
          nonnegativeIntegerOutputSchema,
        nonEmptyTileCellCount:
          nonnegativeIntegerOutputSchema,
        tileObjectCount:
          nonnegativeIntegerOutputSchema,
        referenceCount:
          nonnegativeIntegerOutputSchema,
        distinctUsedTileCount:
          nonnegativeIntegerOutputSchema,
        usedTilesetCount:
          nonnegativeIntegerOutputSchema,
        unusedTilesetCount:
          nonnegativeIntegerOutputSchema,
      })
      .strict(),
    transforms: z
      .object({
        identityReferenceCount:
          nonnegativeIntegerOutputSchema,
        transformedReferenceCount:
          nonnegativeIntegerOutputSchema,
        rawFlagUsage: z.array(
          z
            .object({
              rawFlags:
                nonnegativeIntegerOutputSchema.max(
                  0xffffffff,
                ),
              referenceCount:
                nonnegativeIntegerOutputSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    layerDensity: z
      .object({
        total: nonnegativeIntegerOutputSchema,
        returned:
          nonnegativeIntegerOutputSchema,
        omitted:
          nonnegativeIntegerOutputSchema,
        truncated: z.boolean(),
        order: z.literal(
          "density-asc-then-layer-id",
        ),
        items: z
          .array(
            usageLayerDensityOutputSchema,
          )
          .max(MAX_USAGE_LAYER_SUMMARIES),
      })
      .strict(),
    tilesets: z
      .object({
        total: nonnegativeIntegerOutputSchema,
        returned:
          nonnegativeIntegerOutputSchema,
        omitted:
          nonnegativeIntegerOutputSchema,
        truncated: z.boolean(),
        order: z.literal(
          "unused-first-then-firstgid",
        ),
        items: z
          .array(usageTilesetOutputSchema)
          .max(MAX_USAGE_TILESET_SUMMARIES),
      })
      .strict(),
    topTiles: z
      .object({
        limit: positiveIntegerOutputSchema.max(
          MAX_USAGE_TOP_TILE_LIMIT,
        ),
        returned:
          nonnegativeIntegerOutputSchema,
        distinctUsedTileCount:
          nonnegativeIntegerOutputSchema,
        truncated: z.boolean(),
        order: z.literal(
          "reference-count-desc-then-firstgid-localid",
        ),
        items: z
          .array(usageTopTileOutputSchema)
          .max(MAX_USAGE_TOP_TILE_LIMIT),
      })
      .strict(),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
  })
  .strict();

export const usageAnalysisToolOutputSchema =
  toolOutputSchema(
    usageAnalysisSuccessOutputSchema,
  );
