import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";

const MAP_PATH = "maps/level.tmj";

describe("stateless cell selection", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("selects by tile set ignoring flip bits, with tight bounds", async () => {
    // gid 1 at (0,0), flipped gid 1 at (2,1), gid 2 at (1,0).
    const harness = await createHarness(roots, [
      1, 2, 0,
      0, 0, 0x80000001,
    ]);
    const result = await harness.service.selectCells(
      {
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "tiles",
          tiles: [
            {
              tileset: {
                kind: "external",
                assetId: harness.assetId,
              },
              localId: 0,
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({
      cellCount: 2,
      bounds: { x: 0, y: 0, width: 3, height: 2 },
      cells: [
        { x: 0, y: 0 },
        { x: 2, y: 1 },
      ],
      cellsTruncated: false,
      match: "tiles",
    });
  });

  it("selects empty and non-empty cells and validates regions", async () => {
    const harness = await createHarness(roots, [
      1, 2, 0,
      0, 0, 1,
    ]);
    expect(
      await harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        match: { kind: "empty" },
      }),
    ).toMatchObject({ cellCount: 3 });
    expect(
      await harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        region: { x: 0, y: 0, width: 2, height: 1 },
        match: { kind: "nonEmpty" },
      }),
    ).toMatchObject({
      cellCount: 2,
      bounds: { x: 0, y: 0, width: 2, height: 1 },
    });
    await expect(
      harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        region: { x: 2, y: 1, width: 2, height: 2 },
        match: { kind: "empty" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("magic wand selection", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("floods the seed's connected same-value area, flip bits ignored", async () => {
    // gid 1 region: (0,0), (1,0)-flipped, (1,1); (2,y) is gid 2 wall,
    // so the second gid-1 island beyond it stays unselected.
    const harness = await createHarness(roots, [
      1, 0x80000001, 2,
      0, 1, 2,
    ]);
    const result = await harness.service.selectCells(
      {
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "magicWand",
          seed: { x: 0, y: 0 },
        },
      },
    );
    expect(result).toMatchObject({
      match: "magicWand",
      seedBaseGid: 1,
      cellCount: 3,
      bounds: { x: 0, y: 0, width: 2, height: 2 },
      cells: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    });

    // An empty seed floods the empty area.
    const empty =
      await harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "magicWand",
          seed: { x: 0, y: 1 },
        },
      });
    expect(empty).toMatchObject({
      seedBaseGid: 0,
      cellCount: 1,
    });

    await expect(
      harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        region: { x: 0, y: 0, width: 2, height: 2 },
        match: {
          kind: "magicWand",
          seed: { x: 2, y: 0 },
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("polygon selection", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("selects cells whose centre falls inside the pixel polygon", async () => {
    const harness = await createHarness(roots, [
      1, 1, 1,
      1, 1, 1,
    ]);
    // Tile size 16: cell centres at x 8/24/40, y 8/24. A triangle
    // covering the left column and the middle of the top row.
    const result = await harness.service.selectCells(
      {
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "polygon",
          points: [
            { x: 0, y: 0 },
            { x: 34, y: 0 },
            { x: 0, y: 32 },
          ],
        },
      },
    );
    expect(result).toMatchObject({
      match: "polygon",
      cellCount: 3,
      cells: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
      bounds: { x: 0, y: 0, width: 2, height: 2 },
    });

    await expect(
      harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "polygon",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("composed selection", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("folds union, intersect, and subtract deterministically", async () => {
    const harness = await createHarness(roots, [
      1, 2, 0,
      0, 1, 1,
    ]);
    const tile = (localId: number) => ({
      tileset: {
        kind: "external" as const,
        assetId: harness.assetId,
      },
      localId,
    });
    // nonEmpty ∪ ∅, then subtract tile 1 (gid 2): {(0,0),(1,1),(2,1)}.
    const result = await harness.service.selectCells(
      {
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "compose",
          steps: [
            { op: "union", match: { kind: "nonEmpty" } },
            {
              op: "subtract",
              match: {
                kind: "tiles",
                tiles: [tile(1)],
              },
            },
          ],
        },
        sampleLimit: 2,
      },
    );
    expect(result).toMatchObject({
      match: "compose",
      cellCount: 3,
      cellsTruncated: true,
      cells: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      bounds: { x: 0, y: 0, width: 3, height: 2 },
    });

    // intersect narrows: nonEmpty ∩ magicWand from (1,1).
    const intersected =
      await harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        match: {
          kind: "compose",
          steps: [
            { op: "union", match: { kind: "nonEmpty" } },
            {
              op: "intersect",
              match: {
                kind: "magicWand",
                seed: { x: 1, y: 1 },
              },
            },
          ],
        },
      });
    expect(intersected).toMatchObject({
      cellCount: 2,
      cells: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
    });

    await expect(
      harness.service.selectCells({
        mapPath: MAP_PATH,
        layerId: 1,
        match: { kind: "compose", steps: [] },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
  data: number[],
): Promise<{
  root: string;
  service: MapService;
  assetId: string;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-select-"),
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
          width: 3,
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
      width: 3,
    }),
  );
  const { service } =
    await wireProject(root);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as {
    tilesets: Array<{ assetId: string }>;
  };
  return {
    root,
    service,
    assetId: summary.tilesets[0]!.assetId,
  };
}
