import { describe, expect, it } from "vitest";

import type {
  JsonObject,
  JsonValue,
} from "../src/formats/json.js";
import {
  MAX_PREVIEW_ATLASES,
  MAX_PREVIEW_LAYERS,
  MAX_PREVIEW_OMITTED_LAYERS,
  MAX_PREVIEW_REGION_CELLS,
  MAX_PREVIEW_TILE_DRAWS,
  buildPreviewScene,
  type PreviewLayerSelectionInput,
  type PreviewTilesetRange,
} from "../src/maps/previewScene.js";

const MAP_PATH = "maps/preview.tmj";
const DEFAULT_RANGE: PreviewTilesetRange = {
  assetId: "asset_a",
  firstGid: 1,
  tileCount: 10,
  name: "A",
};

describe("buildPreviewScene", () => {
  it("selects visible tile layers and reports only visible unsupported leaves", () => {
    const scene = build(
      map([
        tileLayer(1, [1]),
        tileLayer(2, [1], { visible: false }),
        objectLayer(3, true),
        objectLayer(4, false),
      ]),
    );

    expect(scene).toMatchObject({
      region: { x: 0, y: 0, width: 1, height: 1 },
      layerSelection: "visible",
      omittedLayers: [
        {
          id: 3,
          name: "Objects 3",
          type: "objectgroup",
          reason: "unsupported-layer-type",
        },
      ],
      usedAssetIds: ["asset_a"],
    });
    expect(scene.layers.map(({ id }) => id)).toEqual([1]);
  });

  it("renders explicitly selected hidden tile layers in document order", () => {
    const ranges = [
      DEFAULT_RANGE,
      {
        assetId: "asset_b",
        firstGid: 11,
        tileCount: 10,
        name: "B",
      },
    ];
    const scene = build(
      map([
        tileLayer(1, [1]),
        tileLayer(2, [11], { visible: false }),
        tileLayer(3, [1]),
      ]),
      1,
      1,
      ranges,
      { layerIds: [3, 2] },
    );

    expect(scene.layerSelection).toBe("explicit");
    expect(scene.layers.map(({ id }) => id)).toEqual([2, 3]);
    expect(scene.omittedLayers).toEqual([]);
    expect(scene.usedAssetIds).toEqual(["asset_a", "asset_b"]);
  });

  it("applies nested group visibility implicitly but explicit selection overrides it", () => {
    const document = map([
      groupLayer(10, false, [
        groupLayer(11, true, [tileLayer(12, [1])]),
      ]),
      groupLayer(20, true, [
        tileLayer(21, [1], { visible: false }),
        tileLayer(22, [1]),
      ]),
    ]);

    expect(build(document).layers.map(({ id }) => id)).toEqual([22]);
    expect(
      build(document, 1, 1, [DEFAULT_RANGE], {
        layerIds: [21, 12],
      }).layers.map(({ id }) => id),
    ).toEqual([12, 21]);
  });

  it("rejects missing and non-tile explicit layer IDs", () => {
    const document = map([tileLayer(1, [1]), objectLayer(2, true)]);

    expect(() =>
      build(document, 1, 1, [DEFAULT_RANGE], { layerIds: [99] }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAYER_NOT_FOUND",
        details: { path: MAP_PATH, layerId: 99 },
      }),
    );
    expect(() =>
      build(document, 1, 1, [DEFAULT_RANGE], { layerIds: [2] }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAYER_TYPE_MISMATCH",
        details: {
          path: MAP_PATH,
          layerId: 2,
          actualType: "objectgroup",
        },
      }),
    );
  });

  it("requires a region for an oversized full map and validates explicit bounds", () => {
    expect(() => build(map([]), 201, 100, [])).toThrowError(
      expect.objectContaining({
        code: "PREVIEW_REGION_REQUIRED",
        details: expect.objectContaining({
          actual: 20_100,
          limit: MAX_PREVIEW_REGION_CELLS,
        }),
      }),
    );
    expect(() =>
      build(map([]), 10, 10, [], {
        region: { x: 9, y: 0, width: 2, height: 1 },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "REGION_OUT_OF_BOUNDS",
        details: expect.objectContaining({
          mapBounds: { x: 0, y: 0, width: 10, height: 10 },
        }),
      }),
    );
    expect(() =>
      build(map([]), 201, 100, [], {
        region: { x: 0, y: 0, width: 201, height: 100 },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          actual: 20_100,
          limit: MAX_PREVIEW_REGION_CELLS,
        }),
      }),
    );

    expect(
      build(map([]), 200, 100, [], {
        region: { x: 0, y: 0, width: 200, height: 100 },
      }).region,
    ).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it.each([
    ["blend-mode", { mode: "multiply" }],
    ["tint-color", { tintcolor: "#ff00ff" }],
    ["offsetx", { offsetx: 1 }],
  ] satisfies Array<[string, JsonObject]>)(
    "fails closed on unsupported %s layer rendering",
    (feature, fields) => {
      expect(() =>
        build(map([tileLayer(1, [1], fields)])),
      ).toThrowError(
        expect.objectContaining({
          code: "UNSUPPORTED_RENDER_FEATURE",
          details: expect.objectContaining({ feature, layerId: 1 }),
        }),
      );
    },
  );

  it("fails closed on non-default group opacity", () => {
    expect(() =>
      build(
        map([
          groupLayer(10, true, [tileLayer(11, [1])], {
            opacity: 0.5,
          }),
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_RENDER_FEATURE",
        details: {
          feature: "group-opacity",
          childLayerId: 11,
          opacity: 0.5,
        },
      }),
    );
  });

  it.each([
    ["base64/string", { data: "AAAA" }],
    ["chunks", { chunks: [], data: [1] }],
  ] satisfies Array<[string, JsonObject]>)(
    "rejects unsupported %s tile encoding",
    (_label, fields) => {
      expect(() =>
        build(map([tileLayer(1, [1], fields)])),
      ).toThrowError(
        expect.objectContaining({
          code: "UNSUPPORTED_TILE_ENCODING",
          details: { layerId: 1 },
        }),
      );
    },
  );

  it("rejects a GID that falls outside every tileset range", () => {
    expect(() =>
      build(
        map([tileLayer(1, [3])]),
        1,
        1,
        [
          {
            assetId: "asset_one",
            firstGid: 1,
            tileCount: 2,
            name: "One",
          },
        ],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "GID_OUT_OF_RANGE",
        details: { gid: 3, layerId: 1 },
      }),
    );
  });

  it("bounds the number of selected tile layers", () => {
    const layers = Array.from(
      { length: MAX_PREVIEW_LAYERS + 1 },
      (_, index) => tileLayer(index + 1, [0]),
    );

    expect(() => build(map(layers), 1, 1, [])).toThrowError(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
        details: {
          actual: MAX_PREVIEW_LAYERS + 1,
          limit: MAX_PREVIEW_LAYERS,
        },
      }),
    );
  });

  it("bounds worst-case region × layer draw work", () => {
    const layerCount =
      Math.floor(MAX_PREVIEW_TILE_DRAWS / MAX_PREVIEW_REGION_CELLS) + 1;
    const layers = Array.from(
      { length: layerCount },
      (_, index) => tileLayer(index + 1, [0]),
    );

    expect(() =>
      build(map(layers), 200, 100, [], {
        region: { x: 0, y: 0, width: 200, height: 100 },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
        details: {
          regionCells: MAX_PREVIEW_REGION_CELLS,
          layerCount,
          maximumDraws: MAX_PREVIEW_REGION_CELLS * layerCount,
          limit: MAX_PREVIEW_TILE_DRAWS,
        },
      }),
    );
  });

  it("bounds distinct atlas images used by the selected region", () => {
    const atlasCount = MAX_PREVIEW_ATLASES + 1;
    const ranges = Array.from(
      { length: atlasCount },
      (_, index): PreviewTilesetRange => ({
        assetId: `asset_${index}`,
        firstGid: index + 1,
        tileCount: 1,
        name: `Tiles ${index}`,
      }),
    );

    expect(() =>
      build(
        map([
          tileLayer(
            1,
            Array.from({ length: atlasCount }, (_, index) => index + 1),
            { width: atlasCount, height: 1 },
          ),
        ]),
        atlasCount,
        1,
        ranges,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
        details: {
          actual: atlasCount,
          limit: MAX_PREVIEW_ATLASES,
        },
      }),
    );
  });

  it("bounds omission metadata and reports the full omitted count", () => {
    const objectLayers = Array.from(
      { length: MAX_PREVIEW_OMITTED_LAYERS + 1 },
      (_, index) => ({
        ...objectLayer(index + 1, true),
        name: "x".repeat(1_000),
      }),
    );
    const scene = build(map(objectLayers), 1, 1, []);

    expect(scene.omittedLayers).toHaveLength(
      MAX_PREVIEW_OMITTED_LAYERS,
    );
    expect(scene.omittedLayerCount).toBe(
      MAX_PREVIEW_OMITTED_LAYERS + 1,
    );
    expect(scene.omittedLayersTruncated).toBe(true);
    expect(
      scene.omittedLayers.every((layer) => layer.name.length <= 128),
    ).toBe(true);
  });

  it("does not collect sources or draw work for opacity-zero layers", () => {
    const scene = build(
      map([tileLayer(1, [1], { opacity: 0 })]),
    );
    expect(scene.layers).toHaveLength(1);
    expect(scene.usedAssetIds).toEqual([]);
  });

  it.each([
    ["visible", { visible: "yes" }],
    ["type", { type: 17 }],
  ] satisfies Array<[string, JsonObject]>)(
    "rejects a malformed layer %s field",
    (_field, patch) => {
      expect(() =>
        build(map([tileLayer(1, [1], patch)])),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_DOCUMENT" }),
      );
    },
  );
});

