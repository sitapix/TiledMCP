import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * Keeps `evals/iso-town.xml` honest, in the two ways it can go wrong.
 *
 * The first is drift: answers that no longer match the fixture report a
 * correct model as wrong, and the reader ends up distrusting the model rather
 * than the file. So every answer is recomputed from the committed fixture
 * bytes and compared.
 *
 * The second is subtler and is why this file does more than
 * `floorPlanEval.test.ts` does. An evaluation is only meaningful if the server
 * can actually answer it -- a question about a group-nested layer on an
 * isometric map is worthless if `getRegion` rejects the map. So the fixture is
 * also read back through the real service and checked against the same ground
 * truth, which makes this a conformance test for the reads the questions
 * depend on.
 *
 * Regenerate the fixture with `pnpm tsx scripts/generate-isotown-fixture.ts`.
 */

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FIXTURE_DIR = join(
  ROOT,
  "fixtures",
  "isotown",
);

const MAP_PATH = "maps/town.tmj";
const TILESET_PATH = "maps/town.tsj";
const GROUND_LAYER_ID = 2;
const OVERLAY_LAYER_ID = 3;
const OBJECT_LAYER_ID = 4;
const WIDTH = 8;
const HEIGHT = 6;

/** Tiled packs three flip flags into the high bits of every GID. */
const GID_FLAGS = 0xe0000000;
const FLIPPED_DIAGONALLY = 0x20000000;

interface RawTile {
  id: number;
  type: string;
  properties: Array<{
    name: string;
    value: boolean;
  }>;
  animation?: unknown;
}

interface RawLayer {
  id: number;
  name: string;
  type: string;
  data?: number[];
  layers?: RawLayer[];
  objects?: Array<Record<string, unknown>>;
}

async function fixture(name: string): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, name));
}

async function isoTownProject(): Promise<{
  files: Record<string, Buffer>;
}> {
  return {
    files: {
      [MAP_PATH]: await fixture("town.tmj"),
      [TILESET_PATH]: await fixture("town.tsj"),
      "maps/tiles.png": await fixture("tiles.png"),
    },
  };
}

/** The fixture as plain JSON, which is the reference the answers must match. */
async function readFixture(): Promise<{
  classById: Map<number, string>;
  walkableById: Map<number, boolean>;
  animatedIds: number[];
  layerByName: Map<string, RawLayer>;
  layerById: Map<number, RawLayer>;
  groupTileLayerCount: number;
  objects: Array<Record<string, unknown>>;
}> {
  const map = JSON.parse(
    await readFile(
      join(FIXTURE_DIR, "town.tmj"),
      "utf8",
    ),
  ) as { layers: RawLayer[] };
  const tileset = JSON.parse(
    await readFile(
      join(FIXTURE_DIR, "town.tsj"),
      "utf8",
    ),
  ) as { tiles: RawTile[] };

  const layerByName = new Map<string, RawLayer>();
  const layerById = new Map<number, RawLayer>();
  const walk = (layers: RawLayer[]): void => {
    for (const layer of layers) {
      layerByName.set(layer.name, layer);
      layerById.set(layer.id, layer);
      if (layer.layers !== undefined) {
        walk(layer.layers);
      }
    }
  };
  walk(map.layers);

  const group = map.layers.find(
    (layer) => layer.type === "group",
  );
  expect(group, "fixture has a group layer").toBeDefined();

  return {
    classById: new Map(
      tileset.tiles.map((tile) => [
        tile.id,
        tile.type,
      ]),
    ),
    walkableById: new Map(
      tileset.tiles.map((tile) => [
        tile.id,
        tile.properties.find(
          (property) =>
            property.name === "walkable",
        )!.value,
      ]),
    ),
    animatedIds: tileset.tiles
      .filter(
        (tile) => tile.animation !== undefined,
      )
      .map((tile) => tile.id),
    layerByName,
    layerById,
    groupTileLayerCount: (
      group!.layers ?? []
    ).filter(
      (layer) => layer.type === "tilelayer",
    ).length,
    objects:
      layerByName.get("Markers")?.objects ?? [],
  };
}

/** The local tile id a GID refers to, with the flip flags masked off. */
const localIdOf = (gid: number): number =>
  (gid & ~GID_FLAGS) - 1;

async function answers(): Promise<
  Map<string, string>
> {
  const xml = await readFile(
    join(ROOT, "evals", "iso-town.xml"),
    "utf8",
  );
  const pairs = new Map<string, string>();
  for (const match of xml.matchAll(
    /<question>([\s\S]*?)<\/question>\s*<answer>([\s\S]*?)<\/answer>/gu,
  )) {
    pairs.set(match[1]!.trim(), match[2]!.trim());
  }
  return pairs;
}

/** The answer to the one question containing every given fragment. */
function answerFor(
  pairs: Map<string, string>,
  ...fragments: string[]
): string {
  const hits = [...pairs.entries()].filter(
    ([question]) =>
      fragments.every((fragment) =>
        question.includes(fragment),
      ),
  );
  expect(
    hits,
    `expected exactly one question matching ${JSON.stringify(fragments)}`,
  ).toHaveLength(1);
  return hits[0]![1];
}

