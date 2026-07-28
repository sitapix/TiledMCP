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

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { convertPrefabObject } from "../src/maps/prefab.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/decor.tsj";

const DECODE_NONE = (): never => {
  throw new Error("no gid expected");
};

describe("prefab object conversion", () => {
  it("converts the supported serialized shapes", () => {
    expect(
      convertPrefabObject(
        {
          id: 1,
          name: "Chest",
          type: "Loot",
          x: 8,
          y: 8,
          width: 8,
          height: 8,
          rotation: 0,
          visible: true,
        },
        "o",
        DECODE_NONE,
      ),
    ).toEqual({
      shape: "rectangle",
      name: "Chest",
      className: "Loot",
      x: 8,
      y: 8,
      width: 8,
      height: 8,
    });
    expect(
      convertPrefabObject(
        {
          id: 2,
          ellipse: true,
          x: 1,
          y: 2,
          width: 4,
          height: 4,
          rotation: 45,
          visible: false,
        },
        "o",
        DECODE_NONE,
      ),
    ).toEqual({
      shape: "ellipse",
      x: 1,
      y: 2,
      width: 4,
      height: 4,
      rotation: 45,
      visible: false,
    });
    expect(
      convertPrefabObject(
        {
          id: 3,
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
          ],
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
        "o",
        DECODE_NONE,
      ),
    ).toEqual({
      shape: "polygon",
      x: 0,
      y: 0,
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
    });
    expect(
      convertPrefabObject(
        {
          id: 4,
          gid: 7,
          x: 0,
          y: 16,
          width: 16,
          height: 16,
        },
        "o",
        (gid) => {
          expect(gid).toBe(7);
          return {
            tileset: {
              kind: "external" as const,
              assetId: "asset_0123456789abcdef01234567",
            },
            localId: 6,
          };
        },
      ),
    ).toMatchObject({
      shape: "tile",
      width: 16,
      height: 16,
      tile: { localId: 6 },
    });
    expect(
      convertPrefabObject(
        {
          id: 5,
          text: { text: "Hi", wrap: true },
          x: 0,
          y: 0,
          width: 32,
          height: 16,
        },
        "o",
        DECODE_NONE,
      ),
    ).toMatchObject({
      shape: "text",
      text: "Hi",
      wrap: true,
      width: 32,
      height: 16,
    });
  });

  it("fails closed outside the stamping profile", () => {
    expect(() =>
      convertPrefabObject(
        {
          id: 1,
          template: "../templates/crate.tj",
          x: 0,
          y: 0,
        },
        "o",
        DECODE_NONE,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_OBJECT_PROFILE",
      }),
    );
    expect(() =>
      convertPrefabObject(
        {
          id: 1,
          properties: [
            { name: "hp", type: "int", value: 3 },
          ],
          x: 0,
          y: 0,
        },
        "o",
        DECODE_NONE,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_OBJECT_PROFILE",
      }),
    );
    expect(() =>
      convertPrefabObject(
        { id: 1, x: 0, y: 0, custommember: 1 },
        "o",
        DECODE_NONE,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_OBJECT_PROFILE",
      }),
    );
    expect(() =>
      convertPrefabObject(
        {
          id: 1,
          point: true,
          x: 0,
          y: 0,
          width: 4,
          height: 0,
        },
        "o",
        DECODE_NONE,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_DOCUMENT",
      }),
    );
    expect(() =>
      convertPrefabObject(
        {
          id: 1,
          ellipse: true,
          point: true,
          x: 0,
          y: 0,
        },
        "o",
        DECODE_NONE,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_DOCUMENT",
      }),
    );
  });
});