function build(
  document: JsonObject,
  mapWidth = 1,
  mapHeight = 1,
  ranges: readonly PreviewTilesetRange[] = [DEFAULT_RANGE],
  input: PreviewLayerSelectionInput = {},
) {
  return buildPreviewScene(
    document,
    MAP_PATH,
    mapWidth,
    mapHeight,
    ranges,
    input,
  );
}

function map(layers: JsonValue[]): JsonObject {
  return {
    type: "map",
    renderorder: "right-down",
    layers,
  };
}

function tileLayer(
  id: number,
  data: JsonValue[],
  fields: JsonObject = {},
): JsonObject {
  return {
    id,
    name: `Tile ${id}`,
    type: "tilelayer",
    visible: true,
    opacity: 1,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    data,
    ...fields,
  };
}

function objectLayer(id: number, visible: boolean): JsonObject {
  return {
    id,
    name: `Objects ${id}`,
    type: "objectgroup",
    visible,
    opacity: 1,
    objects: [],
  };
}

function groupLayer(
  id: number,
  visible: boolean,
  layers: JsonValue[],
  fields: JsonObject = {},
): JsonObject {
  return {
    id,
    name: `Group ${id}`,
    type: "group",
    visible,
    opacity: 1,
    layers,
    ...fields,
  };
}
