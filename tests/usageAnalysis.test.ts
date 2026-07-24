import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
} from "../src/maps/gid.js";
import {
  MapService,
  MAX_USAGE_SCAN_VALUES,
} from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/usage.tmj";
const UNUSED_TILESET_PATH = "tiles/unused.tsj";
const USED_TILESET_PATH = "tiles/used.tsj";

interface Harness {
  root: string;
  service: MapService;
}

interface Summary {
  revision: string;
  dependencyRevisions: Record<string, string>;
  tilesets: Array<{
    assetId: string;
    path: string;
    revision: string;
  }>;
}

describe("MapService.analyzeUsage", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("aggregates recursive hidden layers, tile objects, transforms, ties, density, and unused local IDs", async () => {
    const harness = await createHarness(roots);
    const summary = await getSummary(harness.service);
    const unusedTileset = requireTileset(
      summary,
      UNUSED_TILESET_PATH,
    );
    const usedTileset = requireTileset(
      summary,
      USED_TILESET_PATH,
    );

    const result = await harness.service.analyzeUsage({
      mapPath: MAP_PATH,
      topTileLimit: 2,
      expectedMapRevision: summary.revision,
      expectedDependencyRevisions:
        summary.dependencyRevisions,
    });

    expect(result).toMatchObject({
      map: {
        path: MAP_PATH,
        revision: summary.revision,
      },
      dependencyRevisions:
        summary.dependencyRevisions,
      profile:
        "finite-orthogonal-tmj-external-atlas-tsj",
      snapshotConsistency: "non-atomic-read-set",
      scope: {
        tileLayers: "all-recursive",
        tileObjects: "all-recursive",
        visibility: "ignored",
        tileIdentity:
          "external-asset-id-plus-local-id",
        transformAggregation: "base-tile",
        unusedLocalIdDomain:
          "atlas-local-ids-zero-to-tilecount-exclusive",
      },
      scan: {
        tileCellCount: 12,
        objectCount: 3,
        valueCount: 15,
        limit: MAX_USAGE_SCAN_VALUES,
      },
      totals: {
        tileLayerCount: 3,
        objectLayerCount: 1,
        imageLayerCount: 1,
        groupLayerCount: 2,
        emptyTileCellCount: 6,
        nonEmptyTileCellCount: 6,
        tileObjectCount: 2,
        referenceCount: 8,
        distinctUsedTileCount: 3,
        usedTilesetCount: 1,
        unusedTilesetCount: 1,
      },
      transforms: {
        identityReferenceCount: 4,
        transformedReferenceCount: 4,
        rawFlagUsage: [
          { rawFlags: 0, referenceCount: 4 },
          {
            rawFlags: GID_DIAGONAL_OR_HEX_60,
            referenceCount: 1,
          },
          {
            rawFlags: GID_FLIP_VERTICAL,
            referenceCount: 1,
          },
          {
            rawFlags: GID_FLIP_HORIZONTAL,
            referenceCount: 2,
          },
        ],
      },
      layerDensity: {
        total: 3,
        returned: 3,
        omitted: 0,
        truncated: false,
        order: "density-asc-then-layer-id",
        items: [
          {
            layerId: 5,
            name: "Hidden Empty",
            bounds: {
              x: 0,
              y: 0,
              width: 4,
              height: 1,
            },
            cellCount: 4,
            emptyCellCount: 4,
            nonEmptyCellCount: 0,
            density: 0,
          },
          {
            layerId: 1,
            name: "Root Sparse",
            bounds: {
              x: -2,
              y: 3,
              width: 4,
              height: 1,
            },
            cellCount: 4,
            emptyCellCount: 2,
            nonEmptyCellCount: 2,
            density: 0.5,
          },
          {
            layerId: 3,
            name: "Hidden Dense",
            bounds: {
              x: 1,
              y: -1,
              width: 4,
              height: 1,
            },
            cellCount: 4,
            emptyCellCount: 0,
            nonEmptyCellCount: 4,
            density: 1,
          },
        ],
      },
      tilesets: {
        total: 2,
        returned: 2,
        omitted: 0,
        truncated: false,
        order: "unused-first-then-firstgid",
        items: [
          {
            assetId: unusedTileset.assetId,
            name: "Unused Atlas",
            firstGid: 1,
            tileCount: 20,
            gidSpan: 20,
            unused: true,
            referenceCount: 0,
            tileCellReferenceCount: 0,
            tileObjectReferenceCount: 0,
            transformedReferenceCount: 0,
            usedLocalIdCount: 0,
            unusedLocalIds: {
              count: 20,
              sample: Array.from(
                { length: 16 },
                (_, localId) => localId,
              ),
              truncated: true,
            },
          },
          {
            assetId: usedTileset.assetId,
            name: "Used Atlas",
            firstGid: 101,
            tileCount: 20,
            gidSpan: 20,
            unused: false,
            referenceCount: 8,
            tileCellReferenceCount: 6,
            tileObjectReferenceCount: 2,
            transformedReferenceCount: 4,
            usedLocalIdCount: 3,
            unusedLocalIds: {
              count: 17,
              sample: Array.from(
                { length: 16 },
                (_, index) => index + 3,
              ),
              truncated: true,
            },
          },
        ],
      },
      topTiles: {
        limit: 2,
        returned: 2,
        distinctUsedTileCount: 3,
        truncated: true,
        order:
          "reference-count-desc-then-firstgid-localid",
        items: [
          {
            tile: {
              tileset: {
                kind: "external",
                assetId: usedTileset.assetId,
              },
              localId: 0,
            },
            references: {
              total: 3,
              tileCells: 3,
              tileObjects: 0,
              transformed: 2,
            },
          },
          {
            tile: {
              tileset: {
                kind: "external",
                assetId: usedTileset.assetId,
              },
              localId: 1,
            },
            references: {
              total: 3,
              tileCells: 2,
              tileObjects: 1,
              transformed: 2,
            },
          },
        ],
      },
    });
  });

  it("requires a complete revision pin and rejects stale map or tileset snapshots", async () => {
    const incompleteHarness = await createHarness(roots);
    const incompleteSummary = await getSummary(
      incompleteHarness.service,
    );
    await expect(
      incompleteHarness.service.analyzeUsage({
        mapPath: MAP_PATH,
        expectedMapRevision:
          incompleteSummary.revision,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      incompleteHarness.service.analyzeUsage({
        mapPath: MAP_PATH,
        expectedDependencyRevisions:
          incompleteSummary.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    const staleMapHarness = await createHarness(roots);
    const staleMapSummary = await getSummary(
      staleMapHarness.service,
    );
    const changedMap = usageMap();
    changedMap.backgroundcolor = "#123456";
    await writeJson(
      join(staleMapHarness.root, MAP_PATH),
      changedMap,
    );
    await expect(
      staleMapHarness.service.analyzeUsage({
        mapPath: MAP_PATH,
        expectedMapRevision:
          staleMapSummary.revision,
        expectedDependencyRevisions:
          staleMapSummary.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision:
          staleMapSummary.revision,
        actualRevision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
      },
    });

    const staleTilesetHarness = await createHarness(roots);
    const staleTilesetSummary = await getSummary(
      staleTilesetHarness.service,
    );
    await writeJson(
      join(
        staleTilesetHarness.root,
        USED_TILESET_PATH,
      ),
      atlasTileset("Changed Used Atlas"),
    );
    await expect(
      staleTilesetHarness.service.analyzeUsage({
        mapPath: MAP_PATH,
        expectedMapRevision:
          staleTilesetSummary.revision,
        expectedDependencyRevisions:
          staleTilesetSummary.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId: requireTileset(
          staleTilesetSummary,
          USED_TILESET_PATH,
        ).assetId,
        expectedRevision:
          requireTileset(
            staleTilesetSummary,
            USED_TILESET_PATH,
          ).revision,
        actualRevision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
      },
    });
  });

  it.each([
    {
      name: "a value above uint32",
      gid: 0x1_0000_0000,
      code: "INVALID_TILE_DATA",
    },
    {
      name: "transform flags on base GID zero",
      gid: GID_FLIP_HORIZONTAL,
      code: "INVALID_GID",
    },
    {
      name: "a base GID in an unbound range",
      gid: 50,
      code: "GID_OUT_OF_RANGE",
    },
  ])("rejects $name", async ({ gid, code }) => {
    const map = usageMap();
    const rootTileLayer = (
      map.layers as JsonObject[]
    )[0];
    if (rootTileLayer === undefined) {
      throw new Error(
        "Expected the root tile-layer fixture.",
      );
    }
    rootTileLayer.data = [gid, 0, 0, 0];
    const harness = await createHarness(roots, map);

    await expect(
      harness.service.analyzeUsage({
        mapPath: MAP_PATH,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("enforces the aggregate cell-and-object scan budget before scanning the next layer", async () => {
    const map = usageMap();
    map.width = MAX_USAGE_SCAN_VALUES;
    map.height = 1;
    map.layers = [
      {
        id: 1,
        name: "One object first",
        type: "objectgroup",
        visible: true,
        objects: [
          {
            id: 1,
            name: "Plain object",
            point: true,
            x: 0,
            y: 0,
          },
        ],
      },
      {
        data: Array.from(
          { length: MAX_USAGE_SCAN_VALUES },
          () => 0,
        ),
        height: 1,
        id: 2,
        name: "Budget overflow",
        type: "tilelayer",
        visible: true,
        width: MAX_USAGE_SCAN_VALUES,
        x: 0,
        y: 0,
      },
    ];
    map.nextlayerid = 3;
    map.nextobjectid = 2;
    const harness = await createHarness(roots, map);

    await expect(
      harness.service.analyzeUsage({
        mapPath: MAP_PATH,
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        path: MAP_PATH,
        limit: MAX_USAGE_SCAN_VALUES,
        scanned: 1,
        nextCount: MAX_USAGE_SCAN_VALUES,
      },
    });
  }, 20_000);
});

async function createHarness(
  roots: Set<string>,
  map: JsonObject = usageMap(),
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-usage-analysis-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), map);
  await writeJson(
    join(root, UNUSED_TILESET_PATH),
    atlasTileset("Unused Atlas"),
  );
  await writeJson(
    join(root, USED_TILESET_PATH),
    atlasTileset("Used Atlas"),
  );
  await writeFile(
    join(root, "tiles", "unused.png"),
    Buffer.from("unused placeholder", "utf8"),
  );
  await writeFile(
    join(root, "tiles", "used.png"),
    Buffer.from("used placeholder", "utf8"),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
  };
}

function usageMap(): JsonObject {
  const firstUsedGid = 101;
  const secondUsedGid = 102;
  const thirdUsedGid = 103;
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        data: [
          firstUsedGid,
          secondUsedGid,
          0,
          0,
        ],
        height: 1,
        id: 1,
        name: "Root Sparse",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 4,
        x: -2,
        y: 3,
      },
      {
        id: 2,
        name: "Hidden Parent",
        opacity: 1,
        type: "group",
        visible: false,
        layers: [
          {
            data: [
              (
                GID_FLIP_HORIZONTAL |
                firstUsedGid
              ) >>> 0,
              (
                GID_FLIP_VERTICAL |
                firstUsedGid
              ) >>> 0,
              (
                GID_FLIP_HORIZONTAL |
                secondUsedGid
              ) >>> 0,
              thirdUsedGid,
            ],
            height: 1,
            id: 3,
            name: "Hidden Dense",
            opacity: 1,
            type: "tilelayer",
            visible: false,
            width: 4,
            x: 1,
            y: -1,
          },
          {
            id: 4,
            name: "Nested Hidden Group",
            opacity: 1,
            type: "group",
            visible: false,
            layers: [
              {
                data: [0, 0, 0, 0],
                height: 1,
                id: 5,
                name: "Hidden Empty",
                opacity: 1,
                type: "tilelayer",
                visible: false,
                width: 4,
                x: 0,
                y: 0,
              },
              {
                id: 6,
                name: "Hidden Objects",
                opacity: 1,
                type: "objectgroup",
                visible: false,
                objects: [
                  {
                    id: 1,
                    name: "Plain object",
                    point: true,
                    x: 0,
                    y: 0,
                  },
                  {
                    gid:
                      (
                        GID_DIAGONAL_OR_HEX_60 |
                        secondUsedGid
                      ) >>> 0,
                    height: 16,
                    id: 2,
                    name: "Flagged tile object",
                    visible: true,
                    width: 16,
                    x: 16,
                    y: 16,
                  },
                  {
                    gid: thirdUsedGid,
                    height: 16,
                    id: 3,
                    name: "Identity tile object",
                    visible: true,
                    width: 16,
                    x: 32,
                    y: 16,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 7,
        image: "../tiles/used.png",
        name: "Backdrop",
        opacity: 1,
        type: "imagelayer",
        visible: false,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 8,
    nextobjectid: 4,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/unused.tsj",
      },
      {
        firstgid: 101,
        source: "../tiles/used.tsj",
      },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 4,
  };
}

function atlasTileset(name: string): JsonObject {
  const image =
    name.includes("Unused")
      ? "unused.png"
      : "used.png";
  return {
    columns: 5,
    image,
    imageheight: 64,
    imagewidth: 80,
    margin: 0,
    name,
    spacing: 0,
    tilecount: 20,
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
  };
}

async function getSummary(
  service: MapService,
): Promise<Summary> {
  return await service.getSummary(
    MAP_PATH,
  ) as unknown as Summary;
}

function requireTileset(
  summary: Summary,
  path: string,
): Summary["tilesets"][number] {
  const tileset = summary.tilesets.find(
    (candidate) => candidate.path === path,
  );
  if (tileset === undefined) {
    throw new Error(
      `Expected summary tileset ${path}.`,
    );
  }
  return tileset;
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(
    path,
    serializeJsonDocument(document),
  );
}
