import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type {
  JsonObject,
  JsonValue,
} from "../src/formats/json.js";
import {
  MAX_NATIVE_PREVIEW_OBJECT_POINTS,
  MAX_NATIVE_PREVIEW_OBJECTS,
} from "../src/images/mapPreview.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/object-debug.tmj";
const OBJECT_LAYER_ID = 20;

interface ObjectDebugEntry {
  sourceIndex: number;
  objectId: number;
  layerId: number;
  shape: string;
  representation: string;
  rendered: boolean;
  clipped: boolean;
}

interface ObjectDebugMetadata {
  profile: string;
  style: string;
  visibilityPolicy: string;
  drawOrder: string;
  selectedObjectCount: number;
  renderedObjectCount: number;
  entries: ObjectDebugEntry[];
}

describe("MapService native object debug overlay", () => {
  let root: string;
  let service: MapService;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), "tiledmcp-object-debug-"),
    );
    await mkdir(join(root, "maps"));
    await writeMap(root, supportedMap());
    const resolver =
      await ProjectPathResolver.create(root);
    service = new MapService(
      resolver,
      new DocumentStore(resolver),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("preserves explicit input order and projects supported hidden objects before rendering", async () => {
    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: {
        objectIds: [3, 1, 5, 4, 2],
      },
    });
    const metadata = objectDebugOf(rendered.result);

    expect(metadata).toMatchObject({
      profile: "explicit-basic-object-geometry-v3",
      style: "geometry-cyan-v1",
      visibilityPolicy:
        "explicit-ignore-object-and-layer-visibility-opacity",
      drawOrder:
        "after-highlights-and-grid-before-coordinates",
      selectedObjectCount: 5,
      renderedObjectCount: 5,
      entries: [
        {
          sourceIndex: 0,
          objectId: 3,
          layerId: OBJECT_LAYER_ID,
          shape: "polygon",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 1,
          objectId: 1,
          layerId: OBJECT_LAYER_ID,
          shape: "point",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 2,
          objectId: 5,
          layerId: OBJECT_LAYER_ID,
          shape: "text",
          representation: "text-box-only",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 3,
          objectId: 4,
          layerId: OBJECT_LAYER_ID,
          shape: "rectangle",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 4,
          objectId: 2,
          layerId: OBJECT_LAYER_ID,
          shape: "polyline",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
      ],
    });
    expect(rendered.result).toMatchObject({
      omittedLayers: [],
      partial: false,
    });
    expect(rendered.png.byteLength).toBeGreaterThan(0);
  });

  it("reports a fully clipped explicit object without dropping its entry", async () => {
    const map = supportedMap();
    objectLayerOf(map).objects = [
      pointObject(6, 100, 100),
    ];
    await writeMap(root, map);

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: { objectIds: [6] },
    });
    expect(objectDebugOf(rendered.result)).toMatchObject({
      selectedObjectCount: 1,
      renderedObjectCount: 0,
      entries: [
        {
          sourceIndex: 0,
          objectId: 6,
          rendered: false,
          clipped: true,
        },
      ],
    });
  });

  it("returns the fixed empty object-debug envelope when no objects were requested", async () => {
    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
    });
    expect(objectDebugOf(rendered.result)).toMatchObject({
      profile: "explicit-basic-object-geometry-v3",
      selectedObjectCount: 0,
      renderedObjectCount: 0,
      entries: [],
    });
  });

  it("keeps explicit object selection independent from tile-layer selection and omission reporting", async () => {
    const map = supportedMap();
    groupOf(map).visible = true;
    groupOf(map).opacity = 1;
    objectLayerOf(map).visible = true;
    objectLayerOf(map).opacity = 1;
    const layers = map.layers as JsonValue[];
    layers.unshift({
      data: Array.from({ length: 16 }, () => 0),
      height: 4,
      id: 30,
      name: "Empty tiles",
      opacity: 1,
      type: "tilelayer",
      visible: true,
      width: 4,
      x: 0,
      y: 0,
    });
    await writeMap(root, map);

    const implicit = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: { objectIds: [1] },
    });
    expect(implicit.result).toMatchObject({
      layerIds: [30],
      layerSelection: "visible",
      omittedLayers: [
        {
          id: OBJECT_LAYER_ID,
          type: "objectgroup",
          reason: "unsupported-layer-type",
        },
      ],
      omittedLayerCount: 1,
      partial: true,
    });
    expect(objectDebugOf(implicit.result)).toMatchObject({
      selectedObjectCount: 1,
      renderedObjectCount: 1,
    });

    const explicit = await service.renderPreview({
      mapPath: MAP_PATH,
      layerIds: [30],
      scale: 1,
      overlays: { objectIds: [1] },
    });
    expect(explicit.result).toMatchObject({
      layerIds: [30],
      layerSelection: "explicit",
      omittedLayers: [],
      omittedLayerCount: 0,
      partial: false,
    });
    expect(objectDebugOf(explicit.result)).toMatchObject({
      selectedObjectCount: 1,
      renderedObjectCount: 1,
    });
  });

  it("accepts exactly sixty-four explicitly selected objects", async () => {
    const map = supportedMap();
    objectLayerOf(map).objects = Array.from(
      { length: MAX_NATIVE_PREVIEW_OBJECTS },
      (_, index) =>
        pointObject(
          index + 1,
          4 + (index % 8) * 6,
          4 + Math.floor(index / 8) * 6,
        ),
    );
    map.nextobjectid =
      MAX_NATIVE_PREVIEW_OBJECTS + 1;
    await writeMap(root, map);

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: {
        objectIds: Array.from(
          { length: MAX_NATIVE_PREVIEW_OBJECTS },
          (_, index) => index + 1,
        ),
      },
    });
    expect(objectDebugOf(rendered.result)).toMatchObject({
      selectedObjectCount:
        MAX_NATIVE_PREVIEW_OBJECTS,
      renderedObjectCount:
        MAX_NATIVE_PREVIEW_OBJECTS,
    });
  });

  it.each([
    {
      name: "empty",
      objectIds: [],
    },
    {
      name: "duplicate",
      objectIds: [1, 1],
    },
    {
      name: "non-positive",
      objectIds: [0],
    },
    {
      name: "unsafe",
      objectIds: [Number.MAX_SAFE_INTEGER + 1],
    },
    {
      name: "oversized",
      objectIds: Array.from(
        { length: MAX_NATIVE_PREVIEW_OBJECTS + 1 },
        (_, index) => index + 1,
      ),
    },
  ])("rejects an $name explicit selection", async ({ objectIds }) => {
    await expect(
      service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
        overlays: { objectIds },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("fails the whole selection when an object ID is missing", async () => {
    await expect(
      service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
        overlays: { objectIds: [1, 999] },
      }),
    ).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND",
      details: {
        path: MAP_PATH,
        objectId: 999,
      },
    });
  });

  it("projects ellipse, capsule and zero-extent curve objects in explicit order", async () => {
    const map = supportedMap();
    const omittedSizeEllipse: JsonObject = {
      ...rectangleObject(13),
      ellipse: true,
      x: 32,
      y: 32,
    };
    delete omittedSizeEllipse.width;
    delete omittedSizeEllipse.height;
    objectLayerOf(map).objects = [
      {
        ...rectangleObject(11),
        ellipse: true,
        rotation: 30,
        width: 18,
        height: 10,
        x: 8,
        y: 8,
      },
      {
        ...rectangleObject(12),
        capsule: true,
        rotation: 90,
        width: 20,
        height: 8,
        x: 40,
        y: 8,
      },
      omittedSizeEllipse,
    ];
    map.nextobjectid = 14;
    await writeMap(root, map);

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: { objectIds: [12, 11, 13] },
    });
    expect(objectDebugOf(rendered.result)).toMatchObject({
      profile: "explicit-basic-object-geometry-v3",
      selectedObjectCount: 3,
      renderedObjectCount: 3,
      entries: [
        {
          sourceIndex: 0,
          objectId: 12,
          shape: "capsule",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 1,
          objectId: 11,
          shape: "ellipse",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 2,
          objectId: 13,
          shape: "ellipse",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
      ],
    });
  });

  it.each([
    {
      name: "template",
      object: {
        ...rectangleObject(11),
        template: "../templates/object.tx",
      },
      code: "UNSUPPORTED_OBJECT_PROFILE",
      feature: "template",
    },
    {
      name: "template tile",
      object: {
        ...rectangleObject(11),
        gid: 1,
        template: "../templates/object.tx",
      },
      code: "UNSUPPORTED_OBJECT_PROFILE",
      feature: "template",
    },
  ])(
    "fails closed on an explicitly selected $name object",
    async ({ object, code, feature }) => {
      const map = supportedMap();
      objectLayerOf(map).objects = [object];
      await writeMap(root, map);

      await expect(
        service.renderPreview({
          mapPath: MAP_PATH,
          scale: 1,
          overlays: { objectIds: [11] },
        }),
      ).rejects.toMatchObject({
        code,
        details: {
          objectId: 11,
          feature,
        },
      });
    },
  );

  it("projects tile-object frames with Tiled alignment, scaled tile offsets and dimension defaults", async () => {
    const map = supportedMap();
    map.tilesets = [
      { firstgid: 1, source: "../tiles/frame.tsj" },
    ];
    objectLayerOf(map).objects = [
      {
        gid: 1,
        height: 16,
        id: 11,
        name: "Crate",
        rotation: 0,
        type: "",
        visible: true,
        width: 16,
        x: 16,
        y: 32,
      },
      {
        // Flip flags and the preserved raw 0x10000000 bit must not change
        // the outline geometry, and the omitted dimensions default to the
        // tileset tile size.
        gid: 0xd0000001,
        id: 12,
        name: "FlippedProp",
        rotation: 0,
        type: "",
        visible: true,
        x: 40,
        y: 40,
      },
    ];
    map.nextobjectid = 13;
    await writeTileset(root, "frame.tsj", {
      tileoffset: { x: 2, y: -4 },
    });
    await writeMap(root, map);

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: { objectIds: [11, 12] },
    });
    const metadata = objectDebugOf(rendered.result);
    expect(metadata).toMatchObject({
      selectedObjectCount: 2,
      renderedObjectCount: 2,
      entries: [
        {
          sourceIndex: 0,
          objectId: 11,
          layerId: OBJECT_LAYER_ID,
          shape: "tile",
          representation: "tile-frame-only",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 1,
          objectId: 12,
          layerId: OBJECT_LAYER_ID,
          shape: "tile",
          representation: "tile-frame-only",
          rendered: true,
          clipped: false,
        },
      ],
    });

    const decoded = await decodeRgba(rendered.png);
    const cyan = [34, 211, 238, 255] as const;
    // Bottom-left alignment lifts the 16x16 frame above the anchor, and the
    // tileset tile offset (2,-4) shifts it scaled by object/tile size.
    expect(pixel(decoded, 18, 12)).toEqual(cyan);
    expect(pixel(decoded, 34, 12)).toEqual(cyan);
    expect(pixel(decoded, 34, 28)).toEqual(cyan);
    expect(pixel(decoded, 26, 20)).toEqual([
      0, 0, 0, 0,
    ]);
    // The anchor crosshair stays at the object position.
    expect(pixel(decoded, 16, 32)).toEqual(cyan);
    // Flip flags leave the defaulted 16x16 frame unchanged.
    expect(pixel(decoded, 42, 20)).toEqual(cyan);
    expect(pixel(decoded, 58, 36)).toEqual(cyan);
  });

  it("honors an explicit tileset objectalignment for tile frames", async () => {
    const map = supportedMap();
    map.tilesets = [
      { firstgid: 1, source: "../tiles/frame.tsj" },
    ];
    objectLayerOf(map).objects = [
      {
        gid: 1,
        height: 16,
        id: 11,
        name: "Centered",
        rotation: 0,
        type: "",
        visible: true,
        width: 16,
        x: 32,
        y: 32,
      },
    ];
    map.nextobjectid = 12;
    await writeTileset(root, "frame.tsj", {
      objectalignment: "center",
    });
    await writeMap(root, map);

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: { objectIds: [11] },
    });
    const decoded = await decodeRgba(rendered.png);
    const cyan = [34, 211, 238, 255] as const;
    expect(pixel(decoded, 24, 24)).toEqual(cyan);
    expect(pixel(decoded, 40, 40)).toEqual(cyan);
  });

  it.each([
    {
      name: "dangling gid",
      gid: 99,
      tileset: {},
      code: "GID_OUT_OF_RANGE",
    },
    {
      name: "empty gid",
      gid: 0,
      tileset: {},
      code: "INVALID_DOCUMENT",
    },
    {
      name: "unsupported objectalignment",
      gid: 1,
      tileset: { objectalignment: "diagonal" },
      code: "INVALID_DOCUMENT",
    },
    {
      name: "malformed tileoffset",
      gid: 1,
      tileset: { tileoffset: { x: 2 } },
      code: "INVALID_DOCUMENT",
    },
  ])(
    "fails closed on a tile-object frame with a $name",
    async ({ gid, tileset, code }) => {
      const map = supportedMap();
      map.tilesets = [
        {
          firstgid: 1,
          source: "../tiles/frame.tsj",
        },
      ];
      objectLayerOf(map).objects = [
        {
          ...rectangleObject(11),
          gid,
        },
      ];
      await writeTileset(root, "frame.tsj", tileset);
      await writeMap(root, map);

      await expect(
        service.renderPreview({
          mapPath: MAP_PATH,
          scale: 1,
          overlays: { objectIds: [11] },
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("rejects a tile object that also carries a shape marker", async () => {
    const map = supportedMap();
    map.tilesets = [
      { firstgid: 1, source: "../tiles/frame.tsj" },
    ];
    objectLayerOf(map).objects = [
      {
        ...rectangleObject(11),
        ellipse: true,
        gid: 1,
      },
    ];
    await writeTileset(root, "frame.tsj", {});
    await writeMap(root, map);

    await expect(
      service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
        overlays: { objectIds: [11] },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      details: {
        objectId: 11,
        feature: "ellipse",
      },
    });
  });

  it.each([
    {
      name: "object-layer tile x",
      mutate(map: JsonObject) {
        objectLayerOf(map).x = 1;
      },
      feature: "object-layer-x",
    },
    {
      name: "object-layer pixel offset",
      mutate(map: JsonObject) {
        objectLayerOf(map).offsetx = 0.5;
      },
      feature: "offsetx",
    },
    {
      name: "ancestor group tile y",
      mutate(map: JsonObject) {
        groupOf(map).y = -1;
      },
      feature: "group-y",
    },
    {
      name: "ancestor group parallax",
      mutate(map: JsonObject) {
        groupOf(map).parallaxy = 0.5;
      },
      feature: "parallaxy",
    },
  ])(
    "fails closed on non-default $name positioning",
    async ({ mutate, feature }) => {
      const map = supportedMap();
      mutate(map);
      await writeMap(root, map);

      await expect(
        service.renderPreview({
          mapPath: MAP_PATH,
          scale: 1,
          overlays: { objectIds: [1] },
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_RENDER_FEATURE",
        details: {
          objectId: 1,
          layerId: OBJECT_LAYER_ID,
          feature,
        },
      });
    },
  );

  it("rejects malformed selected-layer positioning as an invalid document", async () => {
    const map = supportedMap();
    objectLayerOf(map).parallaxx = "1";
    await writeMap(root, map);

    await expect(
      service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
        overlays: { objectIds: [1] },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      details: {
        objectId: 1,
        layerId: OBJECT_LAYER_ID,
        field: "parallaxx",
        value: "1",
      },
    });
  });

  it("enforces the aggregate path-point budget across the exact selection", async () => {
    const points = Array.from(
      { length: 256 },
      (_, index) => ({
        x: index % 16,
        y: Math.floor(index / 16),
      }),
    );
    const objectCount =
      Math.floor(MAX_NATIVE_PREVIEW_OBJECT_POINTS / points.length) + 1;
    const map = supportedMap();
    objectLayerOf(map).objects = Array.from(
      { length: objectCount },
      (_, index) => ({
        id: index + 1,
        name: "",
        polygon: points,
        rotation: 0,
        type: "",
        visible: true,
        x: 0,
        y: 0,
      }),
    );
    map.nextobjectid = objectCount + 1;
    await writeMap(root, map);

    await expect(
      service.renderPreview({
        mapPath: MAP_PATH,
        scale: 1,
        overlays: {
          objectIds: Array.from(
            { length: objectCount },
            (_, index) => index + 1,
          ),
        },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        actual: objectCount * points.length,
        limit: MAX_NATIVE_PREVIEW_OBJECT_POINTS,
        sourceIndex: objectCount - 1,
        objectId: objectCount,
      },
    });
  });

  it("accepts exactly the aggregate path-point budget", async () => {
    const points = Array.from(
      { length: 256 },
      (_, index) => ({
        x: index % 16,
        y: Math.floor(index / 16),
      }),
    );
    const objectCount =
      MAX_NATIVE_PREVIEW_OBJECT_POINTS /
      points.length;
    const map = supportedMap();
    objectLayerOf(map).objects = Array.from(
      { length: objectCount },
      (_, index) => ({
        id: index + 1,
        name: "",
        polygon: points,
        rotation: 0,
        type: "",
        visible: true,
        x: index % 4,
        y: Math.floor(index / 4),
      }),
    );
    map.nextobjectid = objectCount + 1;
    await writeMap(root, map);

    const rendered = await service.renderPreview({
      mapPath: MAP_PATH,
      scale: 1,
      overlays: {
        objectIds: Array.from(
          { length: objectCount },
          (_, index) => index + 1,
        ),
      },
    });
    expect(objectDebugOf(rendered.result)).toMatchObject({
      selectedObjectCount: objectCount,
      renderedObjectCount: objectCount,
    });
  });

  it("resolves the full object selection before trying to load atlas images", async () => {
    await mkdir(join(root, "tiles"));
    await writeFile(
      join(root, "tiles", "missing.tsj"),
      JSON.stringify({
        columns: 1,
        image: "does-not-exist.png",
        imageheight: 16,
        imagewidth: 16,
        margin: 0,
        name: "Missing image",
        spacing: 0,
        tilecount: 1,
        tileheight: 16,
        tilewidth: 16,
        type: "tileset",
        version: "1.10",
      }),
      "utf8",
    );
    await writeFile(
      join(root, "tiles", "does-not-exist.png"),
      Buffer.from("not an image", "utf8"),
    );
    const map = supportedMap();
    map.width = 1;
    map.height = 1;
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/missing.tsj",
      },
    ];
    const layers = map.layers as JsonValue[];
    layers.unshift({
      data: [1],
      height: 1,
      id: 30,
      name: "Needs missing atlas",
      opacity: 1,
      type: "tilelayer",
      visible: true,
      width: 1,
      x: 0,
      y: 0,
    });
    await writeMap(root, map);

    await expect(
      service.renderPreview({
        mapPath: MAP_PATH,
        region: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        scale: 1,
        overlays: { objectIds: [999] },
      }),
    ).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND",
      details: { objectId: 999 },
    });
  });
});

function supportedMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 4,
    infinite: false,
    layers: [
      {
        id: 10,
        layers: [
          {
            id: OBJECT_LAYER_ID,
            name: "Hidden objects",
            objects: [
              pointObject(1, 30, 30),
              {
                id: 2,
                name: "Path",
                opacity: 0,
                polyline: [
                  { x: 0, y: 0 },
                  { x: 8, y: 4 },
                  { x: 12, y: 8 },
                ],
                rotation: -15,
                type: "Path",
                visible: false,
                x: 8,
                y: 40,
              },
              {
                id: 3,
                name: "Zone",
                polygon: [
                  { x: 0, y: 0 },
                  { x: 8, y: 0 },
                  { x: 4, y: 8 },
                ],
                rotation: 0,
                type: "Zone",
                visible: false,
                x: 16,
                y: 16,
              },
              rectangleObject(4),
              {
                height: 12,
                id: 5,
                name: "Label",
                rotation: 0,
                text: {
                  text: "debug",
                },
                type: "Label",
                visible: false,
                width: 20,
                x: 36,
                y: 4,
              },
            ],
            opacity: 0,
            type: "objectgroup",
            visible: false,
          },
        ],
        name: "Hidden group",
        opacity: 0,
        type: "group",
        visible: false,
      },
    ],
    nextlayerid: 31,
    nextobjectid: 6,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 4,
  };
}

