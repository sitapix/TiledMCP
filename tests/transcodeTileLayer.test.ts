import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { encodeTileLayerCells } from "../src/maps/tileData.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const LAYER_ID = 1;
const CELLS = [5, 0, 7, 0];

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
}

describe("explicit tile layer transcoding", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("transcodes csv to compressed base64 end to end", async () => {
    const harness = await createHarness(roots, {
      data: CELLS,
    });
    const plan = await pledge(harness, {
      type: "transcodeTileLayer",
      layerId: LAYER_ID,
      encoding: "base64",
      compression: "zlib",
    });
    expect(plan.summary).toMatchObject({
      affectedTileLayerIds: [LAYER_ID],
      transcodes: [
        {
          layerId: LAYER_ID,
          fromEncoding: "csv",
          fromCompression: "",
          toEncoding: "base64",
          toCompression: "zlib",
          cellCount: 4,
          wouldChange: true,
        },
      ],
    });
    const preview =
      new ChangeSetRegistry().put(plan);
    expect(preview.operations[0]).toMatchObject({
      type: "transcodeTileLayer",
      destructive: false,
      from: { encoding: "csv", compression: "" },
      to: {
        encoding: "base64",
        compression: "zlib",
      },
      wouldChange: true,
    });

    await harness.service.applyEdits(plan);
    const layer = await readLayer(harness);
    expect(layer.encoding).toBe("base64");
    expect(layer.compression).toBe("zlib");
    const decoded = inflateSync(
      Buffer.from(String(layer.data), "base64"),
    );
    expect([
      decoded.readUInt32LE(0),
      decoded.readUInt32LE(4),
      decoded.readUInt32LE(8),
      decoded.readUInt32LE(12),
    ]).toEqual(CELLS);
  });

  it("transcodes compressed base64 back to csv, deleting the encoding members", async () => {
    const harness = await createHarness(roots, {
      data: encodeTileLayerCells(
        CELLS,
        "zlib",
        LAYER_ID,
        MAP_PATH,
      ),
      encoding: "base64",
      compression: "zlib",
    });
    const plan = await pledge(harness, {
      type: "transcodeTileLayer",
      layerId: LAYER_ID,
      encoding: "csv",
    });
    await harness.service.applyEdits(plan);
    const layer = await readLayer(harness);
    expect(layer.encoding).toBeUndefined();
    expect(layer.compression).toBeUndefined();
    expect(layer.data).toEqual(CELLS);
  });

  it("changes only the compression without restoring stale bytes", async () => {
    const harness = await createHarness(roots, {
      data: encodeTileLayerCells(
        CELLS,
        "zlib",
        LAYER_ID,
        MAP_PATH,
      ),
      encoding: "base64",
      compression: "zlib",
    });
    const plan = await pledge(harness, {
      type: "transcodeTileLayer",
      layerId: LAYER_ID,
      encoding: "base64",
      compression: "gzip",
    });
    await harness.service.applyEdits(plan);
    const layer = await readLayer(harness);
    expect(layer.compression).toBe("gzip");
    const bytes = Buffer.from(
      String(layer.data),
      "base64",
    );
    // gzip magic, not zlib
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it("reports a same-target transcode as a no-op and leaves bytes alone", async () => {
    const harness = await createHarness(roots, {
      data: CELLS,
    });
    const before = await readFile(
      join(harness.root, MAP_PATH),
    );
    const plan = await pledge(harness, {
      type: "transcodeTileLayer",
      layerId: LAYER_ID,
      encoding: "csv",
    });
    expect(plan.summary).toMatchObject({
      affectedTileLayerIds: [],
      transcodes: [
        { wouldChange: false },
      ],
    });
    await harness.service.applyEdits(plan);
    expect(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).equals(before),
    ).toBe(true);
  });

  it("fails closed on batching, csv compression, and chunked layers", async () => {
    const harness = await createHarness(roots, {
      data: CELLS,
    });
    await expect(
      pledge(
        harness,
        {
          type: "transcodeTileLayer",
          layerId: LAYER_ID,
          encoding: "csv",
        },
        [
          {
            type: "updateMap",
            patch: { renderOrder: "left-up" },
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      pledge(harness, {
        type: "transcodeTileLayer",
        layerId: LAYER_ID,
        encoding: "csv",
        compression: "zlib",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    const chunked = await createHarness(roots, {
      infinite: true,
    });
    await expect(
      pledge(chunked, {
        type: "transcodeTileLayer",
        layerId: LAYER_ID,
        encoding: "base64",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILE_ENCODING",
    });
  });
});

async function pledge(
  harness: Harness,
  operation: Record<string, unknown>,
  extra: Record<string, unknown>[] = [],
) {
  const snapshot =
    await harness.store.readSnapshot(MAP_PATH);
  return harness.service.planEdits(
    MAP_PATH,
    snapshot.revision,
    {},
    [operation, ...extra] as never,
  );
}

async function readLayer(
  harness: Harness,
): Promise<JsonObject> {
  const map = JSON.parse(
    (
      await readFile(join(harness.root, MAP_PATH))
    ).toString("utf8"),
  ) as { layers: JsonObject[] };
  const layer = map.layers.find(
    ({ id }) => id === LAYER_ID,
  );
  if (layer === undefined) {
    throw new Error("expected the layer");
  }
  return layer;
}

async function createHarness(
  roots: Set<string>,
  options: {
    data?: number[] | string;
    encoding?: string;
    compression?: string;
    infinite?: boolean;
  },
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-transcode-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  const layer: JsonObject = {
    height: 2,
    id: LAYER_ID,
    name: "Ground",
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: 2,
    x: 0,
    y: 0,
    ...(options.infinite === true
      ? {
          startx: 0,
          starty: 0,
          chunks: [
            {
              x: 0,
              y: 0,
              width: 4,
              height: 4,
              data: new Array(16).fill(0),
            },
          ],
          width: 4,
          height: 4,
        }
      : {
          data: options.data ?? [0, 0, 0, 0],
          ...(options.encoding === undefined
            ? {}
            : { encoding: options.encoding }),
          ...(options.compression === undefined
            ? {}
            : {
                compression: options.compression,
              }),
        }),
  };
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 2,
      infinite: options.infinite === true,
      layers: [layer],
      nextlayerid: 2,
      nextobjectid: 1,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 16,
      tilesets: [],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 2,
    }),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    store,
    service: new MapService(resolver, store),
  };
}
