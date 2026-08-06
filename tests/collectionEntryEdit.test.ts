import {
  mkdir,
  mkdtemp,
  readFile,
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
const TILESET_PATH = "tiles/props.tsj";

interface Harness {
  root: string;
  service: MapService;
  assetId: string;
  mapRevision: string;
  tilesetRevision: string;
}

describe("collection tile entry create/remove", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("creates a new entry from a verified image and grows the tile size", async () => {
    const harness = await createHarness(roots);
    const plan = await harness.service.planUpdateTile({
      mapPath: MAP_PATH,
      tilesetAssetId: harness.assetId,
      expectedMapRevision: harness.mapRevision,
      expectedTilesetRevision:
        harness.tilesetRevision,
      updates: [
        {
          tileId: 3,
          createCollectionTile: {
            image: "wide.png",
          },
        },
      ],
    });
    expect(plan.summary).toMatchObject({
      collectionStructure: {
        action: "create",
        tileId: 3,
        tileCountBefore: 2,
        tileCountAfter: 3,
        tileSizeBefore: {
          width: 24,
          height: 16,
        },
        tileSizeAfter: { width: 32, height: 16 },
      },
      wouldChange: true,
    });
    expect(plan.updates[0]).toMatchObject({
      createCollectionTile: {
        image: "wide.png",
        imageWidth: 32,
        imageHeight: 16,
      },
    });

    await harness.service.applyTilesetEdit(plan);
    const document = JSON.parse(
      (
        await readFile(
          join(harness.root, TILESET_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(document).toMatchObject({
      tilecount: 3,
      tilewidth: 32,
      tileheight: 16,
    });
    expect(document.tiles).toEqual([
      expect.objectContaining({ id: 0 }),
      expect.objectContaining({ id: 2 }),
      {
        id: 3,
        image: "wide.png",
        imageheight: 16,
        imagewidth: 32,
      },
    ]);
  });

  it("removes an unreferenced entry and recomputes the tile size", async () => {
    const harness = await createHarness(roots);
    const plan = await harness.service.planUpdateTile({
      mapPath: MAP_PATH,
      tilesetAssetId: harness.assetId,
      expectedMapRevision: harness.mapRevision,
      expectedTilesetRevision:
        harness.tilesetRevision,
      updates: [
        { tileId: 2, removeCollectionTile: true },
      ],
    });
    expect(plan.summary).toMatchObject({
      collectionStructure: {
        action: "remove",
        tileId: 2,
        tileCountBefore: 2,
        tileCountAfter: 1,
        tileSizeAfter: { width: 16, height: 16 },
      },
    });

    await harness.service.applyTilesetEdit(plan);
    const document = JSON.parse(
      (
        await readFile(
          join(harness.root, TILESET_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(document).toMatchObject({
      tilecount: 1,
      tilewidth: 16,
      tileheight: 16,
    });
    expect(
      (document.tiles as JsonObject[]).map(
        (tile) => tile.id,
      ),
    ).toEqual([0]);
  });

  it("fails closed on misuse, references, and image drift", async () => {
    const harness = await createHarness(roots);
    const plan_ = (
      updates: Parameters<
        MapService["planUpdateTile"]
      >[0]["updates"],
    ) =>
      harness.service.planUpdateTile({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        expectedMapRevision: harness.mapRevision,
        expectedTilesetRevision:
          harness.tilesetRevision,
        updates,
      });

    // The map's layer references local ID 0, so its removal is blocked.
    await expect(
      plan_([
        { tileId: 0, removeCollectionTile: true },
      ]),
    ).rejects.toMatchObject({
      code: "TILESET_IN_USE",
      details: expect.objectContaining({
        localId: 0,
      }),
    });
    await expect(
      plan_([
        { tileId: 7, removeCollectionTile: true },
      ]),
    ).rejects.toMatchObject({
      code: "TILE_ID_OUT_OF_RANGE",
    });
    await expect(
      plan_([
        {
          tileId: 0,
          createCollectionTile: {
            image: "wide.png",
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // Structural updates must be exclusive to their change set.
    await expect(
      plan_([
        {
          tileId: 3,
          createCollectionTile: {
            image: "wide.png",
          },
        },
        { tileId: 0, patch: { className: "X" } },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    // A plan pinned to one image size refuses to apply after the image
    // is replaced with different dimensions.
    const plan = await plan_([
      {
        tileId: 3,
        createCollectionTile: {
          image: "wide.png",
        },
      },
    ]);
    await writeFile(
      join(harness.root, "tiles/wide.png"),
      await pngBytes(8, 8),
    );
    await expect(
      harness.service.applyTilesetEdit(plan),
    ).rejects.toMatchObject({
      code: "TILESET_IMAGE_DIMENSION_MISMATCH",
    });
  });

  it("blocks removal while another project map references the tileset", async () => {
    const harness = await createHarness(roots, {
      secondMap: true,
    });
    await expect(
      harness.service.planUpdateTile({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        expectedMapRevision: harness.mapRevision,
        expectedTilesetRevision:
          harness.tilesetRevision,
        updates: [
          {
            tileId: 2,
            removeCollectionTile: true,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
    });
  });

  it("refuses to remove the last remaining entry and atlas structural edits", async () => {
    const harness = await createHarness(roots, {
      emptyLayer: true,
    });
    const removeLast =
      await harness.service.planUpdateTile({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        expectedMapRevision: harness.mapRevision,
        expectedTilesetRevision:
          harness.tilesetRevision,
        updates: [
          {
            tileId: 2,
            removeCollectionTile: true,
          },
        ],
      });
    await harness.service.applyTilesetEdit(
      removeLast,
    );
    const summary =
      (await harness.service.getSummary(
        MAP_PATH,
      )) as {
        revision: string;
        dependencyRevisions: Record<
          string,
          string
        >;
      };
    await expect(
      harness.service.planUpdateTile({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        expectedMapRevision: summary.revision,
        expectedTilesetRevision:
          summary.dependencyRevisions[
            harness.assetId
          ] as string,
        updates: [
          {
            tileId: 0,
            removeCollectionTile: true,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

async function pngBytes(
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 40, g: 90, b: 60, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function createHarness(
  roots: Set<string>,
  options: {
    secondMap?: boolean;
    emptyLayer?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-collection-entry-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/small.png"),
    await pngBytes(16, 16),
  );
  await writeFile(
    join(root, "tiles/flat.png"),
    await pngBytes(24, 8),
  );
  await writeFile(
    join(root, "tiles/wide.png"),
    await pngBytes(32, 16),
  );
  await writeFile(
    join(root, TILESET_PATH),
    serializeJsonDocument({
      columns: 0,
      grid: {
        height: 1,
        orientation: "orthogonal",
        width: 1,
      },
      margin: 0,
      name: "Props",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 24,
      tiles: [
        {
          id: 0,
          image: "small.png",
          imageheight: 16,
          imagewidth: 16,
        },
        {
          id: 2,
          image: "flat.png",
          imageheight: 8,
          imagewidth: 24,
        },
      ],
      type: "tileset",
      version: "1.10",
    }),
  );
  const mapOf = (layerGid: number): JsonObject => ({
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        data: [layerGid],
        height: 1,
        id: 1,
        name: "ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 1,
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
    width: 1,
  });
  // GID 1 = firstGid 1 + local ID 0: the map references tile 0 only.
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(
      mapOf(options.emptyLayer === true ? 0 : 1),
    ),
  );
  if (options.secondMap === true) {
    await writeFile(
      join(root, "maps/annex.tmj"),
      serializeJsonDocument(mapOf(0)),
    );
  }

  const { service } =
    await wireProject(root);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as {
    revision: string;
    tilesets: Array<{ assetId: string }>;
    dependencyRevisions: Record<string, string>;
  };
  const assetId = summary.tilesets[0]!.assetId;
  return {
    root,
    service,
    assetId,
    mapRevision: summary.revision,
    tilesetRevision: summary.dependencyRevisions[
      assetId
    ] as string,
  };
}
