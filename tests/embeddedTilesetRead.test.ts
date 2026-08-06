import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";

const MAP_PATH = "maps/level.tmj";
const EXTERNAL_TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 1;

interface Harness {
  root: string;
  service: MapService;
}

describe("embedded tileset reading", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("lists embedded tilesets in the summary next to external bindings", async () => {
    const harness = await createHarness(roots);
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    expect(summary).toMatchObject({
      tilesets: [
        expect.objectContaining({
          path: EXTERNAL_TILESET_PATH,
          firstGid: 1,
          tileCount: 4,
        }),
      ],
      embeddedTilesets: [
        {
          kind: "embedded",
          sourceIndex: 1,
          name: "Inline",
          firstGid: 5,
          tileCount: 4,
          gidSpan: 4,
          lastPotentialGid: 8,
        },
      ],
    });
    // Embedded content is pinned by the map revision only.
    expect(
      Object.keys(
        summary.dependencyRevisions as Record<
          string,
          string
        >,
      ),
    ).toHaveLength(1);
  });

  it("returns embedded tile references from region reads", async () => {
    const harness = await createHarness(roots);
    const region = await harness.service.getRegion({
      mapPath: MAP_PATH,
      layerId: LAYER_ID,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    const rows = region.rows as Array<
      Array<{
        tileset: Record<string, unknown>;
        localId: number;
      } | null>
    >;
    expect(rows[0]?.[0]).toMatchObject({
      tileset: { kind: "external" },
      localId: 0,
    });
    expect(rows[0]?.[1]).toMatchObject({
      tileset: {
        kind: "embedded",
        sourceIndex: 1,
      },
      localId: 0,
    });
    expect(rows[1]?.[0]).toMatchObject({
      tileset: {
        kind: "embedded",
        sourceIndex: 1,
      },
      localId: 3,
    });
    expect(rows[1]?.[1]).toBeNull();
  });

  it("projects embedded tileset details addressed by tilesets[] index", async () => {
    const harness = await createHarness(roots);
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    const details = await harness.service.getTileset({
      mapPath: MAP_PATH,
      embeddedIndex: 1,
    });
    expect(details).toMatchObject({
      map: {
        path: MAP_PATH,
        revision: summary.revision,
      },
      source: {
        kind: "embedded",
        sourceIndex: 1,
        revision: summary.revision,
      },
      binding: {
        firstGid: 5,
        lastGid: 8,
        gidSpan: 4,
      },
      tileset: {
        embedded: { sourceIndex: 1 },
        name: "Inline",
        tileSize: { width: 16, height: 16 },
        tileCount: 4,
        atlas: {
          columns: 2,
          rows: 2,
          margin: 0,
          spacing: 0,
        },
        image: {
          path: "tiles/inline.png",
          declaredPixelSize: {
            width: 32,
            height: 32,
          },
        },
      },
      tileMetadata: {
        total: 1,
        items: [
          {
            localId: 2,
            className: "Rock",
          },
        ],
      },
      wangSets: {
        total: 1,
        items: [
          expect.objectContaining({
            name: "Ground",
            colorCount: 1,
            wangTileCount: 1,
          }),
        ],
      },
      snapshotConsistency:
        "non-atomic-read-set",
    });
    expect(details).not.toHaveProperty([
      "tileset",
      "path",
    ]);
  });

  it("fails closed on selector misuse and unknown indexes", async () => {
    const harness = await createHarness(roots);
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    const assetId = (
      summary.tilesets as Array<{
        assetId: string;
      }>
    )[0]?.assetId as string;

    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        embeddedIndex: 1,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // Index 0 is the external entry, so no embedded tileset lives there.
    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
        embeddedIndex: 0,
      }),
    ).rejects.toMatchObject({
      code: "TILESET_NOT_IN_MAP",
      details: expect.objectContaining({
        embeddedIndexes: [1],
      }),
    });
  });

  it("keeps every non-opted-in path fail closed", async () => {
    const harness = await createHarness(roots);
    await expect(
      harness.service.analyzeUsage({
        mapPath: MAP_PATH,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    await expect(
      harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        summary.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "updateMap",
            patch: { renderOrder: "left-up" },
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });
  });

  it("rejects embedded edit references on external-only maps", async () => {
    const harness = await createHarness(roots, {
      includeEmbedded: false,
    });
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    await expect(
      harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        summary.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: {
                  tileset: {
                    kind: "embedded",
                    sourceIndex: 0,
                  },
                  localId: 0,
                },
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("renders embedded atlas tiles in the native preview", async () => {
    const harness = await createHarness(roots, {
      realImages: true,
    });
    const rendered =
      await harness.service.renderPreview({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      });
    expect(rendered.png.length).toBeGreaterThan(0);
    expect(rendered.result).toMatchObject({
      mimeType: "image/png",
      sources: expect.arrayContaining([
        expect.objectContaining({
          embedded: { sourceIndex: 1 },
          tileset: expect.objectContaining({
            path: MAP_PATH,
          }),
          image: expect.objectContaining({
            path: "tiles/inline.png",
          }),
        }),
      ]),
    });
    const sources = rendered.result
      .sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
  });

  it("edits embedded tile metadata through a map-targeted change set", async () => {
    const harness = await createHarness(roots);
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    const plan =
      await harness.service.planEmbeddedTileUpdate({
        mapPath: MAP_PATH,
        embeddedIndex: 1,
        expectedMapRevision:
          summary.revision as string,
        updates: [
          {
            tileId: 0,
            patch: { className: "Crate" },
          },
        ],
      });
    expect(plan).toMatchObject({
      kind: "embeddedTilesetEdit",
      mapPath: MAP_PATH,
      baseRevision: summary.revision,
      embeddedIndex: 1,
      summary: {
        updateCount: 1,
        wouldChange: true,
      },
    });

    await harness.service.applyEmbeddedTilesetEdit(
      plan,
    );
    const details = await harness.service.getTileset({
      mapPath: MAP_PATH,
      embeddedIndex: 1,
    });
    expect(details.tileMetadata).toMatchObject({
      total: 2,
      items: [
        expect.objectContaining({
          localId: 0,
          className: "Crate",
        }),
        expect.objectContaining({
          localId: 2,
          className: "Rock",
        }),
      ],
    });
    // Stale replay fails closed after the map commit.
    await expect(
      harness.service.applyEmbeddedTilesetEdit(
        plan,
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    // Structural collection updates are impossible on embedded tilesets.
    const fresh = await harness.service.getSummary(
      MAP_PATH,
    );
    await expect(
      harness.service.planEmbeddedTileUpdate({
        mapPath: MAP_PATH,
        embeddedIndex: 1,
        expectedMapRevision:
          fresh.revision as string,
        updates: [
          {
            tileId: 3,
            createCollectionTile: {
              image: "x.png",
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });
    await expect(
      harness.service.planEmbeddedTileUpdate({
        mapPath: MAP_PATH,
        embeddedIndex: 0,
        expectedMapRevision:
          fresh.revision as string,
        updates: [
          {
            tileId: 0,
            patch: { className: "X" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "TILESET_NOT_IN_MAP",
    });
  });

  it("renders a pixel diff between layer selections", async () => {
    const harness = await createHarness(roots, {
      realImages: true,
    });
    const rendered =
      await harness.service.renderDiff({
        mapPathA: MAP_PATH,
        mapPathB: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      });
    expect(rendered.result).toMatchObject({
      mimeType: "image/png",
      identical: true,
      differingPixelCount: 0,
      differingCells: { count: 0 },
    });
    expect(rendered.png.length).toBeGreaterThan(
      0,
    );
  });

  it("fails closed on embedded collections, legacy terrains, and GID overlaps", async () => {
    const collection = await createHarness(roots, {
      embeddedOverride: {
        firstgid: 5,
        name: "Bag",
        tilewidth: 16,
        tileheight: 16,
        tilecount: 1,
        columns: 0,
        tiles: [
          {
            id: 0,
            image: "../tiles/inline.png",
            imagewidth: 32,
            imageheight: 32,
          },
        ],
      },
    });
    await expect(
      collection.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });

    const terrains = await createHarness(roots, {
      embeddedOverride: {
        ...baseEmbeddedTileset(),
        terrains: [],
      },
    });
    await expect(
      terrains.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });

    const overlap = await createHarness(roots, {
      embeddedOverride: {
        ...baseEmbeddedTileset(),
        firstgid: 4,
      },
    });
    await expect(
      overlap.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "TILESET_GID_RANGE_OVERLAP",
    });
  });
});

function baseEmbeddedTileset(): JsonObject {
  return {
    firstgid: 5,
    name: "Inline",
    tilewidth: 16,
    tileheight: 16,
    tilecount: 4,
    columns: 2,
    margin: 0,
    spacing: 0,
    image: "../tiles/inline.png",
    imagewidth: 32,
    imageheight: 32,
    tiles: [{ id: 2, type: "Rock" }],
    wangsets: [
      {
        name: "Ground",
        type: "corner",
        tile: -1,
        colors: [
          {
            name: "Grass",
            color: "#00ff00",
            probability: 1,
            tile: -1,
          },
        ],
        wangtiles: [
          {
            tileid: 0,
            wangid: [0, 1, 0, 1, 0, 1, 0, 1],
          },
        ],
      },
    ],
  };
}

async function createHarness(
  roots: Set<string>,
  options: {
    includeEmbedded?: boolean;
    embeddedOverride?: JsonObject;
    realImages?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-embedded-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const tilesets: JsonObject[] = [
    { firstgid: 1, source: "../tiles/terrain.tsj" },
  ];
  if (options.includeEmbedded !== false) {
    tilesets.push(
      options.embeddedOverride ??
        baseEmbeddedTileset(),
    );
  }
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 2,
      infinite: false,
      layers: [
        {
          data: [1, 5, 8, 0],
          height: 2,
          id: LAYER_ID,
          name: "ground",
          opacity: 1,
          type: "tilelayer",
          visible: true,
          width: 2,
          x: 0,
          y: 0,
        },
      ],
      nextlayerid: 2,
      nextobjectid: 1,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 16,
      tilesets,
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 2,
    }),
  );
  await writeFile(
    join(root, EXTERNAL_TILESET_PATH),
    serializeJsonDocument({
      columns: 2,
      image: "terrain.png",
      imageheight: 32,
      imagewidth: 32,
      margin: 0,
      name: "Terrain",
      spacing: 0,
      tilecount: 4,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  const imageBytes = async (): Promise<Buffer> =>
    options.realImages === true
      ? sharp({
          create: {
            width: 32,
            height: 32,
            channels: 4,
            background: {
              r: 30,
              g: 120,
              b: 60,
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer()
      : Buffer.from(
          "placeholder image bytes",
          "utf8",
        );
  await writeFile(
    join(root, "tiles/terrain.png"),
    await imageBytes(),
  );
  await writeFile(
    join(root, "tiles/inline.png"),
    await imageBytes(),
  );

  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
  };
}
