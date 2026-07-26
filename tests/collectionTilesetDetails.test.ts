import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/props.tmj";
const COLLECTION_PATH = "tiles/props.tsj";

interface Harness {
  root: string;
  service: MapService;
  assetId: string;
}

describe("image-collection tileset details and search", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("projects sparse details with verified per-tile page images", async () => {
    const harness = await createHarness(roots);
    const details =
      await harness.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
      });
    expect(details).toMatchObject({
      projection: {
        wangSets: "fail-closed",
        sourceImage:
          "per-tile-returned-page-verified",
      },
      tileset: {
        path: COLLECTION_PATH,
        name: "props",
        tileSize: { width: 24, height: 32 },
        tileCount: 2,
        collection: {
          sparseLocalIds: true,
          maxLocalId: 7,
          tileSizeSemantics:
            "maximum-tile-image-size",
        },
      },
      tileMetadata: {
        order: "local-id",
        total: 2,
        returned: 2,
        items: [
          {
            localId: 0,
            image: {
              source: "prop-a.png",
              path: "tiles/prop-a.png",
              revision: expect.stringMatching(
                /^sha256:[0-9a-f]{64}$/u,
              ),
              pixelSize: {
                width: 16,
                height: 16,
              },
            },
          },
          {
            localId: 7,
            className: "Prop",
            image: {
              source: "prop-b.png",
              path: "tiles/prop-b.png",
              pixelSize: {
                width: 24,
                height: 32,
              },
            },
          },
        ],
      },
      wangSets: { total: 0, returned: 0 },
    });
    const tilesetBlock = (
      details as {
        tileset: Record<string, unknown>;
      }
    ).tileset;
    expect(tilesetBlock.atlas).toBeUndefined();
    expect(tilesetBlock.image).toBeUndefined();

    // Sparse pagination between the existing ids.
    const page = await harness.service.getTileset(
      {
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        startTileId: 1,
      },
    );
    expect(page).toMatchObject({
      tileMetadata: {
        returned: 1,
        hasEarlier: true,
        hasMore: false,
        items: [{ localId: 7 }],
      },
    });
  });

  it("searches collection metadata and paginates by sparse id", async () => {
    const harness = await createHarness(roots);
    const found = await harness.service.findTiles(
      {
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        query: {
          mode: "all",
          clauses: [
            { kind: "class", equals: "Prop" },
          ],
        },
      },
    );
    expect(found).toMatchObject({
      page: {
        totalMatches: 1,
        returned: 1,
      },
      items: [
        expect.objectContaining({
          tile: expect.objectContaining({
            localId: 7,
          }),
        }),
      ],
    });
  });

  it("renders explicit sparse collection tiles in input order", async () => {
    const harness = await createHarness(roots);
    const rendered =
      await harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        localIds: [7, 0],
        scale: 2,
      });
    expect(rendered.result).toMatchObject({
      renderProfile:
        "explicit-local-id-collection-selection-v1",
      images: [
        {
          localId: 7,
          path: "tiles/prop-b.png",
          revision: expect.stringMatching(
            /^sha256:[0-9a-f]{64}$/u,
          ),
          format: "png",
          pixelSize: { width: 24, height: 32 },
        },
        {
          localId: 0,
          path: "tiles/prop-a.png",
          format: "png",
          pixelSize: { width: 16, height: 16 },
        },
      ],
      tileset: {
        path: COLLECTION_PATH,
        tileCount: 2,
        collection: {
          sparseLocalIds: true,
          maxLocalId: 7,
        },
      },
      selection: {
        localIds: [7, 0],
        order: "input",
        labels: "local-id",
      },
      scale: 2,
      truncated: false,
    });
    expect(
      (rendered.result as { tileset: Record<string, unknown> })
        .tileset.atlas,
    ).toBeUndefined();
    expect(rendered.png.byteLength).toBeGreaterThan(0);

    await expect(
      harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        localIds: [3],
      }),
    ).rejects.toMatchObject({
      code: "TILE_ID_OUT_OF_RANGE",
    });
    await expect(
      harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        localIds: [7, 7],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("fails closed on dimension mismatch, sub-rectangles, and Wang sets", async () => {
    const mismatch = await createHarness(roots, {
      tiles: [
        {
          id: 0,
          image: "prop-a.png",
          imagewidth: 15,
          imageheight: 16,
        },
        collectionTile(7),
      ],
    });
    await expect(
      mismatch.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: mismatch.assetId,
      }),
    ).rejects.toMatchObject({
      code: "TILESET_IMAGE_DIMENSION_MISMATCH",
      details: expect.objectContaining({
        actualWidth: 16,
        declaredWidth: 15,
      }),
    });

    const subrect = await createHarness(roots, {
      tiles: [
        {
          id: 0,
          image: "prop-a.png",
          imagewidth: 16,
          imageheight: 16,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
        },
        collectionTile(7),
      ],
    });
    await expect(
      subrect.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: subrect.assetId,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
      details: expect.objectContaining({
        field: "x",
      }),
    });
    await expect(
      subrect.service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: subrect.assetId,
        query: {
          mode: "all",
          clauses: [
            { kind: "class", equals: "Prop" },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });

    const wang = await createHarness(roots, {
      wangsets: [
        {
          name: "paths",
          type: "corner",
          tile: -1,
          colors: [],
          wangtiles: [],
        },
      ],
    });
    await expect(
      wang.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: wang.assetId,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
      details: expect.objectContaining({
        wangSets: 1,
      }),
    });
  });

  it("fails closed when a page image is missing", async () => {
    const harness = await createHarness(roots, {
      writeImages: false,
    });
    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
      }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });
});

function collectionTile(id: number): JsonObject {
  return {
    id,
    image: "prop-b.png",
    imagewidth: 24,
    imageheight: 32,
    type: "Prop",
  };
}

async function createHarness(
  roots: Set<string>,
  options: {
    tiles?: JsonObject[];
    wangsets?: JsonObject[];
    writeImages?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "tiledmcp-collection-details-",
    ),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  if (options.writeImages !== false) {
    await writeFile(
      join(root, "tiles/prop-a.png"),
      await buildPng(16, 16),
    );
    await writeFile(
      join(root, "tiles/prop-b.png"),
      await buildPng(24, 32),
    );
  }

  const tiles = options.tiles ?? [
    {
      id: 0,
      image: "prop-a.png",
      imagewidth: 16,
      imageheight: 16,
    },
    collectionTile(7),
  ];
  await writeFile(
    join(root, COLLECTION_PATH),
    serializeJsonDocument({
      columns: 0,
      grid: {
        height: 1,
        orientation: "orthogonal",
        width: 1,
      },
      margin: 0,
      name: "props",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 32,
      tiles,
      tilewidth: 24,
      type: "tileset",
      version: "1.10",
      ...(options.wangsets === undefined
        ? {}
        : { wangsets: options.wangsets }),
    }),
  );
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 2,
      infinite: false,
      layers: [
        {
          data: [1, 8, 0, 0],
          height: 2,
          id: 1,
          name: "Ground",
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
      tilesets: [
        {
          firstgid: 1,
          source: "../tiles/props.tsj",
        },
      ],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 2,
    }),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  const service = new MapService(resolver, store);
  const summary =
    await service.getSummary(MAP_PATH);
  const assetId = Object.keys(
    summary.dependencyRevisions as Record<
      string,
      string
    >,
  )[0] as string;
  return { root, service, assetId };
}

async function buildPng(
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: {
        r: 120,
        g: 100,
        b: 60,
        alpha: 1,
      },
    },
  })
    .png()
    .toBuffer();
}
