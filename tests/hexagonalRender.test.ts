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

import { hexTileToScreen } from "../src/images/isometricPreview.js";
import { hexagonalTileToScreen } from "../src/maps/coordinates.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";

const MAP_PATH = "maps/hex.tmj";

describe("hexagonal screen transform", () => {
  it("matches HexagonalRenderer::tileToScreenCoords", () => {
    // Staggered (side length 0), stagger axis y, index odd:
    // odd rows shift right by columnWidth = tileWidth/2.
    const staggered = {
      tileWidth: 16,
      tileHeight: 8,
      hexSideLength: 0,
      staggerAxis: "y" as const,
      staggerIndex: "odd" as const,
    };
    expect(
      hexTileToScreen(staggered, 0, 0),
    ).toEqual({ x: 0, y: 0 });
    expect(
      hexTileToScreen(staggered, 0, 1),
    ).toEqual({ x: 8, y: 4 });
    expect(
      hexTileToScreen(staggered, 1, 2),
    ).toEqual({ x: 16, y: 8 });

    // Hexagonal, stagger axis y, side length 4:
    // rowHeight = (8-4)/2 + 4 = 6.
    const hexagonal = {
      ...staggered,
      hexSideLength: 4,
    };
    expect(
      hexTileToScreen(hexagonal, 0, 1),
    ).toEqual({ x: 8, y: 6 });
    expect(
      hexTileToScreen(hexagonal, 1, 0),
    ).toEqual({ x: 16, y: 0 });
  });

  /**
   * RenderParams derives its own tile size (`columnWidth + sideOffsetX`), and
   * tileToScreenCoords steps by that rather than by the map's declared size.
   * The two only diverge when `tileSize - sideLength` is odd, which is why an
   * even-dimension fixture cannot catch a regression here.
   */
  it("steps by the derived tile size when the declared size is odd", () => {
    // staggerX, tileHeight 33: sideOffsetY = 16, so rows step by 32, not 33.
    expect(
      hexTileToScreen(
        {
          tileWidth: 32,
          tileHeight: 33,
          hexSideLength: 0,
          staggerAxis: "x",
          staggerIndex: "odd",
        },
        0,
        3,
      ),
    ).toEqual({ x: 0, y: 96 });

    // staggerY, tileWidth 33: sideOffsetX = 16, so columns step by 32, not 33.
    expect(
      hexTileToScreen(
        {
          tileWidth: 33,
          tileHeight: 32,
          hexSideLength: 0,
          staggerAxis: "y",
          staggerIndex: "odd",
        },
        1,
        0,
      ),
    ).toEqual({ x: 32, y: 0 });
  });

  it("shares one transform with tiled_convert_coordinates", () => {
    // The renderer and the coordinate tool must never disagree about where a
    // cell sits; they resolve to the same function, and this pins that.
    const geometry = {
      tileWidth: 33,
      tileHeight: 33,
      hexSideLength: 15,
      staggerAxis: "y" as const,
      staggerIndex: "even" as const,
    };
    for (let x = 0; x < 4; x += 1) {
      for (let y = 0; y < 4; y += 1) {
        expect(
          hexTileToScreen(geometry, x, y),
        ).toEqual(
          hexagonalTileToScreen(geometry, x, y),
        );
      }
    }
  });
});

describe("staggered/hexagonal native rendering", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("renders a staggered map with official offsets and determinism", async () => {
    const harness = await createHarness(
      roots,
      "staggered",
    );
    const rendered =
      await harness.service.renderHexagonal({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      });
    // Cells: (0,0)@(0,0), (1,0)@(16,0), (0,1)@(8,4), (1,1)@(24,4).
    // Canvas: maxX-minX+tw = 24+16 = 40; maxY-minY+th = 4+8 = 12.
    expect(rendered.result).toMatchObject({
      pixelSize: { width: 40, height: 12 },
      projection: {
        orientation: "staggered",
        staggerAxis: "y",
        staggerIndex: "odd",
        hexSideLength: 0,
        originPixel: { x: 0, y: 0 },
      },
      renderProfile:
        "staggered-hexagonal-tile-layers-v1",
    });
    const raw = await sharp(rendered.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (
      x: number,
      y: number,
    ): number[] => {
      const index = (y * 40 + x) * 4;
      return [
        raw.data[index]!,
        raw.data[index + 1]!,
        raw.data[index + 2]!,
        raw.data[index + 3]!,
      ];
    };
    // (0,0) red at 0..16 x 0..8; row 1 paints later: (0,1) green
    // starts at x=8 and overpaints the overlap band.
    expect(pixel(2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(10, 6)).toEqual([0, 255, 0, 255]);
    // Right edge of the staggered row: (1,1) is red at 24..40, y 4..12.
    expect(pixel(38, 10)).toEqual([
      255, 0, 0, 255,
    ]);

    const again =
      await harness.service.renderHexagonal({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      });
    expect(again.result.sha256).toBe(
      rendered.result.sha256,
    );
  });

  it("fails closed on rotation flags and wrong orientations", async () => {
    const rotated = await createHarness(
      roots,
      "hexagonal",
      [1, 0x20000001, 1, 1],
    );
    await expect(
      rotated.service.renderHexagonal({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RENDER_FEATURE",
    });

    const ortho = await createHarness(
      roots,
      "orthogonal",
    );
    await expect(
      ortho.service.renderHexagonal({
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
  orientation: string,
  data: number[] = [1, 1, 2, 1],
): Promise<{
  root: string;
  service: MapService;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-hex-render-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const tiles = await sharp({
    create: {
      width: 32,
      height: 8,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 16,
            height: 8,
            channels: 4,
            background: {
              r: 0,
              g: 255,
              b: 0,
              alpha: 1,
            },
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
    join(root, "tiles/hex.png"),
    tiles,
  );
  await writeFile(
    join(root, "tiles/hex.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "hex.png",
      imageheight: 8,
      imagewidth: 32,
      margin: 0,
      name: "Hex",
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
        data,
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
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation,
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 8,
    tilesets: [
      { firstgid: 1, source: "../tiles/hex.tsj" },
    ],
    tilewidth: 16,
    type: "map",
    width: 2,
  };
  if (
    orientation === "staggered" ||
    orientation === "hexagonal"
  ) {
    map.staggeraxis = "y";
    map.staggerindex = "odd";
  }
  if (orientation === "hexagonal") {
    map.hexsidelength = 4;
  }
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(map),
  );
  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
  };
}
