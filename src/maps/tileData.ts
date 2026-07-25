import {
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

import { TiledMcpError } from "../errors.js";
import type {
  JsonObject,
  JsonValue,
} from "../formats/json.js";

export const TILE_DATA_READ_COMPRESSIONS = [
  "gzip",
  "zlib",
  "zstd",
] as const;

/**
 * Hard cap on decoded tile bytes (16M cells) independent of the compressed
 * input size, so a small hostile payload cannot expand without bound.
 */
export const MAX_DECODED_TILE_DATA_BYTES =
  64 * 1024 * 1024;

const CANONICAL_BASE64_PATTERN =
  /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * Read-only decode of one finite tile layer's `data` member following the
 * exact Tiled 1.12.2 reader (`varianttomapconverter.cpp` /
 * `gidmapper.cpp`): string data requires `encoding:"base64"` with an
 * optional gzip/zlib/zstd `compression`, the decoded byte length must equal
 * exactly `cellCount * 4`, and cells are little-endian uint32 GIDs in
 * row-major order. Anything else fails closed. Write paths never accept
 * encoded data.
 */
export function decodeEncodedTileLayerData(
  layer: JsonObject,
  layerId: number,
  mapPath: string,
  cellCount: number,
): number[] {
  return decodeEncodedCells(
    layer.data as string,
    layer,
    layerId,
    mapPath,
    cellCount,
  );
}

/**
 * Decodes one base64 (optionally compressed) cell blob. The `encoding` and
 * `compression` members always live on the LAYER, also for chunked storage
 * where each chunk carries only its own `data` (Tiled 1.12.2
 * `toTileLayer`/`readTileLayerData`).
 */
function decodeEncodedCells(
  text: string,
  layer: JsonObject,
  layerId: number,
  mapPath: string,
  cellCount: number,
): number[] {
  if (layer.encoding !== "base64") {
    throw new TiledMcpError(
      "UNSUPPORTED_TILE_ENCODING",
      `Layer ${layerId} has string data without encoding "base64".`,
      {
        path: mapPath,
        layerId,
        encoding:
          typeof layer.encoding === "string"
            ? layer.encoding
            : null,
      },
    );
  }
  const compression =
    layer.compression === undefined ||
    layer.compression === ""
      ? ""
      : layer.compression;
  if (
    compression !== "" &&
    !(
      TILE_DATA_READ_COMPRESSIONS as readonly string[]
    ).includes(compression as string)
  ) {
    throw new TiledMcpError(
      "UNSUPPORTED_TILE_ENCODING",
      `Layer ${layerId} uses an unsupported compression method.`,
      {
        path: mapPath,
        layerId,
        compression:
          typeof layer.compression === "string"
            ? layer.compression
            : null,
        supported: [
          ...TILE_DATA_READ_COMPRESSIONS,
        ],
      },
    );
  }
  const expectedBytes = cellCount * 4;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes > MAX_DECODED_TILE_DATA_BYTES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Layer ${layerId} decoded tile data would exceed the ${MAX_DECODED_TILE_DATA_BYTES} byte limit.`,
      {
        path: mapPath,
        layerId,
        limit: MAX_DECODED_TILE_DATA_BYTES,
      },
    );
  }
  if (
    text.length % 4 !== 0 ||
    !CANONICAL_BASE64_PATTERN.test(text)
  ) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${layerId} data is not canonical base64.`,
      { path: mapPath, layerId },
    );
  }
  const raw = Buffer.from(text, "base64");
  let bytes: Buffer;
  try {
    bytes =
      compression === ""
        ? raw
        : compression === "gzip"
          ? gunzipSync(raw, {
              maxOutputLength: expectedBytes,
            })
          : compression === "zlib"
            ? inflateSync(raw, {
                maxOutputLength: expectedBytes,
              })
            : zstdDecompressSync(raw, {
                maxOutputLength: expectedBytes,
              });
  } catch {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${layerId} compressed tile data is corrupt or exceeds its declared size.`,
      {
        path: mapPath,
        layerId,
        compression,
      },
    );
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${layerId} decoded tile data does not match width × height × 4 bytes.`,
      {
        path: mapPath,
        layerId,
        expected: expectedBytes,
        actual: bytes.byteLength,
      },
    );
  }
  const gids: number[] = new Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    gids[index] = bytes.readUInt32LE(index * 4);
  }
  return gids;
}

