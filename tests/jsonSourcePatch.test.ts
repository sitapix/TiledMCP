import { describe, expect, it } from "vitest";

import {
  patchJsonDocumentSource,
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
