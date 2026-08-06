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

const MAP_PATH = "maps/objects.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const TILE_LAYER_ID = 1;
const RED_LAYER_ID = 2;
const BLUE_LAYER_ID = 3;

interface Harness {
  root: string;
  service: MapService;
}

describe("native preview base object layer rendering", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("renders visible object layers with Tiled colors, fills, and disclosures", async () => {
    const harness = await createHarness(roots);
    const rendered =
      await harness.service.renderPreview({
        mapPath: MAP_PATH,
        scale: 4,
      });

    expect(rendered.result).toMatchObject({
      omittedLayers: [],
      partial: false,
      objectLayerRendering: {
        profile: "base-object-layers-v1",
        fillAlpha: 50,
        tileObjects:
          "affine-nearest-neighbor-images",
      },
      objectLayers: [
        {
          id: RED_LAYER_ID,
          name: "Red shapes",
          color: "#ff0000",
          drawOrder: "topdown",
          objectCount: 3,
          renderedObjectCount: 3,
          tileObjectCount: 1,
          omittedTemplateObjectCount: 1,
          hiddenObjectCount: 1,
          textBoxCount: 0,
        },
        {
          id: BLUE_LAYER_ID,
          name: "Blue shapes",
          color: "#0000ff",
          drawOrder: "index",
          objectCount: 2,
          renderedObjectCount: 2,
          tileObjectCount: 0,
          omittedTemplateObjectCount: 0,
          hiddenObjectCount: 0,
          textBoxCount: 1,
        },
      ],
    });

    const decoded = await decodeRgba(rendered.png);
    // The red rectangle spans map pixels (4,4)..(28,20); its interior at
    // map pixel (16,12) → canvas (64,48) carries the alpha-50 red fill.
    const fill = pixel(decoded, 64, 48);
    expect(fill[0]).toBeGreaterThan(200);
    expect(fill[1]).toBeLessThan(80);
    expect(fill[2]).toBeLessThan(80);
    expect(fill[3]).toBeGreaterThan(30);
    expect(fill[3]).toBeLessThan(90);
    // The rectangle's top edge stroke at map pixel (16,4) → canvas (64,16)
    // is fully opaque red.
    expect(pixel(decoded, 64, 16)).toEqual([
      255, 0, 0, 255,
    ]);
    // The blue layer renders after the red layer; where its rectangle
    // overlaps the red one, the blue stroke wins.
    expect(pixel(decoded, 88, 48)).toEqual([
      0, 0, 255, 255,
    ]);
    // The tile object (gid 1, bottom-left alignment) draws its atlas
    // pixels: the frame spans map pixels (0,16)..(16,32), so its center
    // at map pixel (8,24) → canvas (32,96) carries the atlas color.
    expect(pixel(decoded, 32, 96)).toEqual([
      0x33, 0x44, 0x55, 255,
    ]);
  });

  it("honors layer and object opacity multiplicatively", async () => {
    const harness = await createHarness(roots, {
      redLayerOpacity: 0.5,
      redRectOpacity: 0.5,
    });
    const rendered =
      await harness.service.renderPreview({
        mapPath: MAP_PATH,
        scale: 4,
      });
    const decoded = await decodeRgba(rendered.png);
    const stroke = pixel(decoded, 64, 16);
    expect(stroke[0]).toBeGreaterThan(200);
    // 0.5 × 0.5 → stroke alpha ≈ 64.
    expect(stroke[3]).toBeGreaterThan(48);
    expect(stroke[3]).toBeLessThan(80);
  });

  it("fails closed on malformed object geometry in rendered layers", async () => {
    const harness = await createHarness(roots, {
      malformedObject: true,
    });
    await expect(
      harness.service.renderPreview({
        mapPath: MAP_PATH,
        scale: 2,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "conflicting shape markers",
      ),
    });
  });
});

async function decodeRgba(png: Buffer): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
  };
}

function pixel(
  decoded: {
    data: Buffer;
    width: number;
    height: number;
  },
  x: number,
  y: number,
): [number, number, number, number] {
  const index = (y * decoded.width + x) * 4;
  return [
    decoded.data[index] ?? -1,
    decoded.data[index + 1] ?? -1,
    decoded.data[index + 2] ?? -1,
    decoded.data[index + 3] ?? -1,
  ];
}

async function createHarness(
  roots: Set<string>,
  options: {
    redLayerOpacity?: number;
    redRectOpacity?: number;
    malformedObject?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-object-render-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));

  const redObjects: JsonObject[] = [
    {
      height: 16,
      id: 1,
      name: "Solid",
      rotation: 0,
      type: "",
      visible: true,
      width: 24,
      x: 4,
      y: 4,
      ...(options.redRectOpacity === undefined
        ? {}
        : { opacity: options.redRectOpacity }),
    },
    {
      height: 0,
      id: 2,
      name: "Path",
      polyline: [
        { x: 0, y: 0 },
        { x: 10, y: 6 },
      ],
      rotation: 0,
      type: "",
      visible: true,
      width: 0,
      x: 2,
      y: 26,
    },
    {
      gid: 1,
      height: 16,
      id: 3,
      name: "Decor",
      rotation: 0,
      type: "",
      visible: true,
      width: 16,
      x: 0,
      y: 32,
    },
    {
      height: 4,
      id: 4,
      name: "Ghost",
      rotation: 0,
      template: "prop.tj",
      visible: true,
      width: 4,
      x: 20,
      y: 20,
    },
    {
      height: 4,
      id: 5,
      name: "Hidden",
      rotation: 0,
      type: "",
      visible: false,
      width: 4,
      x: 24,
      y: 24,
    },
  ];
  if (options.malformedObject === true) {
    redObjects.push({
      ellipse: true,
      height: 4,
      id: 9,
      name: "Broken",
      point: true,
      rotation: 0,
      type: "",
      visible: true,
      width: 4,
      x: 1,
      y: 1,
    });
  }

  await writeJson(join(root, MAP_PATH), {
    compressionlevel: -1,
    height: 12,
    infinite: false,
    layers: [
      {
        data: new Array(144).fill(0),
        height: 12,
        id: TILE_LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 12,
        x: 0,
        y: 0,
      },
      {
        color: "#ff0000",
        id: RED_LAYER_ID,
        name: "Red shapes",
        objects: redObjects,
        opacity: options.redLayerOpacity ?? 1,
        type: "objectgroup",
        visible: true,
      },
      {
        color: "#0000ff",
        draworder: "index",
        id: BLUE_LAYER_ID,
        name: "Blue shapes",
        objects: [
          {
            height: 12,
            id: 6,
            name: "Over",
            rotation: 0,
            type: "",
            visible: true,
            width: 12,
            x: 22,
            y: 8,
          },
          {
            height: 6,
            id: 7,
            name: "Label",
            rotation: 0,
            text: { text: "hi" },
            type: "",
            visible: true,
            width: 10,
            x: 30,
            y: 34,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
      },
    ],
    nextlayerid: 4,
    nextobjectid: 10,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 4,
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
    ],
    tilewidth: 4,
    type: "map",
    version: "1.10",
    width: 12,
  });
  await writeJson(join(root, TILESET_PATH), {
    columns: 2,
    image: "terrain.svg",
    imageheight: 8,
    imagewidth: 8,
    margin: 0,
    name: "terrain",
    spacing: 0,
    tilecount: 4,
    tiledversion: "1.12.2",
    tileheight: 4,
    tilewidth: 4,
    type: "tileset",
    version: "1.10",
  });
  await writeFile(
    join(root, "tiles", "terrain.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">',
      '<rect width="8" height="8" fill="#334455"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );

  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
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
