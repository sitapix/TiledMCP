import {
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
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
 * (infinite) layers fail closed in both modes. Encoded string data decodes
 * in both modes: edits work on the decoded cells and the apply path
 * re-encodes actually-written layers in kind before patching.
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

/**
 * Encodes cells back into the layer's stored representation: little-endian
 * uint32 bytes, compressed with the layer's own declared method, base64.
 * Write-back never transcodes — the encoding and compression members stay
 * exactly as stored.
 */
export function encodeTileLayerCells(
  cells: readonly JsonValue[],
  compression: string,
  layerId: number,
  mapPath: string,
): string {
  const bytes = Buffer.alloc(cells.length * 4);
  for (const [index, cell] of cells.entries()) {
    if (
      typeof cell !== "number" ||
      !Number.isSafeInteger(cell) ||
      cell < 0 ||
      cell > 0xffffffff
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `Layer ${layerId} has a non-uint32 GID at index ${index}.`,
        { path: mapPath, layerId, index },
      );
    }
    bytes.writeUInt32LE(cell, index * 4);
  }
  const packed =
    compression === ""
      ? bytes
      : compression === "gzip"
        ? gzipSync(bytes)
        : compression === "zlib"
          ? deflateSync(bytes)
          : compression === "zstd"
            ? zstdCompressSync(bytes)
            : undefined;
  if (packed === undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_TILE_ENCODING",
      `Layer ${layerId} uses an unsupported compression method.`,
      { path: mapPath, layerId, compression },
    );
  }
  return packed.toString("base64");
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

export const TILED_DEFAULT_CHUNK_SIZE = 16;
export const TILED_MIN_CHUNK_SIZE = 4;

/**
 * Reads the map's serialization chunk size with Tiled 1.12.2 reader
 * semantics: a missing or zero editorsettings.chunksize member means the
 * 16x16 default, and explicit positive values are raised to the minimum
 * of 4. Negative or non-integer values fail closed instead of guessing,
 * and a chunk larger than the per-chunk decode budget is rejected.
 */
export function readMapChunkSize(
  map: JsonObject,
  mapPath: string,
): { width: number; height: number } {
  const editorSettings = map.editorsettings;
  const chunkSize =
    typeof editorSettings === "object" &&
    editorSettings !== null &&
    !Array.isArray(editorSettings)
      ? (editorSettings as JsonObject).chunksize
      : undefined;
  const readAxis = (field: "width" | "height"): number => {
    const value =
      typeof chunkSize === "object" &&
      chunkSize !== null &&
      !Array.isArray(chunkSize)
        ? (chunkSize as JsonObject)[field]
        : undefined;
    if (value === undefined || value === 0) {
      return TILED_DEFAULT_CHUNK_SIZE;
    }
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${mapPath} editorsettings.chunksize.${field} must be a nonnegative integer.`,
        { path: mapPath, field },
      );
    }
    return Math.max(TILED_MIN_CHUNK_SIZE, value);
  };
  const width = readAxis("width");
  const height = readAxis("height");
  if (width * height * 4 > MAX_DECODED_TILE_DATA_BYTES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${mapPath} editorsettings.chunksize exceeds the per-chunk decode budget.`,
      {
        path: mapPath,
        limit: MAX_DECODED_TILE_DATA_BYTES,
      },
    );
  }
  return { width, height };
}

function chunkedCellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export interface ChunkedCellView {
  /** Sparse nonzero cells keyed by absolute "x,y". */
  cells: Map<string, number>;
  structure: ChunkedTileLayerStructure;
  dirty: boolean;
}

/**
 * Decodes every chunk of an infinite tile layer into one sparse
 * absolute-coordinate cell view. Overlap, budget, and shape validation
 * come from the structural reader; every stored cell must be a uint32.
 */
