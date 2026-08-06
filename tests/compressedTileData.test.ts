import { execFile } from "node:child_process";
import { wireProject } from "./support/project.js";
import {
  TILED_CLI_ENV,
  hasTiledCli,
  TILED_CLI_PATH,
} from "./support/tiledCli.js";
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
import {
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { resolveTileLayerCells } from "../src/maps/tileData.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/packed.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 1;
const CELLS = [1, 2, 0, 3];

type Compression = "" | "gzip" | "zlib" | "zstd";

interface Harness {
  root: string;
  service: MapService;
}

describe("compressed tile data read-only support", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  for (const compression of [
    "",
    "gzip",
    "zlib",
    "zstd",
  ] as Compression[]) {
    it(`reads regions, usage, and native previews from base64${compression === "" ? "" : `+${compression}`} data`, async () => {
      const harness = await createHarness(
        roots,
        encodedLayerData(CELLS, compression),
        compression,
      );

      const region =
        await harness.service.getRegion({
          mapPath: MAP_PATH,
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          width: 2,
          height: 2,
        });
      expect(region.rows).toEqual([
        [
          expect.objectContaining({ localId: 0 }),
          expect.objectContaining({ localId: 1 }),
        ],
        [
          null,
          expect.objectContaining({ localId: 2 }),
        ],
      ]);

      const usage =
        await harness.service.analyzeUsage({
          mapPath: MAP_PATH,
        });
      expect(usage).toMatchObject({
        totals: expect.objectContaining({
          nonEmptyTileCellCount: 3,
        }),
      });

      const rendered =
        await harness.service.renderPreview({
          mapPath: MAP_PATH,
          scale: 1,
        });
      expect(
        rendered.png.byteLength,
      ).toBeGreaterThan(0);
    });
  }

  it("edits encoded layers by re-encoding written data in kind", async () => {
    const harness = await createHarness(
      roots,
      encodedLayerData(CELLS, "zlib"),
      "zlib",
    );
    const before = await readFile(
      join(harness.root, MAP_PATH),
      "utf8",
    );
    const summary =
      await harness.service.getSummary(MAP_PATH);

    const edit = await harness.service.planEdits(
      MAP_PATH,
      summary.revision as string,
      summary.dependencyRevisions as Record<
        string,
        string
      >,
      [
        {
          type: "setTiles",
          layerId: LAYER_ID,
          cells: [
            {
              x: 0,
              y: 1,
              tile: {
                tileset: {
                  kind: "external",
                  assetId: Object.keys(
                    summary.dependencyRevisions as Record<
                      string,
                      string
                    >,
                  )[0]!,
                },
                localId: 3,
              },
            },
          ],
        },
      ],
    );
    const result =
      await harness.service.applyEdits(edit);
    expect(result.changed).toBe(true);

    const written = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as JsonObject;
    const layer = (
      written.layers as JsonObject[]
    ).find((entry) => entry.id === LAYER_ID)!;
    expect(layer.encoding).toBe("base64");
    expect(layer.compression).toBe("zlib");
    expect(typeof layer.data).toBe("string");
    const cells = resolveTileLayerCells(
      layer,
      LAYER_ID,
      MAP_PATH,
      4,
      "read",
      "unused",
    );
    expect([...cells]).toEqual([1, 2, 4, 3]);

    // Writing the original values back must collapse to the exact bytes.
    const restoreSummary =
      await harness.service.getSummary(MAP_PATH);
    const restore =
      await harness.service.planEdits(
        MAP_PATH,
        restoreSummary.revision as string,
        restoreSummary.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 1,
                tile: {
                  tileset: {
                    kind: "external",
                    assetId: Object.keys(
                      restoreSummary.dependencyRevisions as Record<
                        string,
                        string
                      >,
                    )[0]!,
                  },
                  localId: 3,
                },
              },
            ],
          },
        ],
      );
    const noop =
      await harness.service.applyEdits(restore);
    expect(noop.changed).toBe(false);
    expect(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ).not.toBe(before);
  });

  it("preserves untouched encoded layers byte-exactly and keeps resize fail-closed", async () => {
    const harness = await createHarness(
      roots,
      encodedLayerData(CELLS, "zlib"),
      "zlib",
    );
    const summary =
      await harness.service.getSummary(MAP_PATH);

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
            width: 3,
            height: 3,
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILE_ENCODING",
    });

    // A same-value write is a net no-op that must keep the exact bytes.
    const before = await readFile(
      join(harness.root, MAP_PATH),
      "utf8",
    );
    const noopEdit =
      await harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        summary.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: {
                  tileset: {
                    kind: "external",
                    assetId: Object.keys(
                      summary.dependencyRevisions as Record<
                        string,
                        string
                      >,
                    )[0]!,
                  },
                  localId: 0,
                },
              },
            ],
          },
        ],
      );
    const noop =
      await harness.service.applyEdits(noopEdit);
    expect(noop.changed).toBe(false);
    expect(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ).toBe(before);
  });

  it("fails closed on corrupt, oversized, or unsupported encodings", async () => {
    const wrongSize = await createHarness(
      roots,
      Buffer.from(
        encodeCells([1, 2, 0]),
      ).toString("base64"),
      "",
    );
    await expect(
      wrongSize.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TILE_DATA",
    });

    const badBase64 = await createHarness(
      roots,
      "not-canonical-base64!!!",
      "",
    );
    await expect(
      badBase64.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TILE_DATA",
    });

    const bomb = await createHarness(
      roots,
      deflateSync(
        Buffer.alloc(1024 * 1024),
      ).toString("base64"),
      "zlib",
    );
    await expect(
      bomb.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TILE_DATA",
      message: expect.stringContaining(
        "corrupt or exceeds",
      ),
    });

    const unknownCompression =
      await createHarness(
        roots,
        encodedLayerData(CELLS, ""),
        "snappy" as Compression,
      );
    await expect(
      unknownCompression.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILE_ENCODING",
      details: expect.objectContaining({
        compression: "snappy",
      }),
    });

    const csvString = await createHarness(
      roots,
      encodedLayerData(CELLS, ""),
      "",
      "csv",
    );
    await expect(
      csvString.service.getRegion({
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILE_ENCODING",
      details: expect.objectContaining({
        encoding: "csv",
      }),
    });
  });

  it.skipIf(!hasTiledCli)("round-trips a zstd-compressed map through the Tiled CLI", async () => {
    const harness = await createHarness(
      roots,
      encodedLayerData(CELLS, "zstd"),
      "zstd",
    );
    const outputPath = join(
      harness.root,
      "maps",
      "roundtrip.tmj",
    );
    await execFileAsync(
      TILED_CLI_PATH,
      [
        "--export-map",
        "json",
        join(harness.root, MAP_PATH),
        outputPath,
      ],
      {
        env: { ...TILED_CLI_ENV },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );

    const exported = JSON.parse(
      await readFile(outputPath, "utf8"),
    ) as JsonObject;
    const layer = (
      exported.layers as JsonObject[]
    ).find((entry) => entry.id === LAYER_ID);
    expect(layer).toBeDefined();
    const cells = resolveTileLayerCells(
      layer as JsonObject,
      LAYER_ID,
      "maps/roundtrip.tmj",
      4,
      "read",
      "unused",
    );
    expect([...cells]).toEqual(CELLS);
  });
});

function encodeCells(
  cells: readonly number[],
): Buffer {
  const bytes = Buffer.alloc(cells.length * 4);
  for (const [
    index,
    cell,
  ] of cells.entries()) {
    bytes.writeUInt32LE(cell, index * 4);
  }
  return bytes;
}

function encodedLayerData(
  cells: readonly number[],
  compression: Compression,
): string {
  const bytes = encodeCells(cells);
  const packed =
    compression === ""
      ? bytes
      : compression === "gzip"
        ? gzipSync(bytes)
        : compression === "zlib"
          ? deflateSync(bytes)
          : zstdCompressSync(bytes);
  return packed.toString("base64");
}

async function createHarness(
  roots: Set<string>,
  data: string,
  compression: Compression,
  encoding = "base64",
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-packed-data-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const layer: JsonObject = {
    data,
    encoding,
    height: 2,
    id: LAYER_ID,
    name: "Packed",
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: 2,
    x: 0,
    y: 0,
  };
  if (compression !== "") {
    layer.compression = compression;
  }
  await writeJson(join(root, MAP_PATH), {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [layer],
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
      '<rect width="32" height="32" fill="#446688"/>',
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