describe("iso-town evaluation answers", () => {
  it("declares ten questions with non-empty answers", async () => {
    const pairs = await answers();
    expect(pairs.size).toBe(10);
    for (const [
      question,
      answer,
    ] of pairs) {
      expect(
        answer,
        `empty answer for ${question}`,
      ).not.toBe("");
    }
  });

  it("matches the fixture on tile-layer counts", async () => {
    const pairs = await answers();
    const { classById, layerByName } =
      await readFixture();
    const ground = layerByName.get("Ground")!
      .data!;
    const overlay = layerByName.get("Overlay")!
      .data!;

    const water = ground.filter(
      (gid) =>
        gid !== 0 &&
        classById.get(localIdOf(gid)) === "Water",
    ).length;
    expect(
      answerFor(pairs, '"Water"'),
    ).toBe(String(water));

    const classes = new Set(
      ground
        .filter((gid) => gid !== 0)
        .map((gid) =>
          classById.get(localIdOf(gid)),
        ),
    );
    expect(
      answerFor(pairs, "distinct tile classes"),
    ).toBe(String(classes.size));

    expect(
      answerFor(pairs, "are non-empty"),
    ).toBe(
      String(
        overlay.filter((gid) => gid !== 0).length,
      ),
    );
  });

  it("matches the fixture on the diagonally flipped cell", async () => {
    const pairs = await answers();
    const { layerByName } = await readFixture();
    const overlay = layerByName.get("Overlay")!
      .data!;
    const flipped = overlay
      .map((gid, index) => ({ gid, index }))
      .filter(
        ({ gid }) =>
          gid !== 0 &&
          (gid & FLIPPED_DIAGONALLY) !== 0,
      );
    expect(flipped).toHaveLength(1);
    const { index } = flipped[0]!;
    expect(
      answerFor(pairs, "diagonal flip flag"),
    ).toBe(
      `${index % WIDTH},${Math.floor(index / WIDTH)}`,
    );
  });

  it("matches the fixture on tileset facts", async () => {
    const pairs = await answers();
    const { animatedIds, walkableById } =
      await readFixture();
    expect(animatedIds).toHaveLength(1);
    expect(
      answerFor(pairs, "defines an animation"),
    ).toBe(String(animatedIds[0]));

    const blocked = [
      ...walkableById.values(),
    ].filter((value) => value === false).length;
    expect(
      answerFor(pairs, "set to false"),
    ).toBe(String(blocked));
  });

  it("matches the fixture on the layer tree and objects", async () => {
    const pairs = await answers();
    const {
      groupTileLayerCount,
      layerById,
      objects,
    } = await readFixture();

    expect(
      answerFor(pairs, "How many tile layers"),
    ).toBe(String(groupTileLayerCount));
    expect(
      answerFor(pairs, "whose id is 3"),
    ).toBe(layerById.get(3)!.name);
    expect(
      answerFor(pairs, "objects does the"),
    ).toBe(String(objects.length));

    const polygons = objects.filter(
      (object) => object["polygon"] !== undefined,
    );
    expect(polygons).toHaveLength(1);
    expect(
      answerFor(pairs, "polygon object"),
    ).toBe(polygons[0]!["type"]);
  });

  /**
   * The questions are only answerable if the server can read this map, so the
   * same ground truth is asserted through the real service. An isometric map
   * whose tile layers are nested in a group and whose cells carry flip flags
   * is exactly the shape a read path is most likely to get wrong.
   */
  it("answers the same way through the service", async () => {
    const {
      classById,
      layerByName,
      walkableById,
    } = await readFixture();

    await withProject(
      {
        ...(await isoTownProject()),
        prefix: "tiledmcp-isotown",
      },
      async (project) => {
        const summary =
          (await project.service.getSummary(
            MAP_PATH,
          )) as unknown as {
            orientation: string;
          };
        expect(summary.orientation).toBe(
          "isometric",
        );

        const region =
          (await project.service.getRegion({
            mapPath: MAP_PATH,
            layerId: GROUND_LAYER_ID,
            x: 0,
            y: 0,
            width: WIDTH,
            height: HEIGHT,
          })) as unknown as {
            rows: Array<
              Array<{ localId: number } | null>
            >;
          };
        const waterFromService = region.rows
          .flat()
          .filter(
            (cell) =>
              cell !== null &&
              classById.get(cell.localId) ===
                "Water",
          ).length;
        const waterFromBytes = layerByName
          .get("Ground")!
          .data!.filter(
            (gid) =>
              gid !== 0 &&
              classById.get(localIdOf(gid)) ===
                "Water",
          ).length;
        expect(waterFromService).toBe(
          waterFromBytes,
        );

        // The flipped cell must survive the read as a decoded transform
        // rather than as a corrupt local id.
        const overlay =
          (await project.service.getRegion({
            mapPath: MAP_PATH,
            layerId: OVERLAY_LAYER_ID,
            x: 0,
            y: 0,
            width: WIDTH,
            height: HEIGHT,
          })) as unknown as {
            rows: Array<
              Array<{
                localId: number;
                transform?: { flipD?: boolean };
              } | null>
            >;
          };
        const flipped: Array<{
          x: number;
          y: number;
        }> = [];
        overlay.rows.forEach((row, y) =>
          row.forEach((cell, x) => {
            if (cell?.transform?.flipD === true) {
              flipped.push({ x, y });
            }
          }),
        );
        expect(flipped).toHaveLength(1);
        expect(
          `${flipped[0]!.x},${flipped[0]!.y}`,
        ).toBe("7,4");

        const objects =
          (await project.service.listObjects({
            mapPath: MAP_PATH,
            layerId: OBJECT_LAYER_ID,
          })) as unknown as {
            objects: unknown[];
          };
        expect(objects.objects).toHaveLength(
          layerByName.get("Markers")!.objects!
            .length,
        );

        // Reading one object by id is the other path that used to inherit the
        // edit guard and reject this map outright.
        const polygon =
          (await project.service.getObject({
            mapPath: MAP_PATH,
            objectId: 4,
          })) as unknown as {
            object: { className?: string };
          };
        expect(polygon.object.className).toBe(
          "Patrol",
        );
        expect(walkableById.size).toBe(6);
      },
    );
  });
});