/**
 * Resolves a finite tile layer's cells for a read or edit consumer. Chunked
 * (infinite) layers fail closed in both modes; encoded string data decodes
 * in read mode only.
 */
export function resolveTileLayerCells(
  layer: JsonObject,
  layerId: number,
  mapPath: string,
  cellCount: number,
  mode: "read" | "edit",
  editMessage: string,
): JsonValue[] {
  if ("chunks" in layer) {
    throw new TiledMcpError(
      "UNSUPPORTED_TILE_ENCODING",
      mode === "edit"
        ? editMessage
        : `Layer ${layerId} uses infinite chunked storage, which is not supported.`,
      { path: mapPath, layerId },
    );
  }
  if (typeof layer.data === "string") {
    if (mode === "edit") {
      throw new TiledMcpError(
        "UNSUPPORTED_TILE_ENCODING",
        editMessage,
        { path: mapPath, layerId },
      );
    }
    return decodeEncodedTileLayerData(
      layer,
      layerId,
      mapPath,
      cellCount,
    );
  }
  if (!Array.isArray(layer.data)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `layer ${layerId}.data must be an array.`,
      { path: mapPath, layerId },
    );
  }
  return layer.data;
}

export const MAX_TILE_LAYER_CHUNKS = 4_096;

export interface TileLayerChunkRef {
  x: number;
  y: number;
  width: number;
  height: number;
  cells: JsonValue[] | string;
}

export interface ChunkedTileLayerStructure {
  startX: number;
  startY: number;
  width: number;
  height: number;
  chunks: TileLayerChunkRef[];
  totalChunkCells: number;
}

/**
 * Validates the structure of one chunked (infinite-map) tile layer without
 * decoding any cell data: bounded chunk count, positive bounded chunk
 * rectangles, per-chunk cell budgets, and a fail-closed overlap check —
 * overlapping chunks would make cell reads order-dependent.
 */
