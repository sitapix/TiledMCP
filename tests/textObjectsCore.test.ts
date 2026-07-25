import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  MAX_OBJECT_DISPLAY_STRING_LENGTH,
  MapService,
} from "../src/maps/mapService.js";
import {
  MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
  measureTextObjectPayloadBytes,
} from "../src/maps/textObjects.js";
import type {
  MapEditOperation,
  MapEditPlan,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/text.tmj";
const OBJECT_LAYER_ID = 7;
const TEXT_OBJECT_ID = 1;

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("bounded text-object core", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("measures canonical flat payloads independently of request key order", () => {
    const first = {
      text: "Hello 🙂",
      bold: true,
      pixelSize: 24,
      x: 100,
    };
    const second = {
      x: -20,
      pixelSize: 24,
      bold: true,
      text: "Hello 🙂",
    };

    const expected = Buffer.byteLength(
      JSON.stringify({
        bold: true,
        pixelSize: 24,
        text: "Hello 🙂",
      }),
      "utf8",
    );
    expect(measureTextObjectPayloadBytes(first)).toBe(expected);
    expect(measureTextObjectPayloadBytes(second)).toBe(expected);
    expect(
      measureTextObjectPayloadBytes({ x: 1, width: 2 }),
    ).toBe(0);
    expect(() =>
      measureTextObjectPayloadBytes({
        text: "\tline 1\nline 2\r",
      }),
    ).not.toThrow();

    expect(() =>
      measureTextObjectPayloadBytes({
        text: `bad${String.fromCharCode(0)}`,
      }),
    ).toThrow(/TAB, LF and CR/u);
    expect(() =>
      measureTextObjectPayloadBytes({
        text: String.fromCharCode(0xd800),
      }),
    ).toThrow(/well-formed Unicode/u);
    expect(() =>
      measureTextObjectPayloadBytes({
        text: `bad${String.fromCharCode(0x85)}`,
      }),
    ).toThrow(/TAB, LF and CR/u);
    expect(() =>
      measureTextObjectPayloadBytes({
        fontFamily: "Bad\nFont",
      }),
    ).toThrow(/control characters/u);
    expect(() =>
      measureTextObjectPayloadBytes({ pixelSize: 16.5 }),
    ).toThrow(/integer between 1 and 999/u);
  });

  it("creates sparse default and fully styled nested TMJ text objects", async () => {
    const harness = await createHarness(roots);
    const operations: MapEditOperation[] = [
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 12.5,
          y: -4,
          text: "",
          fontFamily: "sans-serif",
          pixelSize: 16,
          wrap: false,
          color: "#FF000000",
          bold: false,
          italic: false,
          underline: false,
          strikeout: false,
          kerning: true,
          horizontalAlignment: "left",
          verticalAlignment: "top",
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 20,
          y: 30,
          width: 180.5,
          height: 48.25,
          text: "Line 1\n世界",
          name: "Dialogue",
          className: "Annotation",
          rotation: 12.5,
          visible: false,
          opacity: 0.5,
          fontFamily: "Noto Sans CJK SC",
          pixelSize: 37,
          wrap: true,
          color: "#80123456",
          bold: true,
          italic: true,
          underline: true,
          strikeout: true,
          kerning: false,
          horizontalAlignment: "right",
          verticalAlignment: "bottom",
        },
      },
    ];

    const edit = await plan(harness.service, operations);
    expect(edit.summary.createdObjectIds).toEqual([2, 3]);
    await harness.service.applyEdits(edit);

    const objects = await readObjects(harness.root);
    expect(objects[1]).toEqual({
      height: 0,
      id: 2,
      name: "",
      rotation: 0,
      text: { text: "" },
      type: "",
      visible: true,
      width: 0,
      x: 12.5,
      y: -4,
    });
    expect(objects[2]).toEqual({
      height: 48.25,
      id: 3,
      name: "Dialogue",
      opacity: 0.5,
      rotation: 12.5,
      text: {
        bold: true,
        color: "#80123456",
        fontfamily: "Noto Sans CJK SC",
        halign: "right",
        italic: true,
        kerning: false,
        pixelsize: 37,
        strikeout: true,
        text: "Line 1\n世界",
        underline: true,
        valign: "bottom",
        wrap: true,
      },
      type: "Annotation",
      visible: false,
      width: 180.5,
      x: 20,
      y: 30,
    });

    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 2,
      }),
    ).resolves.toMatchObject({
      object: {
        id: 2,
        shape: "text",
        width: 0,
        height: 0,
        text: "",
        fontFamily: "sans-serif",
        pixelSize: 16,
        wrap: false,
        color: "#000000",
        bold: false,
        italic: false,
        underline: false,
        strikeout: false,
        kerning: true,
        horizontalAlignment: "left",
        verticalAlignment: "top",
      },
    });
  });

  it("updates common, dimensions, content and style while removing raw defaults", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: TEXT_OBJECT_ID,
        patch: {
          x: -3,
          width: 240,
          height: 60,
          rotation: -15,
          text: "After\r\n世界",
          fontFamily: "sans-serif",
          pixelSize: 16,
          wrap: false,
          color: "#000000",
          bold: false,
          horizontalAlignment: "left",
        },
      },
    ]);
    await harness.service.applyEdits(edit);

    const object = (await readObjects(harness.root))[0];
    expect(object).toMatchObject({
      x: -3,
      width: 240,
      height: 60,
      rotation: -15,
      text: {
        text: "After\r\n世界",
        italic: true,
        kerning: false,
        valign: "bottom",
      },
      vendorObjectExtension: {
        preserve: true,
      },
    });
    expect(object?.text).not.toHaveProperty("fontfamily");
    expect(object?.text).not.toHaveProperty("pixelsize");
    expect(object?.text).not.toHaveProperty("wrap");
    expect(object?.text).not.toHaveProperty("color");
    expect(object?.text).not.toHaveProperty("bold");
    expect(object?.text).not.toHaveProperty("halign");

    const detail = await harness.service.getObject({
      mapPath: MAP_PATH,
      objectId: TEXT_OBJECT_ID,
    });
    expect(detail.object).toMatchObject({
      shape: "text",
      x: -3,
      width: 240,
      height: 60,
      rotation: -15,
      text: "After\r\n世界",
      fontFamily: "sans-serif",
      pixelSize: 16,
      wrap: false,
      color: "#000000",
      bold: false,
      italic: true,
      kerning: false,
      horizontalAlignment: "left",
      verticalAlignment: "bottom",
    });
  });

  it("preserves raw nested text on common-only update and safely deletes the object", async () => {
    const harness = await createHarness(roots);
    const before = (await readObjects(harness.root))[0];
    if (!isJsonObject(before?.text)) {
      throw new Error(
        "Expected the stored text payload.",
      );
    }
    const rawText = structuredClone(before.text);

    const update = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: TEXT_OBJECT_ID,
        patch: {
          x: 44,
          name: "Common-only update",
        },
      },
    ]);
    await harness.service.applyEdits(update);

    const updated = (await readObjects(harness.root))[0];
    expect(updated).toMatchObject({
      id: TEXT_OBJECT_ID,
      x: 44,
      name: "Common-only update",
    });
    expect(updated?.text).toEqual(rawText);

    const deletion = await plan(harness.service, [
      {
        type: "deleteObjects",
        objectIds: [TEXT_OBJECT_ID],
      },
    ]);
    expect(deletion.summary.deletedObjectIds).toEqual([
      TEXT_OBJECT_ID,
    ]);
    await harness.service.applyEdits(deletion);

    expect(await readObjects(harness.root)).toEqual([]);
    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: TEXT_OBJECT_ID,
      }),
    ).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND",
    });
  });

  it("enforces scalar, control, font and pixel-size bounds before mutation", async () => {
    const harness = await createHarness(roots);
    const exactContent = "🙂".repeat(4_096);
    await expect(
      plan(harness.service, [
        createTextOperation(exactContent),
      ]),
    ).resolves.toMatchObject({
      summary: {
        createdObjectIds: [2],
      },
    });

    for (const invalid of [
      "🙂".repeat(4_097),
      `bad${String.fromCharCode(0)}`,
      String.fromCharCode(0xdc00),
    ]) {
      await expect(
        plan(harness.service, [
          createTextOperation(invalid),
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }

    for (const object of [
      {
        ...createTextOperation("ok").object,
        fontFamily: "",
      },
      {
        ...createTextOperation("ok").object,
        fontFamily: "Bad\tFont",
      },
      {
        ...createTextOperation("ok").object,
        pixelSize: 0,
      },
      {
        ...createTextOperation("ok").object,
        pixelSize: 1_000,
      },
    ]) {
      await expect(
        plan(harness.service, [
          unsafeOperation({
            type: "createObject",
            layerId: OBJECT_LAYER_ID,
            object,
          }),
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  });

  it("enforces the canonical aggregate text-field byte budget", async () => {
    const harness = await createHarness(roots);
    const text = "🙂".repeat(4_096);
    const perOperation =
      measureTextObjectPayloadBytes({ text });
    expect(perOperation * 15).toBeLessThanOrEqual(
      MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
    );
    expect(perOperation * 16).toBeGreaterThan(
      MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
    );

    await expect(
      plan(
        harness.service,
        Array.from({ length: 15 }, () => ({
          type: "updateObject" as const,
          objectId: TEXT_OBJECT_ID,
          patch: { text },
        })),
      ),
    ).resolves.toMatchObject({
      summary: {
        updatedObjectIds: [TEXT_OBJECT_ID],
      },
    });
    await expect(
      plan(
        harness.service,
        Array.from({ length: 16 }, () => ({
          type: "updateObject" as const,
          objectId: TEXT_OBJECT_ID,
          patch: { text },
        })),
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit:
          MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
      },
    });
  });

  it("fails closed for non-text targets and unknown nested text fields", async () => {
    const rectangleMap = baseMap();
    const layer = requireObjectLayer(rectangleMap);
    layer.objects = [
      {
        height: 10,
        id: 1,
        name: "",
        rotation: 0,
        type: "",
        visible: true,
        width: 10,
        x: 0,
        y: 0,
      },
    ];
    const rectangleHarness = await createHarness(
      roots,
      rectangleMap,
    );
    await expect(
      plan(rectangleHarness.service, [
        {
          type: "updateObject",
          objectId: 1,
          patch: { text: "not allowed" },
        },
      ]),
    ).rejects.toMatchObject({
      code: "OBJECT_SHAPE_MISMATCH",
    });

    const malformedMap = baseMap();
    const malformedObjects =
      requireObjectLayer(malformedMap).objects;
    const malformedObject = Array.isArray(
      malformedObjects,
    )
      ? malformedObjects[0]
      : undefined;
    if (!isJsonObject(malformedObject)) {
      throw new Error("Expected the text fixture object.");
    }
    malformedObject.text = {
      text: "Hello",
      futureShadow: true,
    };
    const malformedHarness = await createHarness(
      roots,
      malformedMap,
    );
    await expect(
      malformedHarness.service.getObject({
        mapPath: MAP_PATH,
        objectId: TEXT_OBJECT_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    await expect(
      plan(malformedHarness.service, [
        {
          type: "updateObject",
          objectId: TEXT_OBJECT_ID,
          patch: { x: 2 },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    await expect(
      plan(malformedHarness.service, [
        {
          type: "deleteObjects",
          objectIds: [TEXT_OBJECT_ID],
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });

  it("returns bounded discriminated details for all editable shapes and rejects tile objects", async () => {
    const map = baseMap();
    const layer = requireObjectLayer(map);
    layer.objects = [
      {
        height: 3,
        id: 1,
        name: "",
        rotation: 0,
        type: "",
        visible: true,
        width: 4,
        x: 1,
        y: 2,
      },
      {
        height: 0,
        id: 2,
        name: "",
        point: true,
        rotation: 0,
        type: "",
        visible: true,
        width: 0,
        x: 3,
        y: 4,
      },
      {
        id: 3,
        name: "",
        polygon: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 2, y: 3 },
        ],
        rotation: 0,
        type: "",
        visible: true,
        x: 5,
        y: 6,
      },
      {
        gid: 1,
        height: 16,
        id: 4,
        name: "",
        rotation: 0,
        type: "",
        visible: true,
        width: 16,
        x: 0,
        y: 16,
      },
    ];
    map.nextobjectid = 5;
    const harness = await createHarness(roots, map);

    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      }),
    ).resolves.toMatchObject({
      object: {
        shape: "rectangle",
        width: 4,
        height: 3,
      },
    });
    const point = await harness.service.getObject({
      mapPath: MAP_PATH,
      objectId: 2,
    });
    expect(point.object).toMatchObject({
      shape: "point",
      x: 3,
      y: 4,
    });
    expect(point.object).not.toHaveProperty("width");

    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 3,
      }),
    ).resolves.toMatchObject({
      object: {
        shape: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 2, y: 3 },
        ],
      },
    });
    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 4,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OBJECT_PROFILE",
    });
  });

  it("reports malformed stored text coordinates and dimensions as invalid documents", async () => {
    const malformedProfiles: Array<
      (object: JsonObject) => void
    > = [
      (object) => {
        delete object.x;
      },
      (object) => {
        object.width = -1;
      },
    ];

    for (const mutate of malformedProfiles) {
      const map = baseMap();
      const objects = requireObjectLayer(map).objects;
      const object = Array.isArray(objects)
        ? objects[0]
        : undefined;
      if (!isJsonObject(object)) {
        throw new Error(
          "Expected the stored text fixture.",
        );
      }
      mutate(object);
      const harness = await createHarness(roots, map);
      await expect(
        harness.service.getObject({
          mapPath: MAP_PATH,
          objectId: TEXT_OBJECT_ID,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_DOCUMENT",
        details: {
          path: MAP_PATH,
          objectId: TEXT_OBJECT_ID,
        },
      });
    }
  });

  it("bounds getObject display strings by Unicode code points", async () => {
    const map = baseMap();
    const layer = requireObjectLayer(map);
    layer.name = "🧭".repeat(
      MAX_OBJECT_DISPLAY_STRING_LENGTH + 1,
    );
    const objects = layer.objects;
    const object = Array.isArray(objects)
      ? objects[0]
      : undefined;
    if (!isJsonObject(object)) {
      throw new Error(
        "Expected the stored text fixture.",
      );
    }
    object.name = "🙂".repeat(
      MAX_OBJECT_DISPLAY_STRING_LENGTH,
    );
    object.type = "🚀".repeat(
      MAX_OBJECT_DISPLAY_STRING_LENGTH + 1,
    );
    const harness = await createHarness(roots, map);

    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: TEXT_OBJECT_ID,
      }),
    ).resolves.toMatchObject({
      object: {
        layerName: "🧭".repeat(
          MAX_OBJECT_DISPLAY_STRING_LENGTH,
        ),
        layerNameTruncated: true,
        name: "🙂".repeat(
          MAX_OBJECT_DISPLAY_STRING_LENGTH,
        ),
        className: "🚀".repeat(
          MAX_OBJECT_DISPLAY_STRING_LENGTH,
        ),
        classNameTruncated: true,
      },
    });
    const detail = await harness.service.getObject({
      mapPath: MAP_PATH,
      objectId: TEXT_OBJECT_ID,
    });
    expect(detail.object).not.toHaveProperty(
      "nameTruncated",
    );
  });
});

async function createHarness(
  roots: Set<string>,
  map: JsonObject = baseMap(),
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-text-objects-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(map),
  );
  const resolver = await ProjectPathResolver.create(root);
  return {
    root,
    service: new MapService(
      resolver,
      new DocumentStore(resolver),
    ),
  };
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 4,
    infinite: false,
    layers: [
      {
        id: OBJECT_LAYER_ID,
        name: "Text Objects",
        objects: [
          {
            height: 40,
            id: TEXT_OBJECT_ID,
            name: "Existing",
            rotation: 5,
            text: {
              bold: true,
              color: "#80112233",
              fontfamily: "Mono",
              halign: "right",
              italic: true,
              kerning: false,
              pixelsize: 24,
              text: "Before",
              valign: "bottom",
              wrap: true,
            },
            type: "Note",
            vendorObjectExtension: {
              preserve: true,
            },
            visible: true,
            width: 120,
            x: 8,
            y: 9,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
      },
    ],
    nextlayerid: 8,
    nextobjectid: 2,
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

function createTextOperation(
  text: string,
): Extract<
  MapEditOperation,
  { type: "createObject" }
> {
  return {
    type: "createObject",
    layerId: OBJECT_LAYER_ID,
    object: {
      shape: "text",
      x: 0,
      y: 0,
      text,
    },
  };
}

async function plan(
  service: MapService,
  operations: readonly MapEditOperation[],
): Promise<MapEditPlan> {
  const snapshot = await mapSnapshot(service);
  return service.planEdits(
    MAP_PATH,
    snapshot.revision,
    snapshot.dependencies,
    operations,
  );
}

async function mapSnapshot(
  service: MapService,
): Promise<MapSnapshot> {
  const summary = await service.getSummary(MAP_PATH);
  return {
    revision: summary.revision as string,
    dependencies:
      summary.dependencyRevisions as Record<string, string>,
  };
}

async function readObjects(
  root: string,
): Promise<JsonObject[]> {
  const source = await readFile(
    join(root, MAP_PATH),
    "utf8",
  );
  const map = JSON.parse(source) as JsonObject;
  return requireObjectLayer(map).objects as JsonObject[];
}

function requireObjectLayer(map: JsonObject): JsonObject {
  const layers = map.layers;
  if (!Array.isArray(layers)) {
    throw new Error("Expected layers.");
  }
  const layer = layers.find(
    (candidate) =>
      isJsonObject(candidate) &&
      candidate.id === OBJECT_LAYER_ID,
  );
  if (!isJsonObject(layer) || !Array.isArray(layer.objects)) {
    throw new Error("Expected the object layer.");
  }
  return layer;
}

function isJsonObject(
  value: unknown,
): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function unsafeOperation(
  operation: unknown,
): MapEditOperation {
  return operation as MapEditOperation;
}