function pointObject(
  id: number,
  x: number,
  y: number,
): JsonObject {
  return {
    height: 0,
    id,
    name: "Point",
    point: true,
    rotation: 45,
    type: "Marker",
    visible: false,
    width: 0,
    x,
    y,
  };
}

function rectangleObject(id: number): JsonObject {
  return {
    height: 6,
    id,
    name: "Box",
    rotation: 0,
    type: "Bounds",
    visible: false,
    width: 8,
    x: 4,
    y: 4,
  };
}

function groupOf(map: JsonObject): JsonObject {
  const layers = map.layers;
  const group =
    Array.isArray(layers) ? layers[0] : undefined;
  if (
    typeof group !== "object" ||
    group === null ||
    Array.isArray(group)
  ) {
    throw new Error("Expected the fixture group.");
  }
  return group;
}

function objectLayerOf(map: JsonObject): JsonObject {
  const group = groupOf(map);
  const layers = group.layers;
  const layer =
    Array.isArray(layers) ? layers[0] : undefined;
  if (
    typeof layer !== "object" ||
    layer === null ||
    Array.isArray(layer) ||
    !Array.isArray(layer.objects)
  ) {
    throw new Error("Expected the fixture object layer.");
  }
  return layer;
}

function objectDebugOf(
  result: Record<string, unknown>,
): ObjectDebugMetadata {
  const overlays = result.overlays;
  if (
    typeof overlays !== "object" ||
    overlays === null ||
    Array.isArray(overlays)
  ) {
    throw new Error("Expected preview overlays metadata.");
  }
  const objectDebug = (
    overlays as Record<string, unknown>
  ).objectDebug;
  if (
    typeof objectDebug !== "object" ||
    objectDebug === null ||
    Array.isArray(objectDebug)
  ) {
    throw new Error("Expected object debug metadata.");
  }
  return objectDebug as unknown as ObjectDebugMetadata;
}

