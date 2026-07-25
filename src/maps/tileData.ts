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
  const text = layer.data as string;
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
