import {
  mkdir,
  mkdtemp,
  readFile,
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

describe("reference image import", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("quantizes the image to palette tiles deterministically", async () => {
    const harness = await createHarness(roots);
    // 2x2 reference: red, green / green, transparent.
    const reference = await sharp(
      Buffer.from(
        new Uint8Array([
          255, 0, 0, 255, 0, 255, 0, 255,
          0, 255, 0, 255, 0, 0, 0, 0,
        ]),
      ),
      { raw: { width: 2, height: 2, channels: 4 } },
    )
      .png()
      .toBuffer();
    await mkdir(join(harness.root, "reference"));
    await writeFile(
      join(harness.root, "reference/sketch.png"),
      reference,
    );
    const tile = (localId: number) => ({
      tileset: {
        kind: "external" as const,
        assetId: harness.assetId,
      },
      localId,
    });
    const plan =
      await harness.service.planImportImage({
        mapPath: MAP_PATH,
        layerId: 1,
        imagePath: "reference/sketch.png",
        region: { x: 0, y: 0, width: 2, height: 2 },
        palette: [
          { color: "#ff0000", tile: tile(0) },
          { color: "#00ff00", tile: tile(1) },
        ],
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      });
    expect(plan.operations).toEqual([
      {
        type: "setTiles",
        layerId: 1,
        cells: [
          { x: 0, y: 0, tile: tile(0) },
          { x: 1, y: 0, tile: tile(1) },
          { x: 0, y: 1, tile: tile(1) },
          // (1,1) is fully transparent: skipped.
        ],
      },
    ]);
    await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as { layers: Array<{ data: number[] }> };
    expect(saved.layers[0]!.data).toEqual([
      1, 2, 2, 0,
    ]);
  });

  it("fails closed on bad palettes and transparent regions", async () => {
    const harness = await createHarness(roots);
    const transparent = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0,
        },
      },
    })
      .png()
      .toBuffer();
    await mkdir(join(harness.root, "reference"));
    await writeFile(
      join(harness.root, "reference/empty.png"),
      transparent,
    );
    await expect(
      harness.service.planImportImage({
        mapPath: MAP_PATH,
        layerId: 1,
        imagePath: "reference/empty.png",
        region: { x: 0, y: 0, width: 2, height: 2 },
        palette: [
          { color: "#ff0000", tile: null },
        ],
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.planImportImage({
        mapPath: MAP_PATH,
        layerId: 1,
        imagePath: "reference/empty.png",
        region: { x: 0, y: 0, width: 2, height: 2 },
        palette: [
          { color: "red", tile: null },
        ],
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
): Promise<{
  root: string;
  service: MapService;
  assetId: string;
  mapRevision: string;
  dependencyRevisions: Record<string, string>;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-image-import-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/decor.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  await writeFile(
    join(root, "tiles/decor.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "decor.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Decor",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
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
          data: [0, 0, 0, 0],
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
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 16,
      tilesets: [
        {
          firstgid: 1,
          source: "../tiles/decor.tsj",
        },
      ],
      tilewidth: 16,
      type: "map",
      width: 2,
    }),
  );
  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  const service = new MapService(resolver, store);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as {
    revision: string;
    tilesets: Array<{ assetId: string }>;
    dependencyRevisions: Record<string, string>;
  };
  return {
    root,
    service,
    assetId: summary.tilesets[0]!.assetId,
    mapRevision: summary.revision,
    dependencyRevisions:
      summary.dependencyRevisions,
  };
}