export function createChunkedCellView(
  layer: JsonObject,
  layerId: number,
  mapPath: string,
): ChunkedCellView {
  const structure = readChunkedTileLayerStructure(
    layer,
    layerId,
    mapPath,
  );
  const cells = new Map<string, number>();
  for (const chunk of structure.chunks) {
    const decoded = decodeChunkCells(
      chunk,
      layer,
      layerId,
      mapPath,
    );
    for (const [index, value] of decoded.entries()) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 0xffffffff
      ) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} has a non-uint32 GID in a chunk at index ${index}.`,
          { path: mapPath, layerId, index },
        );
      }
      if (value === 0) {
        continue;
      }
      cells.set(
        chunkedCellKey(
          chunk.x + (index % chunk.width),
          chunk.y + Math.floor(index / chunk.width),
        ),
        value,
      );
    }
  }
  return { cells, structure, dirty: false };
}

export function readChunkedViewGid(
  view: ChunkedCellView,
  x: number,
  y: number,
): number {
  return view.cells.get(chunkedCellKey(x, y)) ?? 0;
}

export function writeChunkedViewGid(
  view: ChunkedCellView,
  x: number,
  y: number,
  gid: number,
): void {
  const key = chunkedCellKey(x, y);
  const previous = view.cells.get(key) ?? 0;
  if (previous === gid) {
    return;
  }
  if (gid === 0) {
    view.cells.delete(key);
  } else {
    view.cells.set(key, gid);
  }
  view.dirty = true;
}

export interface SerializedChunkedLayer {
  chunks: JsonObject[];
  startX: number;
  startY: number;
  width: number;
  height: number;
  chunkCount: number;
  nonEmptyCellCount: number;
}

/**
 * Serializes sparse cells in Tiled 1.12.2 canonical save form: nonzero
 * cells are rebucketed into floor-aligned chunkWidth x chunkHeight
 * rectangles, empty chunks are dropped, chunks sort by (y, x), and the
 * layer bounds become the union of the written chunk rectangles. Chunk
 * data encodes with the layer's own stored encoding and compression.
 */
export function serializeChunkedCells(input: {
  cells: ReadonlyMap<string, number>;
  chunkWidth: number;
  chunkHeight: number;
  encoding: "array" | "base64";
  compression: string;
  layerId: number;
  mapPath: string;
}): SerializedChunkedLayer {
  const {
    cells,
    chunkWidth,
    chunkHeight,
    layerId,
    mapPath,
  } = input;
  const floorAlign = (
    value: number,
    size: number,
  ): number => value - (((value % size) + size) % size);
  const buckets = new Map<
    string,
    { x: number; y: number; dense: number[] }
  >();
  let nonEmptyCellCount = 0;
  for (const [key, gid] of cells) {
    if (gid === 0) {
      continue;
    }
    nonEmptyCellCount += 1;
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      Math.abs(x) > 1_000_000_000 ||
      Math.abs(y) > 1_000_000_000
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `Layer ${layerId} has a cell outside the bounded coordinate range.`,
        { path: mapPath, layerId },
      );
    }
    const chunkX = floorAlign(x, chunkWidth);
    const chunkY = floorAlign(y, chunkHeight);
    const bucketKey = chunkedCellKey(chunkX, chunkY);
    let bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      if (buckets.size >= MAX_TILE_LAYER_CHUNKS) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `layer ${layerId} would serialize more than ${MAX_TILE_LAYER_CHUNKS} chunks.`,
          {
            path: mapPath,
            layerId,
            limit: MAX_TILE_LAYER_CHUNKS,
          },
        );
      }
      bucket = {
        x: chunkX,
        y: chunkY,
        dense: new Array<number>(
          chunkWidth * chunkHeight,
        ).fill(0),
      };
      buckets.set(bucketKey, bucket);
    }
    bucket.dense[
      (y - chunkY) * chunkWidth + (x - chunkX)
    ] = gid;
  }
  const ordered = [...buckets.values()].sort(
    (left, right) =>
      left.y - right.y || left.x - right.x,
  );
  const chunks = ordered.map((bucket) => ({
    x: bucket.x,
    y: bucket.y,
    width: chunkWidth,
    height: chunkHeight,
    data:
      input.encoding === "array"
        ? bucket.dense
        : encodeTileLayerCells(
            bucket.dense,
            input.compression,
            layerId,
            mapPath,
          ),
  }));
  if (ordered.length === 0) {
    return {
      chunks: [],
      startX: 0,
      startY: 0,
      width: 0,
      height: 0,
      chunkCount: 0,
      nonEmptyCellCount: 0,
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const bucket of ordered) {
    minX = Math.min(minX, bucket.x);
    minY = Math.min(minY, bucket.y);
    maxX = Math.max(maxX, bucket.x + chunkWidth);
    maxY = Math.max(maxY, bucket.y + chunkHeight);
  }
  return {
    chunks,
    startX: minX,
    startY: minY,
    width: maxX - minX,
    height: maxY - minY,
    chunkCount: ordered.length,
    nonEmptyCellCount,
  };
}