export function readChunkedTileLayerStructure(
  layer: JsonObject,
  layerId: number,
  mapPath: string,
): ChunkedTileLayerStructure {
  const chunksValue = layer.chunks;
  if (!Array.isArray(chunksValue)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `layer ${layerId}.chunks must be an array.`,
      { path: mapPath, layerId },
    );
  }
  if (
    chunksValue.length > MAX_TILE_LAYER_CHUNKS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `layer ${layerId} has more than ${MAX_TILE_LAYER_CHUNKS} chunks.`,
      {
        path: mapPath,
        layerId,
        limit: MAX_TILE_LAYER_CHUNKS,
        actual: chunksValue.length,
      },
    );
  }
  const readBoundedInteger = (
    value: unknown,
    field: string,
  ): number => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      Math.abs(value) > 1_000_000_000
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `layer ${layerId} ${field} must be a bounded integer.`,
        { path: mapPath, layerId, field },
      );
    }
    return value;
  };
  const chunks: TileLayerChunkRef[] = [];
  let totalChunkCells = 0;
  for (const [
    index,
    chunkValue,
  ] of chunksValue.entries()) {
    if (
      typeof chunkValue !== "object" ||
      chunkValue === null ||
      Array.isArray(chunkValue)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `layer ${layerId}.chunks[${index}] must be an object.`,
        { path: mapPath, layerId, index },
      );
    }
    const chunk = chunkValue as JsonObject;
    const x = readBoundedInteger(
      chunk.x,
      `chunks[${index}].x`,
    );
    const y = readBoundedInteger(
      chunk.y,
      `chunks[${index}].y`,
    );
    const width = readBoundedInteger(
      chunk.width,
      `chunks[${index}].width`,
    );
    const height = readBoundedInteger(
      chunk.height,
      `chunks[${index}].height`,
    );
    if (width <= 0 || height <= 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `layer ${layerId}.chunks[${index}] dimensions must be positive.`,
        { path: mapPath, layerId, index },
      );
    }
    const cellCount = width * height;
    if (
      cellCount * 4 >
      MAX_DECODED_TILE_DATA_BYTES
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `layer ${layerId}.chunks[${index}] exceeds the decoded tile data limit.`,
        {
          path: mapPath,
          layerId,
          index,
          limit: MAX_DECODED_TILE_DATA_BYTES,
        },
      );
    }
    totalChunkCells += cellCount;
    const cells = chunk.data;
    if (
      typeof cells !== "string" &&
      !Array.isArray(cells)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `layer ${layerId}.chunks[${index}].data must be an array or an encoded string.`,
        { path: mapPath, layerId, index },
      );
    }
    if (
      Array.isArray(cells) &&
      cells.length !== cellCount
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `layer ${layerId}.chunks[${index}] data length does not match width × height.`,
        {
          path: mapPath,
          layerId,
          index,
          expected: cellCount,
          actual: cells.length,
        },
      );
    }
    chunks.push({ x, y, width, height, cells });
  }
  const sorted = [...chunks].sort(
    (left, right) => left.x - right.x,
  );
  for (const [
    index,
    chunk,
  ] of sorted.entries()) {
    for (
      let other = index + 1;
      other < sorted.length;
      other += 1
    ) {
      const candidate = sorted[other]!;
      if (
        candidate.x >= chunk.x + chunk.width
      ) {
        break;
      }
      if (
        candidate.y < chunk.y + chunk.height &&
        chunk.y < candidate.y + candidate.height
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `layer ${layerId} contains overlapping chunks, which make cell reads order-dependent.`,
          { path: mapPath, layerId },
        );
      }
    }
  }
  const readOptionalInteger = (
    value: unknown,
    field: string,
  ): number =>
    value === undefined
      ? 0
      : readBoundedInteger(value, field);
  return {
    startX: readOptionalInteger(
      layer.startx,
      "startx",
    ),
    startY: readOptionalInteger(
      layer.starty,
      "starty",
    ),
    width: readOptionalInteger(
      layer.width,
      "width",
    ),
    height: readOptionalInteger(
      layer.height,
      "height",
    ),
    chunks,
    totalChunkCells,
  };
}

/**
 * Decodes one chunk's cells: a plain array is returned as-is, an encoded
 * string decodes with the layer-level encoding and compression members.
 */
export function decodeChunkCells(
  chunk: TileLayerChunkRef,
  layer: JsonObject,
  layerId: number,
  mapPath: string,
): JsonValue[] {
  if (Array.isArray(chunk.cells)) {
    return chunk.cells;
  }
  return decodeEncodedCells(
    chunk.cells,
    layer,
    layerId,
    mapPath,
    chunk.width * chunk.height,
  );
}

/**
 * Reads one bounded absolute-coordinate rectangle from a chunked layer.
 * Cells outside every chunk are empty (GID 0).
 */
export function readChunkedRegionGids(
  layer: JsonObject,
  layerId: number,
  mapPath: string,
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
): JsonValue[] {
  const structure = readChunkedTileLayerStructure(
    layer,
    layerId,
    mapPath,
  );
  const out: JsonValue[] = new Array(
    region.width * region.height,
  ).fill(0);
  for (const chunk of structure.chunks) {
    const left = Math.max(region.x, chunk.x);
    const right = Math.min(
      region.x + region.width,
      chunk.x + chunk.width,
    );
    const top = Math.max(region.y, chunk.y);
    const bottom = Math.min(
      region.y + region.height,
      chunk.y + chunk.height,
    );
    if (left >= right || top >= bottom) {
      continue;
    }
    const cells = decodeChunkCells(
      chunk,
      layer,
      layerId,
      mapPath,
    );
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        out[
          (y - region.y) * region.width +
            (x - region.x)
        ] =
          cells[
            (y - chunk.y) * chunk.width +
              (x - chunk.x)
          ]!;
      }
    }
  }
  return out;
}
