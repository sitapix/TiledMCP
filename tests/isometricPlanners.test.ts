import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/iso.tmj";

describe("procedural planners on isometric maps", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("plans shape, generate, scatter, and prefab; generate applies", async () => {
    const harness = await createHarness(roots);
    const tile = {
      tileset: {
        kind: "external" as const,
        assetId: harness.assetId,
      },
      localId: 0,
    };
    const common = {
      mapPath: MAP_PATH,
      expectedMapRevision: harness.mapRevision,
      expectedDependencyRevisions:
        harness.dependencyRevisions,
    };

    const shape =
      await harness.service.planDrawShape({
        ...common,
        layerId: 1,
        draw: {
          shape: "rectangle",
          x: 0,
          y: 0,
          width: 2,
          height: 2,
          fill: true,
        },
        tile,
      });
    expect(shape.kind).toBe("mapEdit");

    const scatter =
      await harness.service.planScatter({
        ...common,
        layerId: 1,
        region: { x: 0, y: 0, width: 4, height: 4 },
        seed: 7,
        density: 1,
        choices: [{ tile, weight: 1 }],
      });
    expect(scatter.kind).toBe("mapEdit");

    const prefab =
      await harness.service.planStampPrefab({
        ...common,
        sourceMapPath: MAP_PATH,
        source: {
          layerId: 1,
          x: 0,
          y: 0,
          width: 2,
          height: 2,
        },
        target: { layerId: 1, x: 2, y: 2 },
        copyEmpty: true,
      });
    expect(prefab.kind).toBe("mapEdit");

    const generate =
      await harness.service.planGenerate({
        ...common,
        layerId: 1,
        region: { x: 0, y: 0, width: 4, height: 4 },
        seed: 42,
        generator: {
          algorithm: "dungeon",
          minRoomSize: 2,
        },
        mapping: [
          { min: 0, max: 0.5, tile },
        ],
      });
    await harness.service.applyEdits(generate);
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as {
      orientation: string;
      layers: Array<{ data: number[] }>;
    };
    expect(saved.orientation).toBe("isometric");
    expect(saved.layers[0]!.data).toContain(1);
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
    join(tmpdir(), "tiledmcp-iso-planners-"),
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
      height: 4,
      infinite: false,
      layers: [
        {
          data: new Array(16).fill(0),
          height: 4,
          id: 1,
          name: "ground",
          opacity: 1,
          type: "tilelayer",
          visible: true,
          width: 4,
          x: 0,
          y: 0,
        },
      ],
      nextlayerid: 2,
      nextobjectid: 1,
      orientation: "isometric",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 8,
      tilesets: [
        {
          firstgid: 1,
          source: "../tiles/decor.tsj",
        },
      ],
      tilewidth: 16,
      type: "map",
      width: 4,
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
