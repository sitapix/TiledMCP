import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { describe, expect, it } from "vitest";

import {
  MAX_NATIVE_PREVIEW_BYTES,
} from "../src/images/mapPreview.js";
import {
  MAX_TILE_RENDER_BYTES,
  MAX_TILESET_SHEET_BYTES,
} from "../src/images/tilesetSheet.js";
import {
  MAX_RASTER_PNG_BYTES,
  STDIO_INBOUND_MESSAGE_LIMIT_BYTES,
} from "../src/rasterContract.js";

/** Bytes a buffer of `raw` length occupies once base64-encoded. */
function base64Length(raw: number): number {
  return Math.ceil(raw / 3) * 4;
}

/**
 * Room reserved for everything in the message that is not the encoded image:
 * the JSON-RPC envelope, `structuredContent`, and the bounded text summary.
 */
const ENVELOPE_HEADROOM_BYTES = 256 * 1024;

describe("inline image budget fits the stdio transport", () => {
  it("tracks the SDK's actual stdio buffer cap", () => {
    // The budget below is derived from this number. If the SDK moves it, the
    // derivation has to be redone rather than silently drifting out of date.
    expect(STDIO_INBOUND_MESSAGE_LIMIT_BYTES).toBe(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
  });

  it("keeps a maximal encoded image under the SDK stdio buffer cap", () => {
    const encoded = base64Length(MAX_RASTER_PNG_BYTES);

    expect(encoded).toBeLessThan(
      STDIO_INBOUND_MESSAGE_LIMIT_BYTES,
    );
    expect(
      encoded + ENVELOPE_HEADROOM_BYTES,
    ).toBeLessThanOrEqual(
      STDIO_INBOUND_MESSAGE_LIMIT_BYTES,
    );
  });

  it("rejects the pre-1.30 ceiling that overflowed the cap", () => {
    // Regression pin: 8 MiB encodes to ~10.67 MiB, which SDK >= 1.30 refuses
    // by throwing out of ReadBuffer.append -- closing the session, not the call.
    expect(
      base64Length(8 * 1024 * 1024),
    ).toBeGreaterThan(
      STDIO_INBOUND_MESSAGE_LIMIT_BYTES,
    );
  });

  it.each([
    ["MAX_NATIVE_PREVIEW_BYTES", MAX_NATIVE_PREVIEW_BYTES],
    ["MAX_TILESET_SHEET_BYTES", MAX_TILESET_SHEET_BYTES],
    ["MAX_TILE_RENDER_BYTES", MAX_TILE_RENDER_BYTES],
  ])(
    "holds producer budget %s at or below the inline ceiling",
    (_name, budget) => {
      // Every one of these feeds imageToolResult, which gates on
      // MAX_RASTER_PNG_BYTES. A producer above the gate can only ever render
      // bytes that the gate then refuses.
      expect(budget).toBeLessThanOrEqual(
        MAX_RASTER_PNG_BYTES,
      );
    },
  );
});
