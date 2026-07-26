import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/endless.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 1;

interface Harness {
  root: string;
  service: MapService;
}

describe("infinite chunked map read-only support", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("summarizes an infinite map with chunked layer bounds", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const summary =
      await harness.service.getSummary(MAP_PATH);
    expect(summary).toMatchObject({
      infinite: true,
      editableProfile:
        "infinite-orthogonal-tmj-read-only-chunked",
      layers: [
        {
          id: LAYER_ID,
          type: "tilelayer",
          chunked: true,
          startX: -4,
          startY: -4,
          width: 8,
          height: 8,
        },
      ],
    });
  });

  it("reads absolute-coordinate regions across chunk boundaries and outside chunks", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const region =
      await harness.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: -2,
        y: -1,
        width: 4,
        height: 2,
      });
    // Chunk A covers [-4,-4)..(0,0); chunk B covers [0,0)..(4,4).
    // Cell (-2,-1) is A local (2,3) → gid 1; (-1,-1) → A local (3,3) → 2;
    // (0,-1) and (1,-1) are outside every chunk → empty; second row enters
    // chunk B at (0,0) → 3 and (1,0) → 0.
    expect(region.rows).toEqual([
      [
        expect.objectContaining({ localId: 0 }),
        expect.objectContaining({ localId: 1 }),
        null,
        null,
      ],
      [
        null,
        null,
        expect.objectContaining({ localId: 2 }),
        null,
      ],
    ]);
    expect(region.layer).toEqual({
      id: LAYER_ID,
      name: "Endless",
    });
  });

  it("reads zlib-compressed chunk data with layer-level encoding members", async () => {
    const chunkCells = (
      cells: number[],
    ): string =>
      deflateSync(
        (() => {
          const bytes = Buffer.alloc(
            cells.length * 4,
          );
          for (const [
            index,
            cell,
          ] of cells.entries()) {
            bytes.writeUInt32LE(cell, index * 4);
          }
          return bytes;
        })(),
      ).toString("base64");
    const cellsA = new Array(16).fill(0);
    cellsA[2 * 4 + 3] = 1;
    const harness = await createHarness(
      roots,
      {
        layerExtra: {
          encoding: "base64",
          compression: "zlib",
        },
        chunks: [
          {
            data: chunkCells(cellsA),
            height: 4,
            width: 4,
            x: -4,
            y: -4,
          },
        ],
        startx: -4,
        starty: -4,
        width: 4,
        height: 4,
      },
    );
    const region =
      await harness.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: -1,
        y: -2,
        width: 1,
        height: 1,
      });
    expect(region.rows).toEqual([
      [expect.objectContaining({ localId: 0 })],
    ]);
  });

  it("analyzes usage across chunks", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const usage =
      await harness.service.analyzeUsage({
        mapPath: MAP_PATH,
      });
    expect(usage).toMatchObject({
      totals: expect.objectContaining({
        tileLayerCount: 1,
        nonEmptyTileCellCount: 3,
      }),
      scan: expect.objectContaining({
        tileCellCount: 32,
      }),
    });
  });

  it("allows non-tile edits while chunk-unaware tile operations stay fail-closed", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const summary =
      await harness.service.getSummary(MAP_PATH);

    const plan = await harness.service.planEdits(
      MAP_PATH,
      summary.revision as string,
      summary.dependencyRevisions as Record<
        string,
        string
      >,
      [
        {
          type: "updateMap",
          patch: { renderOrder: "right-up" },
        },
      ],
    );
    expect(
      plan.summary.mapUpdates?.[0],
    ).toMatchObject({ wouldChange: true });

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        summary.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "resizeMap",
            width: 4,
            height: 4,
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RESIZE_LAYER_BOUNDS",
    });

    await expect(
      harness.service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
      }),
    ).rejects.toMatchObject({
      code: "PREVIEW_REGION_REQUIRED",
    });

    await expect(
      harness.service.planDeleteFile({
        path: TILESET_PATH,
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
    });
  });

  it("edits chunked layers through setTiles and serializes canonical chunks", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const summary =
      await harness.service.getSummary(MAP_PATH);
    const dependencyRevisions =
      summary.dependencyRevisions as Record<
        string,
        string
      >;
    const assetId = Object.keys(
      dependencyRevisions,
    )[0] as string;

    const plan = await harness.service.planEdits(
      MAP_PATH,
      summary.revision as string,
      dependencyRevisions,
      [
        {
          type: "setTiles",
          layerId: LAYER_ID,
          cells: [
            {
              x: 20,
              y: -30,
              tile: {
                tileset: {
                  kind: "external",
                  assetId,
                },
                localId: 0,
              },
            },
            { x: -2, y: -1, tile: null },
          ],
        },
      ],
    );
    expect(plan.summary).toMatchObject({
      cellWrites: 2,
      affectedTileLayerIds: [LAYER_ID],
      chunkedTileLayerIds: [LAYER_ID],
    });

    await harness.service.applyEdits(plan);
    const mapAfter = JSON.parse(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).toString("utf8"),
    ) as {
      layers: Array<{
        id: number;
        chunks: Array<{
          x: number;
          y: number;
          width: number;
          height: number;
          data: number[];
        }>;
        width: number;
        height: number;
        startx: number;
        starty: number;
      }>;
    };
    const layer = mapAfter.layers.find(
      ({ id }) => id === LAYER_ID,
    );
    if (layer === undefined) {
      throw new Error("expected the layer");
    }
    // Canonical 16x16 rebucketing sorted by (y, x): the new cell at
    // (20,-30), the surviving (-1,-1)=2, and (0,0)=3; the erased (-2,-1)
    // no longer occupies a chunk.
    expect(
      layer.chunks.map(({ x, y }) => [x, y]),
    ).toEqual([
      [16, -32],
      [-16, -16],
      [0, 0],
    ]);
    expect(layer).toMatchObject({
      startx: -16,
      starty: -32,
      width: 48,
      height: 48,
    });
    for (const chunk of layer.chunks) {
      expect(chunk.width).toBe(16);
      expect(chunk.height).toBe(16);
      expect(chunk.data).toHaveLength(256);
    }
    const chunkAt = (
      cx: number,
      cy: number,
    ): number[] =>
      (layer.chunks.find(
        ({ x, y }) => x === cx && y === cy,
      ) as { data: number[] }).data;
    expect(
      chunkAt(16, -32)[2 * 16 + 4],
    ).toBe(1);
    expect(
      chunkAt(-16, -16)[15 * 16 + 15],
    ).toBe(2);
    expect(chunkAt(0, 0)[0]).toBe(3);
  });

  it("fills, flood-fills, replaces, and copies chunked cells", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const summary =
      await harness.service.getSummary(MAP_PATH);
    const dependencyRevisions =
      summary.dependencyRevisions as Record<
        string,
        string
      >;
    const assetId = Object.keys(
      dependencyRevisions,
    )[0] as string;
    const tile = (localId: number) => ({
      tileset: {
        kind: "external" as const,
        assetId,
      },
      localId,
    });

    // Flood fill from (-1,-1)=gid 2 within the used-chunk bounds.
    const flood = await harness.service.planEdits(
      MAP_PATH,
      summary.revision as string,
      dependencyRevisions,
      [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: -1,
          y: -1,
          tile: tile(3),
        },
      ],
    );
    expect(
      flood.summary.tileFloodFills?.[0],
    ).toMatchObject({
      changedCellCount: 1,
      wouldChange: true,
    });

    // A seed outside the used chunk bounds fills nothing.
    const outside =
      await harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        dependencyRevisions,
        [
          {
            type: "floodFill",
            layerId: LAYER_ID,
            x: 100,
            y: 100,
            tile: tile(3),
          },
        ],
      );
    expect(
      outside.summary.tileFloodFills?.[0],
    ).toMatchObject({
      changedCellCount: 0,
      wouldChange: false,
    });

    // Replace gid 1 (tile 0) with tile 3 across the sparse layer.
    const replace =
      await harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        dependencyRevisions,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              { from: tile(0), to: tile(3) },
            ],
          },
        ],
      );
    expect(
      replace.summary.tileReplacements?.[0],
    ).toMatchObject({
      scannedCellCount: 3,
      replacedCellCount: 1,
    });
    await harness.service.applyEdits(replace);

    // Copy the two-cell block at (-2,-1) onto (10,10) and fill (12,10).
    const after =
      await harness.service.getSummary(MAP_PATH);
    const combined =
      await harness.service.planEdits(
        MAP_PATH,
        after.revision as string,
        after.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "copyRegion",
            source: {
              layerId: LAYER_ID,
              x: -2,
              y: -1,
              width: 2,
              height: 1,
            },
            destination: {
              layerId: LAYER_ID,
              x: 10,
              y: 10,
            },
          },
          {
            type: "fillRegion",
            layerId: LAYER_ID,
            x: 12,
            y: 10,
            width: 1,
            height: 1,
            tile: tile(1),
          },
        ],
      );
    await harness.service.applyEdits(combined);
    const region =
      await harness.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 10,
        y: 10,
        width: 3,
        height: 1,
      });
    expect(region.rows).toEqual([
      [
        expect.objectContaining({ localId: 3 }),
        expect.objectContaining({ localId: 1 }),
        expect.objectContaining({ localId: 1 }),
      ],
    ]);
  });

  it("fails closed on overlapping chunks and chunk overflow", async () => {
    const overlapping = await createHarness(
      roots,
      {
        chunks: [
          {
            data: new Array(16).fill(0),
            height: 4,
            width: 4,
            x: 0,
            y: 0,
          },
          {
            data: new Array(16).fill(0),
            height: 4,
            width: 4,
            x: 2,
            y: 2,
          },
        ],
        startx: 0,
        starty: 0,
        width: 6,
        height: 6,
      },
    );
    await expect(
      overlapping.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "overlapping chunks",
      ),
    });

    const tooMany = await createHarness(roots, {
      chunks: Array.from(
        { length: 4_097 },
        (_, index) => ({
          data: [0],
          height: 1,
          width: 1,
          x: index * 2,
          y: 0,
        }),
      ),
      startx: 0,
      starty: 0,
      width: 8_193,
      height: 1,
    });
    await expect(
      tooMany.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: 4_096,
      }),
    });
  });

  it("renders native previews of chunked regions with negative coordinates", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const rendered =
      await harness.service.renderPreview({
        mapPath: MAP_PATH,
        region: {
          x: -3,
          y: -2,
          width: 6,
          height: 4,
        },
        scale: 4,
        overlays: {
          grid: true,
          coordinates: true,
          highlights: [
            {
              x: -2,
              y: -1,
              width: 2,
              height: 1,
            },
          ],
        },
      });
    expect(
      rendered.png.byteLength,
    ).toBeGreaterThan(0);
    expect(rendered.result).toMatchObject({
      renderProfile:
        "infinite-orthogonal-static-atlas-chunked-tilelayers-v1",
      tileRegion: {
        x: -3,
        y: -2,
        width: 6,
        height: 4,
      },
    });

    await expect(
      harness.service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
      }),
    ).rejects.toMatchObject({
      code: "PREVIEW_REGION_REQUIRED",
    });
  });

  it("round-trips an infinite map through the Tiled CLI", async () => {
    const harness = await createHarness(
      roots,
      defaultChunks(),
    );
    const outputPath = join(
      harness.root,
      "maps",
      "roundtrip.tmj",
    );
    try {
      await execFileAsync(
        process.env.TILED_CLI_PATH ?? "tiled",
        [
          "--export-map",
          "json",
          join(harness.root, MAP_PATH),
          outputPath,
        ],
        {
          env: {
            ...process.env,
            LANG: "C",
            LC_ALL: "C",
            QT_QPA_PLATFORM: "offscreen",
          },
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    const exported = JSON.parse(
      await readFile(outputPath, "utf8"),
    ) as JsonObject;
    expect(exported.infinite).toBe(true);
  });
});

interface ChunkFixture {
  layerExtra?: JsonObject;
  chunks: JsonObject[];
  startx: number;
  starty: number;
  width: number;
  height: number;
}

function defaultChunks(): ChunkFixture {
  // Chunk A [-4,-4): gids 1 at local (2,3) => (-2,-1), 2 at (3,3) => (-1,-1).
  const cellsA = new Array(16).fill(0);
  cellsA[3 * 4 + 2] = 1;
  cellsA[3 * 4 + 3] = 2;
  // Chunk B [0,0): gid 3 at local (0,0) => (0,0).
  const cellsB = new Array(16).fill(0);
  cellsB[0] = 3;
  return {
    chunks: [
      {
        data: cellsA,
        height: 4,
        width: 4,
        x: -4,
        y: -4,
      },
      {
        data: cellsB,
        height: 4,
        width: 4,
        x: 0,
        y: 0,
      },
    ],
    startx: -4,
    starty: -4,
    width: 8,
    height: 8,
  };
}

async function createHarness(
  roots: Set<string>,
  fixture: ChunkFixture,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-infinite-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), {
    compressionlevel: -1,
    height: fixture.height,
    infinite: true,
    layers: [
      {
        chunks: fixture.chunks,
        height: fixture.height,
        id: LAYER_ID,
        name: "Endless",
        opacity: 1,
        startx: fixture.startx,
        starty: fixture.starty,
        type: "tilelayer",
        visible: true,
        width: fixture.width,
        x: 0,
        y: 0,
        ...(fixture.layerExtra ?? {}),
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
    width: fixture.width,
  });
  await writeJson(join(root, TILESET_PATH), {
    columns: 2,
    image: "terrain.svg",
    imageheight: 32,
    imagewidth: 32,
    margin: 0,
    name: "terrain",
    spacing: 0,
    tilecount: 4,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  });
  await writeFile(
    join(root, "tiles", "terrain.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
      '<rect width="32" height="32" fill="#557799"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
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
