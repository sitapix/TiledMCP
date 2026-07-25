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
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/props.tmj";
const COLLECTION_PATH = "tiles/props.tsj";
const LAYER_ID = 1;

interface Harness {
  root: string;
  service: MapService;
}

describe("image-collection tileset read support", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("summarizes maps referencing a sparse collection tileset", async () => {
    const harness = await createHarness(roots);
    const summary =
      await harness.service.getSummary(MAP_PATH);
    expect(summary).toMatchObject({
      tilesets: [
        {
          path: COLLECTION_PATH,
          name: "props",
          firstGid: 1,
          tileCount: 2,
          gidSpan: 8,
          lastPotentialGid: 8,
          collection: true,
        },
      ],
    });
  });

  it("reads regions with sparse-id fail-closed validation and object details", async () => {
    const harness = await createHarness(roots);
    const region =
      await harness.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 1,
      });
    expect(region.rows).toEqual([
      [
        expect.objectContaining({ localId: 0 }),
        expect.objectContaining({ localId: 7 }),
      ],
    ]);

    const objects =
      await harness.service.listObjects({
        mapPath: MAP_PATH,
      });
    expect(objects).toMatchObject({ total: 1 });
    const detail =
      await harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      });
    expect(detail.object).toMatchObject({
      id: 1,
      shape: "rectangle",
    });
  });

  it("rejects dangling GIDs pointing into removed collection ids", async () => {
    const harness = await createHarness(roots, {
      cells: [1, 3, 0, 0],
    });
    await expect(
      harness.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 1,
      }),
    ).rejects.toMatchObject({
      code: "GID_OUT_OF_RANGE",
      details: expect.objectContaining({
        gid: 3,
      }),
    });
  });

  it("keeps edits, previews, and tileset details fail-closed", async () => {
    const harness = await createHarness(roots);
    const summary =
      await harness.service.getSummary(MAP_PATH);

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
            patch: { renderOrder: "right-up" },
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });

    await expect(
      harness.service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });

    const assetId = Object.keys(
      summary.dependencyRevisions as Record<
        string,
        string
      >,
    )[0]!;
    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });
  });

  it("fails closed on malformed collection entries", async () => {
    const duplicate = await createHarness(roots, {
      tiles: [
        {
          id: 0,
          image: "a.png",
          imageheight: 8,
          imagewidth: 8,
        },
        {
          id: 0,
          image: "b.png",
          imageheight: 8,
          imagewidth: 8,
        },
      ],
      tilecount: 2,
    });
    await expect(
      duplicate.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "unique nonnegative integer",
      ),
    });

    const missingImage = await createHarness(
      roots,
      {
        tiles: [{ id: 0 }],
        tilecount: 1,
      },
    );
    await expect(
      missingImage.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "per-tile image",
      ),
    });

    const badCount = await createHarness(roots, {
      tiles: [
        {
          id: 0,
          image: "a.png",
          imageheight: 8,
          imagewidth: 8,
        },
      ],
      tilecount: 3,
    });
    await expect(
      badCount.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "does not match its image-collection tile entries",
      ),
    });
  });
});

async function createHarness(
  roots: Set<string>,
  options: {
    cells?: number[];
    tiles?: JsonObject[];
    tilecount?: number;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-collection-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));

  const tiles = options.tiles ?? [
    {
      id: 0,
      image: "prop-a.png",
      imageheight: 16,
      imagewidth: 16,
    },
    {
      id: 7,
      image: "prop-b.png",
      imageheight: 32,
      imagewidth: 24,
    },
  ];
  await writeJson(join(root, COLLECTION_PATH), {
    columns: 0,
    grid: {
      height: 1,
      orientation: "orthogonal",
      width: 1,
    },
    margin: 0,
    name: "props",
    spacing: 0,
    tilecount: options.tilecount ?? 2,
    tiledversion: "1.12.2",
    tileheight: 32,
    tiles,
    tilewidth: 24,
    type: "tileset",
    version: "1.10",
  });
  await writeJson(join(root, MAP_PATH), {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: options.cells ?? [1, 8, 0, 0],
        height: 2,
        id: LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
      {
        draworder: "topdown",
        id: 2,
        name: "Objects",
        objects: [
          {
            height: 4,
            id: 1,
            name: "Marker",
            rotation: 0,
            type: "",
            visible: true,
            width: 4,
            x: 1,
            y: 1,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
      },
    ],
    nextlayerid: 3,
    nextobjectid: 2,
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
  });

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
  };
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
