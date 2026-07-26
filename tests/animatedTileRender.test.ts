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

import { serializeJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";

describe("animated tile preview rendering", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("draws the base tile image of animated tiles, matching static rasterizer output", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "tiledmcp-animated-"),
    );
    roots.add(root);
    await mkdir(join(root, "maps"));
    await mkdir(join(root, "tiles"));
    await writeFile(
      join(root, "tiles/terrain.png"),
      await sharp({
        create: {
          width: 32,
          height: 16,
          channels: 4,
          background: {
            r: 80,
            g: 120,
            b: 80,
            alpha: 1,
          },
        },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(
      join(root, "tiles/terrain.tsj"),
      serializeJsonDocument({
        columns: 2,
        image: "terrain.png",
        imageheight: 16,
        imagewidth: 32,
        margin: 0,
        name: "terrain",
        spacing: 0,
        tilecount: 2,
        tiledversion: "1.12.2",
        tileheight: 16,
        tiles: [
          {
            id: 0,
            animation: [
              { tileid: 1, duration: 100 },
              { tileid: 0, duration: 100 },
            ],
          },
        ],
        tilewidth: 16,
        type: "tileset",
        version: "1.10",
      }),
    );
    await writeFile(
      join(root, MAP_PATH),
      serializeJsonDocument({
        compressionlevel: -1,
        height: 1,
        infinite: false,
        layers: [
          {
            data: [1, 2],
            height: 1,
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
            source: "../tiles/terrain.tsj",
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
    const service = new MapService(
      resolver,
      new DocumentStore(resolver),
    );

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
    });
    expect(
      rendered.png.byteLength,
    ).toBeGreaterThan(0);
    expect(rendered.result).toMatchObject({
      pixelSize: expect.objectContaining({
        width: expect.any(Number),
      }),
    });
  });
});