describe("prefab stamping via map edits", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("stamps tiles and anchored objects within one map", async () => {
    const harness = await createHarness(roots);
    const plan =
      await harness.service.planStampPrefab({
        mapPath: MAP_PATH,
        sourceMapPath: MAP_PATH,
        source: {
          layerId: 1,
          x: 0,
          y: 0,
          width: 2,
          height: 2,
        },
        target: { layerId: 1, x: 3, y: 1 },
        objects: {
          sourceLayerId: 2,
          targetLayerId: 2,
        },
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
        expectedSourceRevision:
          harness.mapRevision,
      });
    expect(plan.operations).toHaveLength(3);
    expect(plan.operations[0]).toMatchObject({
      type: "setTiles",
      layerId: 1,
      cells: [
        { x: 3, y: 1 },
        { x: 4, y: 1 },
        { x: 4, y: 2 },
      ],
    });
    expect(plan.operations[1]).toMatchObject({
      type: "createObject",
      layerId: 2,
      object: {
        shape: "rectangle",
        name: "Chest",
        className: "Loot",
        x: 56,
        y: 24,
        width: 8,
        height: 8,
      },
    });
    expect(plan.operations[2]).toMatchObject({
      type: "createObject",
      layerId: 2,
      object: {
        shape: "ellipse",
        x: 48,
        y: 32,
        rotation: 45,
        visible: false,
      },
    });

    await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as {
      layers: Array<{
        data?: number[];
        objects?: JsonObject[];
      }>;
      nextobjectid: number;
    };
    const data = saved.layers[0]!.data!;
    expect(data[1 * 6 + 3]).toBe(1);
    expect(data[1 * 6 + 4]).toBe(2);
    // The empty source cell is skipped: the prefilled target keeps its
    // tile.
    expect(data[2 * 6 + 3]).toBe(2);
    expect(data[2 * 6 + 4]).toBe(1);
    const objects = saved.layers[1]!.objects!;
    expect(objects).toHaveLength(5);
    expect(objects[3]).toMatchObject({
      id: 10,
      name: "Chest",
      type: "Loot",
      x: 56,
      y: 24,
    });
    expect(objects[4]).toMatchObject({
      id: 11,
      ellipse: true,
      visible: false,
      rotation: 45,
      x: 48,
      y: 32,
    });
    expect(saved.nextobjectid).toBe(12);
  });

  it("stamps the rectangle verbatim as erasure with copyEmpty", async () => {
    const harness = await createHarness(roots);
    const plan =
      await harness.service.planStampPrefab({
        mapPath: MAP_PATH,
        sourceMapPath: MAP_PATH,
        source: {
          layerId: 1,
          x: 0,
          y: 0,
          width: 2,
          height: 2,
        },
        target: { layerId: 1, x: 3, y: 1 },
        copyEmpty: true,
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      });
    await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as { layers: Array<{ data?: number[] }> };
    // The empty source cell erases the prefilled target tile.
    expect(saved.layers[0]!.data![2 * 6 + 3]).toBe(
      0,
    );
  });

  it("fails closed on stale source pins and empty stamps", async () => {
    const harness = await createHarness(roots);
    await expect(
      harness.service.planStampPrefab({
        mapPath: MAP_PATH,
        sourceMapPath: MAP_PATH,
        source: {
          layerId: 1,
          x: 0,
          y: 0,
          width: 2,
          height: 2,
        },
        target: { layerId: 1, x: 3, y: 1 },
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
        expectedSourceRevision:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
    await expect(
      harness.service.planStampPrefab({
        mapPath: MAP_PATH,
        sourceMapPath: MAP_PATH,
        source: {
          layerId: 1,
          x: 0,
          y: 2,
          width: 2,
          height: 2,
        },
        target: { layerId: 1, x: 0, y: 0 },
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
  mapRevision: string;
  dependencyRevisions: Record<string, string>;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-prefab-test-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/decor.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  await writeFile(
    join(root, TILESET_PATH),
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
          data: [
            1, 2, 0, 0, 0, 0,
            0, 1, 0, 0, 0, 0,
            0, 0, 0, 2, 0, 0,
            0, 0, 0, 0, 0, 0,
          ],
          height: 4,
          id: 1,
          name: "ground",
          opacity: 1,
          type: "tilelayer",
          visible: true,
          width: 6,
          x: 0,
          y: 0,
        },
        {
          draworder: "topdown",
          id: 2,
          name: "props",
          objects: [
            {
              height: 8,
              id: 1,
              name: "Chest",
              rotation: 0,
              type: "Loot",
              visible: true,
              width: 8,
              x: 8,
              y: 8,
            },
            {
              ellipse: true,
              height: 4,
              id: 2,
              name: "",
              rotation: 45,
              type: "",
              visible: false,
              width: 4,
              x: 0,
              y: 16,
            },
            {
              height: 8,
              id: 3,
              name: "Outside",
              rotation: 0,
              type: "",
              visible: true,
              width: 8,
              x: 40,
              y: 8,
            },
          ],
          opacity: 1,
          type: "objectgroup",
          visible: true,
        },
      ],
      nextlayerid: 3,
      nextobjectid: 10,
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
      width: 6,
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
