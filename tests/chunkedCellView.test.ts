import { describe, expect, it } from "vitest";

import type { JsonObject } from "../src/formats/json.js";
import {
  createChunkedCellView,
  decodeChunkCells,
  encodeTileLayerCells,
  readChunkedViewGid,
  readMapChunkSize,
  serializeChunkedCells,
  writeChunkedViewGid,
  MAX_TILE_LAYER_CHUNKS,
  TILED_DEFAULT_CHUNK_SIZE,
} from "../src/maps/tileData.js";

const MAP_PATH = "maps/endless.tmj";
const LAYER_ID = 1;

describe("chunked cell view and canonical serialization", () => {
  it("decodes non-aligned chunks into absolute sparse cells and normalizes on save", () => {
    const layer: JsonObject = {
      chunks: [
        {
          x: -2,
          y: -3,
          width: 3,
          height: 2,
          data: [5, 0, 0, 0, 0, 7],
        },
        {
          x: 20,
          y: 1,
          width: 2,
          height: 1,
          data: [9, 0],
        },
      ],
    };
    const view = createChunkedCellView(
      layer,
      LAYER_ID,
      MAP_PATH,
    );
    expect(view.cells.size).toBe(3);
    expect(
      readChunkedViewGid(view, -2, -3),
    ).toBe(5);
    expect(readChunkedViewGid(view, 0, -2)).toBe(
      7,
    );
    expect(readChunkedViewGid(view, 20, 1)).toBe(
      9,
    );
    expect(readChunkedViewGid(view, -1, -3)).toBe(
      0,
    );
    expect(view.dirty).toBe(false);

    const serialized = serializeChunkedCells({
      cells: view.cells,
      chunkWidth: TILED_DEFAULT_CHUNK_SIZE,
      chunkHeight: TILED_DEFAULT_CHUNK_SIZE,
      encoding: "array",
      compression: "",
      layerId: LAYER_ID,
      mapPath: MAP_PATH,
    });
    // Floor alignment sends (-2,-3) and (0,-2) into chunks (-16,-16) and
    // (0,-16); (20,1) lands in (16,0). Chunks sort by (y, x).
    expect(
      serialized.chunks.map(({ x, y }) => [x, y]),
    ).toEqual([
      [-16, -16],
      [0, -16],
      [16, 0],
    ]);
    expect(serialized).toMatchObject({
      startX: -16,
      startY: -16,
      width: 48,
      height: 32,
      chunkCount: 3,
      nonEmptyCellCount: 3,
    });
    const first = serialized.chunks[0] as {
      data: number[];
    };
    expect(first.data).toHaveLength(256);
    expect(first.data[13 * 16 + 14]).toBe(5);
  });

  it("round-trips encoded chunks with the stored compression and tracks dirtiness", () => {
    const dense = new Array<number>(16).fill(0);
    dense[5] = 11;
    const layer: JsonObject = {
      encoding: "base64",
      compression: "zlib",
      chunks: [
        {
          x: 0,
          y: 0,
          width: 4,
          height: 4,
          data: encodeTileLayerCells(
            dense,
            "zlib",
            LAYER_ID,
            MAP_PATH,
          ),
        },
      ],
    };
    const view = createChunkedCellView(
      layer,
      LAYER_ID,
      MAP_PATH,
    );
    expect(readChunkedViewGid(view, 1, 1)).toBe(
      11,
    );

    writeChunkedViewGid(view, 1, 1, 11);
    expect(view.dirty).toBe(false);
    writeChunkedViewGid(view, 2, 3, 21);
    expect(view.dirty).toBe(true);

    const serialized = serializeChunkedCells({
      cells: view.cells,
      chunkWidth: 4,
      chunkHeight: 4,
      encoding: "base64",
      compression: "zlib",
      layerId: LAYER_ID,
      mapPath: MAP_PATH,
    });
    expect(serialized.chunkCount).toBe(1);
    const chunk = serialized.chunks[0] as {
      x: number;
      y: number;
      width: number;
      height: number;
      data: string;
    };
    expect(typeof chunk.data).toBe("string");
    const decoded = decodeChunkCells(
      {
        x: chunk.x,
        y: chunk.y,
        width: chunk.width,
        height: chunk.height,
        cells: chunk.data,
      },
      layer,
      LAYER_ID,
      MAP_PATH,
    );
    expect(decoded[5]).toBe(11);
    expect(decoded[3 * 4 + 2]).toBe(21);
  });

  it("serializes a fully erased layer as empty chunks with zero bounds", () => {
    const view = createChunkedCellView(
      {
        chunks: [
          {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            data: [1, 0, 0, 0],
          },
        ],
      },
      LAYER_ID,
      MAP_PATH,
    );
    writeChunkedViewGid(view, 0, 0, 0);
    expect(view.dirty).toBe(true);
    const serialized = serializeChunkedCells({
      cells: view.cells,
      chunkWidth: TILED_DEFAULT_CHUNK_SIZE,
      chunkHeight: TILED_DEFAULT_CHUNK_SIZE,
      encoding: "array",
      compression: "",
      layerId: LAYER_ID,
      mapPath: MAP_PATH,
    });
    expect(serialized).toEqual({
      chunks: [],
      startX: 0,
      startY: 0,
      width: 0,
      height: 0,
      chunkCount: 0,
      nonEmptyCellCount: 0,
    });
  });

  it("fails closed when the rebucketed chunk count exceeds the budget", () => {
    const cells = new Map<string, number>();
    for (
      let index = 0;
      index <= MAX_TILE_LAYER_CHUNKS;
      index += 1
    ) {
      cells.set(`${index * 4},0`, 1);
    }
    expect(() =>
      serializeChunkedCells({
        cells,
        chunkWidth: 4,
        chunkHeight: 4,
        encoding: "array",
        compression: "",
        layerId: LAYER_ID,
        mapPath: MAP_PATH,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
      }),
    );
  });

  it("reads the map chunk size with Tiled reader semantics", () => {
    expect(
      readMapChunkSize({}, MAP_PATH),
    ).toEqual({ width: 16, height: 16 });
    expect(
      readMapChunkSize(
        {
          editorsettings: {
            chunksize: { width: 0, height: 32 },
          },
        },
        MAP_PATH,
      ),
    ).toEqual({ width: 16, height: 32 });
    expect(
      readMapChunkSize(
        {
          editorsettings: {
            chunksize: { width: 2, height: 3 },
          },
        },
        MAP_PATH,
      ),
    ).toEqual({ width: 4, height: 4 });
    expect(() =>
      readMapChunkSize(
        {
          editorsettings: {
            chunksize: { width: -8 },
          },
        },
        MAP_PATH,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_DOCUMENT",
      }),
    );
  });
});
