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

const MAP_PATH = "maps/iso.tmj";

const RED = { r: 255, g: 0, b: 0 };
const GREEN = { r: 0, g: 255, b: 0 };

describe("isometric native rendering", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("places tiles with the official IsometricRenderer math", async () => {
    const harness = await createHarness(roots);
    const rendered =
      await harness.service.renderIsometric({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      });
    expect(rendered.result).toMatchObject({
      mimeType: "image/png",
      pixelSize: { width: 32, height: 16 },
      scale: 1,
      projection: {
        orientation: "isometric",
        tileWidth: 16,
        tileHeight: 8,
        originPixel: { x: 16, y: 0 },
      },
      layers: [{ id: 1, name: "ground" }],
      omittedObjectLayerIds: [2],
      renderProfile: "isometric-tile-layers-v1",
    });

    const raw = await sharp(rendered.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(raw.info.width).toBe(32);
    expect(raw.info.height).toBe(16);
    const pixel = (
      x: number,
      y: number,
    ): [number, number, number, number] => {
      const index = (y * 32 + x) * 4;
      return [
        raw.data[index]!,
        raw.data[index + 1]!,
        raw.data[index + 2]!,
        raw.data[index + 3]!,
      ];
    };
    // Cell (0,0) is red: bottom-left anchor puts its 16x8 image at
    // x 8..24, y 0..8; sample a point no later cell overpaints.
    expect(pixel(9, 1)).toEqual([255, 0, 0, 255]);
    // Cell (1,0) is green at x 16..32, y 4..12; x >= 24 stays green
    // because cell (1,1) only covers x 8..24.
    expect(pixel(28, 10)).toEqual([0, 255, 0, 255]);
    // Cell (1,1) is red at x 8..24, y 8..16 and paints last on the
    // overlap with (1,0).
    expect(pixel(20, 10)).toEqual([255, 0, 0, 255]);
    // Cell (0,1) is empty: the left corner area outside every image
    // stays transparent.
    expect(pixel(1, 14)[3]).toBe(0);

    // Determinism: the identical request reproduces the same bytes.
    const again =
      await harness.service.renderIsometric({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      });
    expect(again.result.sha256).toBe(
      rendered.result.sha256,
    );
  });

  it("fails closed outside the profile", async () => {
    const harness = await createHarness(roots, {
      data: [1, 0x20000001, 0, 1],
    });
    await expect(
      harness.service.renderIsometric({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RENDER_FEATURE",
    });

    await expect(
      harness.service.renderIsometric({
        mapPath: MAP_PATH,
        region: { x: 1, y: 1, width: 2, height: 2 },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.renderIsometric({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
        layerIds: [9],
      }),
    ).rejects.toMatchObject({
      code: "LAYER_NOT_FOUND",
    });
  });

  it("rejects orthogonal maps toward tiled_render_preview", async () => {
    const harness = await createHarness(roots, {
      orientation: "orthogonal",
    });
    await expect(
      harness.service.renderIsometric({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
  options: {
    data?: number[];
    orientation?: string;
  } = {},
): Promise<{
  root: string;
  service: MapService;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-iso-render-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const tiles = await sharp({
    create: {
      width: 32,
      height: 8,
      channels: 4,
      background: { ...RED, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 16,
            height: 8,
            channels: 4,
            background: { ...GREEN, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
        left: 16,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  await writeFile(
    join(root, "tiles/iso.png"),
    tiles,
  );
  await writeFile(
    join(root, "tiles/iso.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "iso.png",
      imageheight: 8,
      imagewidth: 32,
      margin: 0,
      name: "Iso",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 8,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  const map: JsonObject = {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: options.data ?? [1, 2, 0, 1],
        height: 2,
        id: 1,
        name: "ground",
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
        name: "props",
        objects: [],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 3,
    nextobjectid: 1,
    orientation:
      options.orientation ?? "isometric",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 8,
    tilesets: [
      { firstgid: 1, source: "../tiles/iso.tsj" },
    ],
    tilewidth: 16,
    type: "map",
    width: 2,
  };
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(map),
  );
  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
  };
}