async function writeMap(
  root: string,
  map: JsonObject,
): Promise<void> {
  await writeFile(
    join(root, MAP_PATH),
    JSON.stringify(map),
    "utf8",
  );
}

async function writeTileset(
  root: string,
  name: string,
  extra: JsonObject,
): Promise<void> {
  await mkdir(join(root, "tiles"), {
    recursive: true,
  });
  await writeFile(
    join(root, "tiles", "terrain.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
      '<rect width="32" height="32" fill="#559955"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );
  await writeFile(
    join(root, "tiles", name),
    JSON.stringify({
      columns: 2,
      image: "terrain.svg",
      imageheight: 32,
      imagewidth: 32,
      margin: 0,
      name: "Frames",
      spacing: 0,
      tilecount: 4,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
      ...extra,
    }),
    "utf8",
  );
}

async function decodeRgba(png: Buffer): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
  };
}

function pixel(
  decoded: {
    data: Buffer;
    width: number;
    height: number;
  },
  x: number,
  y: number,
): [number, number, number, number] {
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(decoded.width);
  expect(y).toBeLessThan(decoded.height);
  const index = (y * decoded.width + x) * 4;
  return [
    decoded.data[index] ?? -1,
    decoded.data[index + 1] ?? -1,
    decoded.data[index + 2] ?? -1,
    decoded.data[index + 3] ?? -1,
  ];
}
