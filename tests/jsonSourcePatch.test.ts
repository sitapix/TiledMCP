import { describe, expect, it } from "vitest";

import {
  patchJsonDocumentSource,
  type JsonArrayDeletion,
  type JsonArrayMove,
  type JsonObjectMemberPatch,
  type JsonSourcePath,
} from "../src/formats/jsonSourcePatch.js";
import {
  cloneJson,
  parseJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";

describe("patchJsonDocumentSource", () => {
  it("replaces only a tile data range and preserves surrounding source lexemes", () => {
    const source = [
      "{\r\n",
      "\t\"type\" : \"map\",\r\n",
      "\t\"opacity\" : 1.00e+0,\r\n",
      "\t\"layers\" : [\r\n",
      "\t\t{ \"id\": 7, \"type\": \"tilelayer\", \"data\" : [ 0, 0, 0, 0 ], \"custom\": \"\\u0078\" }\r\n",
      "\t]\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(parseJsonDocument(source, "maps/odd.tmj"));
    const layer = (target.layers as JsonObject[])[0] as JsonObject;
    layer.data = [1, 2, 3, 4];

    const result = patchJsonDocumentSource(
      Buffer.from(source, "utf8"),
      target,
      [["layers", 0, "data"]],
      "maps/odd.tmj",
    );

    const expected = source.replace("[ 0, 0, 0, 0 ]", "[1,2,3,4]");
    expect(result.equals(Buffer.from(expected, "utf8"))).toBe(true);
    expect(result.toString("utf8")).toContain("\"opacity\" : 1.00e+0");
    expect(result.toString("utf8")).toContain("\"custom\": \"\\u0078\"");
    expect(result.toString("utf8").match(/\r\n/g)?.length).toBe(7);
  });

  it("patches nested group tile layers while preserving a UTF-8 BOM", () => {
    const source = [
      "\uFEFF{\r\n",
      "    \"type\": \"map\",\r\n",
      "    \"version\": 1.10,\r\n",
      "    \"layers\": [{\r\n",
      "      \"id\": 1,\r\n",
      "      \"type\": \"group\",\r\n",
      "      \"layers\": [\r\n",
      "        { \"id\": 2, \"type\": \"tilelayer\", \"data\": [0, 0] },\r\n",
      "        { \"id\": 3, \"type\": \"tilelayer\", \"data\": [9, 9] }\r\n",
      "      ]\r\n",
      "    }]\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(parseJsonDocument(source, "nested.tmj"));
    const group = (target.layers as JsonObject[])[0] as JsonObject;
    const layers = group.layers as JsonObject[];
    (layers[0] as JsonObject).data = [4, 5];
    (layers[1] as JsonObject).data = [6, 7];
    const paths: JsonSourcePath[] = [
      ["layers", 0, "layers", 0, "data"],
      ["layers", 0, "layers", 1, "data"],
    ];

    const result = patchJsonDocumentSource(source, target, paths, "nested.tmj");

    expect([...result.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(result.toString("utf8")).toBe(
      source.replace("[0, 0]", "[4,5]").replace("[9, 9]", "[6,7]"),
    );
    expect(parseJsonDocument(result.toString("utf8"), "nested.tmj")).toEqual(target);
  });

  it("inserts one array element without rewriting existing sibling lexemes", () => {
    const source = [
      "\uFEFF{\r\n",
      "  \"nextlayerid\" : 3.0,\r\n",
      "  \"layers\" : [\r\n",
      "    { \"id\" : 1, \"name\" : \"\\u0041\", \"type\" : \"group\", \"layers\" : [] },\r\n",
      "    {\"id\":2,\"name\":\"B\",\"type\":\"objectgroup\",\"objects\":[]}\r\n",
      "  ]\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(parseJsonDocument(source, "maps/odd.tmj"));
    const layers = target.layers as JsonObject[];
    layers.splice(1, 0, {
      id: 3,
      name: "Inserted",
      type: "group",
      layers: [],
    });
    target.nextlayerid = 4;

    const result = patchJsonDocumentSource(
      source,
      target,
      [["nextlayerid"]],
      "maps/odd.tmj",
      [{ path: ["layers"], index: 1 }],
    );
    const text = result.toString("utf8");

    expect([...result.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toContain(
      '{ "id" : 1, "name" : "\\u0041", "type" : "group", "layers" : [] }',
    );
    expect(text).toContain(
      '{"id":2,"name":"B","type":"objectgroup","objects":[]}',
    );
    expect(text).toContain(
      '{"id":3,"name":"Inserted","type":"group","layers":[]},',
    );
    expect(text).toContain('"nextlayerid" : 4');
    expect(parseJsonDocument(text, "maps/odd.tmj")).toEqual(target);
  });

  it("inserts into an empty nested array and rejects disguised sibling changes", () => {
    const source =
      '{"nextlayerid":2,"layers":[{"id":1,"type":"group","layers":[]}]}';
    const target = cloneJson(parseJsonDocument(source, "nested.tmj"));
    const group = (target.layers as JsonObject[])[0] as JsonObject;
    group.layers = [{ id: 2, name: "Child", type: "objectgroup", objects: [] }];
    target.nextlayerid = 3;

    const result = patchJsonDocumentSource(
      source,
      target,
      [["nextlayerid"]],
      "nested.tmj",
      [{ path: ["layers", 0, "layers"], index: 0 }],
    );
    expect(result.toString("utf8")).toBe(
      '{"nextlayerid":3,"layers":[{"id":1,"type":"group","layers":[{"id":2,"name":"Child","type":"objectgroup","objects":[]}]}]}',
    );

    const changedSibling = cloneJson(target);
    ((changedSibling.layers as JsonObject[])[0] as JsonObject).id = 99;
    expect(() =>
      patchJsonDocumentSource(
        source,
        changedSibling,
        [["nextlayerid"]],
        "nested.tmj",
        [{ path: ["layers", 0, "layers"], index: 0 }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_MISMATCH",
      }),
    );
  });

  it.each([
    { label: "prepends", index: 0 },
    { label: "appends", index: 2 },
  ])("$label without rewriting existing array elements", ({ index }) => {
    const source =
      '{"nextlayerid":3.0,"layers":[{"id":1.0e+0},{"id":2.00}]}';
    const target = cloneJson(parseJsonDocument(source, "ordered.tmj"));
    (target.layers as JsonObject[]).splice(index, 0, {
      id: 3,
      name: "New",
      type: "group",
      layers: [],
    });
    target.nextlayerid = 4;

    const result = patchJsonDocumentSource(
      source,
      target,
      [["nextlayerid"]],
      "ordered.tmj",
      [{ path: ["layers"], index }],
    );
    const text = result.toString("utf8");

    expect(text).toContain('{"id":1.0e+0}');
    expect(text).toContain('{"id":2.00}');
    expect(parseJsonDocument(text, "ordered.tmj")).toEqual(target);
  });

  it.each([
    {
      label: "first",
      index: 0,
      expected:
        '{"items":[2e0, 3.000],"keep":"\\u0078"}',
    },
    {
      label: "middle",
      index: 1,
      expected:
        '{"items":[1.00, 3.000],"keep":"\\u0078"}',
    },
    {
      label: "last",
      index: 2,
      expected:
        '{"items":[1.00, 2e0],"keep":"\\u0078"}',
    },
  ])("deletes the $label array element without rewriting siblings", ({
    index,
    expected,
  }) => {
    const source =
      '{"items":[1.00, 2e0, 3.000],"keep":"\\u0078"}';
    const target = cloneJson(
      parseJsonDocument(source, "array-delete.tmj"),
    );
    (target.items as number[]).splice(index, 1);

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "array-delete.tmj",
      [],
      [],
      [{ path: ["items"], index }],
    );

    expect(result.toString("utf8")).toBe(expected);
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "array-delete.tmj",
      ),
    ).toEqual(target);
  });

  it("deletes the only element of a nested multiline array while preserving BOM and CRLF", () => {
    const source = [
      "\uFEFF{\r\n",
      "  \"outer\": [{\r\n",
      "    \"values\": [\r\n",
      "      1.00\r\n",
      "    ],\r\n",
      "    \"keep\": \"\\u0078\"\r\n",
      "  }]\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(
      parseJsonDocument(
        source,
        "nested-array-delete.tmj",
      ),
    );
    const outer = target.outer as JsonObject[];
    (outer[0]?.values as number[]).splice(0, 1);

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "nested-array-delete.tmj",
      [],
      [],
      [
        {
          path: ["outer", 0, "values"],
          index: 0,
        },
      ],
    );
    const text = result.toString("utf8");

    expect(text).toBe(
      [
        "\uFEFF{\r\n",
        "  \"outer\": [{\r\n",
        "    \"values\": [\r\n",
        "      \r\n",
        "    ],\r\n",
        "    \"keep\": \"\\u0078\"\r\n",
        "  }]\r\n",
        "}\r\n",
      ].join(""),
    );
    expect(
      parseJsonDocument(
        text,
        "nested-array-delete.tmj",
      ),
    ).toEqual(target);
  });

  it("batches multiple source-index deletions from one array", () => {
    const source =
      '{"items":[0.0, 1.0, 2.0, 3.0, 4.0, 5.0],"keep":true}';
    const target = cloneJson(
      parseJsonDocument(
        source,
        "multi-array-delete.tmj",
      ),
    );
    target.items = [0, 2, 5];
    const deletions: JsonArrayDeletion[] = [
      { path: ["items"], index: 4 },
      { path: ["items"], index: 1 },
      { path: ["items"], index: 3 },
    ];

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "multi-array-delete.tmj",
      [],
      [],
      deletions,
    );

    expect(result.toString("utf8")).toBe(
      '{"items":[0.0, 2.0, 5.0],"keep":true}',
    );
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "multi-array-delete.tmj",
      ),
    ).toEqual(target);
  });

  it("combines a deletion with sibling value, insertion, and object-member patches", () => {
    const source = [
      '{"meta":{"name":"old"},',
      '"remove":[1.0, 2.0],',
      '"insert":[3.0],',
      '"counter":1.00}',
    ].join("");
    const target = cloneJson(
      parseJsonDocument(
        source,
        "combined-array-delete.tmj",
      ),
    );
    (target.meta as JsonObject).name = "new";
    (target.remove as number[]).splice(0, 1);
    (target.insert as number[]).push(4);
    target.counter = 2;

    const result = patchJsonDocumentSource(
      source,
      target,
      [["counter"]],
      "combined-array-delete.tmj",
      [{ path: ["insert"], index: 1 }],
      [{ path: ["meta"], key: "name" }],
      [{ path: ["remove"], index: 0 }],
    );
    const text = result.toString("utf8");

    expect(text).toBe(
      [
        '{"meta":{"name":"new"},',
        '"remove":[2.0],',
        '"insert":[3.0,4],',
        '"counter":2}',
      ].join(""),
    );
    expect(
      parseJsonDocument(
        text,
        "combined-array-delete.tmj",
      ),
    ).toEqual(target);
  });

  it("strictly rejects invalid or ambiguous array deletions", () => {
    const source =
      '{"items":[1,2,3],"nested":[[1,2]],"object":{}}';
    const unchanged = parseJsonDocument(
      source,
      "invalid-array-delete.tmj",
    );
    const deletedMiddle = cloneJson(unchanged);
    (deletedMiddle.items as number[]).splice(1, 1);
    const deletion: JsonArrayDeletion = {
      path: ["items"],
      index: 1,
    };

    expect(() =>
      patchJsonDocumentSource(
        source,
        deletedMiddle,
        [],
        "invalid-array-delete.tmj",
        [],
        [],
        [deletion, deletion],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_DUPLICATE_PATH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        deletedMiddle,
        [],
        "invalid-array-delete.tmj",
        [],
        [],
        [{ path: ["items"], index: 9 }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_DELETION_MISMATCH",
      }),
    );

    const wrongTarget = cloneJson(unchanged);
    (wrongTarget.items as number[]).splice(0, 1);
    expect(() =>
      patchJsonDocumentSource(
        source,
        wrongTarget,
        [],
        "invalid-array-delete.tmj",
        [],
        [],
        [deletion],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_DELETION_MISMATCH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        unchanged,
        [],
        "invalid-array-delete.tmj",
        [],
        [],
        [{ path: ["object"], index: 0 }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_DELETION_MISMATCH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        deletedMiddle,
        [["items", 0]],
        "invalid-array-delete.tmj",
        [],
        [],
        [deletion],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        deletedMiddle,
        [],
        "invalid-array-delete.tmj",
        [{ path: ["items"], index: 0 }],
        [],
        [deletion],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        deletedMiddle,
        [],
        "invalid-array-delete.tmj",
        [],
        [{ path: [], key: "items" }],
        [deletion],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        unchanged,
        [],
        "invalid-array-delete.tmj",
        [],
        [],
        [
          { path: ["nested"], index: 0 },
          { path: ["nested", 0], index: 0 },
        ],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );
  });

  it.each([
    {
      label: "first to last",
      sourceIndex: 0,
      targetIndex: 3,
      expected:
        '{"items":[1e0, 2.00, 3.000, 0.0],"keep":"\\u0078"}',
    },
    {
      label: "last to first",
      sourceIndex: 3,
      targetIndex: 0,
      expected:
        '{"items":[3.000, 0.0, 1e0, 2.00],"keep":"\\u0078"}',
    },
    {
      label: "adjacent forward",
      sourceIndex: 1,
      targetIndex: 2,
      expected:
        '{"items":[0.0, 2.00, 1e0, 3.000],"keep":"\\u0078"}',
    },
    {
      label: "adjacent backward",
      sourceIndex: 2,
      targetIndex: 1,
      expected:
        '{"items":[0.0, 2.00, 1e0, 3.000],"keep":"\\u0078"}',
    },
  ])("moves an element $label within one compact array", ({
    sourceIndex,
    targetIndex,
    expected,
  }) => {
    const source =
      '{"items":[0.0, 1e0, 2.00, 3.000],"keep":"\\u0078"}';
    const target = cloneJson(
      parseJsonDocument(source, "same-array-move.tmj"),
    );
    const items = target.items as number[];
    const [moved] = items.splice(sourceIndex, 1);
    if (moved === undefined) {
      throw new Error("Expected a moved fixture value.");
    }
    items.splice(targetIndex, 0, moved);

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "same-array-move.tmj",
      [],
      [],
      [],
      [
        {
          sourcePath: ["items"],
          sourceIndex,
          targetPath: ["items"],
          targetIndex,
        },
      ],
    );

    expect(result.toString("utf8")).toBe(expected);
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "same-array-move.tmj",
      ),
    ).toEqual(target);
  });

  it("treats a same-position array move as an exact no-op", () => {
    const source = Buffer.from(
      '\uFEFF{\r\n  "items" : [ 1.00, 2e0 ]\r\n}\r\n',
      "utf8",
    );
    const target = parseJsonDocument(
      source.toString("utf8"),
      "no-op-array-move.tmj",
    );

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "no-op-array-move.tmj",
      [],
      [],
      [],
      [
        {
          sourcePath: ["items"],
          sourceIndex: 1,
          targetPath: ["items"],
          targetIndex: 1,
        },
      ],
    );

    expect(result.equals(source)).toBe(true);
  });

  it("moves an exact element from a single-element array into an empty array", () => {
    const source =
      '{"from":[{"raw":1.00}],"to":[],"keep":"\\u0078"}';
    const target = cloneJson(
      parseJsonDocument(
        source,
        "cross-array-move.tmj",
      ),
    );
    const [moved] = (
      target.from as JsonObject[]
    ).splice(0, 1);
    if (moved === undefined) {
      throw new Error("Expected a moved fixture object.");
    }
    (target.to as JsonObject[]).splice(0, 0, moved);

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "cross-array-move.tmj",
      [],
      [],
      [],
      [
        {
          sourcePath: ["from"],
          sourceIndex: 0,
          targetPath: ["to"],
          targetIndex: 0,
        },
      ],
    );

    expect(result.toString("utf8")).toBe(
      '{"from":[],"to":[{"raw":1.00}],"keep":"\\u0078"}',
    );
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "cross-array-move.tmj",
      ),
    ).toEqual(target);
  });

  it("moves a root sibling into a later Group using source-snapshot paths", () => {
    const source = [
      "\uFEFF{\r\n",
      "  \"layers\": [\r\n",
      "    { \"id\" : 1.00, \"name\" : \"\\u004dove\" },\r\n",
      "    { \"id\" : 2e0 },\r\n",
      "    {\r\n",
      "      \"id\": 3,\r\n",
      "      \"type\": \"group\",\r\n",
      "      \"layers\": [\r\n",
      "        { \"id\" : 4.000 }\r\n",
      "      ]\r\n",
      "    }\r\n",
      "  ],\r\n",
      "  \"keep\": \"\\u0078\"\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(
      parseJsonDocument(
        source,
        "root-into-group.tmj",
      ),
    );
    const layers = target.layers as JsonObject[];
    const group = layers[2] as JsonObject;
    const [moved] = layers.splice(0, 1);
    if (moved === undefined) {
      throw new Error("Expected the root layer fixture.");
    }
    (group.layers as JsonObject[]).splice(
      1,
      0,
      moved,
    );

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "root-into-group.tmj",
      [],
      [],
      [],
      [
        {
          sourcePath: ["layers"],
          sourceIndex: 0,
          targetPath: ["layers", 2, "layers"],
          targetIndex: 1,
        },
      ],
    );
    const text = result.toString("utf8");

    expect(text).toContain(
      '{ "id" : 1.00, "name" : "\\u004dove" }',
    );
    expect(text).toContain('"keep": "\\u0078"');
    expect(
      parseJsonDocument(
        text,
        "root-into-group.tmj",
      ),
    ).toEqual(target);
    expect(text).toBe(
      [
        "\uFEFF{\r\n",
        "  \"layers\": [\r\n",
        "    { \"id\" : 2e0 },\r\n",
        "    {\r\n",
        "      \"id\": 3,\r\n",
        "      \"type\": \"group\",\r\n",
        "      \"layers\": [\r\n",
        "        { \"id\" : 4.000 },\r\n",
        "        { \"id\" : 1.00, \"name\" : \"\\u004dove\" }\r\n",
        "      ]\r\n",
        "    }\r\n",
        "  ],\r\n",
        "  \"keep\": \"\\u0078\"\r\n",
        "}\r\n",
      ].join(""),
    );
  });

  it("moves a Group child to an earlier root index using source-snapshot paths", () => {
    const source =
      '{"layers":[{"id":1.00},{"id":2e0},{"id":3,"layers":[{"id":4.0},{"id":5.00}]}],"keep":"\\u0078"}';
    const target = cloneJson(
      parseJsonDocument(
        source,
        "group-into-root.tmj",
      ),
    );
    const layers = target.layers as JsonObject[];
    const group = layers[2] as JsonObject;
    const [moved] = (
      group.layers as JsonObject[]
    ).splice(1, 1);
    if (moved === undefined) {
      throw new Error("Expected the child layer fixture.");
    }
    layers.splice(1, 0, moved);

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "group-into-root.tmj",
      [],
      [],
      [],
      [
        {
          sourcePath: ["layers", 2, "layers"],
          sourceIndex: 1,
          targetPath: ["layers"],
          targetIndex: 1,
        },
      ],
    );

    expect(result.toString("utf8")).toBe(
      '{"layers":[{"id":1.00},{"id":5.00},{"id":2e0},{"id":3,"layers":[{"id":4.0}]}],"keep":"\\u0078"}',
    );
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "group-into-root.tmj",
      ),
    ).toEqual(target);
  });

  it("combines a move with non-overlapping sibling patch primitives", () => {
    const source =
      '{"from":[1.0,2.0],"to":[3.0],"remove":[4,5],"insert":[6],"meta":{"name":"old"},"counter":1.00}';
    const target = cloneJson(
      parseJsonDocument(
        source,
        "combined-array-move.tmj",
      ),
    );
    const [moved] = (
      target.from as number[]
    ).splice(1, 1);
    if (moved === undefined) {
      throw new Error("Expected the moved number fixture.");
    }
    (target.to as number[]).splice(0, 0, moved);
    (target.remove as number[]).splice(0, 1);
    (target.insert as number[]).push(7);
    (target.meta as JsonObject).name = "new";
    target.counter = 2;

    const result = patchJsonDocumentSource(
      source,
      target,
      [["counter"]],
      "combined-array-move.tmj",
      [{ path: ["insert"], index: 1 }],
      [{ path: ["meta"], key: "name" }],
      [{ path: ["remove"], index: 0 }],
      [
        {
          sourcePath: ["from"],
          sourceIndex: 1,
          targetPath: ["to"],
          targetIndex: 0,
        },
      ],
    );

    expect(result.toString("utf8")).toBe(
      '{"from":[1.0],"to":[2.0,3.0],"remove":[5],"insert":[6,7],"meta":{"name":"new"},"counter":2}',
    );
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "combined-array-move.tmj",
      ),
    ).toEqual(target);
  });

  it("strictly rejects invalid, ambiguous, overlapping, or mismatched array moves", () => {
    const source =
      '{"from":[1,2],"to":[3],"nested":[{"children":[4]}],"meta":{"name":"old"},"other":[5,6]}';
    const unchanged = parseJsonDocument(
      source,
      "invalid-array-move.tmj",
    );
    const movedTarget = cloneJson(unchanged);
    const [moved] = (
      movedTarget.from as number[]
    ).splice(0, 1);
    if (moved === undefined) {
      throw new Error("Expected an invalid-test fixture.");
    }
    (movedTarget.to as number[]).splice(1, 0, moved);
    const move: JsonArrayMove = {
      sourcePath: ["from"],
      sourceIndex: 0,
      targetPath: ["to"],
      targetIndex: 1,
    };

    expect(() =>
      patchJsonDocumentSource(
        source,
        movedTarget,
        [],
        "invalid-array-move.tmj",
        [],
        [],
        [],
        [move, move],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_DUPLICATE_PATH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        movedTarget,
        [],
        "invalid-array-move.tmj",
        [],
        [],
        [],
        [
          move,
          {
            sourcePath: ["other"],
            sourceIndex: 0,
            targetPath: ["to"],
            targetIndex: 0,
          },
        ],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_MOVE_MISMATCH",
      }),
    );

    for (const invalidMove of [
      { ...move, sourceIndex: 9 },
      { ...move, targetIndex: 9 },
    ]) {
      expect(() =>
        patchJsonDocumentSource(
          source,
          movedTarget,
          [],
          "invalid-array-move.tmj",
          [],
          [],
          [],
          [invalidMove],
        ),
      ).toThrow(
        expect.objectContaining({
          code: "JSON_SOURCE_PATCH_MOVE_MISMATCH",
        }),
      );
    }

    const wrongTarget = cloneJson(unchanged);
    (wrongTarget.from as number[]).splice(0, 1);
    (wrongTarget.to as number[]).splice(0, 0, 99);
    expect(() =>
      patchJsonDocumentSource(
        source,
        wrongTarget,
        [],
        "invalid-array-move.tmj",
        [],
        [],
        [],
        [move],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_MOVE_MISMATCH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        unchanged,
        [],
        "invalid-array-move.tmj",
        [],
        [],
        [],
        [
          {
            sourcePath: ["nested"],
            sourceIndex: 0,
            targetPath: [
              "nested",
              0,
              "children",
            ],
            targetIndex: 0,
          },
        ],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );

    for (const invocation of [
      () =>
        patchJsonDocumentSource(
          source,
          movedTarget,
          [["from", 1]],
          "invalid-array-move.tmj",
          [],
          [],
          [],
          [move],
        ),
      () =>
        patchJsonDocumentSource(
          source,
          movedTarget,
          [],
          "invalid-array-move.tmj",
          [{ path: ["to"], index: 0 }],
          [],
          [],
          [move],
        ),
      () =>
        patchJsonDocumentSource(
          source,
          movedTarget,
          [],
          "invalid-array-move.tmj",
          [],
          [{ path: [], key: "from" }],
          [],
          [move],
        ),
      () =>
        patchJsonDocumentSource(
          source,
          movedTarget,
          [],
          "invalid-array-move.tmj",
          [],
          [],
          [{ path: ["to"], index: 0 }],
          [move],
        ),
    ]) {
      expect(invocation).toThrow(
        expect.objectContaining({
          code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
        }),
      );
    }

    const changedNoOp = cloneJson(unchanged);
    (changedNoOp.from as number[])[0] = 99;
    expect(() =>
      patchJsonDocumentSource(
        source,
        changedNoOp,
        [],
        "invalid-array-move.tmj",
        [],
        [],
        [],
        [
          {
            sourcePath: ["from"],
            sourceIndex: 0,
            targetPath: ["from"],
            targetIndex: 0,
          },
        ],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_MOVE_MISMATCH",
      }),
    );
  });

  it("rejects duplicate patch paths", () => {
    const source = '{"layers":[{"data":[0]}]}';
    const target = parseJsonDocument(source, "map.tmj");
    const path: JsonSourcePath = ["layers", 0, "data"];

    expect(() =>
      patchJsonDocumentSource(source, target, [path, path], "map.tmj"),
    ).toThrow(
      expect.objectContaining({ code: "JSON_SOURCE_PATCH_DUPLICATE_PATH" }),
    );
  });

  it("rejects overlapping parent and child patch ranges", () => {
    const source = '{"outer":{"value":1,"keep":true}}';
    const target = cloneJson(parseJsonDocument(source, "map.tmj"));
    (target.outer as JsonObject).value = 2;

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [["outer"], ["outer", "value"]],
        "map.tmj",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );
  });

  it("rejects paths missing from either source or target", () => {
    const source = '{"layers":[{"data":[0]}],"nextobjectid":2}';
    const target = parseJsonDocument(source, "map.tmj");

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [["layers", 1, "data"]],
        "map.tmj",
      ),
    ).toThrow(expect.objectContaining({ code: "JSON_SOURCE_PATCH_PATH_NOT_FOUND" }));

    const targetWithoutCounter = cloneJson(target);
    delete targetWithoutCounter.nextobjectid;
    expect(() =>
      patchJsonDocumentSource(
        source,
        targetWithoutCounter,
        [["nextobjectid"]],
        "map.tmj",
      ),
    ).toThrow(expect.objectContaining({ code: "JSON_SOURCE_PATCH_PATH_NOT_FOUND" }));
  });

  it("rejects a target change that was not covered by the supplied paths", () => {
    const source = '{"width":1,"layers":[{"data":[0]}]}';
    const target = cloneJson(parseJsonDocument(source, "map.tmj"));
    target.width = 2;
    ((target.layers as JsonObject[])[0] as JsonObject).data = [8];

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [["layers", 0, "data"]],
        "map.tmj",
      ),
    ).toThrow(expect.objectContaining({ code: "JSON_SOURCE_PATCH_MISMATCH" }));
  });

  it("retains the original bytes when selected values are unchanged", () => {
    const source = Buffer.from(
      "\uFEFF{\r\n  \"layers\": [{\"data\": [ 1, 2 ]}],\r\n  \"scale\": 1.0\r\n}\r\n",
      "utf8",
    );
    const target = parseJsonDocument(source.toString("utf8"), "map.tmj");

    const result = patchJsonDocumentSource(
      source,
      target,
      [["layers", 0, "data"]],
      "map.tmj",
    );

    expect(result.equals(source)).toBe(true);
  });

  it("sets and replaces object members alongside an existing value patch", () => {
    const source = [
      "\uFEFF{\r\n",
      "  \"layers\" : [{\r\n",
      "    \"\\u006eame\" : \"Old\",\r\n",
      "    \"data\" : [ 0, 0 ]\r\n",
      "  }],\r\n",
      "  \"scale\" : 1.00\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(
      parseJsonDocument(source, "maps/members.tmj"),
    );
    const layer = (
      target.layers as JsonObject[]
    )[0] as JsonObject;
    layer.name = "New";
    layer.data = [7, 8];
    layer.visible = false;

    const result = patchJsonDocumentSource(
      source,
      target,
      [["layers", 0, "data"]],
      "maps/members.tmj",
      [],
      [
        { path: ["layers", 0], key: "name" },
        { path: ["layers", 0], key: "visible" },
      ],
    );
    const text = result.toString("utf8");

    expect([...result.subarray(0, 3)]).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    expect(text).toBe(
      source
        .replace('"Old"', '"New"')
        .replace("[ 0, 0 ]", "[7,8]")
        .replace(
          '    "data" : [7,8]\r\n',
          '    "data" : [7,8],\r\n    "visible" : false\r\n',
        ),
    );
    expect(text).toContain('"\\u006eame" : "New"');
    expect(text).toContain('"scale" : 1.00');
    expect(
      parseJsonDocument(text, "maps/members.tmj"),
    ).toEqual(target);
  });

  it.each([
    {
      label: "first",
      key: "a",
      expected:
        '{"obj":{"b":2, "c":3},"keep":1.00}',
    },
    {
      label: "middle",
      key: "b",
      expected:
        '{"obj":{"a":1, "c":3},"keep":1.00}',
    },
    {
      label: "last",
      key: "c",
      expected:
        '{"obj":{"a":1, "b":2},"keep":1.00}',
    },
  ])("deletes a $label object member without damaging commas", ({
    key,
    expected,
  }) => {
    const source =
      '{"obj":{"a":1, "b":2, "c":3},"keep":1.00}';
    const target = cloneJson(
      parseJsonDocument(source, "members.tmj"),
    );
    delete (target.obj as JsonObject)[key];

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "members.tmj",
      [],
      [{ path: ["obj"], key }],
    );

    expect(result.toString("utf8")).toBe(expected);
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "members.tmj",
      ),
    ).toEqual(target);
  });

  it("deletes a single member and supports multiple structural changes to one object", () => {
    const singleSource =
      '{\r\n  "obj": {\r\n    "only" : 1\r\n  }\r\n}\r\n';
    const singleTarget = cloneJson(
      parseJsonDocument(
        singleSource,
        "single-member.tmj",
      ),
    );
    delete (
      singleTarget.obj as JsonObject
    ).only;

    const singleResult = patchJsonDocumentSource(
      singleSource,
      singleTarget,
      [],
      "single-member.tmj",
      [],
      [{ path: ["obj"], key: "only" }],
    );
    expect(singleResult.toString("utf8")).toBe(
      '{\r\n  "obj": {\r\n    \r\n  }\r\n}\r\n',
    );
    expect(
      parseJsonDocument(
        singleResult.toString("utf8"),
        "single-member.tmj",
      ),
    ).toEqual(singleTarget);

    const source =
      '{"obj":{"old":1,"keep" : 2,"drop":3}}';
    const target = cloneJson(
      parseJsonDocument(source, "multi-member.tmj"),
    );
    const object = target.obj as JsonObject;
    delete object.old;
    delete object.drop;
    object.added = 3;

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "multi-member.tmj",
      [],
      [
        { path: ["obj"], key: "old" },
        { path: ["obj"], key: "drop" },
        { path: ["obj"], key: "added" },
      ],
    );
    expect(result.toString("utf8")).toBe(
      '{"obj":{"keep" : 2,"added" : 3}}',
    );
    expect(
      parseJsonDocument(
        result.toString("utf8"),
        "multi-member.tmj",
      ),
    ).toEqual(target);
  });

  it("inserts into formatted and compact empty objects while preserving BOM and CRLF", () => {
    const source = [
      "\uFEFF{\r\n",
      "  \"formatted\" : {\r\n",
      "  },\r\n",
      "  \"compact\": {}\r\n",
      "}\r\n",
    ].join("");
    const target = cloneJson(
      parseJsonDocument(source, "empty-objects.tmj"),
    );
    (target.formatted as JsonObject).nested = {
      enabled: true,
    };
    (target.compact as JsonObject).value = 2;

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "empty-objects.tmj",
      [],
      [
        { path: ["formatted"], key: "nested" },
        { path: ["compact"], key: "value" },
      ],
    );
    const text = result.toString("utf8");

    expect(text).toBe(
      [
        "\uFEFF{\r\n",
        "  \"formatted\" : {\r\n",
        "    \"nested\": {\"enabled\":true}\r\n",
        "  },\r\n",
        "  \"compact\": {\"value\":2}\r\n",
        "}\r\n",
      ].join(""),
    );
    expect(
      parseJsonDocument(text, "empty-objects.tmj"),
    ).toEqual(target);
  });

  it("batches 128 member patches without repeatedly processing a large unrelated payload", () => {
    const payload = "x".repeat(2 * 1024 * 1024);
    const members = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `existing${index.toString().padStart(2, "0")}`,
        index,
      ]),
    ) as JsonObject;
    const source = [
      `{"payload":${JSON.stringify(payload)},`,
      `"members":${JSON.stringify(members)},`,
      '"tail":1.00}',
    ].join("");
    const target = cloneJson(
      parseJsonDocument(source, "large-members.tmj"),
    );
    const targetMembers = target.members as JsonObject;
    const patches: JsonObjectMemberPatch[] = [];
    for (let index = 0; index < 32; index += 1) {
      const key =
        `existing${index.toString().padStart(2, "0")}`;
      targetMembers[key] = index + 1_000;
      patches.push({ path: ["members"], key });
    }
    for (let index = 32; index < 64; index += 1) {
      const key =
        `existing${index.toString().padStart(2, "0")}`;
      delete targetMembers[key];
      patches.push({ path: ["members"], key });
    }
    for (let index = 0; index < 64; index += 1) {
      const key =
        `inserted${index.toString().padStart(2, "0")}`;
      targetMembers[key] = index;
      patches.push({ path: ["members"], key });
    }

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "large-members.tmj",
      [],
      patches,
    );
    const text = result.toString("utf8");
    const memberMarker = '"members":';
    const sourceMemberOffset =
      source.indexOf(memberMarker);
    const resultMemberOffset =
      text.indexOf(memberMarker);

    expect(patches).toHaveLength(128);
    expect(resultMemberOffset).toBe(sourceMemberOffset);
    expect(
      text.slice(0, resultMemberOffset),
    ).toBe(source.slice(0, sourceMemberOffset));
    expect(text.endsWith(',"tail":1.00}')).toBe(true);
    expect(
      parseJsonDocument(text, "large-members.tmj"),
    ).toEqual(target);
  }, 10_000);

  it("treats equal and absent object members as byte-for-byte no-ops", () => {
    const source = Buffer.from(
      '\uFEFF{\r\n  "obj" : { "\\u0061" : 1.00 }\r\n}\r\n',
      "utf8",
    );
    const target = parseJsonDocument(
      source.toString("utf8"),
      "member-no-op.tmj",
    );
    const patches: JsonObjectMemberPatch[] = [
      { path: ["obj"], key: "a" },
      { path: ["obj"], key: "missing" },
    ];

    const result = patchJsonDocumentSource(
      source,
      target,
      [],
      "member-no-op.tmj",
      [],
      patches,
    );

    expect(result.equals(source)).toBe(true);
  });

  it("rejects invalid, duplicate, and ambiguous object member targets", () => {
    const source =
      '{"obj":{"child":{"value":1},"keep":true},"array":[]}';
    const target = parseJsonDocument(
      source,
      "invalid-members.tmj",
    );
    const duplicate: JsonObjectMemberPatch = {
      path: ["obj"],
      key: "keep",
    };

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "invalid-members.tmj",
        [],
        [duplicate, duplicate],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_DUPLICATE_PATH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "invalid-members.tmj",
        [],
        [{ path: ["missing"], key: "value" }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_PATH_NOT_FOUND",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "invalid-members.tmj",
        [],
        [
          {
            path: ["obj", -1],
            key: "value",
          },
        ],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_INVALID_PATH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "invalid-members.tmj",
        [],
        [{ path: ["array"], key: "value" }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [["obj", "keep"]],
        "invalid-members.tmj",
        [],
        [{ path: ["obj"], key: "keep" }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "invalid-members.tmj",
        [],
        [
          { path: ["obj"], key: "child" },
          {
            path: ["obj", "child"],
            key: "value",
          },
        ],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "invalid-members.tmj",
        [{ path: ["array"], index: 0 }],
        [{ path: [], key: "array" }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
      }),
    );
  });

  it("still rejects target changes omitted from object member patches", () => {
    const source =
      '{"obj":{"selected":1,"uncovered":2},"keep":1.0}';
    const target = cloneJson(
      parseJsonDocument(
        source,
        "member-mismatch.tmj",
      ),
    );
    const object = target.obj as JsonObject;
    object.selected = 3;
    object.uncovered = 4;

    expect(() =>
      patchJsonDocumentSource(
        source,
        target,
        [],
        "member-mismatch.tmj",
        [],
        [{ path: ["obj"], key: "selected" }],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "JSON_SOURCE_PATCH_MISMATCH",
      }),
    );
  });

  it("uses the strict project JSON parser before making edits", () => {
    expect(() =>
      patchJsonDocumentSource(
        '{"layers":[],"layers":[]}',
        { layers: [] },
        [["layers"]],
        "map.tmj",
      ),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_JSON_KEY" }));

    expect(() =>
      patchJsonDocumentSource(
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
        { x: "value" },
        [["x"]],
        "map.tmj",
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_JSON" }));
  });
});
