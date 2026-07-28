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

const MAP_PATH = "maps/level.tmj";

describe("mechanical validation fixes", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("erases exactly the dangling cells and leaves valid ones", async () => {
    // GID 99 resolves to no tileset; 0x80000063 is the same dangling
    // base id with a flip bit.
    const harness = await createHarness(roots, [
      1, 99, 0x80000063, 2,
    ]);
    const plan =
      await harness.service.planValidationFixes({
        mapPath: MAP_PATH,
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      });
    expect(plan.operations).toEqual([
      {
        type: "setTiles",
        layerId: 1,
        cells: [
          { x: 1, y: 0, tile: null },
          { x: 0, y: 1, tile: null },
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
      1, 0, 0, 2,
    ]);
    const validation =
      await harness.service.validate(MAP_PATH);
    expect(validation.valid).toBe(true);
  });

  it("fails closed when there is nothing to fix", async () => {
    const harness = await createHarness(roots, [
      1, 2, 0, 1,
    ]);
    await expect(
      harness.service.planValidationFixes({
        mapPath: MAP_PATH,
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

interface Harness {
  root: string;
  service: MapService;
  mapRevision: string;
  dependencyRevisions: Record<string, string>;
}

async function createHarness(
  roots: Set<string>,
  data: number[],
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-validation-fix-"),
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
    dependencyRevisions: Record<string, string>;
  };
  return {
    root,
    service,
    mapRevision: summary.revision,
    dependencyRevisions:
      summary.dependencyRevisions,
  };
}
